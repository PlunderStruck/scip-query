import type { ObservationReceipt } from './observation-receipt.js';

// ── Auto-Install Types ────────────────────────────────────

export interface InstallMethod {
  /** Human-readable label (e.g., "npm", "pip", "go install") */
  label: string;
  /** Immutable package/module identity requested from the installer. */
  identity?: string;
  /** Host location class that the installer will mutate. */
  destination?: string;
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
  | 'php'
  | 'clojure';

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  'typescript',
  'javascript',
  'java',
  'scala',
  'kotlin',
  'rust',
  'python',
  'ruby',
  'go',
  'cpp',
  'c',
  'csharp',
  'vb',
  'dart',
  'php',
  'clojure',
];

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
    configPath?: string;
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
  /** Committed identity shared by branches, clones, and forks intended to merge into one project history. */
  collaborationDomainId?: string;
  /** Internal repository-level read-through cache for proven content-addressed evidence products. */
  sharedEvidenceDbPath?: string;
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
  /** Project-owned architectural boundaries and dependency rules. */
  architecture?: ArchitectureConfig;
  /** Enumeration-rot contracts: a declared key set that must track a ground-truth source. */
  coverageContracts?: CoverageContractConfig[];
  /** Documentation policy (snapshot-doc exemptions, ...). */
  docs?: DocsConfig;
}

// ── Project Config (.scipquery.json) ───────────────────────

export interface ProjectConfig {
  /** JSON Schema hint for editors. Persisted writers add the packaged project-config schema. */
  $schema?: string;
  /** Persisted project-config format. Omitted only by readable legacy v1 records and in-memory callers. */
  schemaVersion?: 2;
  /**
   * Opaque committed identity shared by branches, clones, linked worktrees,
   * and contributor forks whose durable decisions are intended to merge.
   * Independent derivatives deliberately replace it.
   */
  collaborationDomainId?: string;
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
  /** Project-owned architectural boundaries and dependency rules. */
  architecture?: ArchitectureConfig;
  /** Enumeration-rot contracts: a declared key set that must track a ground-truth source. */
  coverageContracts?: CoverageContractConfig[];
  /** Documentation policy (snapshot-doc exemptions, ...). */
  docs?: DocsConfig;
}

// ── Coverage Contracts ─────────────────────────────────────
// "Enumeration rot": a hand-written key set (an object literal, a string
// array, a markdown list) that is supposed to enumerate the same things as
// some ground-truth source (a directory listing, the registered-command
// list, ...) but drifts because nothing enforces it. A coverage contract
// declares that relationship so health and focused detectors can catch the drift the
// day it happens instead of via a human audit months later.

export type CoverageContractKeySpec =
  | { type: 'object-literal-keys'; identifier: string }
  | { type: 'string-array'; identifier: string }
  | { type: 'markdown-list'; marker: string };

export type CoverageContractSourceSpec =
  | { type: 'top-level-dirs'; path: string }
  | { type: 'file-glob'; pattern: string }
  | { type: 'registered-commands' }
  | { type: 'builtin-skills' };

export interface CoverageContractConfig {
  /** Human-readable name for the contract, used in finding messages. */
  name: string;
  /** File the declared key set is extracted from. */
  file: string;
  /** How to extract the declared key set from `file`. */
  keys: CoverageContractKeySpec;
  /** The ground-truth source the declared key set must track. */
  mustEqual: CoverageContractSourceSpec;
  /** When false (the default), declared keys with no ground-truth match are also flagged. */
  allowExtra?: boolean;
}

export interface LocalityConfig {
  /** Folder names that should be treated as architectural ownership boundaries. */
  architecturalBoundarySegments?: string[];
}

export interface ArchitectureBoundaryConfig {
  /** Stable name used by dependency rules and reports. */
  name: string;
  /** Project-relative exact paths or trailing /* and /** patterns owned by this boundary. */
  paths: string[];
  /** File ceiling for this boundary, overriding `architecture.maxBoundaryFiles`. */
  maxFiles?: number;
  /**
   * Granularity used when checking this boundary's internal structure under
   * `requireResolvedBoundaries`.
   *
   * `directory` (the default) groups members by their containing directory, so
   * a boundary that *is* one directory has a single sub-unit and no internal
   * structure to check. `file` treats every member as its own sub-unit, which
   * makes a cycle between files in the same directory visible. Use `file` for
   * a large single-directory boundary whose members form layers.
   */
  subUnits?: 'directory' | 'file';
}

export interface ArchitectureConfig {
  /** Named code groups whose files serve one stable responsibility. */
  boundaries: ArchitectureBoundaryConfig[];
  /**
   * Closed outgoing dependency rows. When a boundary has a row, cross-boundary
   * targets omitted from that row are forbidden. A missing row remains
   * descriptive and makes no allow/deny claim.
   */
  allowedDependencies?: Record<string, string[]>;
  /**
   * Require every configured boundary to have a closed outgoing dependency
   * row. This prevents an omitted row from silently weakening enforcement.
   */
  requireCompletePolicy?: boolean;
  /**
   * Require every indexed, non-ignored file to belong to exactly one declared
   * boundary. Unmapped and ambiguously mapped files otherwise remain visible
   * coverage facts without being policy violations.
   */
  requireCompleteCoverage?: boolean;
  /** Treat every multi-boundary dependency cycle as a declared violation. */
  requireAcyclic?: boolean;
  /**
   * Treat a boundary that hides an internal dependency cycle as a declared
   * violation.
   *
   * `requireAcyclic` only sees the graph *between* boundaries: every edge whose
   * endpoints share a boundary is discarded before the check runs. A boundary
   * coarse enough to contain both sides of a cycle therefore passes while
   * saying nothing about the code inside it. This rule closes that gap by
   * quotienting each boundary by its sub-directories and requiring that
   * quotient to be acyclic too.
   *
   * Defaults to false so upgrading does not tighten an existing project's gate.
   */
  requireResolvedBoundaries?: boolean;
  /**
   * Treat a declared dependency allowance that no real edge uses as a
   * violation.
   *
   * `requireCompletePolicy` checks that a row *exists*, not that it is
   * *minimal*. An allowance therefore outlives the edge that justified it: the
   * import is deleted, the row stays, and the policy silently widens until it
   * permits something nobody reviewed. This rule keeps the declared matrix and
   * the observed graph converged in both directions.
   *
   * Defaults to false so upgrading does not tighten an existing project's gate.
   */
  requireMinimalPolicy?: boolean;
  /**
   * Maximum number of distinct boundaries one boundary may depend on.
   *
   * Guards the failure mode that coarse boundaries otherwise hide: a boundary
   * that keeps accumulating dependencies until it is coupled to most of the
   * system. Unset means no limit.
   */
  maxBoundaryFanOut?: number;
  /**
   * Maximum number of files one boundary may own. Unset means no limit.
   *
   * A boundary large enough to hold unrelated responsibilities stops being a
   * useful policy unit even when it is internally acyclic.
   */
  maxBoundaryFiles?: number;
  /**
   * Globs for test roots, e.g. `["tests/**"]`.
   *
   * Test files are usually excluded from the compiler project and therefore
   * from the index, which puts them outside every boundary rule. Declaring the
   * roots turns that back on: each test is judged against the boundary of the
   * code it covers (found by path mirroring) and may not import beyond what
   * that boundary is allowed to reach.
   *
   * Unset means tests stay unchecked, which is the historical behavior.
   */
  testPaths?: string[];
}

export interface DocsConfig {
  /**
   * Glob patterns (see src/analysis/glob-match.ts for supported syntax) for
   * dated snapshot docs that intentionally cite code "as of" a moment in
   * time — excluded from doc-drift's
   * default findings. A `<!-- scip-query: snapshot -->` marker inside a doc
   * has the same effect regardless of its path.
   */
  snapshotPaths?: string[];
}

export interface DeclaredCouplingConfig {
  /** Human-readable name for the maintenance unit. */
  name: string;
  /** Exact relative file paths that form one intentional co-change group. */
  files: string[];
  /** Human reason for why these files should move together. */
  reason?: string;
}

export const SUPPRESSION_REASON_CODES = [
  'entry-surface',
  'generated-code',
  'compatibility-shim',
  'reflection-or-registration',
  'test-fixture',
  'intentional-twin',
  'historical-coupling-ended',
  'detector-counterexample',
] as const;

export type SuppressionReasonCode = (typeof SUPPRESSION_REASON_CODES)[number];
export type SuppressionEvidenceKind = 'source' | 'config' | 'test' | 'graph';

export interface SuppressionCounterevidence {
  /** What kind of independently inspectable referent supports the exception. */
  kind: SuppressionEvidenceKind;
  /** Project-relative path for source/config/test, or exact scip-query command for graph evidence. */
  referent: string;
  /** The concrete claim this referent establishes. */
  claim: string;
  /** SHA-256 of source/config/test bytes when target-content invalidation is enabled. */
  contentHash?: string;
  /** Index generation that produced graph evidence, when available. */
  generation?: string;
}

export interface SuppressionDecision {
  kind: 'automated-adjudication';
  reasonCode: SuppressionReasonCode;
  decidedBy: 'agent' | 'human';
  policyVersion: 1;
  /** Repository/index state observed when this adjudication record was created. */
  observation?: ObservationReceipt;
  evidence: SuppressionCounterevidence[];
  invalidateOn: {
    targetContentChange: boolean;
    detectorMajorChange: boolean;
  };
}

export interface FindingSuppression {
  /** Stable finding id, for example SQABC123DEF456. */
  id?: string;
  /** Detector name, for example "twin-drift". */
  check?: string;
  /** Optional file path to narrow check-level suppressions. */
  file?: string;
  /** Human reason for accepting the finding. Required by config validation. */
  reason: string;
  /** ISO date after which the suppression no longer applies. */
  expiresAt?: string;
  /** ISO timestamp stamped when the suppression file was written. */
  createdAt?: string;
  /** Structured, mechanically adjudicated exception evidence. Omission is readable legacy policy, not automatic authority. */
  decision?: SuppressionDecision;
}

export interface SemanticConfig {
  typescript?: TypeScriptSemanticConfig;
  rust?: {
    /** Optional rust-analyzer executable path/name for future semantic backend use. */
    rustAnalyzerPath?: string;
  };
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
  /** Ms to wait after the last file change before triggering reindex (default: 2000) */
  debounceMs?: number;
  /** Requested ms between reindex completions; values below 5000 use the 5000ms safety floor. */
  cooldownMs?: number;
  /** Ms between Git HEAD/index state checks (default: 2000) */
  gitPollMs?: number;
  /** Ms of clean inactivity before the background watcher exits; 0 keeps it running (default: 900000) */
  idleTimeoutMs?: number;
  /** Let project agent hooks refresh stale indexes without a live watch process (default: true) */
  autoRefresh?: boolean;
  /** Extra glob patterns to ignore beyond .gitignore */
  ignore?: string[];
  /** Rolling admission guard for automatic watcher rebuilds. */
  resourceBudget?: WatchResourceBudgetConfig;
}

export interface WatchResourceBudgetConfig {
  /** Enable automatic rebuild admission limits (default: true). */
  enabled?: boolean;
  /** Rolling observation window in milliseconds (default: 900000 / 15 minutes). */
  windowMs?: number;
  /** Completed rebuilds allowed inside the window before automatic work pauses (default: 2). */
  maxRebuilds?: number;
  /** Estimated bytes written inside the window before automatic work pauses (default: 1 GiB). */
  maxEstimatedWriteBytes?: number;
}

export interface IndexerOverrides {
  /** Enable pnpm workspace support (TypeScript) */
  pnpmWorkspaces?: boolean;
  /** TypeScript indexing strategy: one inferred project, or parallel workspace project roots */
  projectMode?: TypeScriptProjectMode;
  /** Explicit TypeScript project roots or tsconfig paths, relative to project root unless absolute */
  projects?: string[];
  /** Indexer-specific config file path, relative to project root */
  configPath?: string;
}
