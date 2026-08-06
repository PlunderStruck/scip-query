import { classifyFile, type FileKind } from '../../analysis/file-classifier.js';
import { readRuntimeBoundaryGraph } from '../../analysis/runtime-boundaries/index.js';
import type { BoundaryObservation } from '../../analysis/runtime-boundaries/types.js';
import { runtimeBoundarySourceScope } from '../../analysis/runtime-boundaries/source-scope.js';
import type { BoundarySourceScope } from '../../analysis/runtime-boundaries/types.js';
import type { IndexedDefinition, SymbolMatch, SymbolResolutionCandidate } from '../../domain/types.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { findEnclosingDefinition } from '../../symbols/definition-catalog.js';
import type { CalleeEvidenceSource } from '../../symbols/graph/call-graph-evidence.js';
import { importedMemberCallTargets } from '../../symbols/graph/member-call-targets.js';
import { findIdentifierLines } from '../../symbols/identifier-index.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { isModuleLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../internal/inspection-limits.js';
import {
  createExplorationTopology,
  type ExplorationEvidenceSource,
  type ExplorationEvidenceStrength,
  type ExplorationFrontierGroup,
  type ExplorationTopology,
  type ExplorationTopologyAnchor,
  type ExplorationTopologyEdge,
  type ExplorationTopologyNode,
} from '../internal/exploration-topology.js';

const DEFAULT_MAX_DEPTH = 3;
const NOTABLE_SYMBOL_LIMIT = 12;
const DEFAULT_EXPANSION_REGION_LIMIT = 12;
const DEFAULT_DRILLDOWN_ANCHOR_LIMIT = 12;
const DEFAULT_TOPOLOGY_CHARACTERS = 20_000;
const ALL_RELATION_KINDS: readonly SystemMapRelationKind[] = [
  'call',
  'contract-symbol',
  'import',
  'reference',
  'runtime-boundary',
];

export type SystemMapAnchorKind = 'literal' | 'symbol';
export type SystemMapAnchorStatus = 'matched' | 'ambiguous' | 'missing';
export type SystemMapRelationKind = 'call' | 'contract-symbol' | 'import' | 'reference' | 'runtime-boundary';
export type SystemMapEvidenceFloor = 'exact' | 'derived';
export type SystemMapSourceScope = BoundarySourceScope;
export type SystemMapReferenceScope = 'none' | 'all' | 'forward-regions' | 'cross-workspace-or-forward';
export type SystemMapRelationEvidence =
  | CalleeEvidenceSource
  | 'ast-member-import-candidate'
  | 'compiler-cross-workspace-symbol'
  | 'indexed-or-source-reference'
  | 'indexed-or-source-import'
  | `runtime-boundary:${string}`;
export type SystemMapRelationStrength = ExplorationEvidenceStrength;

export interface SystemMapOptions {
  searches?: readonly string[];
  symbols?: readonly string[];
  maxDepth?: number;
  expand?: readonly string[];
  relations?: readonly SystemMapRelationKind[];
  evidenceFloor?: SystemMapEvidenceFloor;
  sourceScopes?: readonly SystemMapSourceScope[];
  maxTopologyCharacters?: number;
}

export interface SystemMapAnchorCandidate extends SymbolResolutionCandidate {
  endLine: number;
}

export interface SystemMapAnchor {
  kind: SystemMapAnchorKind;
  query: string;
  status: SystemMapAnchorStatus;
  matchedRegionIds: string[];
  matchingLines?: number;
  /** Production source matches used to seed graph traversal. */
  seedMatchingLines?: number;
  /** Embedded-substring and test-only matches retained without seeding traversal. */
  matchOnlyLines?: number;
  seedRegionIds?: string[];
  matchOnlyRegionIds?: string[];
  symbolCandidates?: SystemMapAnchorCandidate[];
  totalSymbolCandidates?: number;
  omittedSymbolCandidates?: number;
}

export interface SystemMapLiteralHit {
  query: string;
  file: string;
  line: number;
  ownerSymbol: string | null;
  ownerShortName: string | null;
  sourceLine: string;
  matchKind?: 'exact-value' | 'boundary' | 'embedded';
  traversalSeed?: boolean;
}

export interface SystemMapFile {
  file: string;
  kind: FileKind;
  depth: number;
  origins: string[];
}

export interface SystemMapSymbol {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  depth: number;
  origins: string[];
  anchorQueries: string[];
  referenceExpansion: boolean;
  referenceScope: SystemMapReferenceScope;
}

export interface SystemMapRelation {
  kind: SystemMapRelationKind;
  evidence: SystemMapRelationEvidence;
  fromRegionId: string;
  fromFile: string;
  fromSymbol: string | null;
  toRegionId: string;
  toFile: string;
  toSymbol: string | null;
  line: number | null;
  /** Present in results produced by schema version 1 topology-aware builds. */
  strength?: SystemMapRelationStrength;
}

export interface SystemMapRegionRelation {
  fromRegionId: string;
  toRegionId: string;
  kinds: SystemMapRelationKind[];
  relationCount: number;
  fromFiles: string[];
  toFiles: string[];
  fromSymbols: string[];
  toSymbols: string[];
  evidence: SystemMapRelationEvidence[];
  /** Present in results produced by schema version 1 topology-aware builds. */
  strengths?: SystemMapRelationStrength[];
}

export interface SystemMapExternalBoundary {
  kind: 'external-import';
  name: string;
  fromRegionIds: string[];
  fromFiles: string[];
}

export interface SystemMapBoundaryFrontier {
  observationId: string;
  action: string;
  strength: 'exact' | 'derived' | 'candidate';
  file: string;
  line: number;
  ownerShortName: string | null;
  address: string;
  reason: string;
}

export interface SystemMapNotableSymbol {
  shortName: string;
  file: string;
  origins: string[];
}

export interface SystemMapRegion {
  id: string;
  label: string;
  workspace: string;
  structuralPath: string;
  minDepth: number;
  fileCount: number;
  sourceFileCount: number;
  testFileCount: number;
  symbolCount: number;
  literalHitCount: number;
  anchorQueries: string[];
  relationKinds: SystemMapRelationKind[];
  incomingRegionIds: string[];
  outgoingRegionIds: string[];
  memberCallCandidateRelationCount: number;
  notableSymbols: SystemMapNotableSymbol[];
  omittedNotableSymbols: number;
  expanded: boolean;
  files: SystemMapFile[];
  symbols: SystemMapSymbol[];
  literalHits: SystemMapLiteralHit[];
  relations: SystemMapRelation[];
}

export interface SystemMapDrilldownAnchor {
  kind: 'symbol' | 'literal';
  regionId: string;
  file: string;
  line: number;
  endLine: number | null;
  label: string;
}

export interface SystemMapDrilldown {
  command: string | null;
  definitionCommand: string | null;
  candidateAnchors: number;
  selectedAnchors: number;
  omittedAnchors: number;
  anchors: SystemMapDrilldownAnchor[];
}

export interface SystemMapExpansion {
  command: string | null;
  regionCount: number;
  regionIds: string[];
  candidateRegionCount?: number;
  omittedRegionIds?: string[];
}

/** The bounded human topology view; the structured result still retains every region and relation. */
export interface SystemMapPresentation {
  maxCharacters: number;
  estimatedCharacters: number;
  totalEstimatedCharacters: number;
  regionIds: string[];
  omittedRegionIds: string[];
  relationKeys: string[];
  omittedRelations: number;
  complete: boolean;
  expansionCommand: string | null;
}

export interface SystemMapRelationFamilyCoverage {
  evidence: 'compiler-graph' | 'exact-source' | 'mixed';
  scope: string;
  completeWithinScope: true;
}

export interface SystemMapCoverage {
  explicitAnchorCount: number;
  requestedRelationKinds: SystemMapRelationKind[];
  evidenceFloor: SystemMapEvidenceFloor;
  includedSourceScopes: BoundarySourceScope[];
  matchedAnchorCount: number;
  literalSearchesComplete: true;
  symbolCandidateSetsComplete: boolean;
  omittedSymbolCandidates: number;
  maxTraversalDepth: number;
  frontierSymbols: number;
  frontierFiles: number;
  supportFilesNotTraversed: number;
  filteredUnverifiedCallEdges: number;
  memberCallCandidateEdges: number;
  unresolvedMemberCallsites: number;
  runtimeBoundaryEvidenceAvailable: boolean;
  runtimeBoundaryObservations: number;
  runtimeBoundaryExactLinks: number;
  runtimeBoundaryDerivedLinks: number;
  runtimeBoundaryCandidateLinks: number;
  repositoryRuntimeBoundaryExactLinks: number;
  repositoryRuntimeBoundaryDerivedLinks: number;
  repositoryRuntimeBoundaryCandidateLinks: number;
  runtimeBoundaryTraversedLinks: number;
  runtimeBoundaryFrontiers: number;
  referenceExpansionEligibleSymbols: number;
  referenceExpansionSkippedSymbols: number;
  dynamicDispatchRepresented: boolean;
  runtimeGeneratedLinksRepresented: boolean;
  regionBoundariesAreStructural: true;
  relationFamilies: Record<SystemMapRelationKind | 'literal-anchor', SystemMapRelationFamilyCoverage>;
  blindSpots: string[];
}

/** Accounting for the declared query, not a claim that the English task is globally understood. */
export interface SystemMapQueryClosure {
  status: 'accounted' | 'incomplete';
  emitted: { regions: number; relations: number; runtimeLinks: number };
  withheld: { symbols: number; files: number; regions: number; drillAnchors: number };
  ambiguous: { anchors: number; omittedSymbolCandidates: number };
  external: number;
  unresolved: number;
  explanation: string;
}

export interface SystemMapResult {
  anchors: SystemMapAnchor[];
  regions: SystemMapRegion[];
  regionRelations: SystemMapRegionRelation[];
  externalBoundaries: SystemMapExternalBoundary[];
  boundaryFrontiers: SystemMapBoundaryFrontier[];
  unmatchedExpansions: string[];
  expansion?: SystemMapExpansion;
  drilldown?: SystemMapDrilldown;
  presentation: SystemMapPresentation;
  /** Additive universal graph contract; absent only in results serialized by older builds. */
  topology?: ExplorationTopology;
  closure: SystemMapQueryClosure;
  coverage: SystemMapCoverage;
}

interface FileState {
  file: string;
  depth: number;
  primary: boolean;
  promoteBoundaryImports: boolean;
  origins: Set<string>;
  processed: boolean;
}

interface SymbolState {
  definition: IndexedDefinition;
  depth: number;
  origins: Set<string>;
  anchorQueries: Set<string>;
  referenceScope: SystemMapReferenceScope;
  processed: boolean;
}

interface PendingRelation {
  kind: SystemMapRelationKind;
  evidence: SystemMapRelationEvidence;
  fromFile: string;
  fromSymbol: string | null;
  toFile: string;
  toSymbol: string | null;
  line: number | null;
  strength: SystemMapRelationStrength;
}

interface RegionIdentity {
  id: string;
  label: string;
  workspace: string;
  structuralPath: string;
}

interface StructuralWorkspace {
  name: string;
  relativeDir: string;
}

/**
 * Build a layered repository map from explicit literal and symbol anchors.
 *
 * The query does not infer a feature or system from English. It preserves all
 * supplied anchor matches, follows named compiler/source evidence families,
 * and exposes traversal and runtime blind spots in the result.
 */
export function systemMap(db: ScipDatabase, opts: SystemMapOptions): SystemMapResult {
  const searches = uniqueNonEmpty(opts.searches ?? []);
  const symbolQueries = uniqueNonEmpty(opts.symbols ?? []);
  const requestedRelationKinds = uniqueNonEmpty(
    opts.relations && opts.relations.length > 0 ? opts.relations : ALL_RELATION_KINDS,
  ) as SystemMapRelationKind[];
  const invalidRelations = requestedRelationKinds.filter((kind) => !ALL_RELATION_KINDS.includes(kind));
  if (invalidRelations.length > 0) {
    throw new Error(`Unsupported system-map relation kind(s): ${invalidRelations.join(', ')}`);
  }
  const relationPolicy = new Set(requestedRelationKinds);
  const evidenceFloor = opts.evidenceFloor ?? 'derived';
  if (evidenceFloor !== 'exact' && evidenceFloor !== 'derived') {
    throw new Error(`Unsupported system-map evidence floor: ${evidenceFloor}`);
  }
  const includedSourceScopes = uniqueNonEmpty(
    opts.sourceScopes && opts.sourceScopes.length > 0 ? opts.sourceScopes : ['production'],
  ) as BoundarySourceScope[];
  const validSourceScopes: readonly BoundarySourceScope[] = [
    'production',
    'test',
    'fixture',
    'example',
    'generated',
    'script',
    'unknown',
  ];
  const invalidSourceScopes = includedSourceScopes.filter((scope) => !validSourceScopes.includes(scope));
  if (invalidSourceScopes.length > 0) {
    throw new Error(`Unsupported system-map source scope(s): ${invalidSourceScopes.join(', ')}`);
  }
  const sourceScopePolicy = new Set(includedSourceScopes);
  const sourceAllowed = (file: string): boolean => sourceScopePolicy.has(runtimeBoundarySourceScope(file));
  if (searches.length === 0 && symbolQueries.length === 0) {
    throw new Error('system-map requires at least one --search or --symbol anchor.');
  }
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError(`maxDepth must be a non-negative safe integer; received ${maxDepth}`);
  }
  const maxTopologyCharacters = opts.maxTopologyCharacters ?? DEFAULT_TOPOLOGY_CHARACTERS;
  if (!Number.isSafeInteger(maxTopologyCharacters) || maxTopologyCharacters <= 0) {
    throw new RangeError(`maxTopologyCharacters must be a positive safe integer; received ${maxTopologyCharacters}`);
  }

  const index = new ProjectIndex(db);
  const fileGraph = index.fileDependencyGraph();
  const workspaces = inferIndexedWorkspaces(index.sourceFiles());
  const runtimeBoundaries = readRuntimeBoundaryGraph(db);
  const boundaryObservations = new Map(
    (runtimeBoundaries?.observations ?? []).map((observation) => [observation.id, observation]),
  );
  const representedBoundaryLinkIds = new Set<string>();
  const files = new Map<string, FileState>();
  const symbols = new Map<string, SymbolState>();
  const literalHits: SystemMapLiteralHit[] = [];
  const pendingRelations = new Map<string, PendingRelation>();
  const externalImports = new Map<string, { name: string; fromFiles: Set<string> }>();
  const anchors: SystemMapAnchor[] = [];
  let omittedSymbolCandidates = 0;
  let filteredUnverifiedCallEdges = 0;
  let memberCallCandidateEdges = 0;
  let unresolvedMemberCallsites = 0;

  const addFile = (
    file: string,
    depth: number,
    origin: string,
    primary: boolean,
    promoteBoundaryImports = false,
  ): FileState => {
    const existing = files.get(file);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      existing.primary ||= primary;
      existing.promoteBoundaryImports ||= promoteBoundaryImports;
      existing.origins.add(origin);
      return existing;
    }
    const state: FileState = {
      file,
      depth,
      primary,
      promoteBoundaryImports,
      origins: new Set([origin]),
      processed: false,
    };
    files.set(file, state);
    return state;
  };

  const addSymbol = (
    definition: IndexedDefinition,
    depth: number,
    origin: string,
    anchorQuery?: string,
    referenceScope: SystemMapReferenceScope = 'none',
    promoteBoundaryImports = false,
  ): SymbolState => {
    const existing = symbols.get(definition.symbol);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      existing.origins.add(origin);
      if (anchorQuery) existing.anchorQueries.add(anchorQuery);
      existing.referenceScope = widerReferenceScope(existing.referenceScope, referenceScope);
      addFile(definition.relativePath, depth, origin, true, promoteBoundaryImports);
      return existing;
    }
    const state: SymbolState = {
      definition,
      depth,
      origins: new Set([origin]),
      anchorQueries: new Set(anchorQuery ? [anchorQuery] : []),
      referenceScope,
      processed: false,
    };
    symbols.set(definition.symbol, state);
    addFile(definition.relativePath, depth, origin, true, promoteBoundaryImports);
    return state;
  };

  const addBoundaryObservation = (observation: BoundaryObservation, depth: number, origin: string): void => {
    addFile(observation.source.file, depth, origin, true, true);
    if (!observation.owner.symbol) return;
    const owner = resolveIndexedDefinitions(db, index, observation.owner.symbol).matches.find(
      (candidate) => candidate.relativePath === observation.source.file,
    );
    if (owner && !isModuleLikeSymbol(owner.symbol)) addSymbol(owner, depth, origin, undefined, 'none', true);
  };

  for (const query of searches) {
    const matches = systemMapLiteralMatches(db, index, query);
    for (const match of matches) {
      const traversalSeed =
        match.matchKind !== 'embedded' &&
        sourceAllowed(match.relativePath) &&
        (runtimeBoundarySourceScope(match.relativePath) !== 'production' || isTraversalSource(match.relativePath));
      addFile(match.relativePath, 0, `${traversalSeed ? 'literal-anchor' : 'literal-match'}:${query}`, false);
      if (traversalSeed && match.ownerSymbol) {
        const owner = resolveIndexedDefinitions(db, index, match.ownerSymbol).matches[0];
        if (owner && !isModuleLikeSymbol(owner.symbol)) addSymbol(owner, 0, 'literal-owner', query, 'all', true);
      }
      literalHits.push({
        query,
        file: match.relativePath,
        line: match.line,
        ownerSymbol: match.ownerSymbol,
        ownerShortName: match.ownerShortName,
        sourceLine: match.sourceLine.trim(),
        matchKind: match.matchKind,
        traversalSeed,
      });
    }
    const seedMatches = matches.filter(
      (match) =>
        match.matchKind !== 'embedded' &&
        sourceAllowed(match.relativePath) &&
        (runtimeBoundarySourceScope(match.relativePath) !== 'production' || isTraversalSource(match.relativePath)),
    );
    anchors.push({
      kind: 'literal',
      query,
      status: matches.length > 0 ? 'matched' : 'missing',
      matchedRegionIds: [],
      matchingLines: matches.length,
      seedMatchingLines: seedMatches.length,
      matchOnlyLines: matches.length - seedMatches.length,
      seedRegionIds: [],
      matchOnlyRegionIds: [],
    });
  }

  for (const query of symbolQueries) {
    const resolution = resolveIndexedDefinitions(db, index, query);
    omittedSymbolCandidates += resolution.omitted;
    for (const definition of resolution.matches) addSymbol(definition, 0, 'symbol-anchor', query, 'all', true);
    anchors.push({
      kind: 'symbol',
      query,
      status: resolution.total === 0 ? 'missing' : resolution.total === 1 ? 'matched' : 'ambiguous',
      matchedRegionIds: [],
      symbolCandidates: resolution.matches.map(anchorCandidate),
      totalSymbolCandidates: resolution.total,
      omittedSymbolCandidates: resolution.omitted,
    });
  }

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const symbolFrontier = [...symbols.values()].filter((state) => !state.processed && state.depth <= depth);
    for (const state of symbolFrontier) {
      state.processed = true;
      const definition = state.definition;
      if (
        state.referenceScope !== 'none' &&
        (relationPolicy.has('reference') || relationPolicy.has('contract-symbol'))
      ) {
        for (const site of systemMapReferenceSites(db, index, definition)) {
          if (!sourceAllowed(site.file)) continue;
          if (!referenceSiteIsInScope(state, site.file, files, workspaces)) continue;
          const nextDepth = depth + 1;
          addFile(site.file, nextDepth, `reference:${shortenSymbol(definition.symbol)}`, true);
          if (site.enclosingSymbol) {
            const owner = resolveIndexedDefinitions(db, index, site.enclosingSymbol).matches[0];
            if (owner) addSymbol(owner, nextDepth, 'reference-owner');
          }
          if (relationPolicy.has('reference')) {
            addRelation(pendingRelations, {
              kind: 'reference',
              evidence: 'indexed-or-source-reference',
              fromFile: site.file,
              fromSymbol: site.enclosingSymbol,
              toFile: definition.relativePath,
              toSymbol: definition.symbol,
              line: site.line,
              strength: 'mixed',
            });
          }
          if (
            relationPolicy.has('contract-symbol') &&
            workspaceForFile(site.file, workspaces).relativeDir !==
              workspaceForFile(definition.relativePath, workspaces).relativeDir
          ) {
            addRelation(pendingRelations, {
              kind: 'contract-symbol',
              evidence: 'compiler-cross-workspace-symbol',
              fromFile: site.file,
              fromSymbol: site.enclosingSymbol,
              toFile: definition.relativePath,
              toSymbol: definition.symbol,
              line: site.line,
              strength: 'exact',
            });
          }
        }
      }

      for (const callee of relationPolicy.has('call')
        ? (index.calleeMap([definition], { additive: false, semantic: false }).get(definition.symbolId) ?? [])
        : []) {
        const target = resolveIndexedDefinitions(db, index, callee.symbol).matches.find(
          (candidate) => candidate.relativePath === callee.file,
        );
        if (!target) continue;
        if (!sourceAllowed(target.relativePath)) continue;
        const validated =
          target.relativePath === definition.relativePath ||
          (fileGraph.get(definition.relativePath) ?? new Set()).has(target.relativePath);
        if (!validated) {
          filteredUnverifiedCallEdges += 1;
          continue;
        }
        addSymbol(target, depth + 1, `call:${shortenSymbol(definition.symbol)}`, undefined, 'none', true);
        addRelation(pendingRelations, {
          kind: 'call',
          evidence: callee.source,
          fromFile: definition.relativePath,
          fromSymbol: definition.symbol,
          toFile: target.relativePath,
          toSymbol: target.symbol,
          line: null,
          strength: calleeEvidenceStrength(callee.source),
        });
      }
    }

    const fileFrontier = [...files.values()].filter(
      (state) => !state.processed && state.primary && state.depth <= depth,
    );
    for (const state of fileFrontier) {
      state.processed = true;
      const memberCalls = relationPolicy.has('call')
        ? importedMemberCallTargets(db, state.file)
        : { targets: [], unresolvedCallsites: 0 };
      unresolvedMemberCallsites += memberCalls.unresolvedCallsites;
      memberCallCandidateEdges += memberCalls.targets.length;
      for (const target of memberCalls.targets) {
        // This source-derived edge makes the target visible, but it must not
        // recursively widen the map without compiler-resolved receiver type.
        addFile(target.targetFile, depth + 1, `member-call:${state.file}`, false);
        addRelation(pendingRelations, {
          kind: 'call',
          evidence: 'ast-member-import-candidate',
          fromFile: state.file,
          fromSymbol: null,
          toFile: target.targetFile,
          toSymbol: null,
          line: target.line,
          strength: 'candidate',
        });
      }
      for (const imported of relationPolicy.has('import') ? systemMapImports(db, state.file) : []) {
        if (!imported.fromFile) {
          const boundary = externalImports.get(imported.shortName) ?? {
            name: imported.shortName,
            fromFiles: new Set<string>(),
          };
          boundary.fromFiles.add(state.file);
          externalImports.set(imported.shortName, boundary);
          continue;
        }
        if (!sourceAllowed(imported.fromFile)) continue;
        addFile(imported.fromFile, depth + 1, `import:${state.file}`, false);
        addRelation(pendingRelations, {
          kind: 'import',
          evidence: 'indexed-or-source-import',
          fromFile: state.file,
          fromSymbol: null,
          toFile: imported.fromFile,
          toSymbol: imported.symbol,
          line: null,
          strength: 'mixed',
        });
        if (!state.promoteBoundaryImports || !isBoundaryImport(state.file, imported.fromFile, workspaces)) continue;
        const boundaryResolution = resolveIndexedDefinitions(db, index, imported.symbol);
        for (const boundarySymbol of boundaryResolution.matches) {
          if (
            sameBoundaryRegion(boundarySymbol.relativePath, imported.fromFile, workspaces) &&
            !isModuleLikeSymbol(boundarySymbol.symbol)
          ) {
            const crossWorkspace =
              workspaceForFile(state.file, workspaces).relativeDir !==
              workspaceForFile(boundarySymbol.relativePath, workspaces).relativeDir;
            addSymbol(
              boundarySymbol,
              depth + 1,
              `boundary-import:${state.file}`,
              undefined,
              crossWorkspace ? 'cross-workspace-or-forward' : 'forward-regions',
            );
          }
        }
      }
    }

    for (const link of relationPolicy.has('runtime-boundary') ? (runtimeBoundaries?.links ?? []) : []) {
      if (
        link.strength === 'candidate' ||
        (evidenceFloor === 'exact' && link.strength !== 'exact') ||
        representedBoundaryLinkIds.has(link.id)
      )
        continue;
      const from = boundaryObservations.get(link.from);
      const to = boundaryObservations.get(link.to);
      if (!from || !to) continue;
      if (!sourceAllowed(from.source.file) || !sourceAllowed(to.source.file)) continue;
      const fromState = files.get(from.source.file);
      const toState = files.get(to.source.file);
      const fromReached = Boolean(fromState && fromState.depth <= depth);
      const toReached = Boolean(toState && toState.depth <= depth);
      if (!fromReached && !toReached) continue;

      const nextDepth = depth + 1;
      addBoundaryObservation(from, fromReached ? fromState!.depth : nextDepth, `runtime-boundary:${link.joinRule}`);
      addBoundaryObservation(to, toReached ? toState!.depth : nextDepth, `runtime-boundary:${link.joinRule}`);
      addRelation(pendingRelations, {
        kind: 'runtime-boundary',
        evidence: `runtime-boundary:${link.joinRule}`,
        fromFile: from.source.file,
        fromSymbol: from.owner.symbol,
        toFile: to.source.file,
        toSymbol: to.owner.symbol,
        line: from.source.startLine,
        strength: link.strength,
      });
      representedBoundaryLinkIds.add(link.id);
    }
  }

  const regionForFile = new Map<string, RegionIdentity>();
  for (const file of files.keys()) regionForFile.set(file, regionIdentity(file, workspaces));
  const relations = [...pendingRelations.values()]
    .filter((relation) => regionForFile.has(relation.fromFile) && regionForFile.has(relation.toFile))
    .map(
      (relation): SystemMapRelation => ({
        ...relation,
        fromRegionId: regionForFile.get(relation.fromFile)!.id,
        toRegionId: regionForFile.get(relation.toFile)!.id,
      }),
    )
    .sort(compareRelations);
  const regionRelations = collapseRegionRelations(relations);
  const expandedIds = new Set(opts.expand ?? []);
  const regions = buildRegions(files, symbols, literalHits, relations, regionRelations, regionForFile, expandedIds);
  const defaultExpansionRegionIds = new Set(
    [...files.values()]
      .filter((state) => [...state.origins].some((origin) => !origin.startsWith('literal-match:')))
      .map((state) => regionForFile.get(state.file)!.id),
  );
  const directSeedRegionIds = new Set(
    [...files.values()]
      .filter((state) =>
        [...state.origins].some(
          (origin) => origin.startsWith('literal-anchor:') || origin === 'literal-owner' || origin === 'symbol-anchor',
        ),
      )
      .map((state) => regionForFile.get(state.file)!.id),
  );
  const expansion = buildSystemMapExpansion(
    searches,
    symbolQueries,
    maxDepth,
    regions.filter((region) => defaultExpansionRegionIds.has(region.id)),
    directSeedRegionIds,
    requestedRelationKinds,
    evidenceFloor,
    includedSourceScopes,
    maxTopologyCharacters,
  );
  const drilldown = buildSystemMapDrilldown(regions);
  const presentation = buildSystemMapPresentation(
    searches,
    symbolQueries,
    maxDepth,
    requestedRelationKinds,
    evidenceFloor,
    includedSourceScopes,
    maxTopologyCharacters,
    regions,
    regionRelations,
    directSeedRegionIds,
    expandedIds,
  );
  const knownRegionIds = new Set(regions.map((region) => region.id));
  const unmatchedExpansions = [...expandedIds].filter((id) => !knownRegionIds.has(id)).sort();

  for (const anchor of anchors) {
    anchor.matchedRegionIds = matchedRegionIds(anchor, literalHits, symbols, regionForFile);
    if (anchor.kind === 'literal') {
      const hits = literalHits.filter((hit) => hit.query === anchor.query);
      anchor.seedRegionIds = uniqueSorted(
        hits.filter((hit) => hit.traversalSeed).map((hit) => regionForFile.get(hit.file)!.id),
      );
      anchor.matchOnlyRegionIds = uniqueSorted(
        hits.filter((hit) => !hit.traversalSeed).map((hit) => regionForFile.get(hit.file)!.id),
      );
    }
  }

  const frontierSymbols = [...symbols.values()].filter((state) => !state.processed).length;
  const frontierFiles = [...files.values()].filter((state) => state.primary && !state.processed).length;
  const supportFilesNotTraversed = [...files.values()].filter((state) => !state.primary && !state.processed).length;
  const processedSymbols = [...symbols.values()].filter((state) => state.processed);
  const boundaryFrontiers: SystemMapBoundaryFrontier[] = (runtimeBoundaries?.frontiers ?? [])
    .flatMap((frontier) => {
      const observation = boundaryObservations.get(frontier.observationId);
      if (!observation && frontier.source && frontier.action && frontier.strength) {
        if (
          !relationPolicy.has('runtime-boundary') ||
          !sourceAllowed(frontier.source.file) ||
          evidenceFloor === 'exact' ||
          !files.has(frontier.source.file)
        )
          return [];
        return [
          {
            observationId: frontier.observationId,
            action: frontier.action,
            strength: frontier.strength,
            file: frontier.source.file,
            line: frontier.source.startLine,
            ownerShortName: frontier.ownerShortName ?? null,
            address: frontier.address ?? frontier.missingKeyParts.join(', '),
            reason: frontier.reason,
          },
        ];
      }
      if (
        !relationPolicy.has('runtime-boundary') ||
        !observation ||
        !sourceAllowed(observation.source.file) ||
        (evidenceFloor === 'exact' && observation.strength !== 'exact') ||
        !files.has(observation.source.file)
      )
        return [];
      return [
        {
          observationId: observation.id,
          action: observation.action,
          strength: observation.strength,
          file: observation.source.file,
          line: observation.source.startLine,
          ownerShortName: observation.owner.name,
          address: renderBoundaryAddress(observation),
          reason: frontier.reason,
        },
      ];
    })
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  const relevantBoundaryLinks = (runtimeBoundaries?.links ?? []).filter((link) => {
    if (!relationPolicy.has('runtime-boundary')) return false;
    if (evidenceFloor === 'exact' && link.strength !== 'exact') return false;
    const from = boundaryObservations.get(link.from);
    const to = boundaryObservations.get(link.to);
    return Boolean(
      from &&
      to &&
      sourceAllowed(from.source.file) &&
      sourceAllowed(to.source.file) &&
      (files.has(from.source.file) || files.has(to.source.file)),
    );
  });
  const exactBoundaryLinks = relevantBoundaryLinks.filter((link) => link.strength === 'exact').length;
  const derivedBoundaryLinks = relevantBoundaryLinks.filter((link) => link.strength === 'derived').length;
  const candidateBoundaryLinks = relevantBoundaryLinks.filter((link) => link.strength === 'candidate').length;
  const repositoryExactBoundaryLinks = runtimeBoundaries?.links.filter((link) => link.strength === 'exact').length ?? 0;
  const repositoryDerivedBoundaryLinks =
    runtimeBoundaries?.links.filter((link) => link.strength === 'derived').length ?? 0;
  const repositoryCandidateBoundaryLinks =
    runtimeBoundaries?.links.filter((link) => link.strength === 'candidate').length ?? 0;
  const externalBoundaries = buildExternalBoundaries(externalImports, regionForFile);
  const closureStatus = omittedSymbolCandidates === 0 ? 'accounted' : 'incomplete';
  const blindSpots = [
    `Literal matches outside the included source scopes (${includedSourceScopes.join(', ')}) remain visible as match-only evidence and do not seed traversal.`,
    runtimeBoundaries
      ? 'Built-in runtime-boundary extractors traverse direct and replayably derived links; heuristic candidates, unsupported frameworks, reflection, generated names, and dependency-injection wiring remain disclosed frontiers.'
      : 'Runtime-boundary evidence is unavailable for this index; run scip-query reindex with this build to extract supported HTTP, event, registry, and persistence observations.',
    'Reverse references do not recursively expand from discovered callers or callees.',
    'Member-call candidates require a direct imported receiver (or one simple identifier alias) and exactly one imported source file declaring the callable leaf; receiver type is unproved, while re-exports, nested dependency-injection receivers, and ambiguous declarations remain unrepresented.',
    'Literal hits without a precise non-module owner and imported support files remain visible but are not recursively traversed; add a symbol anchor when their internals matter.',
    'Schema consumers stay within forward-flow regions; cross-workspace contracts may discover consumers in other workspaces. Add an explicit symbol anchor to widen either scope.',
    `Traversal stops after depth ${maxDepth}; nonzero frontier counts identify evidence that was discovered but not traversed.`,
    'Region labels are structural path groupings, not inferred runtime or architectural boundaries.',
  ];
  const topology = buildSystemMapTopology({
    anchors,
    regions,
    symbolStates: symbols,
    literalHits,
    relations,
    externalBoundaries,
    boundaryFrontiers,
    regionForFile,
    presentation,
    closureStatus,
    omittedSymbolCandidates,
    maxDepth,
    requestedRelationKinds,
    evidenceFloor,
    includedSourceScopes,
    blindSpots,
  });
  return {
    anchors,
    regions,
    regionRelations,
    externalBoundaries,
    boundaryFrontiers,
    unmatchedExpansions,
    expansion,
    drilldown,
    presentation,
    topology,
    closure: {
      status: closureStatus,
      emitted: {
        regions: regions.length,
        relations: relations.length,
        runtimeLinks: representedBoundaryLinkIds.size,
      },
      withheld: {
        symbols: frontierSymbols,
        files: frontierFiles + supportFilesNotTraversed,
        regions: expansion?.omittedRegionIds?.length ?? 0,
        drillAnchors: drilldown?.omittedAnchors ?? 0,
      },
      ambiguous: {
        anchors: anchors.filter((anchor) => anchor.status === 'ambiguous').length,
        omittedSymbolCandidates,
      },
      external: externalBoundaries.length,
      unresolved: boundaryFrontiers.length,
      explanation:
        closureStatus === 'accounted'
          ? 'Every fact reached under the declared anchors, relations, depth, evidence floor, source scopes, and installed analyzers is accounted for as emitted, withheld, ambiguous, external, or unresolved.'
          : 'Some ambiguous symbol candidates were not identified, so the declared query is not fully accounted for.',
    },
    coverage: {
      explicitAnchorCount: anchors.length,
      requestedRelationKinds,
      evidenceFloor,
      includedSourceScopes,
      matchedAnchorCount: anchors.filter((anchor) => anchor.status !== 'missing').length,
      literalSearchesComplete: true,
      symbolCandidateSetsComplete: omittedSymbolCandidates === 0,
      omittedSymbolCandidates,
      maxTraversalDepth: maxDepth,
      frontierSymbols,
      frontierFiles,
      supportFilesNotTraversed,
      filteredUnverifiedCallEdges,
      memberCallCandidateEdges,
      unresolvedMemberCallsites,
      runtimeBoundaryEvidenceAvailable: runtimeBoundaries !== null,
      runtimeBoundaryObservations: runtimeBoundaries?.observations.length ?? 0,
      runtimeBoundaryExactLinks: exactBoundaryLinks,
      runtimeBoundaryDerivedLinks: derivedBoundaryLinks,
      runtimeBoundaryCandidateLinks: candidateBoundaryLinks,
      repositoryRuntimeBoundaryExactLinks: repositoryExactBoundaryLinks,
      repositoryRuntimeBoundaryDerivedLinks: repositoryDerivedBoundaryLinks,
      repositoryRuntimeBoundaryCandidateLinks: repositoryCandidateBoundaryLinks,
      runtimeBoundaryTraversedLinks: representedBoundaryLinkIds.size,
      runtimeBoundaryFrontiers: boundaryFrontiers.length,
      referenceExpansionEligibleSymbols: processedSymbols.filter((state) => state.referenceScope !== 'none').length,
      referenceExpansionSkippedSymbols: processedSymbols.filter((state) => state.referenceScope === 'none').length,
      dynamicDispatchRepresented:
        runtimeBoundaries?.links.some(
          (link) => link.joinRule === 'carrier.discriminator' && representedBoundaryLinkIds.has(link.id),
        ) ?? false,
      runtimeGeneratedLinksRepresented: runtimeBoundaries !== null,
      regionBoundariesAreStructural: true,
      relationFamilies: {
        'literal-anchor': {
          evidence: 'exact-source',
          scope: 'all indexed documents for each explicit literal',
          completeWithinScope: true,
        },
        reference: {
          evidence: 'compiler-graph',
          scope:
            'all cross-file indexed/source-attributed sites for explicit anchors and promoted non-module boundary symbols',
          completeWithinScope: true,
        },
        call: {
          evidence: 'mixed',
          scope:
            'static callees of traversed symbols plus uniquely attributed member-call leaves declared in one direct imported source file',
          completeWithinScope: true,
        },
        'contract-symbol': {
          evidence: 'compiler-graph',
          scope: 'compiler-resolved symbol identities referenced across inferred workspace boundaries',
          completeWithinScope: true,
        },
        import: {
          evidence: 'compiler-graph',
          scope: 'all indexed or source-resolved imports of traversed primary files',
          completeWithinScope: true,
        },
        'runtime-boundary': {
          evidence: 'exact-source',
          scope:
            'direct and mechanically derived links produced by grounded runtime adapters and factorized relation groups',
          completeWithinScope: true,
        },
      },
      blindSpots,
    },
  };
}

interface SystemMapTopologyInput {
  anchors: readonly SystemMapAnchor[];
  regions: readonly SystemMapRegion[];
  symbolStates: ReadonlyMap<string, SymbolState>;
  literalHits: readonly SystemMapLiteralHit[];
  relations: readonly SystemMapRelation[];
  externalBoundaries: readonly SystemMapExternalBoundary[];
  boundaryFrontiers: readonly SystemMapBoundaryFrontier[];
  regionForFile: ReadonlyMap<string, RegionIdentity>;
  presentation: SystemMapPresentation;
  closureStatus: SystemMapQueryClosure['status'];
  omittedSymbolCandidates: number;
  maxDepth: number;
  requestedRelationKinds: readonly SystemMapRelationKind[];
  evidenceFloor: SystemMapEvidenceFloor;
  includedSourceScopes: readonly BoundarySourceScope[];
  blindSpots: readonly string[];
}

function buildSystemMapTopology(input: SystemMapTopologyInput): ExplorationTopology {
  const presentedNodeIds = new Set(input.presentation.regionIds);
  const presentedRelationKeys = new Set(input.presentation.relationKeys);
  const anchors: ExplorationTopologyAnchor[] = input.anchors.map((anchor, index) => {
    const id = topologyId('anchor', String(index), anchor.kind, anchor.query);
    const symbolNodeIds = [...input.symbolStates.values()]
      .filter((state) => state.anchorQueries.has(anchor.query))
      .map((state) => symbolTopologyNodeId(state.definition.symbol));
    const literalOwnerNodeIds = input.literalHits
      .filter((hit) => hit.query === anchor.query && hit.ownerSymbol && input.symbolStates.has(hit.ownerSymbol))
      .map((hit) => symbolTopologyNodeId(hit.ownerSymbol!));
    const matchedNodeIds = uniqueSorted(
      anchor.kind === 'symbol'
        ? symbolNodeIds
        : literalOwnerNodeIds.length > 0
          ? literalOwnerNodeIds
          : anchor.matchedRegionIds,
    );
    return {
      id,
      kind: anchor.kind,
      query: anchor.query,
      status: anchor.status,
      nodeIds: anchor.status === 'ambiguous' ? [] : matchedNodeIds,
      candidateNodeIds: anchor.status === 'ambiguous' ? matchedNodeIds : [],
      omittedCandidates: anchor.omittedSymbolCandidates ?? 0,
    };
  });
  const anchorIdsByNode = new Map<string, string[]>();
  for (const anchor of anchors) {
    for (const nodeId of [...anchor.nodeIds, ...anchor.candidateNodeIds]) {
      const ids = anchorIdsByNode.get(nodeId) ?? [];
      ids.push(anchor.id);
      anchorIdsByNode.set(nodeId, ids);
    }
  }

  const nodes: ExplorationTopologyNode[] = input.regions.map((region) => ({
    id: region.id,
    kind: 'structural-region',
    label: region.label,
    disposition: presentedNodeIds.has(region.id) ? 'emitted' : 'folded',
    location: null,
    anchorIds: uniqueSorted(anchorIdsByNode.get(region.id) ?? []),
    attributes: {
      workspace: region.workspace,
      structuralPath: region.structuralPath,
      minimumDepth: region.minDepth,
      files: region.fileCount,
      symbols: region.symbolCount,
      expanded: region.expanded,
    },
  }));
  for (const state of input.symbolStates.values()) {
    const regionId = input.regionForFile.get(state.definition.relativePath)?.id;
    if (!regionId) throw new Error(`System-map symbol ${state.definition.symbol} has no structural region.`);
    const id = symbolTopologyNodeId(state.definition.symbol);
    const explicitlyAnchored = (anchorIdsByNode.get(id)?.length ?? 0) > 0;
    nodes.push({
      id,
      kind: 'symbol',
      label: shortenSymbol(state.definition.symbol),
      disposition:
        explicitlyAnchored || input.regions.find((region) => region.id === regionId)?.expanded ? 'emitted' : 'folded',
      location: {
        file: state.definition.relativePath,
        line: state.definition.startLine,
        endLine: state.definition.endLine,
      },
      anchorIds: uniqueSorted(anchorIdsByNode.get(id) ?? []),
      attributes: {
        regionId,
        depth: state.depth,
        referenceScope: state.referenceScope,
      },
    });
  }
  const knownNodeIds = new Set(nodes.map((node) => node.id));
  const relationEndpoint = (symbol: string | null, regionId: string): string => {
    const symbolNodeId = symbol ? symbolTopologyNodeId(symbol) : null;
    return symbolNodeId && knownNodeIds.has(symbolNodeId) ? symbolNodeId : regionId;
  };
  const edges: ExplorationTopologyEdge[] = [];
  const groupedRelations = groupBy(
    input.relations,
    (relation) =>
      `${relationEndpoint(relation.fromSymbol, relation.fromRegionId)}\u0000${relationEndpoint(relation.toSymbol, relation.toRegionId)}\u0000${relation.kind}`,
  );
  for (const bucket of groupedRelations.values()) {
    const first = bucket[0]!;
    const fromNodeId = relationEndpoint(first.fromSymbol, first.fromRegionId);
    const toNodeId = relationEndpoint(first.toSymbol, first.toRegionId);
    const endpointsEmitted = [fromNodeId, toNodeId].every(
      (nodeId) => nodes.find((node) => node.id === nodeId)?.disposition === 'emitted',
    );
    edges.push({
      id: topologyId('edge', first.kind, fromNodeId, toNodeId),
      kind: first.kind,
      fromNodeId,
      toNodeId,
      directed: true,
      disposition:
        endpointsEmitted || presentedRelationKeys.has(systemMapRegionRelationKey(first)) ? 'emitted' : 'folded',
      evidence: uniqueExplorationEvidence(
        bucket.map((relation) => ({
          method: relation.evidence,
          strength: relation.strength ?? 'unknown',
          identity: `${relation.fromSymbol ?? relation.fromFile} -> ${relation.toSymbol ?? relation.toFile}`,
          location: relation.line === null ? null : { file: relation.fromFile, line: relation.line },
        })),
      ),
    });
  }

  for (const boundary of input.externalBoundaries) {
    const nodeId = topologyId('external', boundary.kind, boundary.name);
    const fromNodeIds = uniqueSorted(boundary.fromRegionIds);
    const emitted = fromNodeIds.some((id) => presentedNodeIds.has(id));
    nodes.push({
      id: nodeId,
      kind: boundary.kind,
      label: boundary.name,
      disposition: emitted ? 'emitted' : 'folded',
      location: null,
      anchorIds: [],
      attributes: {},
    });
    for (const fromNodeId of fromNodeIds) {
      edges.push({
        id: topologyId('edge', boundary.kind, fromNodeId, nodeId),
        kind: boundary.kind,
        fromNodeId,
        toNodeId: nodeId,
        directed: true,
        disposition: presentedNodeIds.has(fromNodeId) ? 'emitted' : 'folded',
        evidence: [
          {
            method: 'indexed-or-source-import',
            strength: 'mixed',
            identity: `${fromNodeId} -> ${boundary.name}`,
            location: null,
          },
        ],
      });
    }
  }

  const frontiers: ExplorationFrontierGroup[] = [];
  input.boundaryFrontiers.forEach((frontier, index) => {
    const fromNodeId = input.regionForFile.get(frontier.file)?.id;
    if (!fromNodeId) {
      throw new Error(`Runtime-boundary frontier ${frontier.observationId} has no system-map region.`);
    }
    const nodeId = topologyId('unsupported', 'runtime-boundary', frontier.observationId, String(index));
    const edgeId = topologyId('edge', 'runtime-boundary-frontier', fromNodeId, nodeId);
    nodes.push({
      id: nodeId,
      kind: 'runtime-boundary-frontier',
      label: frontier.address,
      disposition: 'unsupported',
      location: { file: frontier.file, line: frontier.line },
      anchorIds: [],
      attributes: {
        action: frontier.action,
        strength: frontier.strength,
        owner: frontier.ownerShortName,
      },
    });
    edges.push({
      id: edgeId,
      kind: 'runtime-boundary-frontier',
      fromNodeId,
      toNodeId: nodeId,
      directed: true,
      disposition: 'unsupported',
      evidence: [
        {
          method: 'runtime-boundary-extractor',
          strength: frontier.strength,
          identity: frontier.observationId,
          location: { file: frontier.file, line: frontier.line },
        },
      ],
    });
    frontiers.push({
      id: topologyId('frontier', 'runtime-boundary', frontier.observationId, String(index)),
      kind: 'runtime-boundary',
      direction: 'unresolved',
      fromNodeIds: [fromNodeId],
      edgeIds: [edgeId],
      memberNodeIds: [nodeId],
      memberCount: 1,
      disposition: 'unsupported',
      reason: frontier.reason,
      expansion: null,
    });
  });

  return createExplorationTopology({
    anchors,
    nodes,
    edges,
    paths: [],
    frontiers,
    scope: `explicit anchors; relations ${input.requestedRelationKinds.join(', ')}; depth ${input.maxDepth}; evidence floor ${input.evidenceFloor}; source scopes ${input.includedSourceScopes.join(', ')}`,
    blindSpots: input.blindSpots,
    incompleteReasons:
      input.closureStatus === 'incomplete'
        ? [`${input.omittedSymbolCandidates} ambiguous symbol candidate(s) were omitted`]
        : [],
  });
}

function uniqueExplorationEvidence(evidence: readonly ExplorationEvidenceSource[]): ExplorationEvidenceSource[] {
  const keyed = new Map<string, ExplorationEvidenceSource>();
  for (const source of evidence) {
    const location = source.location ? `${source.location.file}:${source.location.line}` : '';
    keyed.set(`${source.method}\u0000${source.strength}\u0000${source.identity ?? ''}\u0000${location}`, source);
  }
  return [...keyed.values()].sort(
    (left, right) =>
      left.method.localeCompare(right.method) ||
      (left.identity ?? '').localeCompare(right.identity ?? '') ||
      (left.location?.file ?? '').localeCompare(right.location?.file ?? '') ||
      (left.location?.line ?? 0) - (right.location?.line ?? 0),
  );
}

function topologyId(...parts: readonly string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}

function symbolTopologyNodeId(symbol: string): string {
  return topologyId('symbol', symbol);
}

function calleeEvidenceStrength(source: CalleeEvidenceSource): SystemMapRelationStrength {
  return source === 'semantic-callee' || source === 'scip-chunk' ? 'exact' : 'derived';
}

function buildSystemMapExpansion(
  searches: readonly string[],
  symbols: readonly string[],
  maxDepth: number,
  regions: readonly SystemMapRegion[],
  directSeedRegionIds: ReadonlySet<string>,
  relations: readonly SystemMapRelationKind[],
  evidenceFloor: SystemMapEvidenceFloor,
  sourceScopes: readonly BoundarySourceScope[],
  maxTopologyCharacters: number,
): SystemMapExpansion {
  const ranked = [...regions].sort((left, right) => compareExpansionRegions(left, right, directSeedRegionIds));
  const selected = ranked.slice(0, DEFAULT_EXPANSION_REGION_LIMIT);
  const regionIds = selected.map((region) => region.id);
  const omittedRegionIds = ranked.slice(DEFAULT_EXPANSION_REGION_LIMIT).map((region) => region.id);
  const selectors = [
    ...searches.map((search) => `--search ${shellArgument(search)}`),
    ...symbols.map((symbol) => `--symbol ${shellArgument(symbol)}`),
    `--depth ${maxDepth}`,
    ...relations.map((relation) => `--relation ${shellArgument(relation)}`),
    `--evidence-floor ${shellArgument(evidenceFloor)}`,
    ...sourceScopes.map((scope) => `--source-scope ${shellArgument(scope)}`),
    `--topology-characters ${maxTopologyCharacters}`,
    ...regionIds.map((regionId) => `--expand ${shellArgument(regionId)}`),
  ];
  return {
    command: regionIds.length === 0 ? null : `scip-query system-map ${selectors.join(' ')}`,
    regionCount: regionIds.length,
    regionIds,
    candidateRegionCount: regions.length,
    omittedRegionIds,
  };
}

function buildSystemMapPresentation(
  searches: readonly string[],
  symbols: readonly string[],
  maxDepth: number,
  relations: readonly SystemMapRelationKind[],
  evidenceFloor: SystemMapEvidenceFloor,
  sourceScopes: readonly BoundarySourceScope[],
  maxCharacters: number,
  regions: readonly SystemMapRegion[],
  regionRelations: readonly SystemMapRegionRelation[],
  directSeedRegionIds: ReadonlySet<string>,
  expandedIds: ReadonlySet<string>,
): SystemMapPresentation {
  const rankedRegions = [...regions].sort((left, right) => compareExpansionRegions(left, right, directSeedRegionIds));
  const relationReserve = regionRelations.length > 0 ? Math.floor(maxCharacters * 0.4) : 0;
  const regionBudget = maxCharacters - relationReserve;
  const selectedRegionIds = new Set<string>();
  let estimatedCharacters = 0;
  for (const region of rankedRegions) {
    const estimate = estimateRegionCharacters(region);
    const required = expandedIds.has(region.id);
    if (!required && selectedRegionIds.size > 0 && estimatedCharacters + estimate > regionBudget) continue;
    selectedRegionIds.add(region.id);
    estimatedCharacters += estimate;
  }

  const eligibleRelations = regionRelations
    .filter((relation) => selectedRegionIds.has(relation.fromRegionId) && selectedRegionIds.has(relation.toRegionId))
    .sort(comparePresentationRelations);
  const relationKeys: string[] = [];
  for (const relation of eligibleRelations) {
    const estimate = estimateRelationCharacters(relation);
    if (relationKeys.length > 0 && estimatedCharacters + estimate > maxCharacters) continue;
    relationKeys.push(systemMapRegionRelationKey(relation));
    estimatedCharacters += estimate;
  }

  const omittedRegionIds = regions
    .filter((region) => !selectedRegionIds.has(region.id))
    .map((region) => region.id)
    .sort();
  const selectedRelationKeys = new Set(relationKeys);
  const omittedRelations = regionRelations.filter(
    (relation) => !selectedRelationKeys.has(systemMapRegionRelationKey(relation)),
  ).length;
  const totalEstimatedCharacters =
    regions.reduce((total, region) => total + estimateRegionCharacters(region), 0) +
    regionRelations.reduce((total, relation) => total + estimateRelationCharacters(relation), 0);
  const complete = omittedRegionIds.length === 0 && omittedRelations === 0;
  const selectors = [
    ...searches.map((search) => `--search ${shellArgument(search)}`),
    ...symbols.map((symbol) => `--symbol ${shellArgument(symbol)}`),
    `--depth ${maxDepth}`,
    ...relations.map((relation) => `--relation ${shellArgument(relation)}`),
    `--evidence-floor ${shellArgument(evidenceFloor)}`,
    ...sourceScopes.map((scope) => `--source-scope ${shellArgument(scope)}`),
    `--topology-characters ${Math.max(maxCharacters, totalEstimatedCharacters)}`,
  ];
  return {
    maxCharacters,
    estimatedCharacters,
    totalEstimatedCharacters,
    regionIds: [...selectedRegionIds],
    omittedRegionIds,
    relationKeys,
    omittedRelations,
    complete,
    expansionCommand: complete ? null : `scip-query system-map ${selectors.join(' ')}`,
  };
}

function estimateRegionCharacters(region: SystemMapRegion): number {
  return (
    120 +
    region.id.length +
    region.anchorQueries.join(',').length +
    region.relationKinds.join(',').length +
    region.notableSymbols.slice(0, 2).reduce((total, symbol) => total + symbol.shortName.length + symbol.file.length, 0)
  );
}

function estimateRelationCharacters(relation: SystemMapRegionRelation): number {
  return (
    70 +
    relation.fromRegionId.length +
    relation.toRegionId.length +
    relation.kinds.join(',').length +
    relation.evidence.join(',').length
  );
}

function comparePresentationRelations(left: SystemMapRegionRelation, right: SystemMapRegionRelation): number {
  const priority = (relation: SystemMapRegionRelation): number =>
    relation.kinds.includes('runtime-boundary') ? 0 : relation.kinds.includes('contract-symbol') ? 1 : 2;
  return (
    priority(left) - priority(right) ||
    right.relationCount - left.relationCount ||
    systemMapRegionRelationKey(left).localeCompare(systemMapRegionRelationKey(right))
  );
}

export function systemMapRegionRelationKey(
  relation: Pick<SystemMapRegionRelation, 'fromRegionId' | 'toRegionId'>,
): string {
  return `${relation.fromRegionId}\u0000${relation.toRegionId}`;
}

function compareExpansionRegions(
  left: SystemMapRegion,
  right: SystemMapRegion,
  directSeedRegionIds: ReadonlySet<string>,
): number {
  const directSeedRank = (region: SystemMapRegion): number => (directSeedRegionIds.has(region.id) ? 0 : 1);
  const testOnlyRank = (region: SystemMapRegion): number => (region.sourceFileCount === 0 ? 1 : 0);
  const evidencePresenceRank = (region: SystemMapRegion): number =>
    region.symbolCount + region.literalHitCount > 0 ? 0 : 1;
  const connectedSeedCount = (region: SystemMapRegion): number =>
    [...region.incomingRegionIds, ...region.outgoingRegionIds].filter((id) => directSeedRegionIds.has(id)).length;
  return (
    directSeedRank(left) - directSeedRank(right) ||
    evidencePresenceRank(left) - evidencePresenceRank(right) ||
    testOnlyRank(left) - testOnlyRank(right) ||
    left.minDepth - right.minDepth ||
    connectedSeedCount(right) - connectedSeedCount(left) ||
    right.literalHitCount - left.literalHitCount ||
    left.testFileCount - right.testFileCount ||
    left.label.localeCompare(right.label)
  );
}

function buildSystemMapDrilldown(regions: readonly SystemMapRegion[]): SystemMapDrilldown {
  const candidates: SystemMapDrilldownAnchor[] = [];
  const explicitSymbolAnchorFiles = new Set<string>();
  for (const region of regions.filter((candidate) => candidate.expanded)) {
    for (const symbol of region.symbols) {
      if (symbol.origins.includes('symbol-anchor')) explicitSymbolAnchorFiles.add(symbol.file);
    }
    const symbolsByFile = groupBy(region.symbols, (symbol) => symbol.file);
    const hitsByFile = groupBy(region.literalHits, (hit) => hit.file);
    const rankedFiles = [...region.files].sort((left, right) =>
      compareDrilldownFiles(left, right, symbolsByFile, hitsByFile),
    );
    for (const file of rankedFiles) {
      const symbol = (symbolsByFile.get(file.file) ?? []).sort(compareDrilldownSymbols)[0];
      if (symbol) {
        candidates.push({
          kind: 'symbol',
          regionId: region.id,
          file: symbol.file,
          line: symbol.startLine,
          endLine: symbol.endLine,
          label: symbol.shortName,
        });
        continue;
      }
      const hit = (hitsByFile.get(file.file) ?? []).sort(compareLiteralHits)[0];
      if (hit) {
        candidates.push({
          kind: 'literal',
          regionId: region.id,
          file: hit.file,
          line: hit.line,
          endLine: null,
          label: hit.ownerShortName ?? hit.query,
        });
      }
    }
  }
  const selected = selectCoverageDiverseDrilldownAnchors(candidates, explicitSymbolAnchorFiles);
  return {
    command:
      selected.length === 0
        ? null
        : `scip-query inspect ${selected
            .map((anchor) => `--at ${shellArgument(`${anchor.file}:${anchor.line + 1}`)}`)
            .join(' ')} --view behavior`,
    definitionCommand: null,
    candidateAnchors: candidates.length,
    selectedAnchors: selected.length,
    omittedAnchors: candidates.length - selected.length,
    anchors: selected,
  };
}

function selectCoverageDiverseDrilldownAnchors(
  candidates: readonly SystemMapDrilldownAnchor[],
  explicitSymbolAnchorFiles: ReadonlySet<string>,
): SystemMapDrilldownAnchor[] {
  const byRegion = [...groupBy(candidates, (candidate) => candidate.regionId).values()];
  const selected: SystemMapDrilldownAnchor[] = [];
  const selectedFiles = new Set<string>();
  const limit = Math.min(DEFAULT_DRILLDOWN_ANCHOR_LIMIT, SOURCE_INSPECTION_MAX_SELECTORS);
  for (const candidate of candidates) {
    if (!explicitSymbolAnchorFiles.has(candidate.file) || selectedFiles.has(candidate.file)) continue;
    selected.push(candidate);
    selectedFiles.add(candidate.file);
    if (selected.length === limit) return selected;
  }
  for (let offset = 0; selected.length < limit; offset += 1) {
    let foundCandidate = false;
    for (const regionCandidates of byRegion) {
      const candidate = regionCandidates[offset];
      if (!candidate) continue;
      foundCandidate = true;
      if (selectedFiles.has(candidate.file)) continue;
      selected.push(candidate);
      selectedFiles.add(candidate.file);
      if (selected.length === limit) break;
    }
    if (!foundCandidate) break;
  }
  return selected;
}

function compareDrilldownFiles(
  left: SystemMapFile,
  right: SystemMapFile,
  symbolsByFile: ReadonlyMap<string, SystemMapSymbol[]>,
  hitsByFile: ReadonlyMap<string, SystemMapLiteralHit[]>,
): number {
  const kindRank = (file: SystemMapFile): number => (file.kind === 'test' ? 2 : file.kind === 'barrel' ? 1 : 0);
  const directLiteralRank = (file: SystemMapFile): number =>
    (hitsByFile.get(file.file) ?? []).some((hit) => hit.traversalSeed) ? 0 : 1;
  const originRank = (file: SystemMapFile): number => {
    const symbols = symbolsByFile.get(file.file) ?? [];
    return Math.min(5, ...symbols.map((symbol) => notableOriginRank(symbol.origins)));
  };
  return (
    kindRank(left) - kindRank(right) ||
    directLiteralRank(left) - directLiteralRank(right) ||
    originRank(left) - originRank(right) ||
    left.depth - right.depth ||
    left.file.localeCompare(right.file)
  );
}

function compareDrilldownSymbols(left: SystemMapSymbol, right: SystemMapSymbol): number {
  return (
    notableOriginRank(left.origins) - notableOriginRank(right.origins) ||
    left.depth - right.depth ||
    left.startLine - right.startLine ||
    left.shortName.localeCompare(right.shortName)
  );
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface LiteralMatch {
  relativePath: string;
  line: number;
  sourceLine: string;
  ownerSymbol: string | null;
  ownerShortName: string | null;
  matchKind: 'exact-value' | 'boundary' | 'embedded';
}

function systemMapLiteralMatches(db: ScipDatabase, index: ProjectIndex, pattern: string): LiteralMatch[] {
  const matches: LiteralMatch[] = [];
  for (const relativePath of indexedDocumentPaths(db, { includeIgnored: false })) {
    const lines = getSourceLines(db, relativePath);
    if (lines.length === 0) continue;
    const definitions = index.definitionsForFile(relativePath);
    for (let line = 0; line < lines.length; line += 1) {
      const sourceLine = lines[line] ?? '';
      if (!sourceLine.includes(pattern)) continue;
      const owner = findEnclosingDefinition(definitions, line);
      matches.push({
        relativePath,
        line,
        sourceLine,
        ownerSymbol: owner?.symbol ?? null,
        ownerShortName: owner ? shortenSymbol(owner.symbol) : null,
        matchKind: literalMatchKind(sourceLine, pattern),
      });
    }
  }
  return matches;
}

function literalMatchKind(sourceLine: string, pattern: string): 'exact-value' | 'boundary' | 'embedded' {
  const identifierCharacter = /[\p{L}\p{N}_$]/u;
  let offset = sourceLine.indexOf(pattern);
  while (offset >= 0) {
    const before = sourceLine[offset - 1] ?? '';
    const after = sourceLine[offset + pattern.length] ?? '';
    if ((before === "'" || before === '"' || before === '`') && after === before) return 'exact-value';
    if (!identifierCharacter.test(before) && !identifierCharacter.test(after)) return 'boundary';
    offset = sourceLine.indexOf(pattern, offset + Math.max(1, pattern.length));
  }
  return 'embedded';
}

function isTraversalSource(relativePath: string): boolean {
  if (classifyFile(relativePath) === 'test') return false;
  return !/(?:^|[/._-])(?:fixtures?|mocks?|previews?|demos?|examples?|stories)(?:[/._-]|$)/iu.test(relativePath);
}

interface ReferenceSite {
  file: string;
  line: number | null;
  enclosingSymbol: string | null;
}

function systemMapReferenceSites(
  db: ScipDatabase,
  index: ProjectIndex,
  definition: IndexedDefinition,
): ReferenceSite[] {
  const files = index.callerFileMap([definition], { semantic: false }).get(definition.symbolId) ?? new Set<string>();
  const sites: ReferenceSite[] = [];
  for (const file of [...files].sort()) {
    const lines = definition.leaf ? findIdentifierLines(db, file, definition.leaf) : [];
    if (lines.length === 0) {
      sites.push({ file, line: null, enclosingSymbol: null });
      continue;
    }
    const definitions = index.definitionsForFile(file);
    for (const line of lines) {
      sites.push({
        file,
        line,
        enclosingSymbol: findEnclosingDefinition(definitions, line)?.symbol ?? null,
      });
    }
  }
  return sites;
}

interface ImportEvidence {
  symbol: string;
  shortName: string;
  fromFile: string | null;
}

function systemMapImports(db: ScipDatabase, importer: string): ImportEvidence[] {
  const rows = db.all<{ symbol: string; from_file: string | null }>(
    `SELECT DISTINCT gs.symbol, def_d.relative_path AS from_file
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents imp_d ON c.document_id = imp_d.id
     JOIN global_symbols gs ON m.symbol_id = gs.id
     LEFT JOIN (
       SELECT m2.symbol_id, c2.document_id
       FROM mentions m2
       JOIN chunks c2 ON m2.chunk_id = c2.id
       WHERE m2.role = 1
       GROUP BY m2.symbol_id
     ) sym_def ON sym_def.symbol_id = gs.id
     LEFT JOIN documents def_d ON sym_def.document_id = def_d.id
     WHERE imp_d.relative_path = ? AND m.role = 2
     ORDER BY def_d.relative_path, gs.symbol`,
    importer,
  );
  if (rows.length > 0) {
    return rows.map((row) => ({
      symbol: row.symbol,
      shortName: shortenSymbol(row.symbol),
      fromFile: row.from_file,
    }));
  }
  return getSourceImports(db, importer).map((entry) => {
    const shortName = renderImportName(entry.importedName, entry.localName, entry.kind);
    return { symbol: shortName, shortName, fromFile: entry.sourcePath };
  });
}

function renderImportName(
  importedName: string,
  localName: string | null,
  kind: 'named' | 'default' | 'namespace' | 'side-effect',
): string {
  if (kind === 'namespace' && importedName === '*' && localName) return `* as ${localName}`;
  if (kind === 'default' && localName) return `default as ${localName}`;
  if (kind === 'side-effect') return '(side effect import)';
  if (localName && localName !== importedName) return `${importedName} as ${localName}`;
  return importedName;
}

function resolveIndexedDefinitions(
  db: ScipDatabase,
  index: ProjectIndex,
  query: string,
): { matches: IndexedDefinition[]; total: number; omitted: number } {
  const resolution = resolveSymbol(db, query);
  if (!resolution.match) return { matches: [], total: 0, omitted: 0 };
  const candidates = [
    resolution.match,
    ...resolution.candidates.map((candidate) => resolveSymbol(db, candidate.symbol).match),
  ].filter((candidate): candidate is SymbolMatch => candidate !== null);
  const matches = new Map<string, IndexedDefinition>();
  for (const candidate of candidates) {
    const definition = index
      .definitionsForFile(candidate.relativePath)
      .find((item) => item.symbol === candidate.symbol);
    if (definition) matches.set(definition.symbol, definition);
  }
  return {
    matches: [...matches.values()],
    total: resolution.total,
    omitted: Math.max(0, resolution.total - matches.size),
  };
}

function anchorCandidate(definition: IndexedDefinition): SystemMapAnchorCandidate {
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    relativePath: definition.relativePath,
    startLine: definition.startLine,
    endLine: definition.endLine,
  };
}

function addRelation(relations: Map<string, PendingRelation>, relation: PendingRelation): void {
  const key = [
    relation.kind,
    relation.fromFile,
    relation.fromSymbol ?? '',
    relation.toFile,
    relation.toSymbol ?? '',
    relation.line ?? '',
  ].join('\u0000');
  relations.set(key, relation);
}

function isBoundaryImport(fromFile: string, toFile: string, workspaces: readonly StructuralWorkspace[]): boolean {
  const fromWorkspace = workspaceForFile(fromFile, workspaces);
  const toWorkspace = workspaceForFile(toFile, workspaces);
  if (fromWorkspace.relativeDir !== toWorkspace.relativeDir) return true;
  return /(?:^|\/)(?:contracts?|schemas?|db\/schema)(?:\/|$)/u.test(toFile);
}

function sameBoundaryRegion(leftFile: string, rightFile: string, workspaces: readonly StructuralWorkspace[]): boolean {
  return regionIdentity(leftFile, workspaces).id === regionIdentity(rightFile, workspaces).id;
}

function referenceSiteIsInScope(
  state: SymbolState,
  siteFile: string,
  files: ReadonlyMap<string, FileState>,
  workspaces: readonly StructuralWorkspace[],
): boolean {
  if (state.referenceScope === 'all') return true;
  const siteRegionId = regionIdentity(siteFile, workspaces).id;
  const inForwardRegion = [...files.values()].some(
    (file) => file.promoteBoundaryImports && regionIdentity(file.file, workspaces).id === siteRegionId,
  );
  if (inForwardRegion) return true;
  if (state.referenceScope !== 'cross-workspace-or-forward') return false;
  return (
    workspaceForFile(siteFile, workspaces).relativeDir !==
    workspaceForFile(state.definition.relativePath, workspaces).relativeDir
  );
}

function widerReferenceScope(left: SystemMapReferenceScope, right: SystemMapReferenceScope): SystemMapReferenceScope {
  const rank: Record<SystemMapReferenceScope, number> = {
    none: 0,
    'forward-regions': 1,
    'cross-workspace-or-forward': 2,
    all: 3,
  };
  return rank[left] >= rank[right] ? left : right;
}

function workspaceForFile(file: string, workspaces: readonly StructuralWorkspace[]): StructuralWorkspace {
  return (
    workspaces.find((candidate) => file === candidate.relativeDir || file.startsWith(`${candidate.relativeDir}/`)) ?? {
      name: 'root',
      relativeDir: '',
    }
  );
}

function inferIndexedWorkspaces(files: readonly string[]): StructuralWorkspace[] {
  const workspaceContainers = new Set(['apps', 'packages', 'services', 'crates', 'libs', 'tools']);
  const workspaces = new Map<string, StructuralWorkspace>();
  for (const file of files) {
    const parts = file.split('/').filter(Boolean);
    if (parts.length < 3 || !workspaceContainers.has(parts[0]!)) continue;
    const relativeDir = `${parts[0]}/${parts[1]}`;
    workspaces.set(relativeDir, { name: parts[1]!, relativeDir });
  }
  return [...workspaces.values()].sort((left, right) => right.relativeDir.length - left.relativeDir.length);
}

function regionIdentity(file: string, workspaces: readonly StructuralWorkspace[]): RegionIdentity {
  const workspace = workspaceForFile(file, workspaces);
  const withinWorkspace = workspace.relativeDir ? file.slice(workspace.relativeDir.length + 1) : file;
  const parts = withinWorkspace.split('/').filter(Boolean);
  if (parts[0] === 'src') parts.shift();
  const structuralPath = structuralRegionPath(parts);
  const packageId = workspace.relativeDir || 'root';
  return {
    id: `region:${packageId}:${structuralPath}`,
    label: `${workspace.name}:${structuralPath}`,
    workspace: workspace.name,
    structuralPath,
  };
}

function structuralRegionPath(parts: readonly string[]): string {
  if (parts.length <= 1) return 'root';
  const first = parts[0]!;
  const second = parts[1]!;
  if (['components', 'features', 'modules'].includes(first)) return `${first}/${second}`;
  if (first === 'db') return `${first}/${second}`;
  if (['contracts', 'routes', 'services'].includes(first)) return first;
  if (first === 'tests' || first === '__tests__') return 'tests';
  return first;
}

function buildRegions(
  files: ReadonlyMap<string, FileState>,
  symbols: ReadonlyMap<string, SymbolState>,
  literalHits: readonly SystemMapLiteralHit[],
  relations: readonly SystemMapRelation[],
  regionRelations: readonly SystemMapRegionRelation[],
  regionForFile: ReadonlyMap<string, RegionIdentity>,
  expandedIds: ReadonlySet<string>,
): SystemMapRegion[] {
  const fileBuckets = groupBy([...files.values()], (state) => regionForFile.get(state.file)!.id);
  const symbolBuckets = groupBy([...symbols.values()], (state) => regionForFile.get(state.definition.relativePath)!.id);
  const hitBuckets = groupBy(literalHits, (hit) => regionForFile.get(hit.file)!.id);
  const relationBuckets = new Map<string, SystemMapRelation[]>();
  for (const relation of relations) {
    for (const regionId of new Set([relation.fromRegionId, relation.toRegionId])) {
      const bucket = relationBuckets.get(regionId) ?? [];
      bucket.push(relation);
      relationBuckets.set(regionId, bucket);
    }
  }
  const incoming = groupBy(regionRelations, (relation) => relation.toRegionId);
  const outgoing = groupBy(regionRelations, (relation) => relation.fromRegionId);

  return [...fileBuckets.entries()]
    .map(([regionId, fileStates]): SystemMapRegion => {
      const identity = regionForFile.get(fileStates[0]!.file)!;
      const symbolStates = symbolBuckets.get(regionId) ?? [];
      const hits = hitBuckets.get(regionId) ?? [];
      const regionalRelations = relationBuckets.get(regionId) ?? [];
      const expanded = expandedIds.has(regionId);
      const notableSymbols = symbolStates
        .map(publicNotableSymbol)
        .sort(compareNotableSymbols)
        .slice(0, NOTABLE_SYMBOL_LIMIT);
      const testFileCount = fileStates.filter((state) => classifyFile(state.file) === 'test').length;
      return {
        id: regionId,
        label: identity.label,
        workspace: identity.workspace,
        structuralPath: identity.structuralPath,
        minDepth: Math.min(...fileStates.map((state) => state.depth)),
        fileCount: fileStates.length,
        sourceFileCount: fileStates.length - testFileCount,
        testFileCount,
        symbolCount: symbolStates.length,
        literalHitCount: hits.length,
        anchorQueries: uniqueSorted([
          ...hits.map((hit) => hit.query),
          ...symbolStates.flatMap((state) => [...state.anchorQueries]),
        ]),
        relationKinds: uniqueSorted(regionalRelations.map((relation) => relation.kind)),
        incomingRegionIds: uniqueSorted((incoming.get(regionId) ?? []).map((relation) => relation.fromRegionId)),
        outgoingRegionIds: uniqueSorted((outgoing.get(regionId) ?? []).map((relation) => relation.toRegionId)),
        memberCallCandidateRelationCount: regionalRelations.filter(
          (relation) => relation.evidence === 'ast-member-import-candidate',
        ).length,
        notableSymbols,
        omittedNotableSymbols: Math.max(0, symbolStates.length - notableSymbols.length),
        expanded,
        files: expanded ? fileStates.map(publicFile).sort(compareFiles) : [],
        symbols: expanded ? symbolStates.map(publicSymbol).sort(compareSymbols) : [],
        literalHits: expanded ? [...hits].sort(compareLiteralHits) : [],
        relations: expanded ? [...regionalRelations].sort(compareRelations) : [],
      };
    })
    .sort((left, right) => left.minDepth - right.minDepth || left.label.localeCompare(right.label));
}

function publicFile(state: FileState): SystemMapFile {
  return {
    file: state.file,
    kind: classifyFile(state.file),
    depth: state.depth,
    origins: uniqueSorted([...state.origins]),
  };
}

function publicSymbol(state: SymbolState): SystemMapSymbol {
  return {
    symbol: state.definition.symbol,
    shortName: shortenSymbol(state.definition.symbol),
    file: state.definition.relativePath,
    startLine: state.definition.startLine,
    endLine: state.definition.endLine,
    depth: state.depth,
    origins: uniqueSorted([...state.origins]),
    anchorQueries: uniqueSorted([...state.anchorQueries]),
    referenceExpansion: state.referenceScope !== 'none',
    referenceScope: state.referenceScope,
  };
}

function publicNotableSymbol(state: SymbolState): SystemMapNotableSymbol {
  return {
    shortName: shortenSymbol(state.definition.symbol),
    file: state.definition.relativePath,
    origins: uniqueSorted([...state.origins]),
  };
}

function collapseRegionRelations(relations: readonly SystemMapRelation[]): SystemMapRegionRelation[] {
  const buckets = groupBy(
    relations.filter((relation) => relation.fromRegionId !== relation.toRegionId),
    (relation) => `${relation.fromRegionId}\u0000${relation.toRegionId}`,
  );
  return [...buckets.values()]
    .map(
      (bucket): SystemMapRegionRelation => ({
        fromRegionId: bucket[0]!.fromRegionId,
        toRegionId: bucket[0]!.toRegionId,
        kinds: uniqueSorted(bucket.map((relation) => relation.kind)),
        relationCount: bucket.length,
        fromFiles: uniqueSorted(bucket.map((relation) => relation.fromFile)),
        toFiles: uniqueSorted(bucket.map((relation) => relation.toFile)),
        fromSymbols: uniqueSorted(
          bucket.flatMap((relation) => (relation.fromSymbol ? [shortenSymbol(relation.fromSymbol)] : [])),
        ),
        toSymbols: uniqueSorted(
          bucket.flatMap((relation) => (relation.toSymbol ? [shortenSymbol(relation.toSymbol)] : [])),
        ),
        evidence: uniqueSorted(bucket.map((relation) => relation.evidence)),
        strengths: uniqueSorted(bucket.map((relation) => relation.strength ?? 'unknown')),
      }),
    )
    .sort(
      (left, right) =>
        left.fromRegionId.localeCompare(right.fromRegionId) || left.toRegionId.localeCompare(right.toRegionId),
    );
}

function buildExternalBoundaries(
  externalImports: ReadonlyMap<string, { name: string; fromFiles: ReadonlySet<string> }>,
  regionForFile: ReadonlyMap<string, RegionIdentity>,
): SystemMapExternalBoundary[] {
  return [...externalImports.values()]
    .map(
      (boundary): SystemMapExternalBoundary => ({
        kind: 'external-import',
        name: boundary.name,
        fromRegionIds: uniqueSorted(
          [...boundary.fromFiles].flatMap((file) => {
            const region = regionForFile.get(file);
            return region ? [region.id] : [];
          }),
        ),
        fromFiles: uniqueSorted([...boundary.fromFiles]),
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function matchedRegionIds(
  anchor: SystemMapAnchor,
  literalHits: readonly SystemMapLiteralHit[],
  symbols: ReadonlyMap<string, SymbolState>,
  regionForFile: ReadonlyMap<string, RegionIdentity>,
): string[] {
  const files =
    anchor.kind === 'literal'
      ? literalHits.filter((hit) => hit.query === anchor.query).map((hit) => hit.file)
      : [...symbols.values()]
          .filter((state) => state.anchorQueries.has(anchor.query))
          .map((state) => state.definition.relativePath);
  return uniqueSorted(files.map((file) => regionForFile.get(file)?.id).filter((id): id is string => Boolean(id)));
}

function renderBoundaryAddress(observation: BoundaryObservation): string {
  return observation.keyParts.map((part) => `${part.name}=${part.value}`).join(' ');
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function groupBy<T>(values: readonly T[], keyFor: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const bucket = grouped.get(key) ?? [];
    bucket.push(value);
    grouped.set(key, bucket);
  }
  return grouped;
}

function compareRelations(left: SystemMapRelation, right: SystemMapRelation): number {
  return (
    left.fromRegionId.localeCompare(right.fromRegionId) ||
    left.toRegionId.localeCompare(right.toRegionId) ||
    left.kind.localeCompare(right.kind) ||
    left.fromFile.localeCompare(right.fromFile) ||
    left.toFile.localeCompare(right.toFile) ||
    (left.line ?? -1) - (right.line ?? -1)
  );
}

function compareNotableSymbols(left: SystemMapNotableSymbol, right: SystemMapNotableSymbol): number {
  return (
    notableOriginRank(left.origins) - notableOriginRank(right.origins) || left.shortName.localeCompare(right.shortName)
  );
}

function notableOriginRank(origins: readonly string[]): number {
  if (origins.includes('symbol-anchor')) return 0;
  if (origins.includes('literal-owner')) return 1;
  if (origins.some((origin) => origin.startsWith('boundary-import:'))) return 2;
  if (origins.includes('reference-owner')) return 3;
  return 4;
}

function compareFiles(left: SystemMapFile, right: SystemMapFile): number {
  return left.depth - right.depth || left.file.localeCompare(right.file);
}

function compareSymbols(left: SystemMapSymbol, right: SystemMapSymbol): number {
  return left.depth - right.depth || left.file.localeCompare(right.file) || left.symbol.localeCompare(right.symbol);
}

function compareLiteralHits(left: SystemMapLiteralHit, right: SystemMapLiteralHit): number {
  return left.file.localeCompare(right.file) || left.line - right.line || left.query.localeCompare(right.query);
}
