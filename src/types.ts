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
  /** Command to produce the SCIP index file */
  indexCommand: (opts: { projectRoot: string; outputPath: string }) => string;
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
