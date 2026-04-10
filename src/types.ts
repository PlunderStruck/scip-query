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
  }>;
  referencedBy: string[];
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
  kind: 'dead-code' | 'dead-export';
}

export interface DeadSummary {
  symbols: DeadSymbolResult[];
  totalCount: number;
  deadCodeCount: number;
  deadExportCount: number;
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
}

// ── Bottleneck / Isolated / Coverage / Chain Types ─────────

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

export interface TestCoverageResult {
  symbol: string;
  shortName: string;
  definedIn: string;
  testFiles: string[];
  covered: boolean;
}

export interface DocCoverageResult {
  totalSymbols: number;
  documented: number;
  undocumented: number;
  coveragePercent: number;
  undocumentedSymbols: Array<{
    symbol: string;
    shortName: string;
    relativePath: string;
    startLine: number;
  }>;
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

// ── Dead Code Query Options ────────────────────────────────

export interface DeadOptions {
  scope?: string;
  minLoc?: number;
  includeTests?: boolean;
  skipBarrels?: boolean;
  includeMembers?: boolean;
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
  | 'dart'
  | 'php';

export interface IndexerConfig {
  language: SupportedLanguage;
  /** The npm/cargo/pip package or binary that produces the SCIP index */
  indexerBinary: string;
  /** Command to check if the indexer is installed */
  checkCommand: string;
  /** Returns the binary + args array for execFileSync (no shell injection) */
  indexArgs: (opts: {
    projectRoot: string;
    outputPath: string;
    pnpmWorkspaces?: boolean;
  }) => { binary: string; args: string[] };
  /** Marker files that indicate this language is present */
  markerFiles: string[];
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

// ── Watch State ────────────────────────────────────────────

export type WatcherStatus =
  | { state: 'idle' }
  | { state: 'waiting'; changedFiles: number; reindexAt: number }
  | { state: 'indexing'; startedAt: number }
  | { state: 'cooldown'; until: number; dirty: boolean };
