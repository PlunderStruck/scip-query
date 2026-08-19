import { normalizedCallableLeaf } from '../query-utils.js';
import { behaviorSignalsByLine, type BehaviorSignal } from '../../source/facts/behavior-skeleton.js';
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
import { SOURCE_INSPECTION_SAFE_CHARACTERS } from '../../domain/source-inspection-limits.js';

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

export interface NextAnchorCandidate {
  anchor: SystemMapNextAnchor;
}

export interface SourceRangeNextAnchorSeed {
  id: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
}

interface ResolvedCalleeTarget {
  row: CalleeRow;
  alternative: SystemMapNextAnchorAlternative;
}

function definitionLocationKey(file: string, line: number, endLine: number | null): string {
  return `${file}\0${line}\0${endLine ?? line}`;
}

interface NextAnchorStepContext {
  db: ScipDatabase;
  topology: ExplorationTopology;
  nodeById: ReadonlyMap<string, ExplorationTopologyNode>;
  returnedNodeIds: ReadonlySet<string>;
  sourceAllowed: (file: string) => boolean;
  alternativeAlreadyReturned: (alternative: SystemMapNextAnchorAlternative) => boolean;
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
  const returnedDefinitionLocations = new Set<string>();
  for (const step of behavior.steps) {
    for (const declaration of step.behavior?.supportingDeclarations ?? []) {
      returnedSymbols.add(declaration.symbol);
      returnedDefinitionLocations.add(definitionLocationKey(declaration.file, declaration.line, declaration.endLine));
    }
  }
  const alternativeAlreadyReturned = (alternative: SystemMapNextAnchorAlternative): boolean =>
    (alternative.symbol !== null && returnedSymbols.has(alternative.symbol)) ||
    returnedDefinitionLocations.has(definitionLocationKey(alternative.file, alternative.line, alternative.endLine));
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
  const candidates: NextAnchorCandidate[] = [];
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
    const graphRelationCandidates = collectNextAnchorGraphRelationCandidates(step, {
      db,
      topology,
      nodeById,
      returnedNodeIds,
      sourceAllowed,
      alternativeAlreadyReturned,
    });
    candidates.push(...graphRelationCandidates.candidates);
    upstreamCandidates += graphRelationCandidates.upstreamCandidates;
    runtimeCandidates += graphRelationCandidates.runtimeCandidates;
    resultCandidates += graphRelationCandidates.resultCandidates;

    const exactOccurrenceCandidates = collectNextAnchorExactOccurrenceCandidates(
      step,
      {
        db,
        topology,
        nodeById,
        returnedNodeIds,
        sourceAllowed,
        alternativeAlreadyReturned,
      },
      evidencedCallsiteKeys,
    );
    candidates.push(...exactOccurrenceCandidates);

    const callsiteCandidates = collectNextAnchorCallsiteCandidates(
      step,
      {
        db,
        topology,
        nodeById,
        returnedNodeIds,
        sourceAllowed,
        alternativeAlreadyReturned,
      },
      {
        evidencedCallsiteKeys,
        consideredCandidateKeys,
        calleeMap,
        stepDefinition: stepDefinitions.get(step.id),
      },
    );
    candidates.push(...callsiteCandidates.candidates);
    scannedBehaviorSteps += callsiteCandidates.scannedBehaviorSteps;
    visibleCallsites += callsiteCandidates.visibleCallsites;
    identityCandidateCallsites += callsiteCandidates.identityCandidateCallsites;
    ambiguousCallsites += callsiteCandidates.ambiguousCallsites;
    unresolvedCallsites += callsiteCandidates.unresolvedCallsites;
  }

  return nextAnchorPacketFromCandidates(
    db,
    candidates,
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

function collectNextAnchorGraphRelationCandidates(
  step: ConnectedBehaviorStep,
  context: NextAnchorStepContext,
): {
  candidates: NextAnchorCandidate[];
  upstreamCandidates: number;
  resultCandidates: number;
  runtimeCandidates: number;
} {
  const candidates: NextAnchorCandidate[] = [];
  let upstreamCandidates = 0;
  let resultCandidates = 0;
  let runtimeCandidates = 0;
  if (!step.location || !step.behavior) {
    return { candidates, upstreamCandidates, resultCandidates, runtimeCandidates };
  }

  const adjacentCausalEdges = context.topology.edges.filter(
    (edge) =>
      ['call', 'runtime-boundary'].includes(edge.kind) &&
      (edge.fromNodeId === step.nodeId || edge.toNodeId === step.nodeId) &&
      edge.disposition !== 'excluded' &&
      edge.disposition !== 'unsupported',
  );
  for (const edge of adjacentCausalEdges) {
    const incoming = edge.toNodeId === step.nodeId;
    const candidateNodeId = incoming ? edge.fromNodeId : edge.toNodeId;
    if (context.returnedNodeIds.has(candidateNodeId)) continue;
    const candidateNode = context.nodeById.get(candidateNodeId);
    if (!candidateNode?.location || !context.sourceAllowed(candidateNode.location.file)) continue;
    const alternative =
      edge.kind === 'call' ? callableAlternativeForNode(context.db, candidateNode) : alternativeForNode(candidateNode);
    if (!alternative) continue;
    if (context.alternativeAlreadyReturned(alternative)) continue;
    const location = evidenceLocation(edge, candidateNode.location.file) ?? candidateNode.location;
    const sourceLine = getSourceLines(context.db, location.file)[location.line]?.trim();
    const direction = incoming ? 'upstream' : 'downstream';
    const causalRole =
      edge.kind === 'runtime-boundary'
        ? incoming
          ? 'runtime-producer'
          : 'runtime-consumer'
        : incoming
          ? 'caller'
          : 'callee';
    const strength = strongestEvidence(edge.evidence);
    const leaf = nodeLeaf(candidateNode);
    candidates.push({
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
          signals: ['call'],
          calleeLeaf: leaf,
        },
        alternatives: [alternative],
        alternativeCount: 1,
        evidence: edge.evidence,
      },
    });
    if (incoming) upstreamCandidates += 1;
    if (edge.kind === 'runtime-boundary') runtimeCandidates += 1;
  }

  const callableReferences = context.topology.edges.filter(
    (edge) =>
      edge.kind === 'reference' &&
      edge.fromNodeId === step.nodeId &&
      edge.disposition !== 'excluded' &&
      edge.disposition !== 'unsupported' &&
      !context.returnedNodeIds.has(edge.toNodeId),
  );
  for (const edge of callableReferences) {
    const target = context.nodeById.get(edge.toNodeId);
    if (!target?.location || !context.sourceAllowed(target.location.file)) continue;
    const alternative = callableAlternativeForNode(context.db, target);
    if (!alternative) continue;
    if (context.alternativeAlreadyReturned(alternative)) continue;
    const leaf = nodeLeaf(target);
    const line = evidenceLocation(edge, step.location.file)?.line;
    const materialLine = step.behavior.lines.find(
      (candidate) =>
        (line === undefined || (line >= candidate.line && line <= candidate.endLine)) && candidate.text.includes(leaf),
    );
    if (!materialLine) continue;
    const causalRole = callableReferenceCausalRole(materialLine.signals);
    const strength = strongestEvidence(edge.evidence);
    candidates.push({
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
    });
    if (causalRole === 'result-callback') resultCandidates += 1;
  }

  return { candidates, upstreamCandidates, resultCandidates, runtimeCandidates };
}

function collectNextAnchorExactOccurrenceCandidates(
  step: ConnectedBehaviorStep,
  context: NextAnchorStepContext,
  evidencedCallsiteKeys: Set<string>,
): NextAnchorCandidate[] {
  const candidates: NextAnchorCandidate[] = [];
  if (!step.location) return candidates;
  const exactRangeTargets = scipOccurrenceCallTargetsForRange(
    context.db,
    step.location.file,
    step.location.line,
    step.location.endLine ?? step.location.line,
  );
  const sourceLines = getSourceLines(context.db, step.location.file);
  const signalsByLine = behaviorSignalsByLine(
    context.db,
    step.location.file,
    step.location.line,
    step.location.endLine ?? step.location.line,
  );
  for (const target of exactRangeTargets.targets) {
    if (!context.sourceAllowed(target.definition.relativePath)) continue;
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
    if (context.alternativeAlreadyReturned(alternative)) continue;
    candidates.push({
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
    });
  }
  return candidates;
}

function collectNextAnchorCallsiteCandidates(
  step: ConnectedBehaviorStep,
  context: NextAnchorStepContext,
  input: {
    evidencedCallsiteKeys: Set<string>;
    consideredCandidateKeys: Set<string>;
    calleeMap: ReadonlyMap<number, CalleeRow[]>;
    stepDefinition: ReturnType<typeof getDefinitionsForFile>[number] | undefined;
  },
): {
  candidates: NextAnchorCandidate[];
  scannedBehaviorSteps: number;
  visibleCallsites: number;
  identityCandidateCallsites: number;
  ambiguousCallsites: number;
  unresolvedCallsites: number;
} {
  const empty = {
    candidates: [] as NextAnchorCandidate[],
    scannedBehaviorSteps: 0,
    visibleCallsites: 0,
    identityCandidateCallsites: 0,
    ambiguousCallsites: 0,
    unresolvedCallsites: 0,
  };
  if (!step.location || !step.behavior) return empty;
  const callLines = step.behavior.lines.filter((line) => line.signals.includes('call'));
  if (callLines.length === 0) return empty;

  const candidates: NextAnchorCandidate[] = [];
  let identityCandidateCallsites = 0;
  let ambiguousCallsites = 0;
  let unresolvedCallsites = 0;
  const callsites = (getSourceFacts(context.db, step.location.file)?.callSites ?? []).filter((callsite) =>
    callLines.some((line) => callsite.line >= line.line && callsite.line <= line.endLine),
  );
  const outgoing = context.topology.edges.filter(
    (edge) =>
      edge.kind === 'call' &&
      edge.fromNodeId === step.nodeId &&
      edge.disposition !== 'excluded' &&
      edge.disposition !== 'unsupported',
  );
  const outgoingTargetCountByLeaf = new Map<string, number>();
  for (const edge of outgoing) {
    const target = context.nodeById.get(edge.toNodeId);
    if (!target) continue;
    const leaf = nodeLeaf(target);
    outgoingTargetCountByLeaf.set(leaf, (outgoingTargetCountByLeaf.get(leaf) ?? 0) + 1);
  }

  const resolvedTargets = resolvedCalleeTargets(
    context.db,
    input.stepDefinition ? (input.calleeMap.get(input.stepDefinition.symbolId) ?? []) : [],
  );
  const targetCountByLeaf = countResolvedTargetsByLeaf(resolvedTargets);
  for (const target of resolvedTargets) {
    if (!context.sourceAllowed(target.alternative.file) || context.alternativeAlreadyReturned(target.alternative)) {
      continue;
    }
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
    if (input.evidencedCallsiteKeys.has(callsiteKey)) continue;
    input.evidencedCallsiteKeys.add(callsiteKey);
    const strength = calleeRowEvidenceStrength(target.row.source);
    candidates.push({
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
    });
  }

  for (const edge of outgoing) {
    if (context.returnedNodeIds.has(edge.toNodeId)) continue;
    const target = context.nodeById.get(edge.toNodeId);
    if (!target?.location || !context.sourceAllowed(target.location.file)) continue;
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
    if (input.evidencedCallsiteKeys.has(callsiteKey)) continue;
    input.evidencedCallsiteKeys.add(callsiteKey);
    const alternative = alternativeForNode(target);
    if (!alternative) continue;
    if (context.alternativeAlreadyReturned(alternative)) continue;
    const strength = strongestEvidence(edge.evidence);
    candidates.push({
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
    });
  }

  for (const callsite of callsites) {
    const callsiteKey = sourceCallsiteKey(step.location.file, callsite.line, callsite.calleeLeaf);
    if (input.evidencedCallsiteKeys.has(callsiteKey)) continue;
    const materialLine = materialLineForCallsite(callLines, callsite.line, callsite.calleeLeaf);
    if (!materialLine) continue;
    const definitions = sameLanguageCandidates(
      step.location.file,
      getGlobalLeafIndex(context.db).get(callsite.calleeLeaf) ?? [],
    )
      .flatMap((candidate) =>
        getDefinitionsForFile(context.db, candidate.file).filter(
          (definition) => definition.symbol === candidate.symbol && definition.isFunctionLike,
        ),
      )
      .filter(
        (definition) =>
          context.sourceAllowed(definition.relativePath) &&
          !context.alternativeAlreadyReturned({
            symbol: definition.symbol,
            label: definition.leaf,
            file: definition.relativePath,
            line: definition.startLine,
            endLine: definition.endLine,
          }),
      );
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
    if (input.consideredCandidateKeys.has(candidateKey)) continue;
    input.consideredCandidateKeys.add(candidateKey);
    const ambiguous = alternatives.length > 1;
    if (ambiguous) ambiguousCallsites += 1;
    else identityCandidateCallsites += 1;
    candidates.push({
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
    });
  }

  return {
    candidates,
    scannedBehaviorSteps: 1,
    visibleCallsites: callsites.length,
    identityCandidateCallsites,
    ambiguousCallsites,
    unresolvedCallsites,
  };
}

/**
 * Project the already-proved result-callback classification onto its topology
 * edge so causal traversal does not have to rediscover it from rendered text.
 */
export function enrichResultCallbackControlSemantics(
  db: ScipDatabase,
  topology: ExplorationTopology,
  behavior: ConnectedBehaviorPacket,
): void {
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  for (const step of behavior.steps) {
    if (!step.behavior || !step.location) continue;
    for (const edge of topology.edges) {
      if (
        edge.kind !== 'reference' ||
        edge.fromNodeId !== step.nodeId ||
        edge.disposition === 'excluded' ||
        edge.disposition === 'unsupported'
      ) {
        continue;
      }
      const target = nodeById.get(edge.toNodeId);
      if (!target?.location || !callableAlternativeForNode(db, target)) continue;
      const leaf = nodeLeaf(target);
      const line = evidenceLocation(edge, step.location.file)?.line;
      const materialLine = step.behavior.lines.find(
        (candidate) =>
          (line === undefined || (line >= candidate.line && line <= candidate.endLine)) &&
          candidate.text.includes(leaf),
      );
      if (!materialLine || callableReferenceCausalRole(materialLine.signals) !== 'result-callback') continue;
      if (edge.semantics?.some(({ family, subtype }) => family === 'control' && subtype === 'result-callback'))
        continue;
      edge.semantics = [
        ...(edge.semantics ?? []),
        {
          family: 'control',
          subtype: 'result-callback',
          attributes: { evidenceRole: 'result-producing-callable-reference' },
        },
      ];
    }
  }
}

export function callableReferenceCausalRole(
  signals: readonly BehaviorSignal[],
): 'result-callback' | 'callable-reference' {
  return signals.includes('call') &&
    signals.some((signal) => ['return', 'mutation', 'shape', 'spread', 'binding'].includes(signal))
    ? 'result-callback'
    : 'callable-reference';
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
  const candidates: NextAnchorCandidate[] = [];
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
  const identityCandidateCallsites = 0;
  const ambiguousCallsites = 0;
  let unresolvedCallsites = 0;
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
      candidates.push({
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
      candidates.push({
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
      });
    }
    graphEvidencedCallsites += memberTargetsByCallsite.size;

    for (const callsite of callsites) {
      const key = sourceCallsiteKey(seed.file, callsite.line, callsite.calleeLeaf);
      if (exactCallsiteKeys.has(key)) continue;
      // A repository-wide same-leaf match is not call-target evidence. Keep
      // the callsite visible in unresolved accounting until SCIP/compiler or
      // source-grounded member resolution establishes its identity.
      unresolvedCallsites += 1;
    }
  }

  return nextAnchorPacketFromCandidates(db, candidates, steps, limit, {
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
  candidatesInput: readonly NextAnchorCandidate[],
  steps: readonly ConnectedBehaviorStep[],
  limit: number,
  stats: NextAnchorPacketStats,
  selectionTerms: readonly string[] = [],
): SystemMapNextAnchorPacket {
  void selectionTerms;
  void steps;
  const candidates = deduplicateNextAnchorCandidates(candidatesInput).sort(compareNeutralNextAnchors);
  const selectedCandidates = candidates.filter((candidate) => nextAnchorInspectSafe(db, candidate)).slice(0, limit);
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

function compareNeutralNextAnchors(left: NextAnchorCandidate, right: NextAnchorCandidate): number {
  const leftTarget = left.anchor.alternatives[0];
  const rightTarget = right.anchor.alternatives[0];
  return (
    nextAnchorStatusRank(left.anchor.status) - nextAnchorStatusRank(right.anchor.status) ||
    (left.anchor.direction ?? '').localeCompare(right.anchor.direction ?? '') ||
    (left.anchor.relationKind ?? '').localeCompare(right.anchor.relationKind ?? '') ||
    (left.anchor.causalRole ?? '').localeCompare(right.anchor.causalRole ?? '') ||
    left.anchor.fromStepId.localeCompare(right.anchor.fromStepId) ||
    left.anchor.callsite.file.localeCompare(right.anchor.callsite.file) ||
    left.anchor.callsite.line - right.anchor.callsite.line ||
    (leftTarget?.file ?? '').localeCompare(rightTarget?.file ?? '') ||
    (leftTarget?.line ?? 0) - (rightTarget?.line ?? 0) ||
    left.anchor.id.localeCompare(right.anchor.id)
  );
}

export function nextAnchorInspectSafe(db: ScipDatabase, candidate: NextAnchorCandidate): boolean {
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

export function deduplicateNextAnchorCandidates(candidates: readonly NextAnchorCandidate[]): NextAnchorCandidate[] {
  const bestByTarget = new Map<string, NextAnchorCandidate>();
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

function compareDeduplicatedTargetEvidence(left: NextAnchorCandidate, right: NextAnchorCandidate): number {
  return (
    nextAnchorStatusRank(left.anchor.status) - nextAnchorStatusRank(right.anchor.status) ||
    left.anchor.alternativeCount - right.anchor.alternativeCount ||
    compareNeutralNextAnchors(left, right)
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
