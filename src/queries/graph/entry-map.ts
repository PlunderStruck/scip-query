import { isExportedDefinition } from '../internal/exported-definition.js';
import { isEntrySurface, rootedSymbolEvidence, type RootedSymbolEvidence } from '../../analysis/file-classifier.js';
import { groupBy } from '../../domain/group-by.js';
import type { IndexedDefinition, SymbolResolutionCandidate } from '../../domain/types.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import type { ScipDatabase } from '../../storage/db.js';
import type { CalleeEvidenceSource, CalleeRow, CallerRow } from '../../symbols/graph/call-graph-evidence.js';
import { getCallerRowsMapForSymbols } from '../../symbols/graph/call-graph-evidence.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';

export type EntryPointEvidence =
  | 'package-public-export'
  | 'rust-public-library'
  | 'framework-dispatched-export'
  | 'configured-entry-root'
  | 'entry-surface-without-indexed-caller';
export type EntryPointConfidence = 'root' | 'candidate';

export interface EntryPointResult {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  documentation: string | null;
  confidence: EntryPointConfidence;
  evidence: EntryPointEvidence[];
  indexedCallerCount: number;
}

export interface EntryPointsOptions {
  search?: string;
  scope?: string;
}

export interface EntryMapSymbol {
  symbol: string;
  shortName: string;
  file: string;
  depth: number;
}

export interface EntryMapSymbolEdge {
  fromSymbol: string;
  fromShortName: string;
  fromFile: string;
  toSymbol: string;
  toShortName: string;
  toFile: string;
  source: CalleeEvidenceSource;
  evidenceStrength?: 'exact' | 'candidate';
}

export interface EntryMapExternalCall {
  fromSymbol: string;
  fromShortName: string;
  fromFile: string;
  toSymbol: string;
  toShortName: string;
  reportedFile: string;
  source: CalleeEvidenceSource;
  evidenceStrength?: 'exact' | 'candidate';
}

export interface EntryMapRegionEdge {
  fromRegionId: string;
  fromFile: string;
  toRegionId: string;
  toFile: string;
  callCount: number;
  exactCallCount?: number;
  candidateCallCount?: number;
  fromSymbols: string[];
  toSymbols: string[];
  evidence: CalleeEvidenceSource[];
}

export interface EntryMapRegion {
  id: string;
  file: string;
  minDepth: number;
  symbolCount: number;
  internalEdgeCount: number;
  externalCallCount: number;
  incomingRegionIds: string[];
  outgoingRegionIds: string[];
  expanded: boolean;
  symbols: EntryMapSymbol[];
  internalEdges: EntryMapSymbolEdge[];
  externalCalls: EntryMapExternalCall[];
}

export interface EntryMapCoverage {
  /** @deprecated Candidate SCIP chunk co-occurrence may also be present. */
  completeWithinIndexedStaticCallEdges: true;
  completeWithinSelectedStaticEvidence?: true;
  candidateReachabilityIncluded?: boolean;
  dynamicDispatchRepresented: false;
  symbolCount: number;
  symbolEdgeCount: number;
  exactSymbolEdgeCount?: number;
  candidateSymbolEdgeCount?: number;
  regionCount: number;
  regionEdgeCount: number;
  externalCallCount: number;
}

export type EntryCallMapResult =
  | { kind: 'missing'; query: string }
  | {
      kind: 'ambiguous';
      query: string;
      total: number;
      candidates: SymbolResolutionCandidate[];
    }
  | {
      kind: 'not-entry';
      query: string;
      symbol: string;
      shortName: string;
      file: string;
      reason: string;
    }
  | {
      kind: 'matched';
      query: string;
      entry: EntryPointResult;
      regions: EntryMapRegion[];
      regionEdges: EntryMapRegionEdge[];
      unmatchedExpansions: string[];
      coverage: EntryMapCoverage;
    };

interface ClassifiedEntryPoint {
  definition: IndexedDefinition;
  result: EntryPointResult;
}

interface ReachableGraph {
  symbols: EntryMapSymbol[];
  edges: EntryMapSymbolEdge[];
  externalCalls: EntryMapExternalCall[];
}

/** Find callables where control may enter from outside the indexed call graph. */
export function entryPoints(db: ScipDatabase, opts: EntryPointsOptions = {}): EntryPointResult[] {
  const index = new ProjectIndex(db);
  const definitions = index.productionCallableDefinitions({
    scope: opts.scope,
    requireCallableSymbol: true,
    includeSuppressed: true,
  });
  const callerRows = callerRowsForEntryCandidates(db, definitions);
  const normalizedSearch = opts.search?.trim().toLocaleLowerCase();

  return definitions
    .map((definition) => classifyEntryPoint(db, definition, callerRows.get(definition.symbolId) ?? []))
    .filter((entry): entry is ClassifiedEntryPoint => entry !== null)
    .map((entry) => entry.result)
    .filter((entry) => !normalizedSearch || entryPointSearchText(entry).includes(normalizedSearch))
    .sort(compareEntryPoints);
}

/** Build the complete indexed callee graph from one detected entry point, collapsed by file. */
export function entryCallMap(
  db: ScipDatabase,
  query: string,
  opts: { expand?: readonly string[] } = {},
): EntryCallMapResult {
  const resolution = resolveSymbol(db, query);
  if (!resolution.match) return { kind: 'missing', query };
  if (resolution.total > 1) {
    return {
      kind: 'ambiguous',
      query,
      total: resolution.total,
      candidates: [
        {
          symbol: resolution.match.symbol,
          shortName: shortenSymbol(resolution.match.symbol),
          relativePath: resolution.match.relativePath,
          startLine: resolution.match.startLine,
        },
        ...resolution.candidates,
      ],
    };
  }

  const index = new ProjectIndex(db);
  const definition = index
    .definitionsForFile(resolution.match.relativePath)
    .find((candidate) => candidate.symbol === resolution.match!.symbol);
  if (!definition?.isFunctionLike) {
    return {
      kind: 'not-entry',
      query,
      symbol: resolution.match.symbol,
      shortName: shortenSymbol(resolution.match.symbol),
      file: resolution.match.relativePath,
      reason: 'The resolved symbol is not a callable definition.',
    };
  }

  const callerRows = callerRowsForEntryCandidates(db, [definition]);
  const classified = classifyEntryPoint(db, definition, callerRows.get(definition.symbolId) ?? []);
  if (!classified) {
    return {
      kind: 'not-entry',
      query,
      symbol: definition.symbol,
      shortName: shortenSymbol(definition.symbol),
      file: definition.relativePath,
      reason: 'The callable is neither an external root nor an uncalled callable on a detected entry surface.',
    };
  }

  const graph = reachableCallGraph(db, index, definition);
  const expandedIds = new Set(opts.expand ?? []);
  const projected = projectRegions(graph, expandedIds);
  const matchedRegionIds = new Set(projected.regions.filter((region) => region.expanded).map((region) => region.id));
  const unmatchedExpansions = [...expandedIds].filter((id) => !matchedRegionIds.has(id)).sort();

  return {
    kind: 'matched',
    query,
    entry: classified.result,
    regions: projected.regions,
    regionEdges: projected.regionEdges,
    unmatchedExpansions,
    coverage: {
      completeWithinIndexedStaticCallEdges: true,
      completeWithinSelectedStaticEvidence: true,
      candidateReachabilityIncluded: graph.edges.some((edge) => edge.evidenceStrength === 'candidate'),
      dynamicDispatchRepresented: false,
      symbolCount: graph.symbols.length,
      symbolEdgeCount: graph.edges.length,
      exactSymbolEdgeCount: graph.edges.filter((edge) => edge.evidenceStrength === 'exact').length,
      candidateSymbolEdgeCount: graph.edges.filter((edge) => edge.evidenceStrength === 'candidate').length,
      regionCount: projected.regions.length,
      regionEdgeCount: projected.regionEdges.length,
      externalCallCount: graph.externalCalls.length,
    },
  };
}

function callerRowsForEntryCandidates(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
): Map<number, CallerRow[]> {
  const entryCandidates = definitions.filter(
    (definition) =>
      isDetectedEntrySurface(db, definition.relativePath) ||
      rootedSymbolEvidence(db, definition.symbol, definition.relativePath).length > 0,
  );
  return getCallerRowsMapForSymbols(db, entryCandidates, {
    semantic: false,
    semanticEvidence: symbolSemanticEvidence,
  });
}

function classifyEntryPoint(
  db: ScipDatabase,
  definition: IndexedDefinition,
  callerRows: readonly CallerRow[],
): ClassifiedEntryPoint | null {
  const rootEvidence = positiveEntryRootEvidence(db, definition);
  const rooted = rootEvidence.length > 0;
  const uncalledEntrySurface = isDetectedEntrySurface(db, definition.relativePath) && callerRows.length === 0;
  if (!rooted && !uncalledEntrySurface) return null;

  const evidence: EntryPointEvidence[] = [...rootEvidence];
  if (uncalledEntrySurface) evidence.push('entry-surface-without-indexed-caller');
  return {
    definition,
    result: {
      symbol: definition.symbol,
      shortName: shortenSymbol(definition.symbol),
      file: definition.relativePath,
      startLine: definition.startLine,
      endLine: definition.endLine,
      documentation: definition.documentation,
      confidence: rooted ? 'root' : 'candidate',
      evidence,
      indexedCallerCount: callerRows.length,
    },
  };
}

function isDetectedEntrySurface(db: ScipDatabase, file: string): boolean {
  return isEntrySurface(db, file) || /(?:^|\/)entry\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file);
}

function positiveEntryRootEvidence(db: ScipDatabase, definition: IndexedDefinition): EntryPointEvidence[] {
  const rooted = rootedSymbolEvidence(db, definition.symbol, definition.relativePath);
  const evidence: EntryPointEvidence[] = [];
  if (hasAnyEvidence(rooted, ['package-surface-file', 'transitive-package-surface'])) {
    if (isExportedDefinition(db, definition)) evidence.push('package-public-export');
  }
  if (rooted.includes('rust-public-library')) evidence.push('rust-public-library');
  if (rooted.includes('framework-entrypoint')) evidence.push('framework-dispatched-export');
  if (
    hasAnyEvidence(rooted, [
      'configured-file',
      'configured-path-prefix',
      'configured-qualified-var',
      'configured-symbol-pattern',
    ])
  ) {
    evidence.push('configured-entry-root');
  }
  return evidence;
}

function hasAnyEvidence(actual: readonly RootedSymbolEvidence[], expected: readonly RootedSymbolEvidence[]): boolean {
  return expected.some((evidence) => actual.includes(evidence));
}

function entryPointSearchText(entry: EntryPointResult): string {
  return [entry.symbol, entry.shortName, entry.file, entry.documentation ?? '', ...entry.evidence]
    .join('\n')
    .toLocaleLowerCase();
}

function compareEntryPoints(left: EntryPointResult, right: EntryPointResult): number {
  const confidence = entryPointConfidenceRank(left.confidence) - entryPointConfidenceRank(right.confidence);
  return (
    confidence ||
    left.file.localeCompare(right.file) ||
    left.startLine - right.startLine ||
    left.symbol.localeCompare(right.symbol)
  );
}

function entryPointConfidenceRank(confidence: EntryPointConfidence): number {
  return confidence === 'root' ? 0 : 1;
}

function reachableCallGraph(db: ScipDatabase, index: ProjectIndex, entry: IndexedDefinition): ReachableGraph {
  const depthBySymbol = new Map<string, number>([[entry.symbol, 0]]);
  const symbolByName = new Map<string, EntryMapSymbol>();
  const definitionByName = new Map<string, IndexedDefinition>([[entry.symbol, entry]]);
  const edgesByKey = new Map<string, EntryMapSymbolEdge>();
  const externalByKey = new Map<string, EntryMapExternalCall>();
  let frontier: IndexedDefinition[] = [entry];

  while (frontier.length > 0) {
    const calleeMap = index.calleeMap(frontier, { additive: false, semantic: false });
    const nextFrontier: IndexedDefinition[] = [];
    for (const current of frontier) {
      const currentDepth = depthBySymbol.get(current.symbol) ?? 0;
      symbolByName.set(current.symbol, entryMapSymbol(current, currentDepth));
      for (const callee of calleeMap.get(current.symbolId) ?? []) {
        const calleeDefinition = resolveIndexedDefinition(index, callee, definitionByName);
        if (!calleeDefinition) {
          const external = externalCall(current, callee);
          externalByKey.set(externalCallKey(external), external);
          continue;
        }
        const nextDepth = currentDepth + 1;
        const knownDepth = depthBySymbol.get(calleeDefinition.symbol);
        if (knownDepth === undefined || nextDepth < knownDepth) depthBySymbol.set(calleeDefinition.symbol, nextDepth);
        symbolByName.set(
          calleeDefinition.symbol,
          entryMapSymbol(calleeDefinition, Math.min(nextDepth, knownDepth ?? nextDepth)),
        );
        const edge = symbolEdge(current, calleeDefinition, callee);
        edgesByKey.set(symbolEdgeKey(edge), edge);
        if (knownDepth === undefined) nextFrontier.push(calleeDefinition);
      }
    }
    frontier = nextFrontier;
  }

  return {
    symbols: [...symbolByName.values()].sort(compareMapSymbols),
    edges: [...edgesByKey.values()].sort(compareSymbolEdges),
    externalCalls: [...externalByKey.values()].sort(compareExternalCalls),
  };
}

function resolveIndexedDefinition(
  index: ProjectIndex,
  callee: CalleeRow,
  cache: Map<string, IndexedDefinition>,
): IndexedDefinition | null {
  const cached = cache.get(callee.symbol);
  if (cached) return cached;
  const definition =
    index.definitionsForFile(callee.file).find((candidate) => candidate.symbol === callee.symbol) ?? null;
  if (definition) cache.set(definition.symbol, definition);
  return definition;
}

function entryMapSymbol(definition: IndexedDefinition, depth: number): EntryMapSymbol {
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    file: definition.relativePath,
    depth,
  };
}

function symbolEdge(from: IndexedDefinition, to: IndexedDefinition, evidence: CalleeRow): EntryMapSymbolEdge {
  return {
    fromSymbol: from.symbol,
    fromShortName: shortenSymbol(from.symbol),
    fromFile: from.relativePath,
    toSymbol: to.symbol,
    toShortName: shortenSymbol(to.symbol),
    toFile: to.relativePath,
    source: evidence.source,
    evidenceStrength: evidence.source === 'scip-chunk' ? 'candidate' : 'exact',
  };
}

function externalCall(from: IndexedDefinition, callee: CalleeRow): EntryMapExternalCall {
  return {
    fromSymbol: from.symbol,
    fromShortName: shortenSymbol(from.symbol),
    fromFile: from.relativePath,
    toSymbol: callee.symbol,
    toShortName: shortenSymbol(callee.symbol),
    reportedFile: callee.file,
    source: callee.source,
    evidenceStrength: callee.source === 'scip-chunk' ? 'candidate' : 'exact',
  };
}

function projectRegions(
  graph: ReachableGraph,
  expandedIds: ReadonlySet<string>,
): { regions: EntryMapRegion[]; regionEdges: EntryMapRegionEdge[] } {
  const symbolsByFile = groupBy(graph.symbols, (symbol) => symbol.file);
  const internalEdgesByFile = groupBy(
    graph.edges.filter((edge) => edge.fromFile === edge.toFile),
    (edge) => edge.fromFile,
  );
  const externalCallsByFile = groupBy(graph.externalCalls, (call) => call.fromFile);
  const regionEdges = collapseRegionEdges(graph.edges.filter((edge) => edge.fromFile !== edge.toFile));
  const incomingByRegion = groupBy(regionEdges, (edge) => edge.toRegionId);
  const outgoingByRegion = groupBy(regionEdges, (edge) => edge.fromRegionId);

  const regions = [...symbolsByFile.entries()]
    .map(([file, symbols]): EntryMapRegion => {
      const id = regionId(file);
      const expanded = expandedIds.has(id);
      const internalEdges = internalEdgesByFile.get(file) ?? [];
      const externalCalls = externalCallsByFile.get(file) ?? [];
      return {
        id,
        file,
        minDepth: Math.min(...symbols.map((symbol) => symbol.depth)),
        symbolCount: symbols.length,
        internalEdgeCount: internalEdges.length,
        externalCallCount: externalCalls.length,
        incomingRegionIds: uniqueSorted((incomingByRegion.get(id) ?? []).map((edge) => edge.fromRegionId)),
        outgoingRegionIds: uniqueSorted((outgoingByRegion.get(id) ?? []).map((edge) => edge.toRegionId)),
        expanded,
        symbols: expanded ? symbols : [],
        internalEdges: expanded ? internalEdges : [],
        externalCalls: expanded ? externalCalls : [],
      };
    })
    .sort((left, right) => left.minDepth - right.minDepth || left.file.localeCompare(right.file));

  return { regions, regionEdges };
}

function collapseRegionEdges(edges: readonly EntryMapSymbolEdge[]): EntryMapRegionEdge[] {
  const buckets = new Map<string, EntryMapSymbolEdge[]>();
  for (const edge of edges) {
    const key = `${edge.fromFile}\u0000${edge.toFile}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(edge);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((bucket): EntryMapRegionEdge => {
      const first = bucket[0]!;
      return {
        fromRegionId: regionId(first.fromFile),
        fromFile: first.fromFile,
        toRegionId: regionId(first.toFile),
        toFile: first.toFile,
        callCount: bucket.length,
        exactCallCount: bucket.filter((edge) => edge.evidenceStrength === 'exact').length,
        candidateCallCount: bucket.filter((edge) => edge.evidenceStrength === 'candidate').length,
        fromSymbols: uniqueSorted(bucket.map((edge) => edge.fromShortName)),
        toSymbols: uniqueSorted(bucket.map((edge) => edge.toShortName)),
        evidence: uniqueSorted(bucket.map((edge) => edge.source)),
      };
    })
    .sort((left, right) => left.fromFile.localeCompare(right.fromFile) || left.toFile.localeCompare(right.toFile));
}

function regionId(file: string): string {
  return `file:${file}`;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function symbolEdgeKey(edge: EntryMapSymbolEdge): string {
  return `${edge.fromSymbol}\u0000${edge.toSymbol}`;
}

function externalCallKey(call: EntryMapExternalCall): string {
  return `${call.fromSymbol}\u0000${call.toSymbol}`;
}

function compareMapSymbols(left: EntryMapSymbol, right: EntryMapSymbol): number {
  return left.depth - right.depth || left.file.localeCompare(right.file) || left.symbol.localeCompare(right.symbol);
}

function compareSymbolEdges(left: EntryMapSymbolEdge, right: EntryMapSymbolEdge): number {
  return (
    left.fromFile.localeCompare(right.fromFile) ||
    left.fromSymbol.localeCompare(right.fromSymbol) ||
    left.toSymbol.localeCompare(right.toSymbol)
  );
}

function compareExternalCalls(left: EntryMapExternalCall, right: EntryMapExternalCall): number {
  return (
    left.fromFile.localeCompare(right.fromFile) ||
    left.fromSymbol.localeCompare(right.fromSymbol) ||
    left.toSymbol.localeCompare(right.toSymbol)
  );
}
