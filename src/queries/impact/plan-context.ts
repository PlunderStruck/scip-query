import type { ScipDatabase } from '../../storage/db.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { gitEvidenceProduct } from '../../analysis/git-history.js';
import type { CoChangeSubjectContext } from '../../analysis/git-history.js';
import { getSuppressionInventory } from '../../analysis/suppressions.js';
import { affected, type AffectedResult } from '../graph/affected.js';
import { callGraph, type CallGraphResult } from '../navigation/call-graph.js';
import { changeSurface, type ChangeSurfaceResult } from './change-surface.js';
import { coChange } from '../cleanup/co-change.js';
import { similar, type SimilarSymbolResult } from '../cleanup/similar.js';
import { complexity, type ComplexityResult } from '../quality/complexity.js';
import { dataflow, type DataflowResult } from '../navigation/dataflow.js';
import { deps, rdeps, type DepResult } from '../navigation/deps.js';
import { slice, type SliceResult } from '../navigation/slice.js';
import { surface, type SurfaceResult } from '../navigation/surface.js';
import { system, type SystemResult } from '../navigation/system.js';
import { trace, type TraceResult } from '../navigation/trace.js';
import { definitionSourceSnippet } from '../cleanup/duplicate-bodies.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { resolveIndexedPaths } from '../internal/file-resolution.js';
import { findExactSymbolMatch, findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { leafName } from '../../symbols/symbol-parser.js';
import type { IndexedDefinition } from '../../domain/types.js';

export interface PlanContextOptions {
  semantic?: boolean;
  impactDepth?: number;
  sliceDepth?: number;
  scope?: string;
  /** Already-resolved invocation HEAD for snapshot-consistent history evidence. */
  gitHead?: string;
}

/** Decision-time history risk for the target's file, from the change graph. */
export interface PlanContextHistory {
  /** False when git history is unavailable or no file could be resolved. */
  available: boolean;
  file: string | null;
  churn: { changes: number; fixChanges: number; lastChangedAt: number } | null;
  /** Files that usually change together with this one — edit checklist. */
  coChangePartners: Array<{
    file: string;
    together: number;
    confidence: number;
    subjectContext: CoChangeSubjectContext;
  }>;
  /** Detector suppressions present in the file — known accepted findings. */
  suppressionsInFile: number;
}

export interface PlanContextAffectedConsumer {
  symbol: string;
  shortName: string;
  file: string;
  referenceCount: number;
}

export interface PlanContextConsumerReuseCandidate {
  /** Similarity evidence between one affected consumer and this possible existing owner. */
  candidate: SimilarSymbolResult;
  /** Affected consumers whose bounded similarity scan produced this same possible owner. */
  consumers: PlanContextAffectedConsumer[];
}

export interface PlanContextConsumerReuseCoverage {
  totalConsumers: number;
  analyzedConsumers: number;
  omittedConsumers: number;
  perConsumerSearchLimit: number;
  perConsumerCandidateLimit: number;
  candidateLimit: number;
  returnedCandidates: number;
}

export interface PlanContextConsumerReuse {
  candidates: PlanContextConsumerReuseCandidate[];
  coverage: PlanContextConsumerReuseCoverage;
}

export interface PlanContextPrimaryCallable {
  symbol: string;
  shortName: string;
  file: string;
}

export interface PlanContextSourceSlice extends PlanContextPrimaryCallable {
  role: 'target' | 'consumer' | 'reuse-candidate';
  startLine: number;
  endLine: number;
  source: string;
  omittedLines: number;
}

export interface PlanContextSourcePacket {
  slices: PlanContextSourceSlice[];
  candidateSlices: number;
  omittedSlices: number;
  maxSlices: number;
  maxLinesPerSlice: number;
  maxTotalLines: number;
}

export interface PlanContextResult {
  target: string;
  /** One callable selected from a file target only when the choice is unambiguous. */
  primaryCallable?: PlanContextPrimaryCallable;
  matched: {
    symbol: boolean;
    file: boolean;
    module: boolean;
  };
  history: PlanContextHistory;
  trace: TraceResult;
  callGraph: CallGraphResult | null;
  complexity: ComplexityResult | null;
  dataflow: DataflowResult | null;
  backwardSlice: SliceResult | null;
  forwardSlice: SliceResult | null;
  affected: AffectedResult[];
  changeSurface: ChangeSurfaceResult | null;
  deps: DepResult[];
  rdeps: DepResult[];
  system: SystemResult;
  surface: SurfaceResult[];
  /** Bounded existing symbols whose implementation evidence may support reuse. */
  reuseCandidates?: SimilarSymbolResult[];
  /**
   * Bounded possible owners found by comparing functions that directly use
   * the target. Kept separate because this is surrounding-behavior evidence,
   * not evidence that the owner can replace the target itself.
   */
  affectedConsumerReuse?: PlanContextConsumerReuse;
  /** Bounded source slices for the target, its direct consumers, and possible owners. */
  sourcePacket?: PlanContextSourcePacket;
  warnings: string[];
}

const AFFECTED_CONSUMER_LIMIT = 6;
const PER_CONSUMER_SEARCH_LIMIT = 10;
const PER_CONSUMER_REUSE_LIMIT = 3;
const AFFECTED_CONSUMER_REUSE_LIMIT = 8;
const MIN_SINGLE_CONSUMER_SIGNAL_SIMILARITY = 0.7;
const SOURCE_PACKET_SLICE_LIMIT = 8;
const SOURCE_PACKET_LINES_PER_SLICE = 40;
const SOURCE_PACKET_TOTAL_LINE_LIMIT = 200;

// scip-query: ignore-extract — reviewed E1 workflow owner; target resolution, evidence gathering, and plan rendering stay together.
export function planContext(db: ScipDatabase, target: string, opts: PlanContextOptions = {}): PlanContextResult {
  const impactDepth = opts.impactDepth ?? 3;
  const sliceDepth = opts.sliceDepth ?? 3;
  const semantic = opts.semantic;
  const pathResolution = looksLikePathTarget(target) ? resolvePlanContextPrimaryCallable(db, target) : null;
  const graphTarget = pathResolution ? (pathResolution.primary?.symbol ?? null) : target;
  const symbolTarget = graphTarget !== null;

  const traceResult = symbolTarget
    ? profilePlanContextComponent(
        'trace',
        graphTarget,
        () => trace(db, graphTarget, { semantic }),
        (result) => ({
          definitions: result.definitions.length,
          references: result.referencedBy.length,
        }),
      )
    : { definitions: [], referencedBy: [] };
  const callGraphResult = symbolTarget
    ? profilePlanContextComponent(
        'call-graph',
        graphTarget,
        () => callGraph(db, graphTarget, { semantic }),
        (result) => ({
          callers: result?.callers.length ?? 0,
          callees: result?.callees.length ?? 0,
        }),
      )
    : null;
  const complexityResult = symbolTarget
    ? profilePlanContextComponent(
        'complexity',
        graphTarget,
        () => complexity(db, graphTarget, { semantic }),
        (result) => ({
          callees: result?.calleeCount ?? 0,
        }),
      )
    : null;
  const dataflowResult = symbolTarget
    ? profilePlanContextComponent(
        'dataflow',
        graphTarget,
        () => dataflow(db, graphTarget, { semantic }),
        (result) => ({
          references: result?.usageSites.length ?? 0,
          producers: result?.producers.length ?? 0,
          consumers: result?.consumers.length ?? 0,
        }),
      )
    : null;
  const backwardSliceResult = symbolTarget
    ? profilePlanContextComponent(
        'backward-slice',
        graphTarget,
        () =>
          slice(db, graphTarget, {
            direction: 'backward',
            maxDepth: sliceDepth,
            semantic,
          }),
        (result) => ({ maxDepth: sliceDepth, connectedSymbols: result?.connectedSymbols.length ?? 0 }),
      )
    : null;
  const forwardSliceResult = symbolTarget
    ? profilePlanContextComponent(
        'forward-slice',
        graphTarget,
        () =>
          slice(db, graphTarget, {
            direction: 'forward',
            maxDepth: sliceDepth,
            semantic,
          }),
        (result) => ({ maxDepth: sliceDepth, connectedSymbols: result?.connectedSymbols.length ?? 0 }),
      )
    : null;
  const affectedResults = symbolTarget
    ? profilePlanContextComponent(
        'affected',
        graphTarget,
        () =>
          affected(db, graphTarget, {
            maxDepth: impactDepth,
            scope: opts.scope,
          }),
        (result) => ({ maxDepth: impactDepth, affectedSymbols: result.length }),
      )
    : [];
  const reuseCandidates = symbolTarget
    ? profilePlanContextComponent(
        'reuse-candidates',
        graphTarget,
        () =>
          similar(db, graphTarget, {
            minSimilarity: 0.4,
            limit: 5,
            semantic,
            sourceCandidateMode: 'target-pruned',
          }),
        (result) => ({
          candidates: result.length,
          direct: result.filter((item) => item.actionTier === 'direct').length,
        }),
      )
    : [];
  const targetSymbol = symbolTarget ? (findFirstSymbolMatch(db, graphTarget)?.symbol ?? null) : null;
  const affectedConsumerReuse = symbolTarget
    ? profilePlanContextComponent(
        'affected-consumer-reuse',
        graphTarget,
        () =>
          discoverAffectedConsumerReuse(
            traceResult,
            targetSymbol,
            (consumerSymbol) =>
              similar(db, consumerSymbol, {
                minSimilarity: 0.4,
                limit: PER_CONSUMER_SEARCH_LIMIT,
                semantic,
                sourceCandidateMode: 'target-pruned',
              }),
            {
              consumerLimit: AFFECTED_CONSUMER_LIMIT,
              perConsumerSearchLimit: PER_CONSUMER_SEARCH_LIMIT,
              perConsumerCandidateLimit: PER_CONSUMER_REUSE_LIMIT,
              candidateLimit: AFFECTED_CONSUMER_REUSE_LIMIT,
            },
          ),
        (result) => ({
          totalConsumers: result.coverage.totalConsumers,
          analyzedConsumers: result.coverage.analyzedConsumers,
          candidates: result.candidates.length,
        }),
      )
    : emptyAffectedConsumerReuse();

  const changeSurfaceResult = profilePlanContextComponent(
    'change-surface',
    target,
    () => changeSurface(db, target, { semantic }),
    (result) => ({ symbols: result?.symbols.length ?? 0, externalConsumers: result?.totalExternalConsumers ?? 0 }),
  );
  const systemResult = profilePlanContextComponent(
    'system',
    target,
    () => system(db, target),
    (result) => ({
      files: result.files.length,
      symbols: result.symbols.length,
    }),
  );
  const reuseSystemEdges = systemResult.files.length === 1;
  const depsResults = profilePlanContextComponent(
    'deps',
    target,
    () => (reuseSystemEdges ? systemResult.dependsOn.map((relativePath) => ({ relativePath })) : deps(db, target)),
    (result) => ({
      files: result.length,
      reusedSystem: reuseSystemEdges,
    }),
  );
  const rdepsResults = profilePlanContextComponent(
    'rdeps',
    target,
    () => (reuseSystemEdges ? systemResult.dependedOnBy.map((relativePath) => ({ relativePath })) : rdeps(db, target)),
    (result) => ({
      files: result.length,
      reusedSystem: reuseSystemEdges,
    }),
  );
  const surfaceResults = profilePlanContextComponent(
    'surface',
    target,
    () => surface(db, target),
    (result) => ({
      consumers: result.length,
    }),
  );

  const matched = {
    symbol:
      traceResult.definitions.length > 0 ||
      traceResult.referencedBy.length > 0 ||
      callGraphResult !== null ||
      complexityResult !== null ||
      dataflowResult !== null ||
      backwardSliceResult !== null ||
      forwardSliceResult !== null ||
      affectedResults.length > 0,
    file: changeSurfaceResult !== null || depsResults.length > 0 || rdepsResults.length > 0,
    module: systemResult.files.length > 0 || systemResult.symbols.length > 0 || surfaceResults.length > 0,
  };

  const warnings: string[] = [];
  if (pathResolution && !pathResolution.primary && pathResolution.callableCount > 1) {
    warnings.push(
      `File target has ${pathResolution.callableCount} callable symbols; use one callable name for compiler-resolved flow.`,
    );
  }
  if (!matched.symbol && !matched.file && !matched.module) {
    warnings.push('No symbol, file, or module matched target.');
  }

  const historyFile = changeSurfaceResult?.file ?? traceResult.definitions[0]?.relativePath ?? null;

  return {
    target,
    ...(pathResolution?.primary
      ? {
          primaryCallable: {
            symbol: pathResolution.primary.symbol,
            shortName: leafName(pathResolution.primary.symbol),
            file: pathResolution.primary.relativePath,
          },
        }
      : {}),
    matched,
    history: profilePlanContextComponent('history', historyFile ?? target, () =>
      buildPlanContextHistory(db, historyFile, opts.gitHead),
    ),
    trace: traceResult,
    callGraph: callGraphResult,
    complexity: complexityResult,
    dataflow: dataflowResult,
    backwardSlice: backwardSliceResult,
    forwardSlice: forwardSliceResult,
    affected: affectedResults,
    changeSurface: changeSurfaceResult,
    deps: depsResults,
    rdeps: rdepsResults,
    system: systemResult,
    surface: surfaceResults,
    reuseCandidates,
    affectedConsumerReuse,
    sourcePacket: buildPlanContextSourcePacket(db, targetSymbol, traceResult, affectedConsumerReuse, reuseCandidates),
    warnings,
  };
}

interface PrimaryCallableResolution {
  primary: ReturnType<typeof getDefinitionsForFile>[number] | null;
  callableCount: number;
}

function resolvePlanContextPrimaryCallable(db: ScipDatabase, target: string): PrimaryCallableResolution {
  const files = resolveIndexedPaths(db, target);
  if (files.length !== 1) return { primary: null, callableCount: 0 };
  const callables = getDefinitionsForFile(db, files[0]!).filter((definition) => definition.isFunctionLike);
  const topLevel = callables.filter((definition) => definition.enclosingSymbol === null);
  const candidates = topLevel.length > 0 ? topLevel : callables;
  return {
    primary: candidates.length === 1 ? candidates[0]! : null,
    callableCount: candidates.length,
  };
}

function buildPlanContextSourcePacket(
  db: ScipDatabase,
  targetSymbol: string | null,
  traceResult: TraceResult,
  consumerReuse: PlanContextConsumerReuse,
  targetReuse: readonly SimilarSymbolResult[],
): PlanContextSourcePacket {
  const candidates: Array<{
    definition: IndexedDefinition | null;
    role: PlanContextSourceSlice['role'];
  }> = [
    ...(targetSymbol ? [{ definition: resolveIndexedDefinition(db, targetSymbol), role: 'target' as const }] : []),
    ...affectedConsumers(traceResult).map((consumer) => ({
      definition: resolveIndexedDefinition(db, consumer.symbol),
      role: 'consumer' as const,
    })),
    ...[...consumerReuse.candidates.map((item) => item.candidate), ...targetReuse].map((candidate) => ({
      definition: resolveIndexedDefinition(db, candidate.symbolB),
      role: 'reuse-candidate' as const,
    })),
  ];
  const unique = new Map<string, { definition: IndexedDefinition; role: PlanContextSourceSlice['role'] }>();
  for (const candidate of candidates) {
    if (!candidate.definition || unique.has(candidate.definition.symbol)) continue;
    unique.set(candidate.definition.symbol, { definition: candidate.definition, role: candidate.role });
  }

  const slices: PlanContextSourceSlice[] = [];
  let remainingLines = SOURCE_PACKET_TOTAL_LINE_LIMIT;
  for (const candidate of unique.values()) {
    if (slices.length >= SOURCE_PACKET_SLICE_LIMIT || remainingLines <= 0) break;
    const source = definitionSourceSnippet(db, candidate.definition);
    if (!source) continue;
    const lines = source.split('\n');
    const kept = Math.min(lines.length, SOURCE_PACKET_LINES_PER_SLICE, remainingLines);
    slices.push({
      role: candidate.role,
      symbol: candidate.definition.symbol,
      shortName: leafName(candidate.definition.symbol),
      file: candidate.definition.relativePath,
      startLine: candidate.definition.startLine,
      endLine: candidate.definition.startLine + kept - 1,
      source: lines.slice(0, kept).join('\n'),
      omittedLines: Math.max(0, lines.length - kept),
    });
    remainingLines -= kept;
  }
  return {
    slices,
    candidateSlices: unique.size,
    omittedSlices: Math.max(0, unique.size - slices.length),
    maxSlices: SOURCE_PACKET_SLICE_LIMIT,
    maxLinesPerSlice: SOURCE_PACKET_LINES_PER_SLICE,
    maxTotalLines: SOURCE_PACKET_TOTAL_LINE_LIMIT,
  };
}

function resolveIndexedDefinition(db: ScipDatabase, symbol: string): IndexedDefinition | null {
  const match = findExactSymbolMatch(db, symbol);
  if (!match) return null;
  return getDefinitionsForFile(db, match.relativePath).find((definition) => definition.symbol === symbol) ?? null;
}

interface AffectedConsumerReuseLimits {
  consumerLimit?: number;
  perConsumerSearchLimit?: number;
  perConsumerCandidateLimit?: number;
  candidateLimit?: number;
}

/**
 * Turn compiler-resolved target references into a bounded search for existing
 * owners of the surrounding consumer behavior. Exported for a pure contract
 * test; production supplies `similar` as the evidence source.
 */
export function discoverAffectedConsumerReuse(
  traceResult: Pick<TraceResult, 'referencedBy'>,
  targetSymbol: string | null,
  findSimilar: (consumerSymbol: string) => SimilarSymbolResult[],
  limits: AffectedConsumerReuseLimits = {},
): PlanContextConsumerReuse {
  const consumerLimit = normalizedPositiveLimit(limits.consumerLimit, AFFECTED_CONSUMER_LIMIT);
  const perConsumerSearchLimit = normalizedPositiveLimit(limits.perConsumerSearchLimit, PER_CONSUMER_SEARCH_LIMIT);
  const perConsumerCandidateLimit = normalizedPositiveLimit(limits.perConsumerCandidateLimit, PER_CONSUMER_REUSE_LIMIT);
  const candidateLimit = normalizedPositiveLimit(limits.candidateLimit, AFFECTED_CONSUMER_REUSE_LIMIT);
  const consumers = affectedConsumers(traceResult);
  const analyzedConsumers = consumers.slice(0, consumerLimit);
  const excludedSymbols = new Set(consumers.map((consumer) => consumer.symbol));
  if (targetSymbol) excludedSymbols.add(targetSymbol);

  const byCandidateSymbol = new Map<string, PlanContextConsumerReuseCandidate>();
  for (const consumer of analyzedConsumers) {
    const rows = findSimilar(consumer.symbol).slice(0, perConsumerSearchLimit);
    let acceptedForConsumer = 0;
    for (const rawCandidate of rows) {
      const candidate = normalizeConsumerSimilarity(rawCandidate, consumer.symbol);
      if (!candidate || excludedSymbols.has(candidate.symbolB)) continue;

      const current = byCandidateSymbol.get(candidate.symbolB);
      if (!current) {
        byCandidateSymbol.set(candidate.symbolB, { candidate, consumers: [consumer] });
      } else {
        if (!current.consumers.some((item) => item.symbol === consumer.symbol)) {
          current.consumers.push(consumer);
        }
        if (candidate.similarity > current.candidate.similarity) current.candidate = candidate;
      }
      acceptedForConsumer += 1;
      if (acceptedForConsumer >= perConsumerCandidateLimit) break;
    }
  }

  const candidates = [...byCandidateSymbol.values()]
    .filter(
      (candidate) =>
        candidate.candidate.actionTier === 'direct' ||
        candidate.candidate.similarity >= MIN_SINGLE_CONSUMER_SIGNAL_SIMILARITY ||
        candidate.consumers.length > 1,
    )
    .sort(compareConsumerReuseCandidates)
    .slice(0, candidateLimit);
  return {
    candidates,
    coverage: {
      totalConsumers: consumers.length,
      analyzedConsumers: analyzedConsumers.length,
      omittedConsumers: Math.max(0, consumers.length - analyzedConsumers.length),
      perConsumerSearchLimit,
      perConsumerCandidateLimit,
      candidateLimit,
      returnedCandidates: candidates.length,
    },
  };
}

function affectedConsumers(traceResult: Pick<TraceResult, 'referencedBy'>): PlanContextAffectedConsumer[] {
  const bySymbol = new Map<string, PlanContextAffectedConsumer>();
  for (const reference of traceResult.referencedBy) {
    if (!reference.enclosingSymbol) continue;
    const current = bySymbol.get(reference.enclosingSymbol);
    if (current) {
      current.referenceCount += 1;
      continue;
    }
    bySymbol.set(reference.enclosingSymbol, {
      symbol: reference.enclosingSymbol,
      shortName: leafName(reference.enclosingSymbol) || reference.enclosingShort,
      file: reference.relativePath,
      referenceCount: 1,
    });
  }
  return [...bySymbol.values()].sort(
    (left, right) => right.referenceCount - left.referenceCount || left.symbol.localeCompare(right.symbol),
  );
}

function normalizeConsumerSimilarity(
  candidate: SimilarSymbolResult,
  consumerSymbol: string,
): SimilarSymbolResult | null {
  if (candidate.symbolA === consumerSymbol) return candidate;
  if (candidate.symbolB !== consumerSymbol) return null;
  return {
    ...candidate,
    symbolA: candidate.symbolB,
    shortNameA: candidate.shortNameB,
    fileA: candidate.fileB,
    symbolB: candidate.symbolA,
    shortNameB: candidate.shortNameA,
    fileB: candidate.fileA,
    uniqueToA: candidate.uniqueToB,
    uniqueToB: candidate.uniqueToA,
  };
}

function compareConsumerReuseCandidates(
  left: PlanContextConsumerReuseCandidate,
  right: PlanContextConsumerReuseCandidate,
): number {
  const tierDifference = actionTierRank(right.candidate.actionTier) - actionTierRank(left.candidate.actionTier);
  if (tierDifference !== 0) return tierDifference;
  const supportDifference = right.consumers.length - left.consumers.length;
  if (supportDifference !== 0) return supportDifference;
  const similarityDifference = right.candidate.similarity - left.candidate.similarity;
  return similarityDifference !== 0
    ? similarityDifference
    : left.candidate.symbolB.localeCompare(right.candidate.symbolB);
}

function actionTierRank(tier: SimilarSymbolResult['actionTier']): number {
  return tier === 'direct' ? 1 : 0;
}

function normalizedPositiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function emptyAffectedConsumerReuse(): PlanContextConsumerReuse {
  return {
    candidates: [],
    coverage: {
      totalConsumers: 0,
      analyzedConsumers: 0,
      omittedConsumers: 0,
      perConsumerSearchLimit: PER_CONSUMER_SEARCH_LIMIT,
      perConsumerCandidateLimit: PER_CONSUMER_REUSE_LIMIT,
      candidateLimit: AFFECTED_CONSUMER_REUSE_LIMIT,
      returnedCandidates: 0,
    },
  };
}

function profilePlanContextComponent<T>(
  component: string,
  target: string,
  run: () => T,
  cardinality: (result: T) => Record<string, unknown> = () => ({}),
): T {
  let result: T;
  return profileSpan(
    `plan-context.${component}`,
    () => {
      result = run();
      return result;
    },
    () => ({ target, ...cardinality(result!) }),
  );
}

function buildPlanContextHistory(db: ScipDatabase, file: string | null, gitHead?: string): PlanContextHistory {
  const unavailable: PlanContextHistory = {
    available: false,
    file,
    churn: null,
    coChangePartners: [],
    suppressionsInFile: 0,
  };
  if (!file) return unavailable;
  const git = gitEvidenceProduct(db, gitHead ? { head: gitHead } : {});
  const churn = profilePlanContextComponent(
    'history.churn',
    file,
    () => git.fileChurn(),
    (result) => ({
      files: result?.size ?? 0,
    }),
  );
  if (!churn) return unavailable;

  const partners = profilePlanContextComponent(
    'history.co-change',
    file,
    () => coChange(db, file, { limit: 5, ...(gitHead ? { head: gitHead } : {}) }),
    (result) => ({
      commits: result.commitsAnalyzed,
      partners: result.findings.length,
    }),
  );
  const suppressionsInFile = profilePlanContextComponent(
    'history.suppressions',
    file,
    () => getSuppressionInventory(db).byFile.get(file) ?? 0,
    (result) => ({ suppressions: result }),
  );
  return {
    available: true,
    file,
    churn: churn.get(file) ?? { changes: 0, fixChanges: 0, lastChangedAt: 0 },
    coChangePartners: partners.findings.map((finding) => ({
      file: finding.fileA === file ? finding.fileB : finding.fileA,
      together: finding.together,
      confidence: finding.confidence,
      subjectContext: finding.subjectContext,
    })),
    suppressionsInFile,
  };
}

function looksLikePathTarget(target: string): boolean {
  return target.includes('/') || target.includes('\\') || /\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/.test(target);
}
