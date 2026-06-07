// ── Query Result Types ─────────────────────────────────────

export interface StatsResult {
  documents: number;
  symbols: number;
  definitions: number;
  references: number;
  indexSizeBytes: number;
  lastBuilt: Date | null;
}

export interface FileResult {
  relativePath: string;
}

export interface SymbolResult {
  startLine: number;
  endLine: number;
  symbol: string;
  shortName: string;
  signature: string | null;
}

export interface MethodResult {
  startLine: number;
  endLine: number;
  name: string;
}

export interface RefResult {
  relativePath: string;
  line: number;
}

export interface DepResult {
  relativePath: string;
}

export interface TraceResult {
  definitions: Array<{
    relativePath: string;
    startLine: number;
    endLine: number;
    signature: string | null;
    source: string | null;
  }>;
  referencedBy: Array<{
    relativePath: string;
    line: number;
    enclosingSymbol: string | null;
    enclosingShort: string;
  }>;
}

export interface SystemResult {
  files: string[];
  symbols: SymbolResult[];
  dependsOn: string[];
  dependedOnBy: string[];
}

export interface SurfaceResult {
  consumer: string;
  symbol: string;
  shortName: string;
}

export interface DeadSymbolResult {
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
  symbol: string;
  shortName: string;
  sameFileRefs: number;
  kind: 'dead-code' | 'file-internal';
}

export interface DeadSummary {
  symbols: DeadSymbolResult[];
  totalCount: number;
  /** Symbols with zero references anywhere — safe to delete */
  deadCodeCount: number;
  /** Symbols referenced only within their own file — no cross-file consumers.
   *  May be private helpers (fine) or forgotten exports (needs review). */
  fileInternalCount: number;
  totalLoc: number;
}

// ── Hotspot / Fan / Coupling Types ─────────────────────────

export interface HotspotResult {
  symbol: string;
  shortName: string;
  refCount: number;
  fileCount: number;
  definedIn: string;
}

export interface ImportResult {
  symbol: string;
  shortName: string;
  fromFile: string;
}

export interface UnusedImportResult {
  symbol: string;
  shortName: string;
  importedIn: string;
}

export interface OutlineNode {
  symbol: string;
  shortName: string;
  startLine: number;
  endLine: number;
  children: OutlineNode[];
}

export interface MemberResult {
  symbol: string;
  shortName: string;
  startLine: number;
  endLine: number;
  kind: string;
}

export interface FanResult {
  name: string;
  count: number;
}

export interface CouplingResult {
  file1: string;
  file2: string;
  sharedSymbols: number;
}

export interface CycleResult {
  /** Files forming a cycle, in order */
  path: string[];
  /**
   * Classification of the cycle:
   *   - 'real':            architectural cycle worth fixing
   *   - 'module-hierarchy': barrel-file pattern (mod.rs / index.ts /
   *                        __init__.py declaring children that re-import
   *                        parent re-exports). Standard module structure,
   *                        not actionable.
   */
  kind: 'real' | 'module-hierarchy';
}

// ── Bottleneck / Isolated / Chain Types ───────────────────

export interface BottleneckResult {
  symbol: string;
  shortName: string;
  fanIn: number;
  fanOut: number;
  /** fanIn * fanOut — higher = more central coupling hub */
  score: number;
  definedIn: string;
}

export interface IsolatedResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
}

export interface ByKindResult {
  symbol: string;
  shortName: string;
  kind: number;
  kindName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
}

export interface DeepChainResult {
  /** Files in the chain, from leaf to root */
  chain: string[];
  depth: number;
}

export interface HierarchyNode {
  symbol: string;
  shortName: string;
  depth: number;
}

export interface CallGraphResult {
  symbol: string;
  shortName: string;
  /** Symbols that call this one (incoming) */
  callers: Array<{ symbol: string; shortName: string; file: string }>;
  /** Symbols called by this one (outgoing) */
  callees: Array<{ symbol: string; shortName: string; file: string }>;
}

// ── Drift / Wrapper / Passthrough / Stale / Complexity Types

export interface DriftResult {
  file: string;
  kind: 'unused-import' | 'layer-violation' | 'pattern-deviation';
  description: string;
  /** The dependency involved */
  dep: string;
  /** For layer violations: the expected layer boundary */
  detail?: string;
}

export interface DriftSummary {
  results: DriftResult[];
  unusedImports: number;
  layerViolations: number;
  patternDeviations: number;
}

export interface WrapperCandidate {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  singleCaller: string;
  singleCallerShort: string;
  callerFanIn: number;
}

export interface PassthroughCandidate {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  forwardsTo: string;
  forwardsToShort: string;
  forwardsToFile: string;
}

export interface StaleAbstraction {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  /**
   * Cross-file consumers NOT counting files that only re-export the symbol
   * through a barrel (`export { X } from '...'`). Barrel files expand the
   * public surface; they aren't real consumers.
   */
  consumers: number;
  /** Number of files whose only reference is a passthrough re-export. */
  barrelConsumers: number;
  /** What the definition is syntactically — detected from source at the definition line. */
  kind: 'class' | 'interface' | 'type' | 'enum' | 'other';
  /**
   * Does the defining file itself reference the type outside its own declaration?
   * `false` is the strongest stale signal — the type lives in a file that never
   * uses it (misplaced types file), while another file is its only consumer.
   */
  definerUsesType: boolean;
  /**
   * Ranked confidence in the "stale" verdict:
   *   'high'   — consumers === 0, OR consumers === 1 && !definerUsesType && kind !== 'class'.
   *   'medium' — consumers <= 1 with one of the signals pointing weakly stale.
   *   'low'    — consumers === 1 but kind === 'class' (likely encapsulation, not over-abstraction).
   */
  confidence: 'high' | 'medium' | 'low';
  /** Short human-readable explanation of why this was flagged. */
  reason: string;
}

export interface ComplexityHotspot {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  fanIn: number;
  fanOut: number;
  calleeCount: number;
  score: number;
}

// ── Similarity / Extraction Types ──────────────────────────

export interface SimilarSymbolResult {
  symbolA: string;
  shortNameA: string;
  fileA: string;
  symbolB: string;
  shortNameB: string;
  fileB: string;
  /** Similarity score (0-1). Basis says what evidence was compared. */
  similarity: number;
  /** Evidence used for similarity: call graph callees or lexical source tokens. */
  similarityBasis?: 'callees' | 'source-tokens';
  /** Shared callees or source tokens, depending on similarityBasis. */
  sharedCallees: string[];
  /** Callees or source tokens unique to A, depending on similarityBasis. */
  uniqueToA: string[];
  /** Callees or source tokens unique to B, depending on similarityBasis. */
  uniqueToB: string[];
}

export interface SimilarFileResult {
  fileA: string;
  fileB: string;
  /** Jaccard similarity of dependency sets (0-1) */
  similarity: number;
  sharedDeps: string[];
  uniqueToA: string[];
  uniqueToB: string[];
}

export interface SimilarChainResult {
  chainA: string[];
  chainB: string[];
  /** Fraction of nodes shared (0-1) */
  similarity: number;
  /** Edit distance between the two chains */
  editDistance: number;
  /** Indices where the chains diverge — the consolidation targets */
  divergencePoints: Array<{
    index: number;
    nodeA: string;
    nodeB: string;
  }>;
  /** Shared prefix */
  commonPrefix: string[];
  /** Shared suffix */
  commonSuffix: string[];
}

export interface ExtractCandidate {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
  /** Total callees */
  totalCallees: number;
  /** Distinct clusters of callees (natural extraction seams) */
  clusters: Array<{
    callees: string[];
    /** How isolated this cluster is from the rest (0-1, higher = more extractable) */
    isolation: number;
  }>;
}

// ── Health / Convergence Types ──────────────────────────────

export interface HealthAction {
  category: string;
  description: string;
  effort: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  count: number;
  locRecoverable: number;
}

export interface HealthReport {
  score: number;
  overview: { documents: number; symbols: number; indexSizeBytes: number };
  findings: {
    deadSymbols: number;
    deadLoc: number;
    isolatedSymbols: number;
    isolatedLoc: number;
    cycles: number;
    similarPairs: number;
    extractionCandidates: number;
    wrappers: number;
    passthroughs: number;
    staleTypes: number;
    driftedFiles: number;
    complexityHotspotCount: number;
  };
  actions: HealthAction[];
  topComplexity: Array<{ symbol: string; score: number }>;
  warnings?: string[];
}

export interface ConvergenceResult {
  symbolA: { symbol: string; shortName: string; file: string; loc: number };
  symbolB: { symbol: string; shortName: string; file: string; loc: number };
  similarity: number;
  sharedCallees: string[];
  uniqueToA: string[];
  uniqueToB: string[];
  consolidationStrategy: string;
}

// ── Code / Complexity / Dataflow / Slice Types ─────────────

export interface CodeResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  language: string | null;
  source: string;
}

export interface ComplexityResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
  /** Branch count from source-level regex (if, else, for, while, switch, catch, ternary, &&, ||) */
  branches: number;
  /** Cyclomatic complexity estimate: branches + 1 */
  cyclomaticEstimate: number;
  /** Number of distinct callees within the definition */
  calleeCount: number;
  fanIn: number;
  fanOut: number;
}

export interface DataflowResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  /** Where the symbol is defined (role=1) */
  definitionSites: Array<{ file: string; line: number }>;
  /** Where the symbol is referenced (role!=1) */
  usageSites: Array<{ file: string; line: number; enclosingSymbol: string; enclosingShort: string }>;
  /** Symbols that appear in the same function that defines this symbol (producers/inputs) */
  producers: Array<{ symbol: string; shortName: string; file: string }>;
  /** Symbols defined by functions that reference this symbol (consumers/outputs) */
  consumers: Array<{ symbol: string; shortName: string; file: string }>;
}

export interface SliceResult {
  symbol: string;
  shortName: string;
  direction: 'backward' | 'forward';
  /** Backward: symbols referenced in the same function as the target's definition (inputs) */
  /** Forward: symbols defined by functions that reference the target (outputs) */
  connectedSymbols: Array<{ symbol: string; shortName: string; file: string; relationship: string }>;
}

// ── Affected / Change Surface / Diff Impact Types ────────

export interface AffectedResult {
  symbol: string;
  shortName: string;
  file: string;
  depth: number;
}

export interface ChangeSurfaceEntry {
  symbol: string;
  shortName: string;
  startLine: number;
  endLine: number;
  externalConsumers: number;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ChangeSurfaceResult {
  file: string;
  symbols: ChangeSurfaceEntry[];
  totalExternalConsumers: number;
}

export interface DiffImpactResult {
  changedFiles: string[];
  changedSymbols: Array<{ symbol: string; shortName: string; file: string; fanIn: number }>;
  affectedConsumers: Array<{ file: string; consumedSymbols: number }>;
  summary: {
    totalChangedFiles: number;
    totalChangedSymbols: number;
    totalAffectedFiles: number;
    note?: string;
  };
}
