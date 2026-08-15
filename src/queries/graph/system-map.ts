import {
  classifyFile,
  isExplicitPackageSurfaceSymbol,
  rootedSymbolEvidence,
  type FileKind,
  type RootedSymbolEvidence,
} from '../../analysis/file-classifier.js';
import { readRuntimeBoundaryGraph } from '../../analysis/runtime-boundaries/index.js';
import type { BoundaryObservation } from '../../analysis/runtime-boundaries/types.js';
import { runtimeBoundarySourceScope } from '../../analysis/runtime-boundaries/source-scope.js';
import type { BoundarySourceScope } from '../../analysis/runtime-boundaries/types.js';
import { groupBy } from '../../domain/group-by.js';
import { compareSystemMapDrilldownSymbols, systemMapOriginRank } from '../../domain/system-map-origin-rank.js';
import type { IndexedDefinition, SymbolMatch, SymbolResolutionCandidate } from '../../domain/types.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { getAst, type SyntaxNode } from '../../source/ast.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { smallestSourceCallableAtLine } from '../../source/facts/source-callables.js';
import { behaviorConstructRange, governingBehaviorControlLines } from '../../source/facts/behavior-skeleton.js';
import { focusedSourceConstructRange, readableSourceUnitRange } from '../../source/facts/source-construct.js';
import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths, resolveIndexedDocumentCandidates } from '../../storage/scip-documents.js';
import { findEnclosingDefinition, getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import type { CalleeEvidenceSource } from '../../symbols/graph/call-graph-evidence.js';
import {
  importedMemberCallTargets,
  serviceDeclarationFilesForImplementation,
} from '../../symbols/graph/member-call-targets.js';
import {
  scipOccurrenceCallableReferencesForRange,
  scipOccurrenceCallTargetsForRange,
} from '../../symbols/graph/scip-occurrence-call-targets.js';
import { resolveImportedDefinitions } from '../../symbols/imported-definitions.js';
import { findIdentifierLines } from '../../symbols/identifier-index.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { isModuleLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { uniqueNonEmpty } from '../query-utils.js';
import { ProjectIndex } from '../internal/project-index.js';
import { isExportedDefinition } from '../internal/exported-definition.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../../domain/source-inspection-limits.js';
import { connectedBehaviorPacket, type ConnectedBehaviorPacket } from '../internal/connected-behavior.js';
import {
  enrichResultCallbackControlSemantics,
  systemMapNextAnchorPacket,
  type SystemMapNextAnchorPacket,
} from '../internal/next-anchor-candidates.js';
import {
  SYSTEM_MAP_RELATION_KINDS,
  systemMapRelationProgramSemantics,
  systemMapSyntheticEdgeProgramSemantics,
  type SystemMapRelationKind,
} from './system-map-edge-semantics.js';
import { programDataElementsForSystemMapRelations } from './program-data-edges.js';
import { programControlElementsForTopologyNodes } from './program-control-edges.js';
import { programStateTemporalElementsForTopologyNodes } from './program-state-temporal-edges.js';
import { buildCausalCorridor } from '../internal/causal-corridor.js';
import {
  createExplorationTopology,
  selectExplorationTopology,
  type ExplorationEvidenceSource,
  type ExplorationEvidenceStrength,
  type ExplorationFrontierGroup,
  type ExplorationSourceLocation,
  type ExplorationTopology,
  type ExplorationTopologyAnchor,
  type ExplorationTopologyEdge,
  type ExplorationTopologyNode,
} from '../internal/exploration-topology.js';

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_LITERAL_MATCH_LIMIT = 12;
const DEFAULT_LITERAL_SEED_LIMIT = 8;
const DEFAULT_ACTIVE_LITERAL_SEED_LIMIT = 3;
const LITERAL_REPRESENTATIVE_LIMIT = 8;
const LITERAL_SCOPE_COMMAND_LIMIT = 6;
const NOTABLE_SYMBOL_LIMIT = 12;
const DEFAULT_EXPANSION_REGION_LIMIT = 12;
const DEFAULT_DRILLDOWN_ANCHOR_LIMIT = 12;
const MAX_RECURSIVE_CALLER_BRANCHES = 2;
const CAUSAL_CORRIDOR_LOCAL_SIGNALS = new Set([
  'branch',
  'loop',
  'call',
  'await',
  'return',
  'throw',
  'mutation',
  'catch',
  'finally',
]);
// Leave enough of the default 32k human-output page for connected behavior,
// anchor identities, and an explicit omission ledger. The topology budget is
// independently recoverable and must not force a transport continuation.
const DEFAULT_TOPOLOGY_CHARACTERS = 9_000;
const ALL_RELATION_KINDS: readonly SystemMapRelationKind[] = SYSTEM_MAP_RELATION_KINDS;

export type SystemMapAnchorKind = 'literal' | 'symbol';
export type SystemMapAnchorStatus = 'matched' | 'ambiguous' | 'missing';
export type { SystemMapRelationKind } from './system-map-edge-semantics.js';
export type SystemMapEvidenceFloor = 'exact' | 'derived';
export type SystemMapSourceScope = BoundarySourceScope;
export type SystemMapReferenceScope = 'none' | 'all' | 'forward-regions' | 'cross-workspace-or-forward';
export type SystemMapRelationEvidence =
  | CalleeEvidenceSource
  | 'ast-constructed-member-callsite'
  | 'ast-factory-callback-callsite'
  | 'ast-service-member-callsite'
  | 'ast-member-import-candidate'
  | 'scip-occurrence-callsite'
  | 'scip-occurrence-reference'
  | 'compiler-cross-workspace-symbol'
  | 'indexed-or-source-reference'
  | 'indexed-or-source-import'
  | `runtime-boundary:${string}`;
export type SystemMapRelationStrength = ExplorationEvidenceStrength;
export type {
  ConnectedBehaviorLine,
  ConnectedBehaviorOptions,
  ConnectedBehaviorPacket,
  ConnectedBehaviorPath,
  ConnectedBehaviorRepresentation,
  ConnectedBehaviorStep,
  ConnectedBehaviorStepRole,
  ConnectedBehaviorTransition,
} from '../internal/connected-behavior.js';
export type {
  SystemMapNextAnchor,
  SystemMapNextAnchorAlternative,
  SystemMapNextAnchorPacket,
} from '../internal/next-anchor-candidates.js';

export interface SystemMapOptions {
  searches?: readonly string[];
  symbols?: readonly string[];
  behaviorFocusLocations?: readonly { file: string; line: number }[];
  maxDepth?: number;
  expand?: readonly string[];
  relations?: readonly SystemMapRelationKind[];
  evidenceFloor?: SystemMapEvidenceFloor;
  sourceScopes?: readonly SystemMapSourceScope[];
  maxTopologyCharacters?: number;
  topologyFrontiers?: readonly string[];
  /** Stable upstream route IDs to materialize together. */
  routeIds?: readonly string[];
  fullLiteralTraversal?: boolean;
  /** @deprecated Accepted as a no-op; query vocabulary no longer affects graph selection. */
  selectionTerms?: readonly string[];
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
  /** Matches actually materialized as graph traversal seeds. */
  seedMatchingLines?: number;
  /** Embedded-substring and out-of-scope matches that are not traversal eligible. */
  matchOnlyLines?: number;
  /** Matches eligible to seed traversal before a broad-selector guard is applied. */
  eligibleSeedMatchingLines?: number;
  materializedMatchingLines?: number;
  withheldMatchingLines?: number;
  literalTraversal?: 'materialized' | 'withheld-broad';
  representativeMatches?: SystemMapLiteralHit[];
  narrowingCommands?: string[];
  exhaustiveTraversalCommand?: string;
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
  ownerStartLine?: number | null;
  ownerEndLine?: number | null;
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
  /** Source-backed runtime participant used when this endpoint has no compiler symbol. */
  fromBoundaryParticipant?: SystemMapBoundaryParticipant;
  /** Source-backed runtime participant used when this endpoint has no compiler symbol. */
  toBoundaryParticipant?: SystemMapBoundaryParticipant;
  /** Exact source callable used when this endpoint has no compiler symbol. */
  fromSourceConstruct?: SystemMapSourceConstruct;
  /** Exact source callable used when this endpoint has no compiler symbol. */
  toSourceConstruct?: SystemMapSourceConstruct;
  /** Exact normalized rendezvous key that joined the runtime participants. */
  runtimeBoundaryKey?: string;
  line: number | null;
  /** Present in results produced by schema version 1 topology-aware builds. */
  strength?: SystemMapRelationStrength;
}

/** One parser-delimited callable that is absent from the compiler symbol catalog. */
export interface SystemMapSourceConstruct {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
}

/** One exact producer or consumer observation at a runtime crossing. */
export interface SystemMapBoundaryParticipant {
  observationId: string;
  action: string;
  protocol: string;
  role: string;
  /** Stable, source-derived key parts that distinguish operations sharing one owner file. */
  address?: string;
  file: string;
  line: number;
  endLine: number;
  ownerName: string | null;
  ownerSymbol: string | null;
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
  /** Exact observation context retained even when its runtime peer is unresolved. */
  protocol?: string;
  role?: string;
  modality?: 'must' | 'may' | 'unknown';
  resolution?: 'locally-linked' | 'external' | 'unresolved' | 'ambiguous';
  sourceScope?: BoundarySourceScope;
  keyParts?: Array<{ name: string; value: string; evidence: string }>;
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
  broadLiteralAnchors?: number;
  withheldLiteralMatches?: number;
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
  withheld: { symbols: number; files: number; regions: number; drillAnchors: number; literalMatches?: number };
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
  /** Graph-ordered constructs and the evidence-bearing transitions between them. */
  behavior?: ConnectedBehaviorPacket;
  /** Structurally important callable targets not yet materialized in behavior. */
  nextAnchors?: SystemMapNextAnchorPacket;
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

interface SourceConstructState extends SystemMapSourceConstruct {
  depth: number;
  origins: Set<string>;
  anchorQueries: Set<string>;
  reverseCallExpansion: boolean;
  traversalEligible: boolean;
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
  fromBoundaryParticipant?: SystemMapBoundaryParticipant;
  toBoundaryParticipant?: SystemMapBoundaryParticipant;
  fromSourceConstruct?: SystemMapSourceConstruct;
  toSourceConstruct?: SystemMapSourceConstruct;
  runtimeBoundaryKey?: string;
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
  return executeSystemMap(db, opts, 'full');
}

/**
 * Build only the canonical typed topology for an explicit system-map request.
 *
 * Unlike {@link systemMap}, this operation does not materialize connected
 * behavior, causal corridors, adjacent-recovery candidates, legacy
 * presentation, or expansion commands. Canonical graph projections use this
 * seam so compatibility-only presentation work cannot leak into their cost or
 * semantics.
 */
export function systemMapTopology(db: ScipDatabase, opts: SystemMapOptions): ExplorationTopology {
  return executeSystemMap(db, opts, 'topology');
}

function executeSystemMap(db: ScipDatabase, opts: SystemMapOptions, mode: 'full'): SystemMapResult;
function executeSystemMap(db: ScipDatabase, opts: SystemMapOptions, mode: 'topology'): ExplorationTopology;
function executeSystemMap(
  db: ScipDatabase,
  opts: SystemMapOptions,
  mode: 'full' | 'topology',
): SystemMapResult | ExplorationTopology {
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
  const reverseFileGraph = reverseFileDependencyGraph(fileGraph);
  const workspaces = inferIndexedWorkspaces(index.sourceFiles());
  const runtimeBoundaries = readRuntimeBoundaryGraph(db);
  const boundaryObservations = new Map(
    (runtimeBoundaries?.observations ?? []).map((observation) => [observation.id, observation]),
  );
  const boundaryObservationLocations = new Set(
    (runtimeBoundaries?.observations ?? []).map(
      (observation) => `${observation.source.file}\0${observation.source.startLine}`,
    ),
  );
  const representedBoundaryLinkIds = new Set<string>();
  const boundaryObservationDepths = new Map<string, number>();
  const files = new Map<string, FileState>();
  const symbols = new Map<string, SymbolState>();
  const sourceConstructs = new Map<string, SourceConstructState>();
  const literalHits: SystemMapLiteralHit[] = [];
  const pendingRelations = new Map<string, PendingRelation>();
  const externalImports = new Map<string, { name: string; fromFiles: Set<string> }>();
  const anchors: SystemMapAnchor[] = [];
  let omittedSymbolCandidates = 0;
  let broadLiteralAnchors = 0;
  let withheldLiteralMatches = 0;
  let filteredUnverifiedCallEdges = 0;
  let memberCallCandidateEdges = 0;
  let unresolvedMemberCallsites = 0;
  const reverseExpandedSourceConstructs = new Set<string>();
  const serviceCallerFilesBySourceConstruct = new Map<string, Set<string>>();
  const fullFileMemberCallTargets = new Map<string, ReturnType<typeof importedMemberCallTargets>>();
  const memberCallTargetsForWholeFile = (file: string): ReturnType<typeof importedMemberCallTargets> => {
    const cached = fullFileMemberCallTargets.get(file);
    if (cached) return cached;
    const resolved = importedMemberCallTargets(db, file, { excludeIndexedTargets: false });
    fullFileMemberCallTargets.set(file, resolved);
    return resolved;
  };

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

  const addSourceConstruct = (
    construct: SystemMapSourceConstruct,
    depth: number,
    origin: string,
    anchorQuery?: string,
    reverseCallExpansion = false,
    traversalEligible = true,
  ): SourceConstructState => {
    const key = sourceConstructKey(construct);
    const existing = sourceConstructs.get(key);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      existing.origins.add(origin);
      if (anchorQuery) existing.anchorQueries.add(anchorQuery);
      existing.reverseCallExpansion ||= reverseCallExpansion;
      existing.traversalEligible ||= traversalEligible;
      addFile(construct.file, depth, origin, existing.traversalEligible, true);
      return existing;
    }
    const state: SourceConstructState = {
      ...construct,
      depth,
      origins: new Set([origin]),
      anchorQueries: new Set(anchorQuery ? [anchorQuery] : []),
      reverseCallExpansion,
      traversalEligible,
    };
    sourceConstructs.set(key, state);
    addFile(construct.file, depth, origin, traversalEligible, true);
    return state;
  };

  const addBoundaryObservation = (observation: BoundaryObservation, depth: number, origin: string): string | null => {
    addFile(observation.source.file, depth, origin, true, true);
    if (observation.owner.file !== observation.source.file) {
      addFile(observation.owner.file, depth, `${origin}:owner`, true, true);
    }
    const definitions = getDefinitionsForFile(db, observation.owner.file);
    const declaredOwner = observation.owner.symbol
      ? resolveIndexedDefinitions(db, index, observation.owner.symbol).matches.find(
          (candidate) => candidate.relativePath === observation.owner.file,
        )
      : null;
    const owner =
      (declaredOwner && !isModuleLikeSymbol(declaredOwner.symbol) ? declaredOwner : null) ??
      findEnclosingDefinition(definitions, observation.source.startLine);
    if (owner && !isModuleLikeSymbol(owner.symbol)) {
      addSymbol(owner, depth, origin, undefined, 'none', true);
      return owner.symbol;
    }

    if (observation.owner.name) {
      addSourceConstruct(
        {
          file: observation.owner.file,
          name: observation.owner.name,
          startLine: observation.owner.startLine,
          endLine: observation.owner.endLine,
        },
        depth,
        `${origin}:source-owner`,
        undefined,
        true,
      );
    }

    const referencedHandlers = index
      .definitionsForFile(observation.source.file)
      .filter(
        (definition) =>
          Boolean(definition.leaf) &&
          findIdentifierLines(db, observation.source.file, definition.leaf!).some(
            (line) => line >= observation.source.startLine && line <= observation.source.endLine,
          ),
      );
    if (referencedHandlers.length === 1) {
      const handler = referencedHandlers[0]!;
      addSymbol(handler, depth, `${origin}:handler-identifier`, undefined, 'none', true);
      addRelation(pendingRelations, {
        kind: 'runtime-boundary',
        evidence: 'runtime-boundary:handler-identifier',
        fromFile: observation.source.file,
        fromSymbol: null,
        toFile: handler.relativePath,
        toSymbol: handler.symbol,
        fromBoundaryParticipant: boundaryParticipant(observation),
        line: observation.source.startLine,
        strength: 'derived',
      });
    }
    return null;
  };

  for (const query of searches) {
    const matches = systemMapLiteralMatches(db, index, query, boundaryObservationLocations);
    const traversalEligible = matches.filter((match) => literalMatchCanSeed(match, sourceAllowed));
    const broad =
      !opts.fullLiteralTraversal &&
      (matches.length > DEFAULT_LITERAL_MATCH_LIMIT || traversalEligible.length > DEFAULT_LITERAL_SEED_LIMIT);
    const materializedMatches = broad ? [] : matches;
    const activeTraversalSeeds = new Set(
      (broad
        ? []
        : opts.fullLiteralTraversal
          ? traversalEligible
          : [...traversalEligible]
              .sort(compareLiteralTraversalSeedCandidates)
              .slice(0, DEFAULT_ACTIVE_LITERAL_SEED_LIMIT)
      ).map(literalMatchIdentity),
    );
    if (broad) {
      broadLiteralAnchors += 1;
      withheldLiteralMatches += matches.length;
    }
    for (const match of materializedMatches) {
      const traversalSeed = activeTraversalSeeds.has(literalMatchIdentity(match));
      const sourceOwnedSeed =
        traversalSeed && !match.ownerSymbol && match.ownerStartLine !== null && match.ownerEndLine !== null;
      addFile(
        match.relativePath,
        0,
        `${traversalSeed ? 'literal-anchor' : 'literal-match'}:${query}`,
        sourceOwnedSeed,
        sourceOwnedSeed,
      );
      if (sourceOwnedSeed) {
        addSourceConstruct(
          {
            file: match.relativePath,
            name: match.ownerShortName ?? `${match.relativePath}:${match.ownerStartLine! + 1}`,
            startLine: match.ownerStartLine!,
            endLine: match.ownerEndLine!,
          },
          0,
          `literal-source-owner:${query}`,
          query,
          true,
        );
      }
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
        ownerStartLine: match.ownerStartLine,
        ownerEndLine: match.ownerEndLine,
        sourceLine: match.sourceLine.trim(),
        matchKind: match.matchKind,
        traversalSeed,
      });
    }
    anchors.push({
      kind: 'literal',
      query,
      status: matches.length > 0 ? 'matched' : 'missing',
      matchedRegionIds: [],
      matchingLines: matches.length,
      seedMatchingLines: broad ? 0 : activeTraversalSeeds.size,
      matchOnlyLines: matches.length - activeTraversalSeeds.size,
      eligibleSeedMatchingLines: traversalEligible.length,
      materializedMatchingLines: materializedMatches.length,
      withheldMatchingLines: broad ? matches.length : 0,
      literalTraversal: broad ? 'withheld-broad' : 'materialized',
      representativeMatches: broad ? selectLiteralRepresentatives(query, matches) : undefined,
      narrowingCommands: broad ? literalNarrowingCommands(query, matches) : undefined,
      exhaustiveTraversalCommand:
        broad || activeTraversalSeeds.size < traversalEligible.length
          ? `scip-query system-map --search ${shellArgument(query)} --full-literal-traversal`
          : undefined,
      seedRegionIds: [],
      matchOnlyRegionIds: [],
    });
  }

  for (const query of symbolQueries) {
    const resolution = resolveIndexedDefinitions(db, index, query);
    omittedSymbolCandidates += resolution.omitted;
    const sourceConstruct = sourceConstructForLocationQuery(db, query);
    const preciseCompilerMatches = resolution.matches.filter((definition) => !isModuleLikeSymbol(definition.symbol));
    const useSourceConstruct = sourceConstruct !== null && preciseCompilerMatches.length === 0;
    if (useSourceConstruct) addSourceConstruct(sourceConstruct, 0, 'source-construct-anchor', query, true);
    const selectedDefinitions = useSourceConstruct ? preciseCompilerMatches : resolution.matches;
    for (const definition of selectedDefinitions) addSymbol(definition, 0, 'symbol-anchor', query, 'all', true);
    const sourceCandidate = useSourceConstruct ? sourceConstructAnchorCandidate(sourceConstruct) : null;
    const totalCandidates = useSourceConstruct ? 1 : resolution.total;
    anchors.push({
      kind: 'symbol',
      query,
      status: totalCandidates === 0 ? 'missing' : totalCandidates === 1 ? 'matched' : 'ambiguous',
      matchedRegionIds: [],
      symbolCandidates: [...(sourceCandidate ? [sourceCandidate] : []), ...selectedDefinitions.map(anchorCandidate)],
      totalSymbolCandidates: totalCandidates,
      omittedSymbolCandidates: resolution.omitted,
    });
  }

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (relationPolicy.has('call')) {
      const sourceConstructFrontier = [...sourceConstructs.values()].filter(
        (state) =>
          state.traversalEligible &&
          state.reverseCallExpansion &&
          state.depth <= depth &&
          !reverseExpandedSourceConstructs.has(sourceConstructKey(state)),
      );
      for (const targetConstruct of sourceConstructFrontier) {
        reverseExpandedSourceConstructs.add(sourceConstructKey(targetConstruct));

        // Source-only callables still form a real local activation chain even
        // when the compiler emitted no symbol for a wrapped function. Admit a
        // reverse edge only when this file has one callable with the target
        // name and the call is a direct (not receiver-member) invocation. The
        // result is derived rather than exact because lexical shadowing can
        // still change runtime identity without a compiler occurrence.
        const targetFacts = getSourceFacts(db, targetConstruct.file);
        const matchingLocalDefinitions = (targetFacts?.callables ?? []).filter(
          (callable) =>
            callable.name === targetConstruct.name &&
            callable.startLine <= targetConstruct.endLine &&
            callable.endLine >= targetConstruct.startLine,
        );
        if (matchingLocalDefinitions.length === 1) {
          const localCallsites = (targetFacts?.callSites ?? []).filter(
            (callsite) => callsite.calleeLeaf === targetConstruct.name && !callsite.memberAccess,
          );
          for (const callsite of localCallsites) {
            const nextDepth = depth + 1;
            const owner = findEnclosingDefinition(getDefinitionsForFile(db, targetConstruct.file), callsite.line);
            let fromSymbol: string | null = null;
            let fromSourceConstruct: SourceConstructState | null = null;
            if (owner && !isModuleLikeSymbol(owner.symbol)) {
              if (
                owner.relativePath === targetConstruct.file &&
                owner.startLine <= targetConstruct.endLine &&
                owner.endLine >= targetConstruct.startLine
              )
                continue;
              addSymbol(owner, nextDepth, 'reverse-local-call-owner', undefined, 'forward-regions', true);
              fromSymbol = owner.symbol;
            } else {
              const callable = sourceOwnerConstructAtLine(db, targetConstruct.file, callsite.line);
              if (callable && sourceConstructKey(callable) !== sourceConstructKey(targetConstruct)) {
                fromSourceConstruct = addSourceConstruct(
                  callable,
                  nextDepth,
                  'reverse-local-call-source-owner',
                  undefined,
                  true,
                );
              }
            }
            if (!fromSymbol && !fromSourceConstruct) continue;
            addRelation(pendingRelations, {
              kind: 'call',
              evidence: 'ast-callsite',
              fromFile: targetConstruct.file,
              fromSymbol,
              toFile: targetConstruct.file,
              toSymbol: null,
              fromSourceConstruct: fromSourceConstruct ? sourceConstructIdentity(fromSourceConstruct) : undefined,
              toSourceConstruct: sourceConstructIdentity(targetConstruct),
              line: callsite.line,
              strength: 'derived',
            });
          }
        }

        const reverseCallerFiles = new Set([
          ...(reverseFileGraph.get(targetConstruct.file) ?? []),
          ...(serviceCallerFilesBySourceConstruct.get(sourceConstructKey(targetConstruct)) ?? []),
          ...serviceDeclarationFilesForImplementation(db, targetConstruct.file).flatMap((serviceFile) => [
            ...(reverseFileGraph.get(serviceFile) ?? []),
          ]),
        ]);
        for (const callerFile of reverseCallerFiles) {
          if (!sourceAllowed(callerFile)) continue;
          const memberTargets = memberCallTargetsForWholeFile(callerFile);
          const matchingCalls = memberTargets.targets.filter(
            (target) =>
              target.targetFile === targetConstruct.file &&
              target.targetStartLine <= targetConstruct.endLine &&
              target.targetEndLine >= targetConstruct.startLine,
          );
          for (const target of matchingCalls) {
            const nextDepth = depth + 1;
            const owner = findEnclosingDefinition(getDefinitionsForFile(db, callerFile), target.line);
            let fromSymbol: string | null = null;
            let fromSourceConstruct: SourceConstructState | null = null;
            if (owner && !isModuleLikeSymbol(owner.symbol)) {
              addSymbol(owner, nextDepth, 'reverse-member-call-owner', undefined, 'cross-workspace-or-forward', true);
              fromSymbol = owner.symbol;
            } else {
              const callable = sourceOwnerConstructAtLine(db, callerFile, target.line);
              if (callable) {
                fromSourceConstruct = addSourceConstruct(
                  callable,
                  nextDepth,
                  'reverse-member-call-source-owner',
                  undefined,
                  true,
                );
              }
            }
            if (!fromSymbol && !fromSourceConstruct) continue;
            addRelation(pendingRelations, {
              kind: 'call',
              evidence: 'ast-service-member-callsite',
              fromFile: callerFile,
              fromSymbol,
              toFile: targetConstruct.file,
              toSymbol: null,
              fromSourceConstruct: fromSourceConstruct ? sourceConstructIdentity(fromSourceConstruct) : undefined,
              toSourceConstruct: sourceConstructIdentity(targetConstruct),
              line: target.line,
              strength: target.strength === 'exact' ? 'exact' : 'derived',
            });
          }
        }
      }
    }

    const symbolFrontier = [...symbols.values()].filter((state) => !state.processed && state.depth <= depth);
    const structuralCallees = relationPolicy.has('call')
      ? index.calleeMap(
          symbolFrontier.map((state) => state.definition),
          { additive: false, semantic: false },
        )
      : new Map();
    for (const state of symbolFrontier) {
      state.processed = true;
      const definition = state.definition;
      if (
        state.referenceScope !== 'none' &&
        (relationPolicy.has('call') || relationPolicy.has('reference') || relationPolicy.has('contract-symbol'))
      ) {
        const referenceSites = systemMapReferenceSites(db, index, definition).filter(
          (site) => sourceAllowed(site.file) && referenceSiteIsInScope(state, site.file, files, workspaces),
        );
        const recursiveCallerSymbols = new Set(
          referenceSites
            .flatMap((site) => {
              const isCallsite =
                relationPolicy.has('call') &&
                getSourceFacts(db, site.file)?.callSites.some(
                  (callsite) => callsite.line === site.line && callsite.calleeLeaf === definition.leaf,
                ) === true;
              if (!isCallsite || !site.enclosingSymbol) return [];
              const owner = resolveIndexedDefinitions(db, index, site.enclosingSymbol).matches[0];
              return owner && !isModuleLikeSymbol(owner.symbol) ? [{ owner, site }] : [];
            })
            .sort((left, right) => {
              const targetWorkspace = workspaceForFile(definition.relativePath, workspaces).relativeDir;
              const leftLocal = workspaceForFile(left.owner.relativePath, workspaces).relativeDir === targetWorkspace;
              const rightLocal = workspaceForFile(right.owner.relativePath, workspaces).relativeDir === targetWorkspace;
              const leftPublic = publicEntryPriorityForDefinition(db, left.owner);
              const rightPublic = publicEntryPriorityForDefinition(db, right.owner);
              const leftSpan = left.owner.endLine - left.owner.startLine;
              const rightSpan = right.owner.endLine - right.owner.startLine;
              return (
                Number(rightLocal) - Number(leftLocal) ||
                rightPublic - leftPublic ||
                leftSpan - rightSpan ||
                left.owner.symbol.localeCompare(right.owner.symbol)
              );
            })
            .filter(
              (candidate, index, candidates) =>
                candidates.findIndex((other) => other.owner.symbol === candidate.owner.symbol) === index,
            )
            .reduce<Array<{ symbol: string; workspace: string }>>((selected, candidate) => {
              if (selected.length >= MAX_RECURSIVE_CALLER_BRANCHES) return selected;
              const workspace = workspaceForFile(candidate.owner.relativePath, workspaces).relativeDir;
              if (selected.some((entry) => entry.workspace === workspace)) return selected;
              selected.push({ symbol: candidate.owner.symbol, workspace });
              return selected;
            }, [])
            .map((candidate) => candidate.symbol),
        );
        for (const site of referenceSites) {
          const nextDepth = depth + 1;
          addFile(site.file, nextDepth, `reference:${shortenSymbol(definition.symbol)}`, true);
          const isCallsite =
            relationPolicy.has('call') &&
            getSourceFacts(db, site.file)?.callSites.some(
              (callsite) => callsite.line === site.line && callsite.calleeLeaf === definition.leaf,
            ) === true;
          let referenceOwnerSymbol: string | null = null;
          let referenceSourceConstruct: SourceConstructState | null = null;
          if (site.enclosingSymbol) {
            const owner = resolveIndexedDefinitions(db, index, site.enclosingSymbol).matches[0];
            if (owner && !isModuleLikeSymbol(owner.symbol)) {
              // A proven callsite is one step in the selected operation's
              // activation chain. Preserve the bounded reverse scope so the
              // next graph layer can discover its caller. Non-call references
              // remain one-hop evidence and cannot recursively fan out.
              addSymbol(
                owner,
                nextDepth,
                'reference-owner',
                undefined,
                isCallsite && recursiveCallerSymbols.has(owner.symbol) ? state.referenceScope : 'none',
              );
              referenceOwnerSymbol = owner.symbol;
            }
          }
          if (!referenceOwnerSymbol && site.line !== null) {
            const callable = sourceOwnerConstructAtLine(db, site.file, site.line);
            if (callable) {
              referenceSourceConstruct = addSourceConstruct(
                callable,
                nextDepth,
                'reference-source-owner',
                undefined,
                isCallsite,
              );
            }
          }
          if (relationPolicy.has('reference')) {
            addRelation(pendingRelations, {
              kind: 'reference',
              evidence: 'indexed-or-source-reference',
              fromFile: site.file,
              fromSymbol: referenceOwnerSymbol,
              toFile: definition.relativePath,
              toSymbol: definition.symbol,
              fromSourceConstruct: referenceSourceConstruct
                ? sourceConstructIdentity(referenceSourceConstruct)
                : undefined,
              line: site.line,
              strength: 'mixed',
            });
          }
          if (isCallsite) {
            addRelation(pendingRelations, {
              kind: 'call',
              evidence: 'ast-callsite',
              fromFile: site.file,
              fromSymbol: referenceOwnerSymbol,
              toFile: definition.relativePath,
              toSymbol: definition.symbol,
              fromSourceConstruct: referenceSourceConstruct
                ? sourceConstructIdentity(referenceSourceConstruct)
                : undefined,
              line: site.line,
              strength: 'derived',
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
              fromSymbol: referenceOwnerSymbol,
              toFile: definition.relativePath,
              toSymbol: definition.symbol,
              fromSourceConstruct: referenceSourceConstruct
                ? sourceConstructIdentity(referenceSourceConstruct)
                : undefined,
              line: site.line,
              strength: 'exact',
            });
          }
        }
      }

      for (const callee of structuralCallees.get(definition.symbolId) ?? []) {
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
      const sourceOwnedRanges = [...sourceConstructs.values()].filter(
        (construct) => construct.traversalEligible && construct.file === state.file && construct.depth <= depth,
      );
      const symbolRanges = [...symbols.values()]
        .filter((symbol) => symbol.definition.relativePath === state.file && symbol.depth <= depth)
        .map((symbol) => {
          const sourceUnit = readableSourceUnitRange(db, state.file, symbol.definition.startLine);
          return {
            startLine: sourceUnit?.startLine ?? symbol.definition.startLine,
            endLine: sourceUnit?.endLine ?? symbol.definition.endLine,
          };
        });
      const sourceSymbolAtLine = (line: number): SymbolState | undefined =>
        [...symbols.values()]
          .filter(
            (symbol) =>
              symbol.definition.relativePath === state.file &&
              symbol.definition.startLine <= line &&
              symbol.definition.endLine >= line,
          )
          .sort(
            (left, right) =>
              left.definition.endLine -
                left.definition.startLine -
                (right.definition.endLine - right.definition.startLine) ||
              left.definition.startLine - right.definition.startLine,
          )[0];
      const boundaryRanges = [...boundaryObservations.values()].filter(
        (observation) => observation.source.file === state.file && boundaryObservationDepths.has(observation.id),
      );
      const sourceTraversalRanges = [
        ...sourceOwnedRanges.map((construct) => ({
          startLine: construct.startLine,
          endLine: construct.endLine,
        })),
        ...boundaryRanges.map((observation) => ({
          ...runtimeObservationTraversalRange(db, observation),
        })),
      ];
      const traversalRanges = [...symbolRanges, ...sourceTraversalRanges];
      const sourceOwnedCallsites = (getSourceFacts(db, state.file)?.callSites ?? []).filter((callsite) =>
        traversalRanges.some((range) => callsite.line >= range.startLine && callsite.line <= range.endLine),
      );
      const compilerResolvedCallsiteKeys = new Set<string>();
      if (relationPolicy.has('call')) {
        for (const range of traversalRanges) {
          const resolved = scipOccurrenceCallTargetsForRange(db, state.file, range.startLine, range.endLine);
          for (const target of resolved.targets) {
            if (!sourceAllowed(target.definition.relativePath)) continue;
            const sourceSymbol = sourceSymbolAtLine(target.sourceLine);
            const sourceConstruct = sourceOwnedRanges.find(
              (construct) => construct.startLine <= target.sourceLine && construct.endLine >= target.sourceLine,
            );
            const boundaryObservation = boundaryRanges.find((observation) => {
              const range = runtimeObservationTraversalRange(db, observation);
              return range.startLine <= target.sourceLine && range.endLine >= target.sourceLine;
            });
            addSymbol(
              target.definition,
              depth + 1,
              `scip-occurrence-call:${state.file}:${target.sourceLine + 1}`,
              undefined,
              'none',
              true,
            );
            addRelation(pendingRelations, {
              kind: 'call',
              evidence: 'scip-occurrence-callsite',
              fromFile: state.file,
              fromSymbol: sourceSymbol?.definition.symbol ?? null,
              toFile: target.definition.relativePath,
              toSymbol: target.definition.symbol,
              fromBoundaryParticipant: boundaryObservation ? boundaryParticipant(boundaryObservation) : undefined,
              fromSourceConstruct: sourceConstruct ? sourceConstructIdentity(sourceConstruct) : undefined,
              line: target.sourceLine,
              strength: 'exact',
            });
            compilerResolvedCallsiteKeys.add(`${target.sourceLine}\u0000${target.calleeLeaf}`);
          }
        }
      }
      if (relationPolicy.has('reference')) {
        for (const range of traversalRanges) {
          const references = scipOccurrenceCallableReferencesForRange(db, state.file, range.startLine, range.endLine);
          for (const target of references.targets) {
            if (!sourceAllowed(target.definition.relativePath)) continue;
            if (compilerResolvedCallsiteKeys.has(`${target.sourceLine}\u0000${target.calleeLeaf}`)) continue;
            const sourceSymbol = sourceSymbolAtLine(target.sourceLine);
            if (sourceSymbol?.definition.symbol === target.definition.symbol) continue;
            const sourceConstruct = sourceOwnedRanges.find(
              (construct) => construct.startLine <= target.sourceLine && construct.endLine >= target.sourceLine,
            );
            const boundaryObservation = boundaryRanges.find((observation) => {
              const observationRange = runtimeObservationTraversalRange(db, observation);
              return observationRange.startLine <= target.sourceLine && observationRange.endLine >= target.sourceLine;
            });
            addSymbol(
              target.definition,
              depth + 1,
              `scip-occurrence-reference:${state.file}:${target.sourceLine + 1}`,
              undefined,
              'none',
              true,
            );
            addRelation(pendingRelations, {
              kind: 'reference',
              evidence: 'scip-occurrence-reference',
              fromFile: state.file,
              fromSymbol: sourceSymbol?.definition.symbol ?? null,
              toFile: target.definition.relativePath,
              toSymbol: target.definition.symbol,
              fromBoundaryParticipant: boundaryObservation ? boundaryParticipant(boundaryObservation) : undefined,
              fromSourceConstruct: sourceConstruct ? sourceConstructIdentity(sourceConstruct) : undefined,
              line: target.sourceLine,
              strength: 'exact',
            });
          }
        }
      }
      const memberCalls = relationPolicy.has('call')
        ? importedMemberCallTargets(db, state.file, {
            ranges: traversalRanges,
            excludeIndexedTargets: false,
          })
        : { targets: [], unresolvedCallsites: 0 };
      unresolvedMemberCallsites += memberCalls.unresolvedCallsites;
      const additionalMemberTargets = memberCalls.targets.filter(
        (target) => !compilerResolvedCallsiteKeys.has(`${target.line}\u0000${target.calleeLeaf}`),
      );
      memberCallCandidateEdges += additionalMemberTargets.filter(
        (target) =>
          target.strength !== 'exact' &&
          (target.resolution !== 'imported-service-object-member' || (target.resolutionAlternativeCount ?? 0) > 1),
      ).length;
      for (const target of additionalMemberTargets) {
        const uniquelyResolved = (target.resolutionAlternativeCount ?? 1) === 1;
        const targetDefinition = target.targetSymbol
          ? getDefinitionsForFile(db, target.targetFile).find((definition) => definition.symbol === target.targetSymbol)
          : undefined;
        const targetConstruct = targetDefinition
          ? null
          : addSourceConstruct(
              {
                file: target.targetFile,
                name: target.calleeLeaf,
                startLine: target.targetStartLine,
                endLine: target.targetEndLine,
              },
              depth + 1,
              `member-call:${state.file}`,
              undefined,
              target.resolution === 'imported-service-object-member' && uniquelyResolved,
              uniquelyResolved,
            );
        if (targetConstruct && target.serviceFile) {
          const key = sourceConstructKey(targetConstruct);
          const callers = serviceCallerFilesBySourceConstruct.get(key) ?? new Set<string>();
          for (const callerFile of reverseFileGraph.get(target.serviceFile) ?? []) callers.add(callerFile);
          serviceCallerFilesBySourceConstruct.set(key, callers);
        }
        if (targetDefinition) {
          addSymbol(targetDefinition, depth + 1, `member-call:${state.file}`, undefined, 'none', true);
        }
        const sourceConstruct = sourceOwnedRanges.find(
          (construct) => construct.startLine <= target.line && construct.endLine >= target.line,
        );
        const sourceSymbol = sourceSymbolAtLine(target.line);
        const boundaryObservation = boundaryRanges.find((observation) => {
          const range = runtimeObservationTraversalRange(db, observation);
          return range.startLine <= target.line && range.endLine >= target.line;
        });
        addRelation(pendingRelations, {
          kind: 'call',
          evidence:
            target.resolution === 'constructed-member-receiver'
              ? 'ast-constructed-member-callsite'
              : target.resolution === 'factory-callback-member'
                ? 'ast-factory-callback-callsite'
                : target.resolution === 'imported-service-object-member'
                  ? 'ast-service-member-callsite'
                  : 'ast-member-import-candidate',
          fromFile: state.file,
          fromSymbol: sourceSymbol?.definition.symbol ?? null,
          toFile: target.targetFile,
          toSymbol: targetDefinition?.symbol ?? null,
          fromBoundaryParticipant: boundaryObservation ? boundaryParticipant(boundaryObservation) : undefined,
          fromSourceConstruct: sourceConstruct ? sourceConstructIdentity(sourceConstruct) : undefined,
          toSourceConstruct: targetConstruct ? sourceConstructIdentity(targetConstruct) : undefined,
          line: target.line,
          strength:
            target.resolution === 'imported-service-object-member'
              ? (target.resolutionAlternativeCount ?? 0) === 1
                ? 'derived'
                : 'candidate'
              : (target.strength ?? 'candidate'),
        });
      }
      for (const imported of relationPolicy.has('import') || relationPolicy.has('call')
        ? systemMapImports(db, state.file)
        : []) {
        if (!imported.fromFile) {
          if (relationPolicy.has('import')) {
            const boundary = externalImports.get(imported.shortName) ?? {
              name: imported.shortName,
              fromFiles: new Set<string>(),
            };
            boundary.fromFiles.add(state.file);
            externalImports.set(imported.shortName, boundary);
          }
          continue;
        }
        if (!sourceAllowed(imported.fromFile)) continue;
        if (relationPolicy.has('import')) {
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
        }
        if (relationPolicy.has('call') && sourceOwnedCallsites.length > 0) {
          const importedDefinitions = (
            imported.source === 'compiler'
              ? resolveIndexedDefinitions(db, index, imported.symbol).matches
              : resolveImportedDefinitions(db, imported.fromFile, imported.importedName)
          ).filter((candidate) => !isModuleLikeSymbol(candidate.symbol));
          for (const importedDefinition of importedDefinitions) {
            const sourceCallLines = sourceOwnedCallsites
              .filter((callsite) => callsite.calleeLeaf === imported.localName)
              .map((callsite) => callsite.line);
            if (sourceCallLines.length === 0) continue;
            addSymbol(importedDefinition, depth + 1, `source-call:${state.file}`, undefined, 'none', true);
            for (const line of sourceCallLines) {
              addRelation(pendingRelations, {
                kind: 'call',
                evidence: 'ast-callsite',
                fromFile: state.file,
                fromSymbol: null,
                toFile: importedDefinition.relativePath,
                toSymbol: importedDefinition.symbol,
                line,
                strength: 'derived',
              });
            }
          }
        }
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
      const fromDepth = reachedObservationDepth(from, depth, boundaryObservationDepths, symbols, sourceConstructs);
      const toDepth = reachedObservationDepth(to, depth, boundaryObservationDepths, symbols, sourceConstructs);
      if (fromDepth === null && toDepth === null) continue;

      const nextDepth = depth + 1;
      const fromSymbol = addBoundaryObservation(from, fromDepth ?? nextDepth, `runtime-boundary:${link.joinRule}`);
      const toSymbol = addBoundaryObservation(to, toDepth ?? nextDepth, `runtime-boundary:${link.joinRule}`);
      const fromSourceConstruct = fromSymbol ? null : smallestSourceConstructAtObservation(sourceConstructs, from);
      const toSourceConstruct = toSymbol ? null : smallestSourceConstructAtObservation(sourceConstructs, to);
      boundaryObservationDepths.set(from.id, fromDepth ?? nextDepth);
      boundaryObservationDepths.set(to.id, toDepth ?? nextDepth);
      addRelation(pendingRelations, {
        kind: 'runtime-boundary',
        evidence: `runtime-boundary:${link.joinRule}`,
        fromFile: from.source.file,
        fromSymbol,
        toFile: to.source.file,
        toSymbol,
        fromBoundaryParticipant: boundaryParticipant(from),
        toBoundaryParticipant: boundaryParticipant(to),
        fromSourceConstruct: fromSourceConstruct ? sourceConstructIdentity(fromSourceConstruct) : undefined,
        toSourceConstruct: toSourceConstruct ? sourceConstructIdentity(toSourceConstruct) : undefined,
        runtimeBoundaryKey: link.matchedKeyParts.map((part) => `${part.name}=${part.value}`).join(' '),
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
  const directSeedRegionIds = new Set(
    [...files.values()]
      .filter((state) =>
        [...state.origins].some(
          (origin) => origin.startsWith('literal-anchor:') || origin === 'literal-owner' || origin === 'symbol-anchor',
        ),
      )
      .map((state) => regionForFile.get(state.file)!.id),
  );
  const drilldown = buildSystemMapDrilldown(regions);
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
          protocol: observation.protocol,
          role: observation.role,
          modality: observation.modality,
          resolution: observation.resolution,
          sourceScope: observation.sourceScope,
          keyParts: observation.keyParts.map((part) => ({
            name: part.name,
            value: part.value,
            evidence: part.evidence,
          })),
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
    ...(broadLiteralAnchors > 0
      ? [
          `${broadLiteralAnchors} broad literal anchor(s) withheld ${withheldLiteralMatches} exact match(es) before graph traversal; representative identities and scoped search commands preserve recovery without treating every textual occurrence as relevant.`,
        ]
      : []),
    `Literal matches outside the included source scopes (${includedSourceScopes.join(', ')}) remain visible as match-only evidence and do not seed traversal.`,
    runtimeBoundaries
      ? 'Built-in runtime-boundary extractors traverse direct and replayably derived links; heuristic candidates, unsupported frameworks, reflection, generated names, and dependency wiring not recoverable from compiler occurrences or constructor assignments remain disclosed frontiers.'
      : 'Runtime-boundary evidence is unavailable for this index; run scip-query reindex with this build to extract supported HTTP, event, registry, and persistence observations.',
    'Reverse references do not recursively expand from discovered callers or callees.',
    'Member calls use compiler occurrences, exact constructor-assigned fields, bounded unique service providers, direct factory-return members, and compiler-resolved object-literal callbacks when available. Ambiguous providers remain candidate frontiers; callback values routed through mutation, reflection, or unsupported dependency containers remain unrepresented.',
    'Literal traversal is bounded to the smallest parser-delimited source construct; parser gaps may reduce an owner to one source line and leave its continuation untraversed.',
    'Schema consumers stay within forward-flow regions; cross-workspace contracts may discover consumers in other workspaces. Add an explicit symbol anchor to widen either scope.',
    `Traversal stops after depth ${maxDepth}; nonzero frontier counts identify evidence that was discovered but not traversed.`,
    'Region labels are structural path groupings, not inferred runtime or architectural boundaries.',
  ];
  const topology = buildSystemMapTopology({
    db,
    anchors,
    regions,
    symbolStates: symbols,
    sourceConstructStates: sourceConstructs,
    literalHits,
    relations,
    externalBoundaries,
    boundaryFrontiers,
    regionForFile,
    closureStatus,
    omittedSymbolCandidates,
    maxDepth,
    requestedRelationKinds,
    evidenceFloor,
    includedSourceScopes,
    blindSpots,
    topologyFrontiers: opts.topologyFrontiers ?? [],
    routeIds: opts.routeIds ?? [],
    expandedRegionIds: [...expandedIds],
    maxTopologyCharacters,
    fullLiteralTraversal: opts.fullLiteralTraversal ?? false,
  });
  if (mode === 'topology') return topology;
  const focusedBehaviorNodes =
    (opts.behaviorFocusLocations?.length ?? 0) > 0
      ? new Set([
          ...topology.anchors.flatMap((anchor) => anchor.nodeIds),
          ...topology.paths.flatMap((path) => path.nodeIds),
        ]).size
      : undefined;
  const behavior = connectedBehaviorPacket(db, topology, {
    focusLocations: opts.behaviorFocusLocations,
    ...(focusedBehaviorNodes ? { maxSteps: focusedBehaviorNodes } : {}),
  });
  enrichResultCallbackControlSemantics(db, topology, behavior);
  const corridorFocusLocations = causalCorridorFocusLocations(
    db,
    topology,
    behavior,
    opts.behaviorFocusLocations ?? [],
  );
  topology.corridor = buildCausalCorridor(topology, { focusLocations: corridorFocusLocations });
  const nextAnchors = systemMapNextAnchorPacket(db, topology, behavior, {
    sourceAllowed,
    selectionTerms: opts.selectionTerms,
  });
  const connectorRegionIds = topologyRegionIds(topology);
  const presentation = buildSystemMapPresentation(
    searches,
    symbolQueries,
    maxDepth,
    requestedRelationKinds,
    evidenceFloor,
    includedSourceScopes,
    opts.fullLiteralTraversal ?? false,
    maxTopologyCharacters,
    regions,
    regionRelations,
    directSeedRegionIds,
    expandedIds,
    connectorRegionIds,
  );
  const expansion = buildSystemMapExpansion(
    searches,
    symbolQueries,
    maxDepth,
    regions.filter((region) => connectorRegionIds.has(region.id)),
    directSeedRegionIds,
    requestedRelationKinds,
    evidenceFloor,
    includedSourceScopes,
    opts.fullLiteralTraversal ?? false,
    maxTopologyCharacters,
  );
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
    behavior,
    nextAnchors,
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
        regions: topology.nodes.filter((node) => node.kind === 'structural-region' && node.disposition === 'folded')
          .length,
        drillAnchors: (drilldown?.omittedAnchors ?? 0) + nextAnchors.omittedAnchors,
        literalMatches: withheldLiteralMatches,
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
      broadLiteralAnchors,
      withheldLiteralMatches,
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
            'static callees plus exact SCIP call occurrences in traversed source ranges, exact constructor-assigned member receivers, and uniquely attributed direct-import member candidates',
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

function causalCorridorFocusLocations(
  db: ScipDatabase,
  topology: ExplorationTopology,
  behavior: ConnectedBehaviorPacket,
  explicitFocusLocations: readonly ExplorationSourceLocation[],
): ExplorationSourceLocation[] {
  const locations = new Map<string, ExplorationSourceLocation>();
  const add = (location: ExplorationSourceLocation): void => {
    locations.set(`${location.file}\0${location.line}`, location);
  };
  for (const location of explicitFocusLocations) add(location);
  const matchedAnchorNodeIds = new Set(
    topology.anchors.filter((anchor) => anchor.status === 'matched').flatMap((anchor) => anchor.nodeIds),
  );
  for (const step of behavior.steps) {
    if (!step.location || !matchedAnchorNodeIds.has(step.nodeId) || (step.behavior?.rawCharacters ?? Infinity) > 3_000)
      continue;
    for (const line of step.behavior?.lines ?? []) {
      if (!line.signals.some((signal) => CAUSAL_CORRIDOR_LOCAL_SIGNALS.has(signal))) continue;
      add({ file: step.location.file, line: line.line, endLine: line.endLine });
    }
  }
  const selectedEvidenceLocations = topology.edges
    .filter((edge) => edge.disposition === 'emitted')
    .flatMap((edge) => edge.evidence.flatMap((evidence) => (evidence.location ? [evidence.location] : [])));
  for (const location of selectedEvidenceLocations) {
    add(location);
    const owner = topology.nodes
      .filter(
        (node) =>
          node.location?.file === location.file &&
          ['symbol', 'source-construct', 'runtime-boundary-participant'].includes(node.kind) &&
          node.location.line <= location.line &&
          (node.location.endLine ?? node.location.line) >= location.line,
      )
      .sort(
        (left, right) =>
          (left.location!.endLine ?? left.location!.line) -
            left.location!.line -
            ((right.location!.endLine ?? right.location!.line) - right.location!.line) ||
          left.id.localeCompare(right.id),
      )[0];
    if (!owner?.location) continue;
    const governingLines = governingBehaviorControlLines(
      db,
      location.file,
      owner.location.line,
      owner.location.endLine ?? owner.location.line,
      [location.line],
    );
    for (const line of governingLines) add({ file: location.file, line: line.line, endLine: line.endLine });
  }
  return [...locations.values()].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

interface SystemMapTopologyInput {
  db: ScipDatabase;
  anchors: readonly SystemMapAnchor[];
  regions: readonly SystemMapRegion[];
  symbolStates: ReadonlyMap<string, SymbolState>;
  sourceConstructStates: ReadonlyMap<string, SourceConstructState>;
  literalHits: readonly SystemMapLiteralHit[];
  relations: readonly SystemMapRelation[];
  externalBoundaries: readonly SystemMapExternalBoundary[];
  boundaryFrontiers: readonly SystemMapBoundaryFrontier[];
  regionForFile: ReadonlyMap<string, RegionIdentity>;
  closureStatus: SystemMapQueryClosure['status'];
  omittedSymbolCandidates: number;
  maxDepth: number;
  requestedRelationKinds: readonly SystemMapRelationKind[];
  evidenceFloor: SystemMapEvidenceFloor;
  includedSourceScopes: readonly BoundarySourceScope[];
  blindSpots: readonly string[];
  topologyFrontiers: readonly string[];
  routeIds: readonly string[];
  expandedRegionIds: readonly string[];
  maxTopologyCharacters: number;
  fullLiteralTraversal: boolean;
}

type SourceConstructHit = SystemMapSourceConstruct;

function sourceConstructHit(hit: SystemMapLiteralHit): SourceConstructHit {
  if (hit.ownerStartLine === null || hit.ownerStartLine === undefined) {
    throw new Error(`Literal hit ${hit.file}:${hit.line + 1} has no source-owner start line.`);
  }
  if (hit.ownerEndLine === null || hit.ownerEndLine === undefined) {
    throw new Error(`Literal hit ${hit.file}:${hit.line + 1} has no source-owner end line.`);
  }
  return {
    file: hit.file,
    name: hit.ownerShortName ?? `${hit.file}:${hit.ownerStartLine + 1}`,
    startLine: hit.ownerStartLine,
    endLine: hit.ownerEndLine,
  };
}

function sourceConstructKey(construct: SystemMapSourceConstruct): string {
  return `${construct.file}\u0000${construct.startLine}\u0000${construct.endLine}\u0000${construct.name}`;
}

function sourceConstructIdentity(construct: SystemMapSourceConstruct): SystemMapSourceConstruct {
  return {
    file: construct.file,
    name: construct.name,
    startLine: construct.startLine,
    endLine: construct.endLine,
  };
}

/**
 * Give every topology node one callable identity even when traversal used
 * several narrow line-focused slices of that callable. Relations retain their
 * exact evidence lines, so behavior can render one compact multi-line connector
 * slice instead of repeating the enclosing function for every callsite.
 */
function canonicalSourceConstruct(db: ScipDatabase, construct: SystemMapSourceConstruct): SystemMapSourceConstruct {
  const callable = smallestSourceCallableAtLine(getSourceFacts(db, construct.file)?.callables ?? [], construct.startLine);
  if (callable && callable.endLine >= construct.endLine) {
    return {
      file: construct.file,
      name:
        /^source@\d+$/u.test(callable.name) && !/^source@\d+$/u.test(construct.name) ? construct.name : callable.name,
      startLine: callable.startLine,
      endLine: callable.endLine,
    };
  }
  const binding = sourceBindingOwnerAtLine(db, construct.file, construct.startLine);
  if (binding && binding.endLine >= construct.endLine) {
    return {
      file: construct.file,
      name: binding.name,
      startLine: binding.startLine,
      endLine: binding.endLine,
    };
  }
  return sourceConstructIdentity(construct);
}

function sourceConstructTopologyNodeId(hit: SourceConstructHit): string {
  return topologyId('source-construct', hit.file, String(hit.startLine), String(hit.endLine), hit.name);
}

function publicEntryEvidenceForDefinition(
  db: ScipDatabase,
  definition: IndexedDefinition,
): { evidence: RootedSymbolEvidence[]; priority: number } {
  const evidence = rootedSymbolEvidence(db, definition.symbol, definition.relativePath);
  const packageEvidence = new Set<RootedSymbolEvidence>(['package-surface-file', 'transitive-package-surface']);
  const filtered = evidence.filter((item) => !packageEvidence.has(item) || isExportedDefinition(db, definition));
  const nonPackageEvidence = filtered.some((item) => !packageEvidence.has(item));
  return {
    evidence: filtered,
    priority:
      nonPackageEvidence || isExplicitPackageSurfaceSymbol(db, definition.symbol, definition.relativePath) ? 2 : 1,
  };
}

function publicEntryPriorityForDefinition(db: ScipDatabase, definition: IndexedDefinition): number {
  const result = publicEntryEvidenceForDefinition(db, definition);
  return result.evidence.length > 0 ? result.priority : 0;
}

function publicEntryForSourceConstruct(
  db: ScipDatabase,
  construct: SourceConstructHit,
): { evidence: RootedSymbolEvidence[]; priority: number } {
  const definitions = getDefinitionsForFile(db, construct.file);
  const containingDefinitions = definitions
    .filter((definition) => definition.startLine <= construct.startLine && definition.endLine >= construct.startLine)
    .sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
    );
  for (const definition of containingDefinitions) {
    const result = publicEntryEvidenceForDefinition(db, definition);
    if (result.evidence.length > 0) return result;
  }
  for (const owner of syntaxDeclarationOwnersAtLine(db, construct.file, construct.startLine)) {
    const matchingDefinitions = definitions
      .filter((definition) => definition.leaf === owner.name)
      .sort(
        (left, right) =>
          Math.abs(left.startLine - owner.startLine) - Math.abs(right.startLine - owner.startLine) ||
          left.symbol.localeCompare(right.symbol),
      );
    for (const definition of matchingDefinitions) {
      const result = publicEntryEvidenceForDefinition(db, definition);
      if (result.evidence.length > 0) return result;
    }
    // The nearest named declaration owns this construct. If that declaration
    // is private, a wider exported declaration is only lexical containment,
    // not evidence that the nested construct is externally callable.
    return { evidence: [], priority: 0 };
  }
  return { evidence: [], priority: 0 };
}

/**
 * Declaration owners are named source declarations whose syntax encloses a
 * location. They connect an anonymous nested callback to the exported binding
 * that publishes the containing object, even when the compiler records that
 * binding's definition range as only its declaration line.
 */
function syntaxDeclarationOwnersAtLine(
  db: ScipDatabase,
  relativePath: string,
  line: number,
): Array<{ name: string; startLine: number }> {
  const root = getAst(db, relativePath)?.rootNode;
  if (!root || root.startPosition.row > line || root.endPosition.row < line) return [];
  const owners: Array<{ name: string; startLine: number }> = [];
  let current: SyntaxNode | null = deepestSyntaxNodeAtLine(root, line);
  while (current) {
    if (
      current.type === 'variable_declarator' ||
      current.type === 'function_declaration' ||
      current.type === 'generator_function_declaration' ||
      current.type === 'class_declaration'
    ) {
      const name = current.childForFieldName('name') ?? current.namedChild(0);
      if (name?.type === 'identifier' || name?.type === 'type_identifier') {
        owners.push({ name: name.text, startLine: current.startPosition.row });
      }
    }
    current = current.parent;
  }
  return owners;
}

function systemMapTopologySourceConstructHits(input: SystemMapTopologyInput): SourceConstructHit[] {
  return [
    ...new Map(
      [...input.sourceConstructStates.values()]
        .map((state) => canonicalSourceConstruct(input.db, state))
        .map((construct) => [sourceConstructKey(construct), construct]),
    ).values(),
  ].sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.startLine - right.startLine || left.endLine - right.endLine,
  );
}

function systemMapTopologyAnchors(
  input: SystemMapTopologyInput,
  sourceConstructHits: readonly SourceConstructHit[],
): ExplorationTopologyAnchor[] {
  return input.anchors.map((anchor, index) => {
    const id = topologyId('anchor', String(index), anchor.kind, anchor.query);
    const symbolNodeIds = [...input.symbolStates.values()]
      .filter((state) => state.anchorQueries.has(anchor.query))
      .flatMap((state) => {
        if (!isModuleLikeSymbol(state.definition.symbol)) return [symbolTopologyNodeId(state.definition.symbol)];
        const containedSourceNodes = sourceConstructHits
          .filter((hit) => hit.file === state.definition.relativePath)
          .map((hit) => sourceConstructTopologyNodeId(hit));
        return containedSourceNodes.length > 0 ? containedSourceNodes : [symbolTopologyNodeId(state.definition.symbol)];
      });
    const explicitSourceNodeIds = [...input.sourceConstructStates.values()]
      .filter((state) => state.anchorQueries.has(anchor.query))
      .map((state) => sourceConstructTopologyNodeId(canonicalSourceConstruct(input.db, state)));
    const literalOwnerNodeIds = input.literalHits
      .filter(
        (hit) =>
          hit.query === anchor.query &&
          hit.traversalSeed === true &&
          hit.ownerSymbol &&
          input.symbolStates.has(hit.ownerSymbol),
      )
      .map((hit) => symbolTopologyNodeId(hit.ownerSymbol!));
    const literalSourceNodeIds = input.literalHits
      .filter(
        (hit) =>
          hit.query === anchor.query &&
          hit.traversalSeed === true &&
          !hit.ownerSymbol &&
          hit.ownerStartLine !== null &&
          hit.ownerStartLine !== undefined &&
          hit.ownerEndLine !== null &&
          hit.ownerEndLine !== undefined,
      )
      .map((hit) => sourceConstructTopologyNodeId(canonicalSourceConstruct(input.db, sourceConstructHit(hit))));
    const matchedNodeIds = uniqueSorted(
      anchor.kind === 'symbol'
        ? [...symbolNodeIds, ...explicitSourceNodeIds]
        : literalOwnerNodeIds.length + literalSourceNodeIds.length > 0
          ? [...literalOwnerNodeIds, ...literalSourceNodeIds]
          : (anchor.seedRegionIds ?? []),
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
}

function indexTopologyAnchorIdsByNode(anchors: readonly ExplorationTopologyAnchor[]): Map<string, string[]> {
  const anchorIdsByNode = new Map<string, string[]>();
  for (const anchor of anchors) {
    for (const nodeId of [...anchor.nodeIds, ...anchor.candidateNodeIds]) {
      const ids = anchorIdsByNode.get(nodeId) ?? [];
      ids.push(anchor.id);
      anchorIdsByNode.set(nodeId, ids);
    }
  }
  return anchorIdsByNode;
}

function systemMapTopologyOwnerNodes(
  input: SystemMapTopologyInput,
  sourceConstructHits: readonly SourceConstructHit[],
  anchorIdsByNode: ReadonlyMap<string, string[]>,
): ExplorationTopologyNode[] {
  const boundaryOwnerNames = input.relations.flatMap((relation) =>
    [relation.fromBoundaryParticipant, relation.toBoundaryParticipant].flatMap((participant) =>
      participant?.ownerName ? [participant] : [],
    ),
  );

  const nodes: ExplorationTopologyNode[] = input.regions.map((region) => ({
    id: region.id,
    kind: 'structural-region',
    label: region.label,
    disposition: 'folded',
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
    const publicEntry = publicEntryEvidenceForDefinition(input.db, state.definition);
    nodes.push({
      id,
      kind: 'symbol',
      label: shortenSymbol(state.definition.symbol),
      disposition: (anchorIdsByNode.get(id)?.length ?? 0) > 0 ? 'emitted' : 'folded',
      location: {
        file: state.definition.relativePath,
        line: state.definition.startLine,
        endLine: state.definition.endLine,
      },
      anchorIds: uniqueSorted(anchorIdsByNode.get(id) ?? []),
      attributes: {
        regionId,
        depth: state.depth,
        leaf: state.definition.leaf ?? shortenSymbol(state.definition.symbol),
        referenceScope: state.referenceScope,
        ...(publicEntry.evidence.length > 0
          ? {
              publicEntry: true,
              publicEntryPriority: publicEntry.priority,
              publicEntryEvidence: publicEntry.evidence.join(','),
            }
          : {}),
      },
    });
  }
  for (const hit of sourceConstructHits) {
    const regionId = input.regionForFile.get(hit.file)?.id;
    if (!regionId) throw new Error(`Source construct ${hit.name} has no structural region.`);
    const id = sourceConstructTopologyNodeId(hit);
    const boundaryOwnerName = boundaryOwnerNames.find(
      (participant) =>
        participant.file === hit.file && participant.line >= hit.startLine && participant.line <= hit.endLine,
    )?.ownerName;
    const label = boundaryOwnerName ?? hit.name;
    const publicEntry = publicEntryForSourceConstruct(input.db, hit);
    nodes.push({
      id,
      kind: 'source-construct',
      label,
      disposition: (anchorIdsByNode.get(id)?.length ?? 0) > 0 ? 'emitted' : 'folded',
      location: { file: hit.file, line: hit.startLine, endLine: hit.endLine },
      anchorIds: uniqueSorted(anchorIdsByNode.get(id) ?? []),
      attributes: {
        regionId,
        leaf: label,
        sourceOwned: true,
        ...(publicEntry.evidence.length > 0
          ? {
              publicEntry: true,
              publicEntryPriority: publicEntry.priority,
              publicEntryEvidence: publicEntry.evidence.join(','),
            }
          : {}),
      },
    });
  }
  const boundaryParticipants = new Map<string, SystemMapBoundaryParticipant>();
  for (const relation of input.relations) {
    if (relation.fromBoundaryParticipant) {
      boundaryParticipants.set(relation.fromBoundaryParticipant.observationId, relation.fromBoundaryParticipant);
    }
    if (relation.toBoundaryParticipant) {
      boundaryParticipants.set(relation.toBoundaryParticipant.observationId, relation.toBoundaryParticipant);
    }
  }
  for (const participant of [...boundaryParticipants.values()].sort((left, right) =>
    left.observationId.localeCompare(right.observationId),
  )) {
    const regionId = input.regionForFile.get(participant.file)?.id;
    if (!regionId)
      throw new Error(`Runtime-boundary participant ${participant.observationId} has no structural region.`);
    nodes.push({
      id: runtimeBoundaryParticipantTopologyNodeId(participant.observationId),
      kind: 'runtime-boundary-participant',
      label: participant.address || participant.ownerName || `${participant.role} ${participant.action}`,
      disposition: 'folded',
      location: { file: participant.file, line: participant.line, endLine: participant.endLine },
      anchorIds: [],
      attributes: {
        regionId,
        action: participant.action,
        protocol: participant.protocol,
        role: participant.role,
        ...(participant.address ? { address: participant.address } : {}),
        ownerSymbol: participant.ownerSymbol,
      },
    });
  }
  return nodes;
}

function systemMapTopologyRelationEndpoint(
  db: ScipDatabase,
  knownNodeIds: ReadonlySet<string>,
  sourceConstructsByFile: ReadonlyMap<string, SourceConstructHit[]>,
  symbol: string | null,
  participant: SystemMapBoundaryParticipant | undefined,
  explicitSourceConstruct: SystemMapSourceConstruct | undefined,
  regionId: string,
  file: string,
  line: number | null,
  preferParticipant = false,
): string {
  const symbolNodeId = symbol ? symbolTopologyNodeId(symbol) : null;
  if (symbolNodeId && knownNodeIds.has(symbolNodeId) && !isModuleLikeSymbol(symbol!)) return symbolNodeId;
  const participantNodeId = participant ? runtimeBoundaryParticipantTopologyNodeId(participant.observationId) : null;
  if (preferParticipant && participantNodeId && knownNodeIds.has(participantNodeId)) return participantNodeId;
  const explicitSourceNodeId = explicitSourceConstruct
    ? sourceConstructTopologyNodeId(canonicalSourceConstruct(db, explicitSourceConstruct))
    : null;
  if (explicitSourceNodeId && knownNodeIds.has(explicitSourceNodeId)) return explicitSourceNodeId;
  if (participantNodeId && knownNodeIds.has(participantNodeId)) return participantNodeId;
  const sourceConstruct =
    line === null
      ? null
      : ((sourceConstructsByFile.get(file) ?? [])
          .filter((hit) => hit.startLine <= line && hit.endLine >= line)
          .sort(
            (left, right) =>
              left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
          )[0] ?? null);
  if (sourceConstruct) return sourceConstructTopologyNodeId(sourceConstruct);
  if (symbolNodeId && knownNodeIds.has(symbolNodeId)) return symbolNodeId;
  return regionId;
}

function systemMapTopologyRelationEdges(
  input: SystemMapTopologyInput,
  nodes: readonly ExplorationTopologyNode[],
  sourceConstructHits: readonly SourceConstructHit[],
): ExplorationTopologyEdge[] {
  const knownNodeIds = new Set(nodes.map((node) => node.id));
  const sourceConstructsByFile = groupBy(sourceConstructHits, (hit) => hit.file);
  const relationEndpoint = (
    symbol: string | null,
    participant: SystemMapBoundaryParticipant | undefined,
    explicitSourceConstruct: SystemMapSourceConstruct | undefined,
    regionId: string,
    file: string,
    line: number | null,
    preferParticipant = false,
  ): string =>
    systemMapTopologyRelationEndpoint(
      input.db,
      knownNodeIds,
      sourceConstructsByFile,
      symbol,
      participant,
      explicitSourceConstruct,
      regionId,
      file,
      line,
      preferParticipant,
    );
  const edges: ExplorationTopologyEdge[] = [];
  for (const state of input.symbolStates.values()) {
    const regionId = input.regionForFile.get(state.definition.relativePath)?.id;
    if (!regionId) continue;
    const symbolNodeId = symbolTopologyNodeId(state.definition.symbol);
    edges.push({
      id: topologyId('edge', 'structural-membership', regionId, symbolNodeId),
      kind: 'structural-membership',
      fromNodeId: regionId,
      toNodeId: symbolNodeId,
      directed: true,
      disposition: 'folded',
      semantics: systemMapSyntheticEdgeProgramSemantics('structural-membership'),
      evidence: [
        {
          method: 'indexed-definition-file',
          strength: 'exact',
          identity: state.definition.symbol,
          location: {
            file: state.definition.relativePath,
            line: state.definition.startLine,
            endLine: state.definition.endLine,
          },
        },
      ],
    });
  }
  const groupedRelations = groupBy(
    input.relations,
    (relation) =>
      `${relationEndpoint(relation.fromSymbol, relation.fromBoundaryParticipant, relation.fromSourceConstruct, relation.fromRegionId, relation.fromFile, relation.line, relation.kind === 'runtime-boundary')}\u0000${relationEndpoint(relation.toSymbol, relation.toBoundaryParticipant, relation.toSourceConstruct, relation.toRegionId, relation.toFile, null)}\u0000${relation.kind}`,
  );
  const attachedBoundaryObservations = new Set<string>();
  for (const bucket of groupedRelations.values()) {
    const first = bucket[0]!;
    const fromNodeId = relationEndpoint(
      first.fromSymbol,
      first.fromBoundaryParticipant,
      first.fromSourceConstruct,
      first.fromRegionId,
      first.fromFile,
      first.line,
      first.kind === 'runtime-boundary',
    );
    const toNodeId = relationEndpoint(
      first.toSymbol,
      first.toBoundaryParticipant,
      first.toSourceConstruct,
      first.toRegionId,
      first.toFile,
      null,
    );
    if (first.kind === 'runtime-boundary' && first.fromBoundaryParticipant) {
      const participantNodeId = runtimeBoundaryParticipantTopologyNodeId(first.fromBoundaryParticipant.observationId);
      const concreteFromNodeId = relationEndpoint(
        first.fromSymbol,
        undefined,
        first.fromSourceConstruct,
        first.fromRegionId,
        first.fromFile,
        first.line,
      );
      if (concreteFromNodeId !== participantNodeId && !attachedBoundaryObservations.has(participantNodeId)) {
        attachedBoundaryObservations.add(participantNodeId);
        edges.push({
          id: topologyId('edge', 'boundary-observation', concreteFromNodeId, participantNodeId),
          kind: 'boundary-observation',
          fromNodeId: concreteFromNodeId,
          toNodeId: participantNodeId,
          directed: true,
          disposition: 'folded',
          semantics: systemMapSyntheticEdgeProgramSemantics('boundary-observation'),
          evidence: [
            {
              method: 'runtime-boundary-observation-owner',
              strength: first.strength ?? 'unknown',
              identity: first.fromBoundaryParticipant.observationId,
              location: {
                file: first.fromBoundaryParticipant.file,
                line: first.fromBoundaryParticipant.line,
                endLine: first.fromBoundaryParticipant.endLine,
              },
            },
          ],
        });
      }
    }
    const selfNode = fromNodeId === toNodeId ? nodes.find((node) => node.id === fromNodeId) : null;
    if (selfNode?.kind === 'structural-region') continue;
    edges.push({
      id: topologyId('edge', first.kind, fromNodeId, toNodeId),
      kind: first.kind,
      fromNodeId,
      toNodeId,
      directed: true,
      disposition: 'folded',
      semantics: systemMapRelationProgramSemantics(first),
      evidence: uniqueExplorationEvidence(
        bucket.map((relation) => ({
          method: relation.evidence,
          strength: relation.strength ?? 'unknown',
          identity:
            relation.kind === 'runtime-boundary' && relation.runtimeBoundaryKey
              ? relation.runtimeBoundaryKey
              : `${relation.fromSymbol ?? relation.fromFile} -> ${relation.toSymbol ?? relation.toFile}`,
          location: relation.line === null ? null : { file: relation.fromFile, line: relation.line },
        })),
      ),
    });
  }
  return edges;
}

function appendSystemMapExternalBoundariesAndFrontiers(
  input: SystemMapTopologyInput,
  nodes: ExplorationTopologyNode[],
  edges: ExplorationTopologyEdge[],
): ExplorationFrontierGroup[] {
  for (const boundary of input.externalBoundaries) {
    const nodeId = topologyId('external', boundary.kind, boundary.name);
    const fromNodeIds = uniqueSorted(boundary.fromRegionIds);
    nodes.push({
      id: nodeId,
      kind: boundary.kind,
      label: boundary.name,
      disposition: 'folded',
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
        disposition: 'folded',
        semantics: systemMapSyntheticEdgeProgramSemantics('external-import'),
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
  return frontiers;
}

function selectAndAugmentSystemMapTopology(
  completeTopology: ExplorationTopology,
  input: SystemMapTopologyInput,
): ExplorationTopology {
  const expandProgramFacts = input.topologyFrontiers.some((frontierId) => frontierId === 'frontier:program-facts');
  const selectedTopology = selectExplorationTopology(completeTopology, {
    expandedFrontierIds: input.topologyFrontiers.filter((frontierId) => frontierId !== 'frontier:program-facts'),
    routeIds: input.routeIds,
  });
  const selectedOwnerNodes = selectedTopology.nodes.filter(
    (node) =>
      node.disposition === 'emitted' ||
      selectedTopology.anchors.some((anchor) => anchor.status === 'matched' && anchor.nodeIds.includes(node.id)),
  );
  const selectedRelations = input.relations.filter((relation) =>
    selectedOwnerNodes.some((node) => relationTouchesSelectedOwner(relation, node)),
  );
  const selectedRuntimeObservations = input.boundaryFrontiers.filter((observation) =>
    selectedOwnerNodes.some((node) => runtimeObservationTouchesSelectedOwner(observation, node)),
  );
  const programData = programDataElementsForSystemMapRelations(input.db, selectedRelations, selectedOwnerNodes);
  const programControl = programControlElementsForTopologyNodes(input.db, selectedOwnerNodes);
  const programStateTemporal = programStateTemporalElementsForTopologyNodes(
    input.db,
    selectedOwnerNodes,
    selectedRuntimeObservations,
  );
  const programNodes = [...programData.nodes, ...programControl.nodes, ...programStateTemporal.nodes].map((node) =>
    expandProgramFacts && node.disposition === 'folded' ? { ...node, disposition: 'emitted' as const } : node,
  );
  const programEdges = [...programData.edges, ...programControl.edges, ...programStateTemporal.edges].map((edge) =>
    expandProgramFacts && edge.disposition === 'folded' ? { ...edge, disposition: 'emitted' as const } : edge,
  );
  const programFrontier = expandProgramFacts
    ? null
    : programFactFrontier(selectedOwnerNodes, programNodes, programEdges);
  const augmentedTopology = createExplorationTopology({
    anchors: selectedTopology.anchors,
    nodes: [...selectedTopology.nodes, ...programNodes],
    edges: [...selectedTopology.edges, ...programEdges],
    paths: selectedTopology.paths,
    frontiers: [
      ...selectedTopology.frontiers,
      ...programData.frontiers,
      ...programControl.frontiers,
      ...programStateTemporal.frontiers,
      ...(programFrontier ? [programFrontier] : []),
    ],
    scope: selectedTopology.coverage.scope,
    blindSpots: [
      ...selectedTopology.coverage.blindSpots,
      ...programData.blindSpots,
      ...programControl.blindSpots,
      ...programStateTemporal.blindSpots,
    ],
    incompleteReasons: selectedTopology.coverage.status === 'incomplete' ? [selectedTopology.coverage.explanation] : [],
    ...(selectedTopology.routeCatalog ? { routeCatalog: selectedTopology.routeCatalog } : {}),
  });
  augmentedTopology.completion = selectedTopology.completion;
  for (const frontier of augmentedTopology.frontiers) {
    if (frontier.disposition !== 'folded') continue;
    if (frontier.id.startsWith('frontier:program-facts:')) continue;
    frontier.expansion = systemMapFrontierExpansionCommand(input, frontier.id);
  }
  return augmentedTopology;
}

function buildSystemMapTopology(input: SystemMapTopologyInput): ExplorationTopology {
  const sourceConstructHits = systemMapTopologySourceConstructHits(input);
  const anchors = systemMapTopologyAnchors(input, sourceConstructHits);
  const nodes = systemMapTopologyOwnerNodes(input, sourceConstructHits, indexTopologyAnchorIdsByNode(anchors));
  const edges = systemMapTopologyRelationEdges(input, nodes, sourceConstructHits);
  const frontiers = appendSystemMapExternalBoundariesAndFrontiers(input, nodes, edges);
  return selectAndAugmentSystemMapTopology(
    createExplorationTopology({
      anchors,
      nodes,
      edges,
      paths: [],
      frontiers,
      scope: `explicit anchors; relations ${input.requestedRelationKinds.join(', ')}; depth ${input.maxDepth}; evidence floor ${input.evidenceFloor}; source scopes ${input.includedSourceScopes.join(', ')}`,
      blindSpots: [...input.blindSpots],
      incompleteReasons:
        input.closureStatus === 'incomplete'
          ? [`${input.omittedSymbolCandidates} ambiguous symbol candidate(s) were omitted`]
          : [],
    }),
    input,
  );
}

function relationTouchesSelectedOwner(relation: SystemMapRelation, node: ExplorationTopologyNode): boolean {
  if (relation.fromSymbol && node.id === symbolTopologyNodeId(relation.fromSymbol)) return true;
  if (relation.toSymbol && node.id === symbolTopologyNodeId(relation.toSymbol)) return true;
  if (!node.location) return false;
  const endLine = node.location.endLine ?? node.location.line;
  return (
    (node.location.file === relation.fromFile &&
      relation.line !== null &&
      relation.line >= node.location.line &&
      relation.line <= endLine) ||
    node.location.file === relation.toFile
  );
}

function runtimeObservationTouchesSelectedOwner(
  observation: SystemMapBoundaryFrontier,
  node: ExplorationTopologyNode,
): boolean {
  if (!node.location || node.location.file !== observation.file) return false;
  const endLine = node.location.endLine ?? node.location.line;
  return (
    (observation.line >= node.location.line && observation.line <= endLine) ||
    node.label === observation.ownerShortName ||
    (typeof observation.ownerShortName === 'string' && node.label.includes(observation.ownerShortName))
  );
}

function programFactFrontier(
  ownerNodes: readonly ExplorationTopologyNode[],
  programNodes: readonly ExplorationTopologyNode[],
  programEdges: readonly ExplorationTopologyEdge[],
): ExplorationFrontierGroup | null {
  const memberNodeIds = uniqueSorted(
    programNodes.filter((node) => node.disposition === 'folded').map((node) => node.id),
  );
  const edgeIds = uniqueSorted(programEdges.filter((edge) => edge.disposition === 'folded').map((edge) => edge.id));
  if (memberNodeIds.length === 0 && edgeIds.length === 0) return null;
  return {
    id: topologyId('frontier', 'program-facts'),
    kind: 'program-facts',
    direction: 'outgoing',
    fromNodeIds: uniqueSorted(ownerNodes.map((node) => node.id)),
    edgeIds,
    memberNodeIds,
    memberCount: memberNodeIds.length,
    disposition: 'folded',
    reason: 'Control, data, state, and temporal facts are folded beneath the selected high-level owners.',
    expansion: null,
  };
}

function systemMapFrontierExpansionCommand(input: SystemMapTopologyInput, frontierId: string): string {
  const selectors = [
    ...input.anchors.flatMap((anchor) =>
      anchor.kind === 'literal'
        ? [`--search ${shellArgument(anchor.query)}`]
        : [`--symbol ${shellArgument(anchor.query)}`],
    ),
    `--depth ${input.maxDepth}`,
    ...input.requestedRelationKinds.map((relation) => `--relation ${shellArgument(relation)}`),
    `--evidence-floor ${shellArgument(input.evidenceFloor)}`,
    ...input.includedSourceScopes.map((scope) => `--source-scope ${shellArgument(scope)}`),
    ...(input.fullLiteralTraversal ? ['--full-literal-traversal'] : []),
    `--topology-characters ${input.maxTopologyCharacters}`,
    ...input.expandedRegionIds.map((regionId) => `--expand ${shellArgument(regionId)}`),
    ...input.topologyFrontiers.map((id) => `--frontier ${shellArgument(id)}`),
    ...input.routeIds.map((id) => `--route ${shellArgument(id)}`),
    `--frontier ${shellArgument(frontierId)}`,
  ];
  return `scip-query system-map ${selectors.join(' ')}`;
}

function topologyRegionIds(topology: ExplorationTopology): Set<string> {
  const regionIds = new Set<string>();
  for (const node of topology.nodes) {
    if (node.disposition !== 'emitted') continue;
    if (node.kind === 'structural-region') regionIds.add(node.id);
    const regionId = node.attributes['regionId'];
    if (typeof regionId === 'string') regionIds.add(regionId);
  }
  return regionIds;
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
  fullLiteralTraversal: boolean,
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
    ...(fullLiteralTraversal ? ['--full-literal-traversal'] : []),
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
  fullLiteralTraversal: boolean,
  maxCharacters: number,
  regions: readonly SystemMapRegion[],
  regionRelations: readonly SystemMapRegionRelation[],
  directSeedRegionIds: ReadonlySet<string>,
  expandedIds: ReadonlySet<string>,
  preferredRegionIds?: ReadonlySet<string>,
): SystemMapPresentation {
  const rankedRegions = [...regions]
    .sort((left, right) => compareExpansionRegions(left, right, directSeedRegionIds))
    .filter((region) => !preferredRegionIds || preferredRegionIds.has(region.id) || expandedIds.has(region.id));
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
  const complete =
    rankedRegions.every((region) => selectedRegionIds.has(region.id)) &&
    relationKeys.length === eligibleRelations.length;
  const selectors = [
    ...searches.map((search) => `--search ${shellArgument(search)}`),
    ...symbols.map((symbol) => `--symbol ${shellArgument(symbol)}`),
    `--depth ${maxDepth}`,
    ...relations.map((relation) => `--relation ${shellArgument(relation)}`),
    `--evidence-floor ${shellArgument(evidenceFloor)}`,
    ...sourceScopes.map((scope) => `--source-scope ${shellArgument(scope)}`),
    ...(fullLiteralTraversal ? ['--full-literal-traversal'] : []),
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
      const symbol = (symbolsByFile.get(file.file) ?? []).sort(compareSystemMapDrilldownSymbols)[0];
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
    return Math.min(5, ...symbols.map((symbol) => systemMapOriginRank(symbol.origins)));
  };
  return (
    kindRank(left) - kindRank(right) ||
    directLiteralRank(left) - directLiteralRank(right) ||
    originRank(left) - originRank(right) ||
    left.depth - right.depth ||
    left.file.localeCompare(right.file)
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
  ownerStartLine: number | null;
  ownerEndLine: number | null;
  matchKind: 'exact-value' | 'boundary' | 'embedded';
  seedPriority: number;
}

function systemMapLiteralMatches(
  db: ScipDatabase,
  index: ProjectIndex,
  pattern: string,
  boundaryObservationLocations: ReadonlySet<string>,
): LiteralMatch[] {
  const matches: LiteralMatch[] = [];
  for (const relativePath of indexedDocumentPaths(db, { includeIgnored: false })) {
    const lines = getSourceLines(db, relativePath);
    if (lines.length === 0) continue;
    const definitions = index.definitionsForFile(relativePath);
    const callables = getSourceFacts(db, relativePath)?.callables ?? [];
    for (let line = 0; line < lines.length; line += 1) {
      const sourceLine = lines[line] ?? '';
      if (!sourceLine.includes(pattern)) continue;
      const owner = findEnclosingDefinition(definitions, line);
      const callableOwner = smallestSourceCallableAtLine(callables, line);
      const preciseCompilerOwner = owner && !isModuleLikeSymbol(owner.symbol) ? owner : null;
      const enclosingStartLine =
        preciseCompilerOwner?.startLine ?? callableOwner?.startLine ?? owner?.startLine ?? line;
      const enclosingEndLine = preciseCompilerOwner?.endLine ?? callableOwner?.endLine ?? owner?.endLine ?? line;
      const focusedOwner = focusedSourceConstructRange(db, relativePath, line, enclosingStartLine, enclosingEndLine);
      const runtimeObservation = boundaryObservationLocations.has(`${relativePath}\0${line}`);
      const executableOwner = Boolean(preciseCompilerOwner?.isFunctionLike || callableOwner);
      matches.push({
        relativePath,
        line,
        sourceLine,
        ownerSymbol: preciseCompilerOwner?.symbol ?? null,
        ownerShortName: preciseCompilerOwner
          ? shortenSymbol(preciseCompilerOwner.symbol)
          : (callableOwner?.name ?? (owner ? shortenSymbol(owner.symbol) : null)),
        ownerStartLine: focusedOwner.startLine,
        ownerEndLine: focusedOwner.endLine,
        matchKind: literalMatchKind(sourceLine, pattern),
        seedPriority: runtimeObservation ? 0 : executableOwner ? 1 : 2,
      });
    }
  }
  return matches;
}

function compareLiteralTraversalSeedCandidates(left: LiteralMatch, right: LiteralMatch): number {
  const matchKindRank = { 'exact-value': 0, boundary: 1, embedded: 2 } as const;
  return (
    left.seedPriority - right.seedPriority ||
    matchKindRank[left.matchKind] - matchKindRank[right.matchKind] ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.line - right.line
  );
}

function literalMatchIdentity(match: LiteralMatch): string {
  return `${match.relativePath}\0${match.line}`;
}

function sourceOwnerConstructAtLine(
  db: ScipDatabase,
  relativePath: string,
  line: number,
): SystemMapSourceConstruct | null {
  const callable = smallestSourceCallableAtLine(getSourceFacts(db, relativePath)?.callables ?? [], line);
  const owner = callable ?? sourceBindingOwnerAtLine(db, relativePath, line);
  if (!owner) return null;
  const range = focusedSourceConstructRange(db, relativePath, line, owner.startLine, owner.endLine);
  return {
    file: relativePath,
    name: owner.name,
    startLine: range.startLine,
    endLine: range.endLine,
  };
}

function sourceBindingOwnerAtLine(
  db: ScipDatabase,
  relativePath: string,
  line: number,
): { name: string; startLine: number; endLine: number } | null {
  const root = getAst(db, relativePath)?.rootNode;
  if (!root || root.startPosition.row > line || root.endPosition.row < line) return null;
  let current: SyntaxNode | null = deepestSyntaxNodeAtLine(root, line);
  while (current) {
    if (current.type === 'variable_declarator') {
      const name = current.childForFieldName('name') ?? current.namedChild(0);
      const value = current.childForFieldName('value') ?? current.namedChild(1);
      if (name?.type === 'identifier' && value && syntaxCallableContainsLine(value, line)) {
        return {
          name: name.text,
          startLine: current.startPosition.row,
          endLine: current.endPosition.row,
        };
      }
    }
    if (current.type === 'pair') {
      const key = current.childForFieldName('key') ?? current.namedChild(0);
      const value = current.childForFieldName('value') ?? current.namedChild(1);
      const name = key?.text.replace(/^(?:['"])(.*)(?:['"])$/u, '$1');
      if (name && value && /^[A-Za-z_$][\w$]*$/u.test(name) && syntaxCallableContainsLine(value, line)) {
        return {
          name,
          startLine: current.startPosition.row,
          endLine: current.endPosition.row,
        };
      }
    }
    current = current.parent;
  }
  const readable = readableSourceUnitRange(db, relativePath, line);
  return readable ? { name: `source@${line + 1}`, startLine: readable.startLine, endLine: readable.endLine } : null;
}

function syntaxCallableContainsLine(node: SyntaxNode, line: number): boolean {
  if (
    ['arrow_function', 'function_expression', 'generator_function', 'generator_function_declaration'].includes(
      node.type,
    ) &&
    node.startPosition.row <= line &&
    node.endPosition.row >= line
  ) {
    return true;
  }
  return node.namedChildren.some(
    (child) =>
      child.startPosition.row <= line && child.endPosition.row >= line && syntaxCallableContainsLine(child, line),
  );
}

function deepestSyntaxNodeAtLine(node: SyntaxNode, line: number): SyntaxNode {
  const child = node.namedChildren
    .filter((candidate) => candidate.startPosition.row <= line && candidate.endPosition.row >= line)
    .sort(
      (left, right) =>
        left.endIndex - left.startIndex - (right.endIndex - right.startIndex) ||
        left.startPosition.row - right.startPosition.row,
    )[0];
  return child ? deepestSyntaxNodeAtLine(child, line) : node;
}

function sourceConstructForLocationQuery(db: ScipDatabase, query: string): SystemMapSourceConstruct | null {
  const match = query.match(/^(.+):(\d+)(?:-(\d+))?$/u);
  if (!match) return null;
  const relativePath = resolveIndexedDocumentCandidates(db, match[1]!, { allowMultiple: false })[0]?.relativePath;
  if (!relativePath) return null;
  const startLine = Math.max(0, Number.parseInt(match[2]!, 10) - 1);
  const endLine = match[3] ? Math.max(startLine, Number.parseInt(match[3], 10) - 1) : startLine;
  const callable = (getSourceFacts(db, relativePath)?.callables ?? [])
    .filter((candidate) => candidate.startLine <= startLine && candidate.endLine >= endLine)
    .sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
    )[0];
  if (!callable) return null;
  return {
    file: relativePath,
    name: callable.name,
    startLine: callable.startLine,
    endLine: callable.endLine,
  };
}

function sourceConstructAnchorCandidate(construct: SystemMapSourceConstruct): SystemMapAnchorCandidate {
  return {
    symbol: `source-construct:${construct.file}:${construct.startLine}:${construct.endLine}:${construct.name}`,
    shortName: construct.name,
    relativePath: construct.file,
    startLine: construct.startLine,
    endLine: construct.endLine,
  };
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

function literalMatchCanSeed(match: LiteralMatch, sourceAllowed: (file: string) => boolean): boolean {
  return (
    match.matchKind !== 'embedded' &&
    sourceAllowed(match.relativePath) &&
    (runtimeBoundarySourceScope(match.relativePath) !== 'production' || isTraversalSource(match.relativePath))
  );
}

function selectLiteralRepresentatives(query: string, matches: readonly LiteralMatch[]): SystemMapLiteralHit[] {
  const ranked = [...matches].sort(compareLiteralRepresentativeCandidates);
  const selected: LiteralMatch[] = [];
  const representedFiles = new Set<string>();
  for (const match of ranked) {
    if (representedFiles.has(match.relativePath)) continue;
    selected.push(match);
    representedFiles.add(match.relativePath);
    if (selected.length >= LITERAL_REPRESENTATIVE_LIMIT) break;
  }
  for (const match of ranked) {
    if (selected.length >= LITERAL_REPRESENTATIVE_LIMIT) break;
    if (selected.includes(match)) continue;
    selected.push(match);
  }
  return selected.map((match) => ({
    query,
    file: match.relativePath,
    line: match.line,
    ownerSymbol: match.ownerSymbol,
    ownerShortName: match.ownerShortName,
    ownerStartLine: match.ownerStartLine,
    ownerEndLine: match.ownerEndLine,
    sourceLine: match.sourceLine.trim(),
    matchKind: match.matchKind,
    traversalSeed: false,
  }));
}

function compareLiteralRepresentativeCandidates(left: LiteralMatch, right: LiteralMatch): number {
  const matchKindRank = { 'exact-value': 0, boundary: 1, embedded: 2 } as const;
  return (
    matchKindRank[left.matchKind] - matchKindRank[right.matchKind] ||
    Number(right.ownerSymbol !== null) - Number(left.ownerSymbol !== null) ||
    Number(!isTraversalSource(left.relativePath)) - Number(!isTraversalSource(right.relativePath)) ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.line - right.line
  );
}

function literalNarrowingCommands(query: string, matches: readonly LiteralMatch[]): string[] {
  const counts = new Map<string, number>();
  for (const match of matches) {
    const scope = literalRecoveryScope(match.relativePath);
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  return [...counts]
    .sort(
      ([leftScope, leftCount], [rightScope, rightCount]) =>
        rightCount - leftCount || leftScope.localeCompare(rightScope),
    )
    .slice(0, LITERAL_SCOPE_COMMAND_LIMIT)
    .map(([scope]) => `scip-query search ${shellArgument(query)} --scope ${shellArgument(scope)}`);
}

function literalRecoveryScope(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length <= 1) return relativePath;
  const directories = parts.slice(0, -1);
  const sourceIndex = directories.lastIndexOf('src');
  if (sourceIndex >= 0) return directories.slice(0, Math.min(directories.length, sourceIndex + 3)).join('/');
  return directories.slice(0, Math.min(directories.length, 3)).join('/');
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
  importedName: string;
  localName: string;
  fromFile: string | null;
  source: 'compiler' | 'parsed-source';
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
      importedName: leafNameFromShortSymbol(shortenSymbol(row.symbol)),
      localName: leafNameFromShortSymbol(shortenSymbol(row.symbol)),
      fromFile: row.from_file,
      source: 'compiler' as const,
    }));
  }
  return getSourceImports(db, importer).map((entry) => {
    const shortName = renderImportName(entry.importedName, entry.localName, entry.kind);
    const localName = entry.localName ?? entry.importedName;
    const importedName = entry.importedName === 'default' ? localName : entry.importedName;
    return {
      symbol: shortName,
      shortName,
      importedName,
      localName,
      fromFile: entry.sourcePath,
      source: 'parsed-source' as const,
    };
  });
}

function leafNameFromShortSymbol(shortName: string): string {
  const leaf = shortName.slice(shortName.lastIndexOf(':') + 1).replace(/\(\)$/u, '');
  return leaf || shortName;
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
    relation.fromBoundaryParticipant?.observationId ?? '',
    relation.toBoundaryParticipant?.observationId ?? '',
    relation.fromSourceConstruct ? sourceConstructKey(relation.fromSourceConstruct) : '',
    relation.toSourceConstruct ? sourceConstructKey(relation.toSourceConstruct) : '',
    relation.runtimeBoundaryKey ?? '',
    relation.line ?? '',
  ].join('\u0000');
  relations.set(key, relation);
}

function boundaryParticipant(observation: BoundaryObservation): SystemMapBoundaryParticipant {
  return {
    observationId: observation.id,
    action: observation.action,
    protocol: observation.protocol,
    role: observation.role,
    address: renderBoundaryAddress(observation),
    file: observation.source.file,
    line: observation.source.startLine,
    endLine: observation.source.endLine,
    ownerName: observation.owner.name,
    ownerSymbol: observation.owner.symbol,
  };
}

function runtimeObservationTraversalRange(
  db: ScipDatabase,
  observation: BoundaryObservation,
): { startLine: number; endLine: number } {
  const sourceLines = getSourceLines(db, observation.source.file);
  return behaviorConstructRange(db, observation.source.file, 0, Math.max(0, sourceLines.length - 1), [
    observation.source.startLine,
  ]);
}

function smallestSourceConstructAtObservation(
  sourceConstructs: ReadonlyMap<string, SourceConstructState>,
  observation: BoundaryObservation,
): SourceConstructState | null {
  const constructs = [...sourceConstructs.values()];
  for (const location of [observation.owner, observation.source]) {
    const match = constructs
      .filter(
        (construct) =>
          construct.file === location.file &&
          construct.startLine <= location.startLine &&
          construct.endLine >= location.startLine,
      )
      .sort(
        (left, right) =>
          left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
      )[0];
    if (match) return match;
  }
  return null;
}

function reachedObservationDepth(
  observation: BoundaryObservation,
  maxDepth: number,
  explicitDepths: ReadonlyMap<string, number>,
  symbols: ReadonlyMap<string, SymbolState>,
  sourceConstructs: ReadonlyMap<string, SourceConstructState>,
): number | null {
  const reachedDepths: number[] = [];
  const explicitDepth = explicitDepths.get(observation.id);
  if (explicitDepth !== undefined && explicitDepth <= maxDepth) reachedDepths.push(explicitDepth);

  for (const state of symbols.values()) {
    if (state.depth > maxDepth) continue;
    const definition = state.definition;
    if (boundaryObservationLocationReached(definition, observation)) {
      reachedDepths.push(state.depth);
    }
  }

  for (const construct of sourceConstructs.values()) {
    if (construct.depth > maxDepth) continue;
    if (boundaryObservationLocationReached(construct, observation)) {
      reachedDepths.push(construct.depth);
    }
  }

  return reachedDepths.length > 0 ? Math.min(...reachedDepths) : null;
}

function boundaryObservationLocationReached(
  range: { relativePath?: string; file?: string; startLine: number; endLine: number },
  observation: BoundaryObservation,
): boolean {
  const file = range.relativePath ?? range.file;
  return [observation.owner, observation.source].some(
    (location) =>
      file === location.file && range.startLine <= location.startLine && range.endLine >= location.startLine,
  );
}

function runtimeBoundaryParticipantTopologyNodeId(observationId: string): string {
  return topologyId('runtime-boundary-participant', observationId);
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

function reverseFileDependencyGraph(graph: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
  const reversed = new Map<string, Set<string>>();
  for (const [fromFile, toFiles] of graph) {
    for (const toFile of toFiles) {
      const callers = reversed.get(toFile) ?? new Set<string>();
      callers.add(fromFile);
      reversed.set(toFile, callers);
    }
  }
  return reversed;
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


function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
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
    systemMapOriginRank(left.origins) - systemMapOriginRank(right.origins) || left.shortName.localeCompare(right.shortName)
  );
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
