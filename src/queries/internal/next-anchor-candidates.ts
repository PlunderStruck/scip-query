import { behaviorSignalsByLine, type BehaviorSignal } from '../../source/facts/behavior-skeleton.js';
import { readableSourceUnitRange } from '../../source/facts/source-construct.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import type { CalleeEvidenceSource, CalleeRow } from '../../symbols/graph/call-graph-evidence.js';
import { importedMemberCallTargets } from '../../symbols/graph/member-call-targets.js';
import { scipOccurrenceCallTargetsForRange } from '../../symbols/graph/scip-occurrence-call-targets.js';
import { getGlobalLeafIndex, sameLanguageCandidates } from '../../symbols/leaf-symbol-index.js';
import type { ConnectedBehaviorLine, ConnectedBehaviorPacket, ConnectedBehaviorStep } from './connected-behavior.js';
import type {
  ExplorationEvidenceSource,
  ExplorationEvidenceStrength,
  ExplorationTopology,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
} from './exploration-topology.js';
import { ProjectIndex } from './project-index.js';
import { SOURCE_INSPECTION_SAFE_CHARACTERS } from './inspection-limits.js';

const DEFAULT_NEXT_ANCHOR_LIMIT = 6;
export interface SystemMapNextAnchorAlternative {
  symbol: string | null;
  label: string;
  file: string;
  line: number;
  endLine: number | null;
}

export interface SystemMapNextAnchor {
  id: string;
  status: ExplorationEvidenceStrength | 'ambiguous';
  source: 'graph-call' | 'graph-relation' | 'leaf-identity-candidate';
  /** Optional on legacy call candidates; populated for newly rendered causal targets. */
  direction?: 'upstream' | 'downstream' | 'connector';
  causalRole?: 'caller' | 'callee' | 'result-callback' | 'callable-reference' | 'runtime-producer' | 'runtime-consumer';
  relationKind?: string;
  fromStepId: string;
  fromLabel: string;
  callsite: {
    file: string;
    line: number;
    endLine: number;
    text: string;
    signals: BehaviorSignal[];
    calleeLeaf: string;
  };
  alternatives: SystemMapNextAnchorAlternative[];
  alternativeCount: number;
  evidence: ExplorationEvidenceSource[];
}

export interface SystemMapNextAnchorPacket {
  anchors: SystemMapNextAnchor[];
  withheldAnchors: SystemMapNextAnchor[];
  candidateAnchors: number;
  omittedAnchors: number;
  scannedBehaviorSteps: number;
  visibleCallsites: number;
  graphEvidencedCallsites: number;
  identityCandidateCallsites: number;
  ambiguousCallsites: number;
  unresolvedCallsites: number;
  upstreamCandidates?: number;
  resultCandidates?: number;
  runtimeCandidates?: number;
  inspectCommand: string | null;
  remainingInspectCommands: string[];
}

export interface RankedNextAnchor {
  anchor: SystemMapNextAnchor;
  priority: number;
  /** Internal selection evidence about the target body; never rendered as caller behavior. */
  coverageDimensions?: DownstreamEvidenceDimension[];
  /** Normalized locator terms matched by the already-proven target identity. */
  selectionTermMatches?: string[];
  /** Lower is stronger: identity, path, target source, then one proven callee. */
  selectionTermRanks?: Record<string, number>;
}

export interface SourceRangeNextAnchorSeed {
  id: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
}

type DownstreamEvidenceDimension =
  | 'control-outcome'
  | 'state-effect'
  | 'returned-result'
  | 'produced-value'
  | 'callee-state-effect';

interface ResolvedCalleeTarget {
  row: CalleeRow;
  alternative: SystemMapNextAnchorAlternative;
}

/**
 * Find callable units that can extend the returned behavior packet without
 * guessing what the user's English concern means. Exact graph targets rank
 * first. A unique same-language callable leaf is retained only as an explicitly
 * weaker identity candidate when no graph edge resolved the callsite.
 */
export function systemMapNextAnchorPacket(
  db: ScipDatabase,
  topology: ExplorationTopology,
  behavior: ConnectedBehaviorPacket,
  options: {
    limit?: number;
    sourceAllowed?: (file: string) => boolean;
    selectionTerms?: readonly string[];
  } = {},
): SystemMapNextAnchorPacket {
  const limit = options.limit ?? DEFAULT_NEXT_ANCHOR_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`next-anchor limit must be a positive safe integer; received ${limit}`);
  }
  const sourceAllowed = options.sourceAllowed ?? (() => true);
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const returnedNodeIds = new Set(behavior.steps.map((step) => step.nodeId));
  const returnedSymbols = new Set(
    behavior.steps.flatMap((step) => {
      const symbol = symbolIdentityForNode(nodeById.get(step.nodeId));
      return symbol ? [symbol] : [];
    }),
  );
  const downstreamNodeIds = forwardReachableBehaviorNodeIds(topology);
  const stepDefinitions = new Map(
    behavior.steps.flatMap((step) => {
      if (!step.location) return [];
      const symbol = symbolIdentityForNode(nodeById.get(step.nodeId));
      if (!symbol) return [];
      const definition = getDefinitionsForFile(db, step.location.file).find((candidate) => candidate.symbol === symbol);
      return definition ? [[step.id, definition] as const] : [];
    }),
  );
  // Semantic analysis is deliberately scoped to constructs already returned
  // in the behavior packet. Using it for the universal traversal can surface
  // a large number of valid but query-irrelevant callees and displace the
  // compact causal slice the agent needs to orient itself.
  const calleeMap = new ProjectIndex(db).calleeMap([...stepDefinitions.values()], {
    additive: false,
    semantic: true,
  });
  const ranked: RankedNextAnchor[] = [];
  const targetEffectEvidence = new Map<string, { dimensions: DownstreamEvidenceDimension[]; priorityBonus: number }>();
  const evidencedCallsiteKeys = new Set<string>();
  const consideredCandidateKeys = new Set<string>();
  let scannedBehaviorSteps = 0;
  let visibleCallsites = 0;
  let identityCandidateCallsites = 0;
  let ambiguousCallsites = 0;
  let unresolvedCallsites = 0;
  let upstreamCandidates = 0;
  let resultCandidates = 0;
  let runtimeCandidates = 0;

  for (const step of behavior.steps) {
    if (!step.location || !step.behavior) continue;
    const adjacentCausalEdges = topology.edges.filter(
      (edge) =>
        ['call', 'runtime-boundary'].includes(edge.kind) &&
        (edge.fromNodeId === step.nodeId || edge.toNodeId === step.nodeId) &&
        edge.disposition !== 'excluded' &&
        edge.disposition !== 'unsupported',
    );
    for (const edge of adjacentCausalEdges) {
      const incoming = edge.toNodeId === step.nodeId;
      const candidateNodeId = incoming ? edge.fromNodeId : edge.toNodeId;
      if (returnedNodeIds.has(candidateNodeId)) continue;
      const candidateNode = nodeById.get(candidateNodeId);
      if (!candidateNode?.location || !sourceAllowed(candidateNode.location.file)) continue;
      const alternative =
        edge.kind === 'call' ? callableAlternativeForNode(db, candidateNode) : alternativeForNode(candidateNode);
      if (!alternative) continue;
      const location = evidenceLocation(edge, candidateNode.location.file) ?? candidateNode.location;
      const sourceLine = getSourceLines(db, location.file)[location.line]?.trim();
      const direction = incoming ? 'upstream' : 'downstream';
      const causalRole =
        edge.kind === 'runtime-boundary'
          ? incoming
            ? 'runtime-producer'
            : 'runtime-consumer'
          : incoming
            ? 'caller'
            : 'callee';
      const signals: BehaviorSignal[] = ['call'];
      const strength = strongestEvidence(edge.evidence);
      const leaf = nodeLeaf(candidateNode);
      ranked.push({
        anchor: {
          id: nextAnchorId(step.id, location.line, candidateNode.id),
          status: strength,
          source: 'graph-relation',
          direction,
          causalRole,
          relationKind: edge.kind,
          fromStepId: step.id,
          fromLabel: step.label,
          callsite: {
            file: location.file,
            line: location.line,
            endLine: location.endLine ?? location.line,
            text: sourceLine || `${candidateNode.label} → ${step.label}`,
            signals,
            calleeLeaf: leaf,
          },
          alternatives: [alternative],
          alternativeCount: 1,
          evidence: edge.evidence,
        },
        priority: nextAnchorPriority(
          strength,
          signals,
          step.location.file !== alternative.file,
          1,
          !incoming && downstreamNodeIds.has(step.nodeId),
          step.role,
          direction,
          causalRole,
        ),
      });
      if (incoming) upstreamCandidates += 1;
      if (edge.kind === 'runtime-boundary') runtimeCandidates += 1;
    }

    const callableReferences = topology.edges.filter(
      (edge) =>
        edge.kind === 'reference' &&
        edge.fromNodeId === step.nodeId &&
        edge.disposition !== 'excluded' &&
        edge.disposition !== 'unsupported' &&
        !returnedNodeIds.has(edge.toNodeId),
    );
    for (const edge of callableReferences) {
      const target = nodeById.get(edge.toNodeId);
      if (!target?.location || !sourceAllowed(target.location.file)) continue;
      const alternative = callableAlternativeForNode(db, target);
      if (!alternative) continue;
      const leaf = nodeLeaf(target);
      const line = evidenceLocation(edge, step.location.file)?.line;
      const materialLine = step.behavior.lines.find(
        (candidate) =>
          (line === undefined || (line >= candidate.line && line <= candidate.endLine)) &&
          candidate.text.includes(leaf),
      );
      if (!materialLine) continue;
      const resultProducing =
        materialLine.signals.includes('call') &&
        materialLine.signals.some((signal) => ['return', 'mutation', 'shape', 'spread', 'binding'].includes(signal));
      const causalRole = resultProducing ? 'result-callback' : 'callable-reference';
      const strength = strongestEvidence(edge.evidence);
      ranked.push({
        anchor: {
          id: nextAnchorId(step.id, materialLine.line, target.id),
          status: strength,
          source: 'graph-relation',
          direction: 'downstream',
          causalRole,
          relationKind: 'reference',
          fromStepId: step.id,
          fromLabel: step.label,
          callsite: {
            file: step.location.file,
            line: materialLine.line,
            endLine: materialLine.endLine,
            text: materialLine.text,
            signals: materialLine.signals,
            calleeLeaf: leaf,
          },
          alternatives: [alternative],
          alternativeCount: 1,
          evidence: edge.evidence,
        },
        priority: nextAnchorPriority(
          strength,
          materialLine.signals,
          step.location.file !== alternative.file,
          1,
          downstreamNodeIds.has(step.nodeId),
          step.role,
          'downstream',
          causalRole,
        ),
      });
      if (resultProducing) resultCandidates += 1;
    }

    // Behavior compression is allowed to omit ordinary statements, but that
    // must not erase a compiler-resolved continuation. Recover exact call
    // occurrences across the complete returned construct before restricting
    // the lower-confidence callsite analysis to rendered behavior lines.
    const exactRangeTargets = scipOccurrenceCallTargetsForRange(
      db,
      step.location.file,
      step.location.line,
      step.location.endLine ?? step.location.line,
    );
    const sourceLines = getSourceLines(db, step.location.file);
    const signalsByLine = behaviorSignalsByLine(
      db,
      step.location.file,
      step.location.line,
      step.location.endLine ?? step.location.line,
    );
    for (const target of exactRangeTargets.targets) {
      if (!sourceAllowed(target.definition.relativePath) || returnedSymbols.has(target.definition.symbol)) continue;
      const callsiteKey = sourceCallsiteKey(step.location.file, target.sourceLine, target.calleeLeaf);
      if (evidencedCallsiteKeys.has(callsiteKey)) continue;
      evidencedCallsiteKeys.add(callsiteKey);
      const signals = callsiteSignals(signalsByLine.get(target.sourceLine));
      const alternative: SystemMapNextAnchorAlternative = {
        symbol: target.definition.symbol,
        label: target.definition.leaf,
        file: target.definition.relativePath,
        line: target.definition.startLine,
        endLine: target.definition.endLine,
      };
      const effectEvidence =
        targetEffectEvidence.get(target.definition.symbol) ??
        calleeEffectEvidence(
          db,
          target.definition.relativePath,
          target.definition.startLine,
          target.definition.endLine,
        );
      targetEffectEvidence.set(target.definition.symbol, effectEvidence);
      ranked.push({
        anchor: {
          id: nextAnchorId(step.id, target.sourceLine, target.definition.symbol),
          status: 'exact',
          source: 'graph-call',
          direction: 'downstream',
          causalRole: 'callee',
          relationKind: 'call',
          fromStepId: step.id,
          fromLabel: step.label,
          callsite: {
            file: step.location.file,
            line: target.sourceLine,
            endLine: target.sourceLine,
            text: sourceLines[target.sourceLine]?.trim() || `${target.calleeLeaf}()`,
            signals,
            calleeLeaf: target.calleeLeaf,
          },
          alternatives: [alternative],
          alternativeCount: 1,
          evidence: [
            {
              method: 'scip-occurrence-callsite',
              strength: 'exact',
              identity: target.definition.symbol,
              location: { file: step.location.file, line: target.sourceLine },
            },
          ],
        },
        priority:
          nextAnchorPriority(
            'exact',
            signals,
            step.location.file !== alternative.file,
            1,
            downstreamNodeIds.has(step.nodeId),
            step.role,
            'downstream',
            'callee',
          ) + effectEvidence.priorityBonus,
        coverageDimensions: effectEvidence.dimensions,
      });
    }

    const callLines = step.behavior.lines.filter((line) => line.signals.includes('call'));
    if (callLines.length === 0) continue;
    scannedBehaviorSteps += 1;
    const callsites = (getSourceFacts(db, step.location.file)?.callSites ?? []).filter((callsite) =>
      callLines.some((line) => callsite.line >= line.line && callsite.line <= line.endLine),
    );
    visibleCallsites += callsites.length;
    const outgoing = topology.edges.filter(
      (edge) =>
        edge.kind === 'call' &&
        edge.fromNodeId === step.nodeId &&
        edge.disposition !== 'excluded' &&
        edge.disposition !== 'unsupported',
    );
    const outgoingTargetCountByLeaf = new Map<string, number>();
    for (const edge of outgoing) {
      const target = nodeById.get(edge.toNodeId);
      if (!target) continue;
      const leaf = nodeLeaf(target);
      outgoingTargetCountByLeaf.set(leaf, (outgoingTargetCountByLeaf.get(leaf) ?? 0) + 1);
    }

    const definition = stepDefinitions.get(step.id);
    const resolvedTargets = resolvedCalleeTargets(db, definition ? (calleeMap.get(definition.symbolId) ?? []) : []);
    const targetCountByLeaf = countResolvedTargetsByLeaf(resolvedTargets);
    for (const target of resolvedTargets) {
      if (!sourceAllowed(target.alternative.file) || returnedSymbols.has(target.alternative.symbol ?? '')) continue;
      const leaf = normalizedCallableLeaf(target.alternative.label);
      const callsite = bestCallsiteForResolvedTarget(
        callsites,
        callLines,
        leaf,
        target.row.callsiteLine,
        targetCountByLeaf.get(leaf) === 1,
      );
      if (!callsite) continue;
      const materialLine = materialLineForCallsite(callLines, callsite.line, leaf);
      if (!materialLine) continue;
      const callsiteKey = sourceCallsiteKey(step.location.file, callsite.line, leaf);
      if (evidencedCallsiteKeys.has(callsiteKey)) continue;
      evidencedCallsiteKeys.add(callsiteKey);
      const strength = calleeRowEvidenceStrength(target.row.source);
      ranked.push({
        anchor: {
          id: nextAnchorId(step.id, callsite.line, target.alternative.symbol ?? target.alternative.file),
          status: strength,
          source: 'graph-call',
          direction: 'downstream',
          causalRole: 'callee',
          relationKind: 'call',
          fromStepId: step.id,
          fromLabel: step.label,
          callsite: {
            file: step.location.file,
            line: materialLine.line,
            endLine: materialLine.endLine,
            text: materialLine.text,
            signals: materialLine.signals,
            calleeLeaf: leaf,
          },
          alternatives: [target.alternative],
          alternativeCount: 1,
          evidence: [
            {
              method: target.row.source,
              strength,
              identity: target.row.symbol,
              location: { file: step.location.file, line: callsite.line },
            },
          ],
        },
        priority: nextAnchorPriority(
          strength,
          materialLine.signals,
          step.location.file !== target.alternative.file,
          1,
          downstreamNodeIds.has(step.nodeId),
          step.role,
          'downstream',
          'callee',
        ),
      });
    }

    for (const edge of outgoing) {
      if (returnedNodeIds.has(edge.toNodeId)) continue;
      const target = nodeById.get(edge.toNodeId);
      if (!target?.location || !sourceAllowed(target.location.file)) continue;
      const leaf = nodeLeaf(target);
      const evidenceLine = edge.evidence.find((source) => {
        const location = source.location;
        return location !== null && location.file === step.location?.file && location.line >= 0;
      })?.location?.line;
      const callsite = bestCallsiteForResolvedTarget(
        callsites,
        callLines,
        leaf,
        evidenceLine,
        outgoingTargetCountByLeaf.get(leaf) === 1,
      );
      if (!callsite) continue;
      const materialLine = materialLineForCallsite(callLines, callsite.line, leaf);
      if (!materialLine) continue;
      const callsiteKey = sourceCallsiteKey(step.location.file, callsite.line, leaf);
      if (evidencedCallsiteKeys.has(callsiteKey)) continue;
      evidencedCallsiteKeys.add(callsiteKey);
      const alternative = alternativeForNode(target);
      if (!alternative) continue;
      const strength = strongestEvidence(edge.evidence);
      ranked.push({
        anchor: {
          id: nextAnchorId(step.id, callsite.line, target.id),
          status: strength,
          source: 'graph-call',
          direction: 'downstream',
          causalRole: 'callee',
          relationKind: 'call',
          fromStepId: step.id,
          fromLabel: step.label,
          callsite: {
            file: step.location.file,
            line: materialLine.line,
            endLine: materialLine.endLine,
            text: materialLine.text,
            signals: materialLine.signals,
            calleeLeaf: leaf,
          },
          alternatives: [alternative],
          alternativeCount: 1,
          evidence: edge.evidence,
        },
        priority: nextAnchorPriority(
          strength,
          materialLine.signals,
          step.location.file !== alternative.file,
          1,
          downstreamNodeIds.has(step.nodeId),
          step.role,
          'downstream',
          'callee',
        ),
      });
    }

    for (const callsite of callsites) {
      const callsiteKey = sourceCallsiteKey(step.location.file, callsite.line, callsite.calleeLeaf);
      if (evidencedCallsiteKeys.has(callsiteKey)) continue;
      const materialLine = materialLineForCallsite(callLines, callsite.line, callsite.calleeLeaf);
      if (!materialLine) continue;
      const definitions = sameLanguageCandidates(
        step.location.file,
        getGlobalLeafIndex(db).get(callsite.calleeLeaf) ?? [],
      )
        .flatMap((candidate) =>
          getDefinitionsForFile(db, candidate.file).filter(
            (definition) => definition.symbol === candidate.symbol && definition.isFunctionLike,
          ),
        )
        .filter((definition) => sourceAllowed(definition.relativePath) && !returnedSymbols.has(definition.symbol));
      const alternatives = uniqueAlternatives(
        definitions.map((definition) => ({
          symbol: definition.symbol,
          label: definition.leaf ?? callsite.calleeLeaf,
          file: definition.relativePath,
          line: definition.startLine,
          endLine: definition.endLine,
        })),
      );
      if (alternatives.length === 0) {
        unresolvedCallsites += 1;
        continue;
      }
      const candidateKey = `${step.id}\0${callsite.line}\0${callsite.calleeLeaf}`;
      if (consideredCandidateKeys.has(candidateKey)) continue;
      consideredCandidateKeys.add(candidateKey);
      const ambiguous = alternatives.length > 1;
      if (ambiguous) ambiguousCallsites += 1;
      else identityCandidateCallsites += 1;
      ranked.push({
        anchor: {
          id: nextAnchorId(step.id, callsite.line, callsite.calleeLeaf),
          status: ambiguous ? 'ambiguous' : 'candidate',
          source: 'leaf-identity-candidate',
          direction: 'downstream',
          causalRole: 'callee',
          relationKind: 'call',
          fromStepId: step.id,
          fromLabel: step.label,
          callsite: {
            file: step.location.file,
            line: materialLine.line,
            endLine: materialLine.endLine,
            text: materialLine.text,
            signals: materialLine.signals,
            calleeLeaf: callsite.calleeLeaf,
          },
          alternatives: alternatives.slice(0, 3),
          alternativeCount: alternatives.length,
          evidence: [],
        },
        priority: nextAnchorPriority(
          ambiguous ? 'unknown' : 'candidate',
          materialLine.signals,
          alternatives.some((alternative) => alternative.file !== step.location!.file),
          alternatives.length,
          downstreamNodeIds.has(step.nodeId),
          step.role,
          'downstream',
          'callee',
        ),
      });
    }
  }

  return nextAnchorPacketFromCandidates(
    db,
    ranked,
    behavior.steps,
    limit,
    {
      scannedBehaviorSteps,
      visibleCallsites,
      graphEvidencedCallsites: evidencedCallsiteKeys.size,
      identityCandidateCallsites,
      ambiguousCallsites,
      unresolvedCallsites,
      upstreamCandidates,
      resultCandidates,
      runtimeCandidates,
    },
    options.selectionTerms,
  );
}

/**
 * Continue from exact source constructs materialized by inspect. Unlike a
 * symbol-rooted call graph, this path also works for object-literal methods and
 * registry handlers that have no callable compiler symbol of their own: the
 * source range supplies ownership while SCIP occurrences supply callee
 * identity.
 */
export function sourceRangeNextAnchorPacket(
  db: ScipDatabase,
  seeds: readonly SourceRangeNextAnchorSeed[],
  options: { limit?: number; sourceAllowed?: (file: string) => boolean } = {},
): SystemMapNextAnchorPacket {
  const limit = options.limit ?? DEFAULT_NEXT_ANCHOR_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`next-anchor limit must be a positive safe integer; received ${limit}`);
  }
  const sourceAllowed = options.sourceAllowed ?? (() => true);
  const ranked: RankedNextAnchor[] = [];
  const steps: ConnectedBehaviorStep[] = seeds.map((seed, order) => ({
    id: seed.id,
    nodeId: seed.id,
    order,
    role: 'anchor',
    kind: 'source-construct',
    label: seed.label,
    location: { file: seed.file, line: seed.startLine, endLine: seed.endLine },
    behavior: null,
  }));
  const materializedRanges = seeds.map((seed) => ({
    file: seed.file,
    startLine: seed.startLine,
    endLine: seed.endLine,
  }));
  let visibleCallsites = 0;
  let graphEvidencedCallsites = 0;
  let identityCandidateCallsites = 0;
  let ambiguousCallsites = 0;
  let unresolvedCallsites = 0;
  const targetEffectEvidence = new Map<string, { dimensions: DownstreamEvidenceDimension[]; priorityBonus: number }>();

  for (const seed of seeds) {
    const sourceLines = getSourceLines(db, seed.file);
    const facts = getSourceFacts(db, seed.file);
    const callsites = (facts?.callSites ?? []).filter(
      (callsite) => callsite.line >= seed.startLine && callsite.line <= seed.endLine,
    );
    visibleCallsites += callsites.length;
    const signalsByLine = behaviorSignalsByLine(db, seed.file, seed.startLine, seed.endLine);
    const exact = scipOccurrenceCallTargetsForRange(db, seed.file, seed.startLine, seed.endLine);
    const exactCallsiteKeys = new Set<string>();

    for (const target of exact.targets) {
      if (!sourceAllowed(target.definition.relativePath)) continue;
      if (
        materializedRanges.some(
          (range) =>
            range.file === target.definition.relativePath &&
            range.startLine <= target.definition.startLine &&
            range.endLine >= target.definition.endLine,
        )
      ) {
        continue;
      }
      const key = sourceCallsiteKey(seed.file, target.sourceLine, target.calleeLeaf);
      exactCallsiteKeys.add(key);
      const signals = callsiteSignals(signalsByLine.get(target.sourceLine));
      const alternative: SystemMapNextAnchorAlternative = {
        symbol: target.definition.symbol,
        label: target.definition.leaf,
        file: target.definition.relativePath,
        line: target.definition.startLine,
        endLine: target.definition.endLine,
      };
      const effectEvidence =
        targetEffectEvidence.get(target.definition.symbol) ??
        calleeEffectEvidence(
          db,
          target.definition.relativePath,
          target.definition.startLine,
          target.definition.endLine,
        );
      targetEffectEvidence.set(target.definition.symbol, effectEvidence);
      ranked.push({
        anchor: {
          id: nextAnchorId(seed.id, target.sourceLine, target.definition.symbol),
          status: 'exact',
          source: 'graph-call',
          direction: 'downstream',
          causalRole: 'callee',
          relationKind: 'call',
          fromStepId: seed.id,
          fromLabel: seed.label,
          callsite: {
            file: seed.file,
            line: target.sourceLine,
            endLine: target.sourceLine,
            text: sourceLines[target.sourceLine]?.trim() || `${target.calleeLeaf}()`,
            signals,
            calleeLeaf: target.calleeLeaf,
          },
          alternatives: [alternative],
          alternativeCount: 1,
          evidence: [
            {
              method: 'scip-occurrence-callsite',
              strength: 'exact',
              identity: target.definition.symbol,
              location: { file: seed.file, line: target.sourceLine },
            },
          ],
        },
        priority:
          nextAnchorPriority(
            'exact',
            signals,
            seed.file !== alternative.file,
            1,
            true,
            'anchor',
            'downstream',
            'callee',
          ) + effectEvidence.priorityBonus,
        coverageDimensions: effectEvidence.dimensions,
      });
    }
    graphEvidencedCallsites += exact.resolvedCallsites;

    const memberTargets = importedMemberCallTargets(db, seed.file, {
      ranges: [{ startLine: seed.startLine, endLine: seed.endLine }],
    });
    const memberTargetsByCallsite = new Map<string, typeof memberTargets.targets>();
    for (const target of memberTargets.targets) {
      const callsiteLeaf = callsites.find((callsite) => callsite.line === target.line)?.calleeLeaf ?? target.calleeLeaf;
      const key = sourceCallsiteKey(seed.file, target.line, callsiteLeaf);
      const group = memberTargetsByCallsite.get(key) ?? [];
      group.push(target);
      memberTargetsByCallsite.set(key, group);
    }
    for (const [key, groupedTargets] of memberTargetsByCallsite) {
      if (exactCallsiteKeys.has(key)) continue;
      exactCallsiteKeys.add(key);
      const targets = groupedTargets.filter(
        (target) =>
          sourceAllowed(target.targetFile) &&
          !materializedRanges.some(
            (range) =>
              range.file === target.targetFile &&
              range.startLine <= target.targetStartLine &&
              range.endLine >= target.targetEndLine,
          ),
      );
      if (targets.length === 0) continue;
      const target = targets[0]!;
      const callsiteLeaf = callsites.find((callsite) => callsite.line === target.line)?.calleeLeaf ?? target.calleeLeaf;
      const signals = callsiteSignals(signalsByLine.get(target.line));
      const alternatives = uniqueAlternatives(
        targets.map((candidate) => ({
          symbol: candidate.targetSymbol ?? null,
          label: candidate.calleeLeaf,
          file: candidate.targetFile,
          line: candidate.targetStartLine,
          endLine: candidate.targetEndLine,
        })),
      );
      const strength: ExplorationEvidenceStrength = targets.some(
        (candidate) => (candidate.resolutionAlternativeCount ?? 0) > 1,
      )
        ? 'candidate'
        : targets.every((candidate) => candidate.strength === 'exact')
          ? 'exact'
          : 'derived';
      ranked.push({
        anchor: {
          id: nextAnchorId(
            seed.id,
            target.line,
            alternatives.map((alternative) => `${alternative.file}:${alternative.line}`).join('|'),
          ),
          status: alternatives.length > 1 ? 'ambiguous' : strength,
          source: 'graph-call',
          direction: 'downstream',
          causalRole: 'callee',
          relationKind: 'call',
          fromStepId: seed.id,
          fromLabel: seed.label,
          callsite: {
            file: seed.file,
            line: target.line,
            endLine: target.line,
            text: sourceLines[target.line]?.trim() || `${target.calleeLeaf}()`,
            signals,
            calleeLeaf: callsiteLeaf,
          },
          alternatives: alternatives.slice(0, 3),
          alternativeCount: alternatives.length,
          evidence: targets.map((candidate) => ({
            method:
              candidate.resolution === 'constructed-member-receiver'
                ? 'ast-constructed-member-callsite'
                : candidate.resolution === 'factory-callback-member'
                  ? 'ast-factory-callback-callsite'
                  : candidate.resolution === 'imported-service-object-member'
                    ? 'ast-service-member-callsite'
                    : 'ast-import-member-callsite',
            strength,
            identity:
              candidate.targetSymbol ??
              `${candidate.targetFile}:${candidate.targetStartLine}-${candidate.targetEndLine}`,
            location: { file: seed.file, line: target.line },
          })),
        },
        priority: nextAnchorPriority(
          strength,
          signals,
          alternatives.some((alternative) => seed.file !== alternative.file),
          alternatives.length,
          true,
          'anchor',
          'downstream',
          'callee',
        ),
      });
    }
    graphEvidencedCallsites += memberTargetsByCallsite.size;

    for (const callsite of callsites) {
      const key = sourceCallsiteKey(seed.file, callsite.line, callsite.calleeLeaf);
      if (exactCallsiteKeys.has(key)) continue;
      const definitions = sameLanguageCandidates(seed.file, getGlobalLeafIndex(db).get(callsite.calleeLeaf) ?? [])
        .flatMap((candidate) =>
          getDefinitionsForFile(db, candidate.file).filter(
            (definition) => definition.symbol === candidate.symbol && definition.isFunctionLike,
          ),
        )
        .filter((definition) => sourceAllowed(definition.relativePath));
      const alternatives = uniqueAlternatives(
        definitions.map((definition) => ({
          symbol: definition.symbol,
          label: definition.leaf || callsite.calleeLeaf,
          file: definition.relativePath,
          line: definition.startLine,
          endLine: definition.endLine,
        })),
      );
      if (alternatives.length === 0) {
        unresolvedCallsites += 1;
        continue;
      }
      const ambiguous = alternatives.length > 1;
      if (ambiguous) ambiguousCallsites += 1;
      else identityCandidateCallsites += 1;
      const signals = callsiteSignals(signalsByLine.get(callsite.line));
      ranked.push({
        anchor: {
          id: nextAnchorId(seed.id, callsite.line, callsite.calleeLeaf),
          status: ambiguous ? 'ambiguous' : 'candidate',
          source: 'leaf-identity-candidate',
          direction: 'downstream',
          causalRole: 'callee',
          relationKind: 'call',
          fromStepId: seed.id,
          fromLabel: seed.label,
          callsite: {
            file: seed.file,
            line: callsite.line,
            endLine: callsite.line,
            text: sourceLines[callsite.line]?.trim() || `${callsite.calleeLeaf}()`,
            signals,
            calleeLeaf: callsite.calleeLeaf,
          },
          alternatives: alternatives.slice(0, 3),
          alternativeCount: alternatives.length,
          evidence: [],
        },
        priority: nextAnchorPriority(
          ambiguous ? 'unknown' : 'candidate',
          signals,
          alternatives.some((alternative) => alternative.file !== seed.file),
          alternatives.length,
          true,
          'anchor',
          'downstream',
          'callee',
        ),
      });
    }
  }

  return nextAnchorPacketFromCandidates(db, ranked, steps, limit, {
    scannedBehaviorSteps: seeds.length,
    visibleCallsites,
    graphEvidencedCallsites,
    identityCandidateCallsites,
    ambiguousCallsites,
    unresolvedCallsites,
    upstreamCandidates: 0,
    resultCandidates: 0,
    runtimeCandidates: 0,
  });
}

interface NextAnchorPacketStats {
  scannedBehaviorSteps: number;
  visibleCallsites: number;
  graphEvidencedCallsites: number;
  identityCandidateCallsites: number;
  ambiguousCallsites: number;
  unresolvedCallsites: number;
  upstreamCandidates: number;
  resultCandidates: number;
  runtimeCandidates: number;
}

function nextAnchorPacketFromCandidates(
  db: ScipDatabase,
  ranked: readonly RankedNextAnchor[],
  steps: readonly ConnectedBehaviorStep[],
  limit: number,
  stats: NextAnchorPacketStats,
  selectionTerms: readonly string[] = [],
): SystemMapNextAnchorPacket {
  const normalizedSelectionTerms = [
    ...new Set(selectionTerms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean)),
  ];
  const selectionEvidenceByTarget = new Map<string, { direct: string; oneHop: string }>();
  const candidates = deduplicateRankedAnchors(
    ranked.map((candidate) => {
      const selectionEvidence = nextAnchorSelectionEvidence(db, candidate, selectionEvidenceByTarget);
      const matches = normalizedSelectionTerms
        .map((term) => ({ term, rank: nextAnchorSelectionTermRank(candidate, term, selectionEvidence) }))
        .filter((match): match is { term: string; rank: number } => match.rank !== null);
      return {
        ...candidate,
        selectionTermMatches: matches.map((match) => match.term),
        selectionTermRanks: Object.fromEntries(matches.map((match) => [match.term, match.rank])),
      };
    }),
  ).sort(compareRankedNextAnchors);
  const selectedCandidates = coverageDiverseNextAnchors(
    candidates.filter((candidate) => nextAnchorInspectSafe(db, candidate)),
    steps,
    limit,
    normalizedSelectionTerms,
  );
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.anchor.id));
  const withheldCandidates = candidates.filter((candidate) => !selectedIds.has(candidate.anchor.id));
  const selected = selectedCandidates.map((candidate) => candidate.anchor);
  const withheld = withheldCandidates.map((candidate) => candidate.anchor);
  const inspectAlternatives = uniqueAlternatives(
    selected.flatMap((anchor) => (anchor.alternativeCount === 1 ? anchor.alternatives : [])),
  );
  const withheldInspectAlternatives = uniqueAlternatives(
    withheld.flatMap((anchor) => (anchor.alternativeCount === 1 ? anchor.alternatives : [])),
  );
  return {
    anchors: selected,
    withheldAnchors: withheld,
    candidateAnchors: candidates.length,
    omittedAnchors: Math.max(0, candidates.length - selected.length),
    ...stats,
    inspectCommand:
      inspectAlternatives.length === 0
        ? null
        : `scip-query inspect ${inspectAlternatives.map(inspectSelector).join(' ')} --view behavior`,
    remainingInspectCommands: chunked(withheldInspectAlternatives, 8).map(
      (alternatives) => `scip-query inspect ${alternatives.map(inspectSelector).join(' ')} --view behavior`,
    ),
  };
}

export function nextAnchorInspectSafe(db: ScipDatabase, candidate: RankedNextAnchor): boolean {
  if (candidate.anchor.alternativeCount !== 1) return true;
  const target = candidate.anchor.alternatives[0]!;
  const endLine = target.endLine ?? target.line;
  return (
    getSourceLines(db, target.file)
      .slice(target.line, endLine + 1)
      .join('\n').length <= SOURCE_INSPECTION_SAFE_CHARACTERS
  );
}

function callsiteSignals(signals: readonly BehaviorSignal[] | undefined): BehaviorSignal[] {
  return signals?.includes('call') ? [...signals] : ['call', ...(signals ?? [])];
}

/**
 * Spend the small visible drill-target budget across the causal slice instead
 * of allowing one large outlined construct to monopolize it. A connector is a
 * repository unit that explains why explicit anchors belong to one flow, so
 * its first exact continuation has the highest structural information gain.
 * The next pass gives each explicit anchor or connector one target before the
 * remaining slots return to the ordinary evidence/effect ranking.
 */
export function coverageDiverseNextAnchors(
  candidates: readonly RankedNextAnchor[],
  steps: readonly ConnectedBehaviorStep[],
  limit: number,
  selectionTerms: readonly string[] = [],
): RankedNextAnchor[] {
  if (limit <= 0 || candidates.length === 0) return [];
  const roleByStepId = new Map(steps.map((step) => [step.id, step.role]));
  const selected: RankedNextAnchor[] = [];
  const selectedIds = new Set<string>();
  const representedForwardStepIds = new Set<string>();
  const representedEvidenceDimensions = new Set<DownstreamEvidenceDimension>();

  const select = (candidate: RankedNextAnchor): void => {
    if (selected.length >= limit || selectedIds.has(candidate.anchor.id)) return;
    selected.push(candidate);
    selectedIds.add(candidate.anchor.id);
    if (candidate.anchor.direction !== 'upstream') {
      representedForwardStepIds.add(candidate.anchor.fromStepId);
    }
    for (const dimension of downstreamEvidenceDimensions(candidate)) representedEvidenceDimensions.add(dimension);
  };

  // Parallel implementations often have independent activation chains. Keep
  // one exact upstream continuation from several repository areas so a single
  // high-ranking path cannot hide the ownership of the others.
  const upstreamReservationLimit = Math.max(1, Math.floor(limit / 3));
  const representedUpstreamAreas = new Set<string>();
  for (const candidate of candidates) {
    if (representedUpstreamAreas.size >= upstreamReservationLimit) break;
    if (
      candidate.anchor.direction !== 'upstream' ||
      candidate.anchor.alternativeCount !== 1 ||
      candidate.anchor.status === 'ambiguous'
    ) {
      continue;
    }
    const area = nextAnchorRepositoryArea(candidate);
    if (representedUpstreamAreas.has(area)) continue;
    select(candidate);
    representedUpstreamAreas.add(area);
  }

  const resultCallback = candidates.find(
    (candidate) =>
      candidate.anchor.alternativeCount === 1 &&
      candidate.anchor.status !== 'ambiguous' &&
      candidate.anchor.causalRole === 'result-callback',
  );
  if (resultCallback) select(resultCallback);

  // The locator may carry forward a bounded set of rare normalized terms from
  // the user's question. They do not establish relevance or create an edge;
  // they only reserve space for exact causal targets whose existing identity
  // matches a term. Preserve different terms so one vocabulary family cannot
  // monopolize the fixed packet.
  const selectionReservationLimit = Math.max(1, Math.ceil((limit * 2) / 3));
  let selectedByTerm = 0;
  for (const term of selectionTerms) {
    if (selectedByTerm >= selectionReservationLimit || selected.length >= limit) break;
    const candidate = candidates
      .filter(
        (entry) =>
          !selectedIds.has(entry.anchor.id) &&
          entry.anchor.alternativeCount === 1 &&
          entry.anchor.status !== 'ambiguous' &&
          entry.selectionTermMatches?.includes(term),
      )
      .sort(
        (left, right) =>
          (left.selectionTermRanks?.[term] ?? Number.MAX_SAFE_INTEGER) -
            (right.selectionTermRanks?.[term] ?? Number.MAX_SAFE_INTEGER) || compareRankedNextAnchors(left, right),
      )[0];
    if (!candidate) continue;
    select(candidate);
    selectedByTerm += 1;
  }

  const connectorReservationLimit = Math.max(1, Math.floor(limit / 4));
  let reservedConnectors = 0;
  for (const candidate of candidates) {
    if (reservedConnectors >= connectorReservationLimit) break;
    if (roleByStepId.get(candidate.anchor.fromStepId) !== 'connector') continue;
    if (
      candidate.anchor.source !== 'graph-call' ||
      candidate.anchor.alternativeCount !== 1 ||
      representedForwardStepIds.has(candidate.anchor.fromStepId)
    ) {
      continue;
    }
    select(candidate);
    reservedConnectors += 1;
  }

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const stepId = candidate.anchor.fromStepId;
    if (roleByStepId.get(stepId) !== 'anchor' || representedForwardStepIds.has(stepId)) continue;
    select(candidate);
  }

  // Once the packet represents the explicit anchors, preserve different ways
  // their downstream callees participate in behavior. This replaces redundant
  // breadth inside the same fixed budget; it does not add output or infer the
  // user's repository-specific intent.
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (candidate.anchor.alternativeCount !== 1 || candidate.anchor.status === 'ambiguous') continue;
    const dimensions = downstreamEvidenceDimensions(candidate);
    if (dimensions.length === 0 || dimensions.every((dimension) => representedEvidenceDimensions.has(dimension))) {
      continue;
    }
    select(candidate);
  }

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    select(candidate);
  }
  return selected;
}

function nextAnchorRepositoryArea(candidate: RankedNextAnchor): string {
  const file = candidate.anchor.alternatives[0]?.file ?? candidate.anchor.callsite.file;
  const segments = file.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= 1) return file;
  return `${segments[0]}/${segments[1]}`;
}

export function nextAnchorSelectionTermRank(
  candidate: RankedNextAnchor,
  term: string,
  evidence: { direct?: string; oneHop?: string } = {},
): number | null {
  const identityValues = [
    candidate.anchor.callsite.calleeLeaf,
    ...candidate.anchor.alternatives.map((item) => item.label),
  ];
  if (identityValues.some((value) => selectionVocabularyMatches(value, term))) return 0;
  for (const alternative of candidate.anchor.alternatives) {
    const basename = alternative.file.slice(alternative.file.lastIndexOf('/') + 1).replace(/\.[^.]+$/u, '');
    if (selectionVocabularyMatches(basename, term)) return 1;
  }
  if (candidate.anchor.alternatives.some((alternative) => selectionVocabularyMatches(alternative.file, term))) return 2;
  if (evidence.direct && selectionVocabularyMatches(evidence.direct, term)) return 3;
  return evidence.oneHop && selectionVocabularyMatches(evidence.oneHop, term) ? 4 : null;
}

function nextAnchorSelectionEvidence(
  db: ScipDatabase,
  candidate: RankedNextAnchor,
  cache: Map<string, { direct: string; oneHop: string }>,
): { direct: string; oneHop: string } {
  const target = candidate.anchor.alternativeCount === 1 ? candidate.anchor.alternatives[0] : null;
  if (!target) return { direct: '', oneHop: '' };
  const key = target.symbol ?? `${target.file}:${target.line}:${target.endLine ?? target.line}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const declaredEndLine = target.endLine ?? target.line;
  const readableRange = readableSourceUnitRange(db, target.file, target.line);
  const startLine = readableRange?.startLine ?? target.line;
  const endLine = Math.max(declaredEndLine, readableRange?.endLine ?? declaredEndLine);
  const direct = sourceIdentifierVocabulary(db, target.file, startLine, endLine);
  const oneHop = scipOccurrenceCallTargetsForRange(db, target.file, startLine, endLine)
    .targets.filter((callee) => callee.definition.symbol !== target.symbol)
    .map((callee) =>
      sourceIdentifierVocabulary(
        db,
        callee.definition.relativePath,
        callee.definition.startLine,
        callee.definition.endLine,
      ),
    )
    .join(' ');
  const evidence = { direct, oneHop };
  cache.set(key, evidence);
  return evidence;
}

function sourceIdentifierVocabulary(db: ScipDatabase, file: string, startLine: number, endLine: number): string {
  const facts = getSourceFacts(db, file);
  if (!facts) return '';
  return [...facts.identifierLineMap]
    .filter(([, lines]) => lines.some((line) => line >= startLine && line <= endLine))
    .map(([identifier]) => identifier)
    .join(' ');
}

function selectionVocabularyMatches(value: string, term: string): boolean {
  const vocabulary = new Set<string>();
  for (const word of value
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length >= 3)) {
    for (const variant of selectionWordVariants(word)) vocabulary.add(variant);
  }
  return selectionWordVariants(term).some((variant) => vocabulary.has(variant));
}

function selectionWordVariants(value: string): string[] {
  const word = value.toLocaleLowerCase();
  const variants = new Set([word]);
  if (word.length > 4 && word.endsWith('e')) variants.add(word.slice(0, -1));
  if (word.length > 5 && word.endsWith('ing')) variants.add(undoubleSelectionConsonant(word.slice(0, -3)));
  if (word.length > 4 && word.endsWith('ed')) variants.add(undoubleSelectionConsonant(word.slice(0, -2)));
  if (word.length > 5 && word.endsWith('tion')) {
    const base = word.slice(0, -3);
    variants.add(base);
    variants.add(`${base}e`);
  }
  return [...variants];
}

function undoubleSelectionConsonant(value: string): string {
  if (value.length < 2) return value;
  const last = value.at(-1)!;
  return last === value.at(-2) && !'aeiou'.includes(last) ? value.slice(0, -1) : value;
}

function downstreamEvidenceDimensions(candidate: RankedNextAnchor): DownstreamEvidenceDimension[] {
  if (candidate.anchor.direction === 'upstream') return [];
  const signals = candidate.anchor.callsite.signals;
  const dimensions: DownstreamEvidenceDimension[] = [...(candidate.coverageDimensions ?? [])];
  if (signals.some((signal) => ['branch', 'catch', 'finally', 'throw'].includes(signal))) {
    dimensions.push('control-outcome');
  }
  if (signals.some((signal) => ['await', 'mutation'].includes(signal))) dimensions.push('state-effect');
  if (signals.some((signal) => ['return', 'shape', 'spread'].includes(signal))) dimensions.push('returned-result');
  if (signals.includes('binding')) dimensions.push('produced-value');
  return dimensions;
}

function calleeEffectEvidence(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
): { dimensions: DownstreamEvidenceDimension[]; priorityBonus: number } {
  const sourceLines = getSourceLines(db, file);
  const escapingMutationLines = [...behaviorSignalsByLine(db, file, startLine, endLine)].filter(
    ([line, signals]) => signals.includes('mutation') && writesThroughObjectIdentity(sourceLines[line] ?? ''),
  ).length;
  return {
    dimensions: escapingMutationLines > 0 ? ['callee-state-effect'] : [],
    priorityBonus: Math.min(30, escapingMutationLines * 5),
  };
}

/**
 * Distinguish mutation of reachable object state from reassignment of a local
 * scalar. Both are AST "mutation" signals, but only the former is evidence
 * that a callee may own a state-changing effect worth reserving frontier space
 * for. This deliberately recognizes syntax, not repository-specific names.
 */
export function writesThroughObjectIdentity(sourceLine: string): boolean {
  return /(?:\bthis|\b[$A-Z_a-z][$\w]*)\s*(?:\.|\[[^\]]+\])[^;\n]*?(?:\+\+|--|(?:\+|-|\*|\/|%|&&|\|\||\?\?)?=(?!=|>))/.test(
    sourceLine,
  );
}

function forwardReachableBehaviorNodeIds(topology: ExplorationTopology): Set<string> {
  const reachable = new Set(
    topology.anchors.filter((anchor) => anchor.status === 'matched').flatMap((anchor) => anchor.nodeIds),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of topology.edges) {
      if (
        edge.disposition === 'excluded' ||
        edge.disposition === 'unsupported' ||
        !['call', 'runtime-boundary'].includes(edge.kind) ||
        !reachable.has(edge.fromNodeId) ||
        reachable.has(edge.toNodeId)
      ) {
        continue;
      }
      reachable.add(edge.toNodeId);
      changed = true;
    }
  }
  return reachable;
}

function resolvedCalleeTargets(db: ScipDatabase, rows: readonly CalleeRow[]): ResolvedCalleeTarget[] {
  const targets = new Map<string, ResolvedCalleeTarget>();
  for (const row of rows) {
    const definition = getDefinitionsForFile(db, row.file).find(
      (candidate) => candidate.symbol === row.symbol && candidate.isFunctionLike,
    );
    if (!definition) continue;
    const alternative: SystemMapNextAnchorAlternative = {
      symbol: definition.symbol,
      label: definition.leaf,
      file: definition.relativePath,
      line: definition.startLine,
      endLine: definition.endLine,
    };
    const existing = targets.get(definition.symbol);
    if (!existing || calleeRowEvidenceRank(row.source) > calleeRowEvidenceRank(existing.row.source)) {
      targets.set(definition.symbol, {
        row: {
          ...row,
          ...(row.callsiteLine === undefined && existing?.row.callsiteLine !== undefined
            ? { callsiteLine: existing.row.callsiteLine }
            : {}),
        },
        alternative,
      });
    } else if (existing.row.callsiteLine === undefined && row.callsiteLine !== undefined) {
      targets.set(definition.symbol, { ...existing, row: { ...existing.row, callsiteLine: row.callsiteLine } });
    }
  }
  return [...targets.values()];
}

function countResolvedTargetsByLeaf(targets: readonly ResolvedCalleeTarget[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const leaf = normalizedCallableLeaf(target.alternative.label);
    counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
  }
  return counts;
}

function calleeRowEvidenceStrength(source: CalleeEvidenceSource): ExplorationEvidenceStrength {
  return source === 'semantic-callee' || source === 'scip-chunk' ? 'exact' : 'derived';
}

function calleeRowEvidenceRank(source: CalleeEvidenceSource): number {
  return calleeRowEvidenceStrength(source) === 'exact' ? 2 : 1;
}

function materialLineForCallsite(
  lines: readonly ConnectedBehaviorLine[],
  callsiteLine: number,
  leaf: string,
): ConnectedBehaviorLine | null {
  return (
    lines.find((line) => callsiteLine >= line.line && callsiteLine <= line.endLine && line.text.includes(leaf)) ??
    lines.find((line) => callsiteLine >= line.line && callsiteLine <= line.endLine) ??
    null
  );
}

function bestCallsiteForResolvedTarget(
  callsites: readonly { line: number; calleeLeaf: string }[],
  lines: readonly ConnectedBehaviorLine[],
  leaf: string,
  callsiteLine: number | undefined,
  uniqueTargetLeaf: boolean,
): { line: number; calleeLeaf: string } | null {
  if (callsiteLine !== undefined) {
    return (
      callsites.find(
        (callsite) =>
          callsite.line === callsiteLine &&
          callsite.calleeLeaf === leaf &&
          materialLineForCallsite(lines, callsite.line, leaf) !== null,
      ) ?? null
    );
  }
  const matching = callsites.filter(
    (callsite) =>
      callsite.calleeLeaf === leaf && materialLineForCallsite(lines, callsite.line, callsite.calleeLeaf) !== null,
  );
  return uniqueTargetLeaf && matching.length === 1 ? matching[0]! : null;
}

function nodeLeaf(node: ExplorationTopologyNode): string {
  const leaf = node.attributes['leaf'];
  if (typeof leaf === 'string' && leaf.length > 0) return normalizedCallableLeaf(leaf);
  const label = node.label.slice(node.label.lastIndexOf(':') + 1);
  return normalizedCallableLeaf(label);
}

function normalizedCallableLeaf(value: string): string {
  return value.replace(/\(\)$/u, '').replace(/^#/u, '');
}

function symbolIdentityForNode(node: ExplorationTopologyNode | undefined): string | null {
  if (node?.kind !== 'symbol' || !node.id.startsWith('symbol:')) return null;
  try {
    return decodeURIComponent(node.id.slice('symbol:'.length));
  } catch {
    return null;
  }
}

function alternativeForNode(node: ExplorationTopologyNode): SystemMapNextAnchorAlternative | null {
  if (!node.location) return null;
  return {
    symbol: symbolIdentityForNode(node),
    label: node.label,
    file: node.location.file,
    line: node.location.line,
    endLine: node.location.endLine ?? null,
  };
}

function callableAlternativeForNode(
  db: ScipDatabase,
  node: ExplorationTopologyNode,
): SystemMapNextAnchorAlternative | null {
  const alternative = alternativeForNode(node);
  if (!alternative?.symbol) return null;
  const callable = getDefinitionsForFile(db, alternative.file).some(
    (definition) => definition.symbol === alternative.symbol && definition.isFunctionLike,
  );
  return callable ? alternative : null;
}

function evidenceLocation(
  edge: ExplorationTopologyEdge,
  preferredFile: string,
): { file: string; line: number; endLine?: number } | null {
  return (
    edge.evidence.find((source) => source.location?.file === preferredFile)?.location ??
    edge.evidence.find((source) => source.location !== null)?.location ??
    null
  );
}

function strongestEvidence(evidence: readonly ExplorationEvidenceSource[]): ExplorationEvidenceStrength {
  const rank: Record<ExplorationEvidenceStrength, number> = {
    exact: 5,
    derived: 4,
    mixed: 3,
    candidate: 2,
    unknown: 1,
  };
  return evidence.reduce<ExplorationEvidenceStrength>(
    (best, source) => (rank[source.strength] > rank[best] ? source.strength : best),
    'unknown',
  );
}

function nextAnchorPriority(
  strength: ExplorationEvidenceStrength,
  signals: readonly BehaviorSignal[],
  crossesFile: boolean,
  alternativeCount: number,
  downstreamOfAnchor: boolean,
  sourceRole: ConnectedBehaviorPacket['steps'][number]['role'],
  direction: SystemMapNextAnchor['direction'] = 'downstream',
  causalRole: SystemMapNextAnchor['causalRole'] = 'callee',
): number {
  const strengthScore: Record<ExplorationEvidenceStrength, number> = {
    exact: 50,
    derived: 40,
    mixed: 30,
    candidate: 15,
    unknown: 0,
  };
  let score = strengthScore[strength];
  if (signals.includes('mutation')) score += 40;
  if (signals.includes('finally') || signals.includes('catch')) score += 35;
  if (signals.includes('throw')) score += 30;
  if (signals.includes('return')) score += 25;
  if (signals.includes('await')) score += 20;
  if (signals.includes('branch')) score += 10;
  if (signals.includes('shape')) score += 8;
  if (signals.includes('spread')) score += 8;
  if (crossesFile) score += 5;
  if (alternativeCount === 1) score += 5;
  if (downstreamOfAnchor) score += 15;
  if (direction === 'upstream') score += 35;
  if (causalRole === 'result-callback') score += 45;
  if (causalRole === 'runtime-producer' || causalRole === 'runtime-consumer') score += 35;
  if (causalRole === 'callable-reference') score += 10;
  // A next anchor should first deepen the units the caller explicitly chose.
  // Calls found only in a junction are valid but describe incidental path
  // context, so they must not displace direct effects of an anchor merely
  // because their source statements happen to carry stronger effect signals.
  if (sourceRole === 'anchor') score += 60;
  else if (sourceRole === 'connector') score += 25;
  return score;
}

function compareRankedNextAnchors(left: RankedNextAnchor, right: RankedNextAnchor): number {
  return (
    right.priority - left.priority ||
    left.anchor.callsite.file.localeCompare(right.anchor.callsite.file) ||
    left.anchor.callsite.line - right.anchor.callsite.line ||
    left.anchor.callsite.calleeLeaf.localeCompare(right.anchor.callsite.calleeLeaf)
  );
}

export function deduplicateRankedAnchors(candidates: readonly RankedNextAnchor[]): RankedNextAnchor[] {
  const bestByTarget = new Map<string, RankedNextAnchor>();
  for (const candidate of candidates) {
    const target = candidate.anchor.alternatives[0];
    const key =
      target?.symbol ??
      `${candidate.anchor.callsite.file}:${candidate.anchor.callsite.line}:${candidate.anchor.callsite.calleeLeaf}`;
    const existing = bestByTarget.get(key);
    if (!existing || compareDeduplicatedTargetEvidence(candidate, existing) < 0) bestByTarget.set(key, candidate);
  }
  return [...bestByTarget.values()];
}

function compareDeduplicatedTargetEvidence(left: RankedNextAnchor, right: RankedNextAnchor): number {
  return (
    nextAnchorStatusRank(left.anchor.status) - nextAnchorStatusRank(right.anchor.status) ||
    left.anchor.alternativeCount - right.anchor.alternativeCount ||
    compareRankedNextAnchors(left, right)
  );
}

function nextAnchorStatusRank(status: SystemMapNextAnchor['status']): number {
  const rank: Record<SystemMapNextAnchor['status'], number> = {
    exact: 0,
    derived: 1,
    mixed: 2,
    candidate: 3,
    unknown: 4,
    ambiguous: 5,
  };
  return rank[status];
}

function uniqueAlternatives(alternatives: readonly SystemMapNextAnchorAlternative[]): SystemMapNextAnchorAlternative[] {
  const unique = new Map<string, SystemMapNextAnchorAlternative>();
  for (const alternative of alternatives) {
    unique.set(alternative.symbol ?? `${alternative.file}:${alternative.line}`, alternative);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line || left.label.localeCompare(right.label),
  );
}

function inspectSelector(alternative: SystemMapNextAnchorAlternative): string {
  return `--at ${shellArgument(`${alternative.file}:${alternative.line + 1}`)}`;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sourceCallsiteKey(file: string, line: number, leaf: string): string {
  return `${file}\0${line}\0${leaf}`;
}

function nextAnchorId(fromStepId: string, line: number, target: string): string {
  return ['next-anchor', fromStepId, String(line), target].map(encodeURIComponent).join(':');
}
