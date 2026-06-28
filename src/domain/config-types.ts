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

export type TypeScriptProjectMode = 'single' | 'workspace';

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
    projectPath?: string;
  }) => {
    binary: string;
    args: string[];
  };
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
  /** Project-specific externally-live roots for dead-code filtering */
  entryRoots?: EntryRootsConfig;
  /** Paths to .gitignore files to load for filtering */
  gitignorePaths?: string[];
  /** Optional semantic-provider configuration */
  semantic?: SemanticConfig;
  /** Machine-readable accepted findings. */
  suppressions?: FindingSuppression[];
  /** Project-declared file groups that intentionally change together. */
  declaredCouplings?: DeclaredCouplingConfig[];
  /** Optional analyzer configuration. */
  locality?: LocalityConfig;
}

// ── Project Config (.scipquery.json) ───────────────────────

export interface ProjectConfig {
  /** Override which languages to index (default: auto-detect) */
  languages?: SupportedLanguage[];
  /** Number of indexer workers to run at once (default: adaptive, max 8) */
  indexerConcurrency?: number;
  /** Watch mode settings */
  watch?: WatchConfig;
  /** Per-language indexer overrides */
  indexer?: Partial<Record<SupportedLanguage, IndexerOverrides>>;
  /** Override the database storage path (default: ~/.cache/scip-query/<hash>/) */
  dbPath?: string;
  /** Project-specific externally-live roots for dead-code filtering */
  entryRoots?: EntryRootsConfig;
  /** Optional semantic-provider configuration */
  semantic?: SemanticConfig;
  /** Machine-readable accepted findings. */
  suppressions?: FindingSuppression[];
  /** Project-declared file groups that intentionally change together. */
  declaredCouplings?: DeclaredCouplingConfig[];
  /** Optional locality analyzer configuration. */
  locality?: LocalityConfig;
}

export interface LocalityConfig {
  /** Folder names that should be treated as architectural ownership boundaries. */
  architecturalBoundarySegments?: string[];
}

export interface DeclaredCouplingConfig {
  /** Human-readable name for the maintenance unit. */
  name: string;
  /** Exact relative file paths that form one intentional co-change group. */
  files: string[];
  /** Human reason for why these files should move together. */
  reason?: string;
}

export interface FindingSuppression {
  /** Stable finding id, for example SQABC123DEF456. */
  id?: string;
  /** Detector/check name, for example diff-gate's "echo". */
  check?: string;
  /** Optional file path to narrow check-level suppressions. */
  file?: string;
  /** Human reason for accepting the finding. Required by config validation. */
  reason: string;
  /** ISO date after which the suppression no longer applies. */
  expiresAt?: string;
}

export interface SemanticConfig {
  typescript?: TypeScriptSemanticConfig;
}

// scip-query: ignore-stale — exported config surface even when only referenced structurally.
export interface TypeScriptSemanticConfig {
  /** Explicit tsconfig paths, relative to project root unless absolute */
  tsconfigs?: string[];
}

export interface EntryRootsConfig {
  /** Any symbol defined in these path prefixes is externally live */
  pathPrefixes?: string[];
  /** Any symbol defined in these exact files is externally live */
  files?: string[];
  /** Symbols matching these regular expressions are externally live */
  symbolPatterns?: string[];
  /** Qualified var names like my.ns/my-fn that are externally live */
  qualifiedVars?: string[];
}

export interface WatchConfig {
  /** Enable file watching (default: false, must opt in) */
  enabled?: boolean;
  /** Ms to wait after the last file change before triggering reindex (default: 30000) */
  debounceMs?: number;
  /** Minimum ms between reindex completions (default: 60000) */
  cooldownMs?: number;
  /** Ms between Git HEAD/index state checks (default: 2000) */
  gitPollMs?: number;
  /** Let project agent hooks refresh stale indexes without a live watch process (default: true) */
  autoRefresh?: boolean;
  /** Extra glob patterns to ignore beyond .gitignore */
  ignore?: string[];
}

export interface IndexerOverrides {
  /** Enable pnpm workspace support (TypeScript) */
  pnpmWorkspaces?: boolean;
  /** TypeScript indexing strategy: one inferred project, or parallel workspace project roots */
  projectMode?: TypeScriptProjectMode;
  /** Explicit TypeScript project roots or tsconfig paths, relative to project root unless absolute */
  projects?: string[];
}
