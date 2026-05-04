// ── SCIP Symbol Grammar Types ──────────────────────────────

/** Parsed components of a SCIP symbol string */
export interface ScipSymbol {
  /** The indexer scheme (e.g. "scip-typescript", "scip-java", "rust-analyzer") */
  scheme: string;
  /** Package manager (e.g. "npm", "maven", "cargo") */
  manager: string;
  /** Package name (e.g. "@vega/api", "com.example/mylib") */
  packageName: string;
  /** Package version */
  version: string;
  /** Descriptor chain — the path to the symbol within the file */
  descriptors: ScipDescriptor[];
  /** The raw, unparsed symbol string */
  raw: string;
}

export interface ScipDescriptor {
  name: string;
  suffix: DescriptorSuffix;
}

export type DescriptorSuffix =
  | 'namespace'   // /
  | 'type'        // #
  | 'term'        // .
  | 'method'      // ().
  | 'type-param'  // [
  | 'parameter'   // ()
  | 'meta'        // :
  | 'macro';      // !

/** A local symbol (file-scoped, no cross-file identity) */
export interface ScipLocalSymbol {
  kind: 'local';
  id: string;
  raw: string;
}

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
  /** Jaccard similarity of callee sets (0-1) */
  similarity: number;
  /** Callees shared by both symbols */
  sharedCallees: string[];
  /** Callees unique to A */
  uniqueToA: string[];
  /** Callees unique to B */
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

// ── Dead Code Query Options ────────────────────────────────

export interface DeadOptions {
  scope?: string;
  minLoc?: number;
  includeTests?: boolean;
  skipBarrels?: boolean;
  includeMembers?: boolean;
}

// ── Auto-Install Types ────────────────────────────────────

export interface InstallMethod {
  /** Human-readable label (e.g., "npm", "pip", "go install") */
  label: string;
  /** Binary that must exist for this install method to work (e.g., "npm", "pip3", "go") */
  prerequisite: string;
  /** Command to execute */
  binary: string;
  /** Arguments for the command */
  args: string[];
}

// ── Reindex Types ──────────────────────────────────────────

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'java'
  | 'scala'
  | 'kotlin'
  | 'rust'
  | 'python'
  | 'ruby'
  | 'go'
  | 'cpp'
  | 'c'
  | 'csharp'
  | 'vb'
  | 'dart'
  | 'php';

export interface IndexerConfig {
  language: SupportedLanguage;
  /** Preferred executable name for the indexer */
  indexerBinary: string;
  /** Additional executable names accepted on PATH for the same indexer */
  binaryAliases?: string[];
  /** Project-local executable paths to prefer when they exist */
  projectLocalBinaries?: string[];
  /** Command to check if the indexer is installed */
  checkCommand: string;
  /** Returns the binary + args array for execFileSync (no shell injection) */
  indexArgs: (opts: {
    projectRoot: string;
    outputPath: string;
    pnpmWorkspaces?: boolean;
    indexerBinary: string;
  }) => { binary: string; args: string[] };
  /** Relative output path written by the indexer when it ignores outputPath */
  defaultOutputPath?: string;
  /** Marker files that indicate this language is present */
  markerFiles: string[];
  /** Installation methods to try in order of preference */
  installMethods?: InstallMethod[];
  /** URL for manual installation if auto-install fails */
  installUrl?: string;
  /**
   * npm package bundled with scip-query as an optionalDependency. When this
   * package resolves locally (i.e. it installed successfully), the indexer is
   * considered available even if its binary isn't on PATH — `npx <binary>`
   * will pick up the local install.
   */
  bundledNpmPackage?: string;
}

// ── Database Config ────────────────────────────────────────

export interface ScipQueryConfig {
  /** Path to the SQLite database (index.db) */
  dbPath: string;
  /** Path to the SCIP protobuf index (index.scip) */
  indexPath: string;
  /** Project root directory */
  projectRoot: string;
  /** Paths to .gitignore files to load for filtering */
  gitignorePaths?: string[];
}

// ── Project Config (.scipquery.json) ───────────────────────

export interface ProjectConfig {
  /** Override which languages to index (default: auto-detect) */
  languages?: SupportedLanguage[];
  /** Watch mode settings */
  watch?: WatchConfig;
  /** Per-language indexer overrides */
  indexer?: Partial<Record<SupportedLanguage, IndexerOverrides>>;
  /** Override the database storage path (default: ~/.cache/scip-query/<hash>/) */
  dbPath?: string;
}

export interface WatchConfig {
  /** Enable file watching (default: false, must opt in) */
  enabled?: boolean;
  /** Ms to wait after the last file change before triggering reindex (default: 30000) */
  debounceMs?: number;
  /** Minimum ms between reindex completions (default: 60000) */
  cooldownMs?: number;
  /** Extra glob patterns to ignore beyond .gitignore */
  ignore?: string[];
}

export interface IndexerOverrides {
  /** Enable pnpm workspace support (TypeScript) */
  pnpmWorkspaces?: boolean;
}

// ── Redundant Re-export Types ─────────────────────────────

export interface RedundantReexport {
  barrelFile: string;
  symbol: string;
  shortName: string;
  originalFile: string;
  /** How many consumers import through the barrel */
  barrelConsumers: number;
  /** How many consumers import directly from the source */
  directConsumers: number;
}

// ── Similar Signature Types ───────────────────────────────

export interface SimilarSignatureGroup {
  /** The normalized signature shared by all functions in the group */
  signature: string;
  /** Functions that share this signature */
  functions: Array<{
    symbol: string;
    shortName: string;
    file: string;
    startLine: number;
    endLine: number;
    loc: number;
  }>;
}

// ── Watch State ────────────────────────────────────────────

export type WatcherStatus =
  | { state: 'idle' }
  | { state: 'waiting'; changedFiles: number; reindexAt: number }
  | { state: 'indexing'; startedAt: number }
  | { state: 'cooldown'; until: number; dirty: boolean };
