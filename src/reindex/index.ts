import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { platform } from 'node:os';
import { resolveScipBinary, tryInstallScipCli } from '../runtime/scip-cli.js';
import type { LastRefreshMetadata, RefreshTrigger, SupportedLanguage, TypeScriptProjectMode } from '../domain/types.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { auxiliaryDocumentsAugmentationStage } from './augment.js';
import {
  collectAffectedSetShadowRecord,
  createUnavailableAffectedSetShadowRecord,
  evaluateAffectedSetShadow,
  writeAffectedSetShadowRecord,
  type AffectedSetShadowRecord,
} from './affected-shadow.js';
import { projectInputSnapshotOrNull, type ProjectInputSnapshot } from './affected-set.js';
import { detectLanguages } from './detect.js';
import { getIndexerConfig } from './indexers.js';
import { mergeAndSanitizeScipFiles, mergeScipFiles } from './merge.js';
import { patchIncrementalSqliteGeneration } from './incremental-sqlite-publication.js';
import { runPostIndexAugmentation } from './post-index-augmentation.js';
import { fingerprintProjectFiles, normalizeTypeScriptProjects } from './project-files.js';
import type { ProjectFileFingerprint } from './project-files.js';
import {
  assignFilesToProjects,
  computeProjectShardFingerprints,
  deriveProjectDependencies,
  projectShardSlug,
  readProjectManifestInputs,
} from './project-shards.js';
import { sanitizeScipFile } from './sanitize.js';
import {
  inspectSqliteGeneration,
  promoteReindexArtifacts,
  refreshSqliteGenerationMetadata,
} from './sqlite-generation-store.js';
import { pruneTypeScriptOverlays } from './typescript-overlay-store.js';
import { discoverTypeScriptProjectRoots } from './typescript-projects.js';
import {
  materializeDeferredTypeScriptIndex,
  tryMaterializeTypeScriptIncrementalIndex,
  type MaterializedTypeScriptIncrementalIndex,
} from './typescript-incremental-index.js';
import { runPreparedIndexers } from './indexer-runner.js';
import type { PreparedIndexerRun, IndexerRunResult } from './indexer-runner.js';
import {
  describeIndexerBinary,
  getIndexerExecutionEnv,
  isIndexerInstalled,
  resolveIndexerBinary,
  resolveProjectLocalIndexerBinary,
  tryInstallIndexer,
} from './install.js';

export interface ReindexOptions {
  projectRoot: string;
  /** Override language detection — index only these languages */
  languages?: SupportedLanguage[];
  /** Path for the SCIP protobuf output (default: <projectRoot>/index.scip) */
  outputScip?: string;
  /** Path for the SQLite output (default: <projectRoot>/index.db) */
  outputDb?: string;
  /** Max Node.js heap size in MB (default: 8192) */
  maxHeapMb?: number;
  /** Callback for status updates */
  onStatus?: (message: string) => void;
  /** Extra flags for pnpm-workspace-aware TS indexing */
  pnpmWorkspaces?: boolean;
  /** TypeScript indexing strategy (default: single inferred project). */
  typescriptProjectMode?: TypeScriptProjectMode;
  /** Explicit TypeScript project roots or tsconfig paths for workspace mode. */
  typescriptProjects?: string[];
  /** Optional scip-clojure config path, relative to project root unless absolute. */
  clojureConfigPath?: string;
  /** Skip auto-install prompts */
  skipAutoInstall?: boolean;
  /** Reuse an existing index when tracked source inputs are unchanged (default true). */
  skipIfUnchanged?: boolean;
  /** Permit a partial index when some detected/requested languages fail (default false). */
  allowPartial?: boolean;
  /** Number of language indexers to run at once (default: conservative auto). */
  indexerConcurrency?: number;
  /** Source that requested this refresh, persisted for status and setup diagnostics. */
  trigger?: RefreshTrigger;
}

// Plan 6 6.5.2 — shard-reuse diagnostics: one entry per cached indexing unit
// (a language shard, or one TypeScript workspace project shard within a
// language) explaining whether it was reused and, if not, why.
export interface ReindexShardDiagnostic {
  /** Unique id for this shard: the language, or `<language>:<projectPath>` for a TS workspace sub-project. */
  id: string;
  language: SupportedLanguage;
  /** True when the cached shard was reused without rerunning its indexer. */
  reused: boolean;
  /** Present only when `reused` is false: why the cached shard could not be used. */
  missReason?: string;
  /** Short hash of this shard's fingerprint inputs (source content + indexer options). */
  fingerprint: string;
  /** Size in bytes of the shard's cached SCIP output, or null when unavailable. */
  outputBytes: number | null;
  /** Wall time spent producing this shard; 0 when reused. */
  durationMs: number;
  /** Indexer command invoked to produce this shard; absent when reused. */
  command?: string;
}

export interface ReindexResult {
  /** Languages that were successfully indexed. */
  languages: SupportedLanguage[];
  indexPath: string;
  dbPath: string;
  durationMs: number;
  /** True when existing SCIP/SQLite outputs were reused because inputs were unchanged. */
  reused: boolean;
  /**
   * Languages detected in the project but skipped because their indexer
   * could not be located, installed, or run. Each entry includes the reason.
   */
  skipped: { language: SupportedLanguage; reason: string }[];
  /** Persisted description of this refresh attempt. */
  lastRefresh?: LastRefreshMetadata;
  /** Per-shard reuse diagnostics (plan6 6.5.2); one entry per language/workspace shard. */
  shards?: ReindexShardDiagnostic[];
}

interface PreparedIndexerPlan {
  preparedRuns: PreparedIndexerRun[];
  skippedLanguages: { language: SupportedLanguage; reason: string }[];
  languageOutputScipPaths: Partial<Record<SupportedLanguage, string>>;
}

interface ReindexMetadata {
  version: 2 | 3;
  status: 'complete' | 'partial';
  updatedAt: string;
  fingerprint: ReindexFingerprint;
  languageFingerprints?: Partial<Record<SupportedLanguage, ReindexFingerprint>>;
  /** Whether index.scip is exact or reconstructible from changed-document overlays. */
  scipCompanion?: 'current' | 'deferred';
  /**
   * Per-TypeScript-project shard fingerprints (workspace mode only), keyed by
   * relative project path ('.', 'apps/web'). Additive on meta v3: absent on
   * older metadata or non-workspace runs, in which case every project shard
   * classifies as a miss (today's behavior).
   */
  typescriptProjectShards?: Record<string, { files: ProjectFileFingerprint[] }>;
  requestedLanguages: SupportedLanguage[];
  indexedLanguages: SupportedLanguage[];
  skipped: { language: SupportedLanguage; reason: string }[];
  lastRefresh?: LastRefreshMetadata;
}

interface ReindexOutputPaths {
  outputScip: string;
  outputDb: string;
  metaPath: string;
}

interface TempReindexPaths {
  runDir: string;
  tempOutputScip: string;
  tempOutputDb: string;
  tempMetaPath: string;
}

type IndexedOutput = { language: SupportedLanguage; scipPath: string };

interface FreshIndexRun {
  indexedOutputs: IndexedOutput[];
  skippedLanguages: { language: SupportedLanguage; reason: string }[];
  reusedLanguages: SupportedLanguage[];
  languageFingerprints: Partial<Record<SupportedLanguage, ReindexFingerprint>>;
  shards: ReindexShardDiagnostic[];
  /** Present only when the TypeScript language shard missed in workspace mode. */
  typescriptProjectShardContext?: TypeScriptProjectShardContext;
  /** Exact whole and affected-only SCIP outputs produced by the persistent TypeScript service. */
  incrementalTypeScript?: MaterializedTypeScriptIncrementalIndex;
}

type SqliteMaterializationResult =
  | {
      mode: 'incremental';
      changedDocumentPaths: string[];
      patchDurationMs: number;
      converterDurationMs: number;
      scipCompanion: 'current' | 'deferred';
    }
  | {
      mode: 'full';
      converterDurationMs: number;
      fallbackReason?: string;
    };

/**
 * Carries the per-project fingerprints computed while classifying TypeScript
 * project-shard reuse (2.2) forward to publish (2.3), so `writeReindexMeta`
 * records the exact same fingerprints without a second hashing pass.
 */
interface TypeScriptProjectShardContext {
  /** All discovered/configured project paths, not just the missed ones. */
  projects: readonly string[];
  fingerprints: Record<string, ProjectShardFingerprint>;
}

type ProjectShardFingerprint = { files: ProjectFileFingerprint[] };

interface TypeScriptProjectShardClassification {
  reused: boolean;
  reason?: string;
  fingerprint: ProjectShardFingerprint;
}

interface ReindexLockMetadata {
  version: 1;
  pid: number;
  projectRoot: string;
  startedAt: string;
  trigger?: RefreshTrigger;
}

/**
 * Reindex a project: detect languages, run the appropriate SCIP indexer(s),
 * and convert the output to SQLite.
 */
// scip-query: ignore-extract — this is the lock/cleanup safety envelope for
// reindex; hiding the ordered steps behind another helper would make failure
// behavior harder to audit.
export async function reindex(opts: ReindexOptions): Promise<ReindexResult> {
  const { projectRoot, maxHeapMb = 8192, onStatus = console.log, skipAutoInstall = false } = opts;

  const paths = resolveReindexOutputPaths(opts);
  const start = Date.now();
  mkdirSync(dirname(paths.outputScip), { recursive: true });
  mkdirSync(dirname(paths.outputDb), { recursive: true });

  // Detect or use provided languages
  const languages = opts.languages ?? detectLanguages(projectRoot);
  if (languages.length === 0) {
    throw new Error(
      'No supported languages detected in this project. ' +
        'Looked for: tsconfig.json, Cargo.toml, go.mod, pyproject.toml, etc.',
    );
  }

  onStatus(`Detected languages: ${languages.join(', ')}`);

  const fingerprint = computeReindexFingerprint(projectRoot, languages, {
    pnpmWorkspaces: opts.pnpmWorkspaces,
    typescriptProjectMode: opts.typescriptProjectMode,
    typescriptProjects: opts.typescriptProjects,
    clojureConfigPath: opts.clojureConfigPath,
  });
  const releaseLock = await acquireReindexLock(join(dirname(paths.outputDb), 'index.lock'), {
    projectRoot,
    trigger: opts.trigger,
    onStatus,
  });
  let runDir: string | null = null;

  try {
    const reused = reuseExistingIndexIfPossible({
      opts,
      paths,
      languages,
      fingerprint,
      start,
      onStatus,
    });
    if (reused) return reused;

    await ensureScipCliAvailable(skipAutoInstall, onStatus);

    const tempPaths = createTempReindexPaths(paths);
    runDir = tempPaths.runDir;
    return await runFreshReindex({
      opts,
      languages,
      projectRoot,
      paths,
      tempPaths,
      fingerprint,
      start,
      maxHeapMb,
      skipAutoInstall,
      onStatus,
    });
  } catch (error) {
    updateReindexLastRefresh(
      paths.metaPath,
      buildLastRefresh({
        trigger: opts.trigger,
        result: 'failed',
        start,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  } finally {
    if (runDir) {
      rmSync(runDir, { recursive: true, force: true });
    }
    releaseLock();
  }
}

export { detectLanguages } from './detect.js';
export { augmentAuxiliaryDocuments, auxiliaryDocumentsAugmentationStage } from './augment.js';
export { runPostIndexAugmentation } from './post-index-augmentation.js';
export { augmentVueResolvedReferences, vueResolvedReferencesAugmentationStage } from './vue/augment-vue.js';
export { getIndexerConfig, INDEXER_CONFIGS } from './indexers.js';
export { mergeScipFiles, mergeScipIndexes } from './merge.js';
export {
  describeIndexerBinary,
  getIndexerExecutionEnv,
  isBinaryAvailable,
  isIndexerInstalled,
  resolveIndexerBinary,
  resolveProjectLocalIndexerBinary,
  tryInstallIndexer,
} from './install.js';
export { tryInstallScipCli } from '../runtime/scip-cli.js';

function resolveReindexOutputPaths(opts: ReindexOptions): ReindexOutputPaths {
  const outputScip = opts.outputScip ?? join(opts.projectRoot, 'index.scip');
  const outputDb = opts.outputDb ?? join(opts.projectRoot, 'index.db');
  return {
    outputScip,
    outputDb,
    metaPath: join(dirname(outputDb), 'meta.json'),
  };
}

function reuseExistingIndexIfPossible(opts: {
  opts: ReindexOptions;
  paths: ReindexOutputPaths;
  languages: SupportedLanguage[];
  fingerprint: ReindexFingerprint;
  start: number;
  onStatus: (message: string) => void;
}): ReindexResult | null {
  const generation = inspectSqliteGeneration(opts.paths.outputDb, opts.paths.metaPath);
  if (
    opts.opts.skipIfUnchanged === false ||
    !existsSync(opts.paths.outputScip) ||
    !existsSync(opts.paths.outputDb) ||
    !isUnchangedReindex(opts.paths.metaPath, opts.fingerprint) ||
    generation.state === 'invalid' ||
    generation.state === 'drifted'
  ) {
    return null;
  }

  runPostIndexAugmentation(auxiliaryDocumentsAugmentationStage(), {
    projectRoot: opts.opts.projectRoot,
    dbPath: opts.paths.outputDb,
    onStatus: opts.onStatus,
  });
  const durationMs = Date.now() - opts.start;
  const lastRefresh = buildLastRefresh({
    trigger: opts.opts.trigger,
    result: 'reused',
    start: opts.start,
    languages: opts.languages,
    skipped: [],
  });
  updateReindexLastRefresh(opts.paths.metaPath, lastRefresh);
  opts.onStatus(`Index unchanged; reused existing SQLite index in ${(durationMs / 1000).toFixed(1)}s`);
  return {
    languages: opts.languages,
    indexPath: opts.paths.outputScip,
    dbPath: opts.paths.outputDb,
    durationMs,
    reused: true,
    skipped: [],
    lastRefresh,
    shards: buildFullyReusedShardDiagnostics(opts.paths, opts.opts.projectRoot, opts.languages, opts.opts),
  };
}

// Plan 6 6.5.2: every language is reused together on the whole-project reuse
// path (the project fingerprint check above already proved every tracked
// input is unchanged), so each shard's diagnostic is `reused: true` with no
// indexer command or miss reason.
function buildFullyReusedShardDiagnostics(
  paths: ReindexOutputPaths,
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  opts: {
    pnpmWorkspaces?: boolean;
    typescriptProjectMode?: TypeScriptProjectMode;
    typescriptProjects?: readonly string[];
    clojureConfigPath?: string;
  },
): ReindexShardDiagnostic[] {
  const fingerprints = computeLanguageFingerprints(projectRoot, languages, opts);
  return languages.map((language) => ({
    id: language,
    language,
    reused: true,
    fingerprint: hashFingerprint(fingerprints[language]),
    outputBytes: fileSizeOrNull(languageShardPath(paths.outputDb, language)),
    durationMs: 0,
  }));
}

function createTempReindexPaths(paths: ReindexOutputPaths): TempReindexPaths {
  const runDir = mkdtempSync(join(dirname(paths.outputDb), 'reindex-'));
  return {
    runDir,
    tempOutputScip: join(runDir, basename(paths.outputScip)),
    tempOutputDb: join(runDir, basename(paths.outputDb)),
    tempMetaPath: join(runDir, basename(paths.metaPath)),
  };
}

async function runFreshReindex(opts: {
  opts: ReindexOptions;
  languages: SupportedLanguage[];
  projectRoot: string;
  paths: ReindexOutputPaths;
  tempPaths: TempReindexPaths;
  fingerprint: ReindexFingerprint;
  start: number;
  maxHeapMb: number;
  skipAutoInstall: boolean;
  onStatus: (message: string) => void;
}): Promise<ReindexResult> {
  const env = {
    ...process.env,
    NODE_OPTIONS: `--max-old-space-size=${opts.maxHeapMb}`,
  };

  const {
    indexedOutputs,
    skippedLanguages,
    reusedLanguages,
    languageFingerprints,
    shards,
    typescriptProjectShardContext,
    incrementalTypeScript,
  } = await runLanguageIndexersForFreshReindex(opts, env);
  if (reusedLanguages.length > 0) {
    opts.onStatus(`Reused ${reusedLanguages.length} cached language shard(s): ${reusedLanguages.join(', ')}`);
  }
  if (
    canReusePublishedArtifactsForLanguageShards({
      run: opts,
      indexedOutputs,
      skippedLanguages,
      reusedLanguages,
    })
  ) {
    const lastRefresh = publishFullyReusedLanguageShardArtifacts(
      opts,
      indexedOutputs,
      skippedLanguages,
      reusedLanguages,
      languageFingerprints,
      typescriptProjectShardContext,
    );
    const durationMs = lastRefresh.durationMs;
    opts.onStatus(`All language shards unchanged; reused existing SQLite index in ${(durationMs / 1000).toFixed(1)}s`);
    return {
      languages: indexedOutputs.map((o) => o.language),
      indexPath: opts.paths.outputScip,
      dbPath: opts.paths.outputDb,
      durationMs,
      reused: true,
      skipped: skippedLanguages,
      lastRefresh,
      shards,
    };
  }
  const lastRefresh = publishFreshReindexArtifacts(
    opts,
    env,
    indexedOutputs,
    skippedLanguages,
    reusedLanguages,
    languageFingerprints,
    typescriptProjectShardContext,
    incrementalTypeScript,
  );
  const durationMs = lastRefresh.durationMs;
  opts.onStatus(`Done in ${(durationMs / 1000).toFixed(1)}s`);
  return {
    languages: indexedOutputs.map((o) => o.language),
    indexPath: opts.paths.outputScip,
    dbPath: opts.paths.outputDb,
    durationMs,
    reused: false,
    skipped: skippedLanguages,
    lastRefresh,
    shards,
  };
}

function canReusePublishedArtifactsForLanguageShards(opts: {
  run: Parameters<typeof runFreshReindex>[0];
  indexedOutputs: readonly IndexedOutput[];
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[];
  reusedLanguages: readonly SupportedLanguage[];
}): boolean {
  if (opts.run.opts.skipIfUnchanged === false) return false;
  if (opts.skippedLanguages.length > 0) return false;
  if (!existsSync(opts.run.paths.outputScip) || !existsSync(opts.run.paths.outputDb)) return false;
  const generation = inspectSqliteGeneration(opts.run.paths.outputDb, opts.run.paths.metaPath);
  if (generation.state === 'invalid' || generation.state === 'drifted') return false;

  const reused = new Set(opts.reusedLanguages);
  const indexed = new Set(opts.indexedOutputs.map((output) => output.language));
  return (
    opts.run.languages.length > 0 &&
    indexed.size === opts.run.languages.length &&
    opts.indexedOutputs.length === opts.run.languages.length &&
    opts.run.languages.every((language) => reused.has(language) && indexed.has(language))
  );
}

async function runLanguageIndexersForFreshReindex(
  opts: Parameters<typeof runFreshReindex>[0],
  env: NodeJS.ProcessEnv,
): Promise<FreshIndexRun> {
  const classification = classifyLanguageShardReuse({
    paths: opts.paths,
    projectRoot: opts.projectRoot,
    languages: opts.languages,
    pnpmWorkspaces: opts.opts.pnpmWorkspaces,
    typescriptProjectMode: opts.opts.typescriptProjectMode,
    typescriptProjects: opts.opts.typescriptProjects,
    clojureConfigPath: opts.opts.clojureConfigPath,
  });
  const reusableOutputs: IndexedOutput[] = [];
  const reused = new Set<SupportedLanguage>();
  for (const [language, info] of classification) {
    if (info.reused) {
      reusableOutputs.push({ language, scipPath: info.scipPath });
      reused.add(language);
    }
  }
  for (const language of reused) {
    opts.onStatus(`Reusing cached ${language} SCIP shard (language inputs unchanged).`);
  }

  const typescriptClassification = classification.get('typescript');
  const acceptedGeneration = inspectSqliteGeneration(opts.paths.outputDb, opts.paths.metaPath);
  const acceptedMetadata = readReindexMetaOrNull(opts.paths.metaPath);
  const incrementalGenerationUsable = acceptedGeneration.state === 'legacy' || acceptedGeneration.state === 'current';
  const baseShardCurrent =
    acceptedMetadata?.scipCompanion !== 'deferred' &&
    (acceptedGeneration.state !== 'current' || acceptedGeneration.generation.publication?.scipCompanion !== 'deferred');
  const incrementalTypeScript =
    typescriptClassification && !typescriptClassification.reused && incrementalGenerationUsable
      ? tryMaterializeTypeScriptIncrementalIndex({
          projectRoot: opts.projectRoot,
          cacheDir: dirname(opts.paths.outputDb),
          previousDbPath: opts.paths.outputDb,
          previousIndexPath: opts.paths.outputScip,
          previousShardPath: typescriptClassification.scipPath,
          candidateShardPath: tempScipPath(opts.tempPaths.tempOutputScip, 'typescript-incremental', 0),
          candidateAffectedScipPath: tempScipPath(opts.tempPaths.tempOutputScip, 'typescript-affected', 0),
          baseShardCurrent,
          previousSnapshot: previousProjectInputSnapshot(opts.paths.metaPath),
          currentSnapshot: opts.fingerprint,
          projectMode: opts.opts.typescriptProjectMode,
          onStatus: opts.onStatus,
        })
      : null;
  const incrementallyIndexed = new Set<SupportedLanguage>(incrementalTypeScript ? ['typescript'] : []);

  // Plan6 per-project TS shard caching (2.2): only relevant when the whole
  // typescript language shard missed in workspace mode — an untouched
  // typescript language shard already proves every project unchanged
  // (invariant: the language fingerprint covers the same files every
  // project's fingerprint is built from), so the classification below is
  // skipped entirely on that path (today's behavior, untouched).
  const tsProjectShards = incrementalTypeScript ? undefined : planTypeScriptProjectShardReuse(opts, classification);

  const {
    preparedRuns: preparedRunsAll,
    skippedLanguages,
    languageOutputScipPaths,
  } = prepareIndexerRuns({
    languages: opts.languages.filter((language) => !reused.has(language) && !incrementallyIndexed.has(language)),
    tempOutputScip: opts.tempPaths.tempOutputScip,
    projectRoot: opts.projectRoot,
    env,
    skipAutoInstall: opts.skipAutoInstall,
    pnpmWorkspaces: opts.opts.pnpmWorkspaces,
    typescriptProjectMode: opts.opts.typescriptProjectMode,
    typescriptProjects: opts.opts.typescriptProjects,
    preDiscoveredTypeScriptProjects: tsProjectShards?.allProjects,
    clojureConfigPath: opts.opts.clojureConfigPath,
    onStatus: opts.onStatus,
  });

  // Filter typescript runs down to the projects that actually missed;
  // reused projects are served from cache via the synthetic results below
  // instead of being re-indexed.
  const preparedRuns = tsProjectShards
    ? preparedRunsAll.filter((run) => run.language !== 'typescript' || tsProjectShards.missedProjectIds.has(run.id))
    : preparedRunsAll;

  const runResults = await runPreparedIndexers(
    preparedRuns,
    opts.projectRoot,
    opts.onStatus,
    opts.opts.indexerConcurrency,
  );

  // Cache freshly produced project shards BEFORE collectIndexerOutputs runs
  // — a single-run group gets renameSync'd into its outputScipPath, which
  // would otherwise destroy the only copy of a freshly-indexed shard before
  // it could be cached.
  let syntheticResults: IndexerRunResult[] = [];
  if (tsProjectShards) {
    cacheFreshTypeScriptProjectShards(opts.paths.outputDb, runResults);
    const typescriptOutputScipPath = languageOutputScipPaths['typescript'] ?? opts.tempPaths.tempOutputScip;
    syntheticResults = buildCachedTypeScriptProjectRunResults({
      outputDb: opts.paths.outputDb,
      tempOutputScip: opts.tempPaths.tempOutputScip,
      outputScipPath: typescriptOutputScipPath,
      reusedProjects: tsProjectShards.reusedProjects,
    });
  }

  const combinedResults = [...runResults, ...syntheticResults];
  const { indexedOutputs } = collectIndexerOutputs(combinedResults, skippedLanguages);
  const incrementalOutputs: IndexedOutput[] = incrementalTypeScript
    ? [{ language: 'typescript', scipPath: incrementalTypeScript.scipPath }]
    : [];
  const allIndexedOutputs = [...reusableOutputs, ...incrementalOutputs, ...indexedOutputs];
  validateIndexingOutcome(allIndexedOutputs, skippedLanguages, opts.languages, opts.opts.allowPartial, opts.onStatus);
  const incrementalRunResults: IndexerRunResult[] = incrementalTypeScript
    ? [
        {
          id: 'typescript',
          language: 'typescript',
          label: 'typescript (incremental documents)',
          scipPath: incrementalTypeScript.scipPath,
          outputScipPath: incrementalTypeScript.scipPath,
          durationMs: incrementalTypeScript.durationMs,
          command: 'watch-service:typescript-index',
          outputBytes: fileSizeOrNull(incrementalTypeScript.scipPath) ?? undefined,
        },
      ]
    : [];
  const shards = buildFreshReindexShardDiagnostics(
    classification,
    [...runResults, ...incrementalRunResults],
    tsProjectShards ? { outputDb: opts.paths.outputDb, classification: tsProjectShards.classification } : undefined,
  );
  return {
    indexedOutputs: allIndexedOutputs,
    skippedLanguages,
    reusedLanguages: [...reused],
    languageFingerprints: languageFingerprintsFromClassification(classification, opts.languages),
    shards,
    typescriptProjectShardContext: tsProjectShards
      ? { projects: tsProjectShards.allProjects, fingerprints: tsProjectShards.fingerprints }
      : undefined,
    incrementalTypeScript: incrementalTypeScript ?? undefined,
  };
}

interface TypeScriptProjectShardPlan {
  allProjects: readonly string[];
  fingerprints: Record<string, ProjectShardFingerprint>;
  classification: ReadonlyMap<string, TypeScriptProjectShardClassification>;
  reusedProjects: readonly string[];
  missedProjectIds: ReadonlySet<string>;
}

/**
 * Builds the per-project reuse plan for a workspace-mode TypeScript language
 * shard miss: discovers projects once, derives each project's fingerprint
 * from the already-hashed language fingerprint's file list (no re-hashing),
 * and classifies each project as reused or missed against `meta.json`.
 * Returns undefined when there is nothing to do: typescript wasn't
 * requested, its language shard was reused (today's behavior, untouched),
 * mode isn't workspace, or discovery finds no projects.
 */
function planTypeScriptProjectShardReuse(
  runOpts: Parameters<typeof runFreshReindex>[0],
  classification: ReadonlyMap<SupportedLanguage, LanguageShardClassification>,
): TypeScriptProjectShardPlan | undefined {
  const tsClassification = classification.get('typescript');
  if (!tsClassification || tsClassification.reused) return undefined;
  if (runOpts.opts.typescriptProjectMode !== 'workspace') return undefined;

  const allProjects = discoverTypeScriptProjectRoots(runOpts.projectRoot, runOpts.opts.typescriptProjects);
  if (allProjects.length === 0) return undefined;

  const manifestInputs = readProjectManifestInputs(runOpts.projectRoot, allProjects);
  const assignment = assignFilesToProjects(tsClassification.fingerprint.files, allProjects);
  const dependencies = deriveProjectDependencies(allProjects, manifestInputs);
  const fingerprints = computeProjectShardFingerprints(allProjects, assignment, dependencies);

  const meta = readReindexMetaOrNull(runOpts.paths.metaPath);
  const shardExists = (project: string) => existsSync(typescriptProjectShardPath(runOpts.paths.outputDb, project));
  const projectClassification = classifyTypeScriptProjectShardReuse(meta, fingerprints, shardExists);

  const reusedProjects = [...projectClassification.entries()]
    .filter(([, info]) => info.reused)
    .map(([project]) => project);
  const reusedSet = new Set(reusedProjects);
  const missedProjectIds = new Set(
    allProjects.filter((project) => !reusedSet.has(project)).map((project) => `typescript:${project}`),
  );

  return { allProjects, fingerprints, classification: projectClassification, reusedProjects, missedProjectIds };
}

// Plan6 per-project TS shard caching (2.2): per-project mirror of
// classifyLanguageShardReuse's miss reasons, decided purely over
// (meta.typescriptProjectShards, current per-project fingerprints,
// shardExists) — no filesystem access beyond the injected callback.
function classifyTypeScriptProjectShardReuse(
  meta: Partial<ReindexMetadata> | null,
  current: Record<string, ProjectShardFingerprint>,
  shardExists: (project: string) => boolean,
): Map<string, TypeScriptProjectShardClassification> {
  const result = new Map<string, TypeScriptProjectShardClassification>();
  for (const project of Object.keys(current)) {
    const fingerprint = current[project]!;
    if (!meta) {
      result.set(project, { reused: false, reason: 'no reindex metadata found', fingerprint });
      continue;
    }
    const cached = meta.typescriptProjectShards?.[project];
    if (!cached) {
      result.set(project, { reused: false, reason: 'no cached fingerprint for this project', fingerprint });
      continue;
    }
    if (!shardExists(project)) {
      result.set(project, { reused: false, reason: 'cached shard file missing on disk', fingerprint });
      continue;
    }
    if (stableJson(cached) !== stableJson(fingerprint)) {
      result.set(project, { reused: false, reason: 'project inputs changed since last index', fingerprint });
      continue;
    }
    result.set(project, { reused: true, fingerprint });
  }
  return result;
}

/** Copies each freshly-indexed project shard into the real cache directory, before `collectIndexerOutputs` can rename the source away. Skips failed runs. */
function cacheFreshTypeScriptProjectShards(outputDb: string, runResults: readonly IndexerRunResult[]): void {
  for (const run of runResults) {
    if (run.skipped || !run.id.startsWith('typescript:')) continue;
    const project = run.id.slice('typescript:'.length);
    const shardPath = typescriptProjectShardPath(outputDb, project);
    mkdirSync(dirname(shardPath), { recursive: true });
    copyFileSync(run.scipPath, shardPath);
  }
}

/**
 * Copies each reused project's cached `.scip` into the temp run dir (never
 * the original — invariant 2: cached shard files must never be
 * `renameSync`'d into outputs) and synthesizes a successful
 * `IndexerRunResult` for it so `collectIndexerOutputs` merges reused and
 * freshly-indexed project shards identically.
 */
function buildCachedTypeScriptProjectRunResults(opts: {
  outputDb: string;
  tempOutputScip: string;
  outputScipPath: string;
  reusedProjects: readonly string[];
}): IndexerRunResult[] {
  return opts.reusedProjects.map((project, index) => {
    const cachedPath = typescriptProjectShardPath(opts.outputDb, project);
    const tempCopyPath = tempScipPath(opts.tempOutputScip, 'typescript-project-cached', index);
    copyFileSync(cachedPath, tempCopyPath);
    return {
      id: `typescript:${project}`,
      language: 'typescript' as const,
      label: `typescript (${project})`,
      scipPath: tempCopyPath,
      outputScipPath: opts.outputScipPath,
      durationMs: 0,
      command: 'cached',
      outputBytes: fileSizeOrNull(tempCopyPath) ?? undefined,
    };
  });
}

interface LanguageShardClassification {
  reused: boolean;
  reason?: string;
  fingerprint: ReindexFingerprint;
  scipPath: string;
}

// Plan 6 6.5.2: decides, per requested language, whether its cached SCIP
// shard can be reused, and — when it cannot — records a specific reason so
// `reindex --json` can explain the miss instead of only reporting the
// binary rerun/reuse outcome. Reuse acceptance criteria are unchanged from
// the pre-6.5.2 `reusableLanguageOutputs` behavior: a v3 meta.json with a
// per-language fingerprint that matches the current one and a shard file
// still present on disk.
function classifyLanguageShardReuse(opts: {
  paths: ReindexOutputPaths;
  projectRoot: string;
  languages: readonly SupportedLanguage[];
  pnpmWorkspaces?: boolean;
  typescriptProjectMode?: TypeScriptProjectMode;
  typescriptProjects?: readonly string[];
  clojureConfigPath?: string;
}): Map<SupportedLanguage, LanguageShardClassification> {
  const meta = readReindexMetaOrNull(opts.paths.metaPath);
  const current = computeLanguageFingerprints(opts.projectRoot, opts.languages, opts);
  const result = new Map<SupportedLanguage, LanguageShardClassification>();
  for (const language of opts.languages) {
    const scipPath = languageShardPath(opts.paths.outputDb, language);
    const fingerprint = current[language]!;
    if (!meta) {
      result.set(language, { reused: false, reason: 'no reindex metadata found', fingerprint, scipPath });
      continue;
    }
    if (meta.version !== 3) {
      result.set(language, {
        reused: false,
        reason: `metadata version ${String(meta.version ?? 'unknown')} predates per-language shard caching`,
        fingerprint,
        scipPath,
      });
      continue;
    }
    if (language === 'typescript' && meta.scipCompanion === 'deferred') {
      result.set(language, {
        reused: false,
        reason: 'whole TypeScript SCIP companion is deferred behind changed-document overlays',
        fingerprint,
        scipPath,
      });
      continue;
    }
    if (!meta.languageFingerprints) {
      result.set(language, {
        reused: false,
        reason: 'no per-language fingerprints recorded in metadata',
        fingerprint,
        scipPath,
      });
      continue;
    }
    const cached = meta.languageFingerprints[language];
    if (!cached) {
      result.set(language, {
        reused: false,
        reason: 'no cached fingerprint for this language',
        fingerprint,
        scipPath,
      });
      continue;
    }
    if (!existsSync(scipPath)) {
      result.set(language, { reused: false, reason: 'cached shard file missing on disk', fingerprint, scipPath });
      continue;
    }
    if (stableJson(cached) !== stableJson(fingerprint)) {
      result.set(language, {
        reused: false,
        reason: 'language inputs changed since last index',
        fingerprint,
        scipPath,
      });
      continue;
    }
    result.set(language, { reused: true, fingerprint, scipPath });
  }
  return result;
}

/** Diagnostics context for reused/rerun TypeScript workspace project shards (2.4); undefined on every other path (single mode, non-workspace, or a whole-language hit/miss with no project classification). */
interface TypeScriptProjectShardDiagnosticsContext {
  outputDb: string;
  classification: ReadonlyMap<string, TypeScriptProjectShardClassification>;
}

function buildFreshReindexShardDiagnostics(
  classification: ReadonlyMap<SupportedLanguage, LanguageShardClassification>,
  runResults: readonly IndexerRunResult[],
  typescriptProjects?: TypeScriptProjectShardDiagnosticsContext,
): ReindexShardDiagnostic[] {
  const diagnostics: ReindexShardDiagnostic[] = [];
  for (const [language, info] of classification) {
    if (!info.reused) continue;
    diagnostics.push({
      id: language,
      language,
      reused: true,
      fingerprint: hashFingerprint(info.fingerprint),
      outputBytes: fileSizeOrNull(info.scipPath),
      durationMs: 0,
    });
  }
  for (const run of runResults) {
    const info = classification.get(run.language);
    const project = typescriptProjects && run.id.startsWith('typescript:') ? run.id.slice('typescript:'.length) : null;
    const projectInfo = project ? typescriptProjects!.classification.get(project) : undefined;
    diagnostics.push({
      id: run.id,
      language: run.language,
      reused: false,
      missReason: projectInfo?.reason ?? info?.reason ?? run.skipped?.reason,
      fingerprint: projectInfo
        ? hashFingerprint(projectInfo.fingerprint)
        : info
          ? hashFingerprint(info.fingerprint)
          : 'unknown',
      outputBytes: run.outputBytes ?? null,
      durationMs: run.durationMs,
      command: run.command,
    });
  }
  if (typescriptProjects) {
    for (const [project, info] of typescriptProjects.classification) {
      if (!info.reused) continue;
      diagnostics.push({
        id: `typescript:${project}`,
        language: 'typescript',
        reused: true,
        fingerprint: hashFingerprint(info.fingerprint),
        outputBytes: fileSizeOrNull(typescriptProjectShardPath(typescriptProjects.outputDb, project)),
        durationMs: 0,
      });
    }
  }
  return diagnostics;
}

function hashFingerprint(fingerprint: unknown): string {
  return createHash('sha256').update(stableJson(fingerprint)).digest('hex').slice(0, 16);
}

function fileSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function languageFingerprintsFromClassification(
  classification: ReadonlyMap<SupportedLanguage, LanguageShardClassification>,
  languages: readonly SupportedLanguage[],
): Partial<Record<SupportedLanguage, ReindexFingerprint>> {
  const fingerprints: Partial<Record<SupportedLanguage, ReindexFingerprint>> = {};
  for (const language of languages) {
    const info = classification.get(language);
    if (info) {
      fingerprints[language] = info.fingerprint;
    }
  }
  return fingerprints;
}

// scip-query: ignore-extract — this is the publish phase for a fresh index:
// materialize SCIP, convert to SQLite, promote both artifacts, and write
// metadata are one atomic handoff.
function publishFreshReindexArtifacts(
  opts: Parameters<typeof runFreshReindex>[0],
  env: NodeJS.ProcessEnv,
  indexedOutputs: readonly IndexedOutput[],
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[],
  reusedLanguages: readonly SupportedLanguage[],
  languageFingerprints: Partial<Record<SupportedLanguage, ReindexFingerprint>>,
  typescriptProjectShardContext: TypeScriptProjectShardContext | undefined,
  incrementalTypeScript: MaterializedTypeScriptIncrementalIndex | undefined,
): LastRefreshMetadata {
  const completeScipAvailable = !incrementalTypeScript || incrementalTypeScript.completeScipUpdated;
  let completeScipSanitized = false;
  if (completeScipAvailable) {
    cacheLanguageShards(opts.paths.outputDb, indexedOutputs);
    completeScipSanitized = materializeScipOutput(indexedOutputs, opts.tempPaths.tempOutputScip, opts.onStatus);
  }
  const sqliteMaterialization = materializeSqliteOutput({
    run: opts,
    env,
    indexedOutputs,
    skippedLanguages,
    reusedLanguages,
    incrementalTypeScript,
    completeScipAvailable,
    completeScipSanitized,
    materializeFullFallback: () => {
      if (!incrementalTypeScript || incrementalTypeScript.completeScipUpdated) {
        return completeScipSanitized;
      }
      opts.onStatus('Materializing the deferred whole TypeScript SCIP companion for full conversion...');
      materializeDeferredTypeScriptIndex({
        cacheDir: dirname(opts.paths.outputDb),
        generationIdentity: incrementalTypeScript.nextFragmentGeneration,
        baseShardPath: incrementalTypeScript.scipPath,
        candidateShardPath: incrementalTypeScript.candidateScipPath,
      });
      const completeOutputs = indexedOutputs.map((output) =>
        output.language === 'typescript'
          ? { language: output.language, scipPath: incrementalTypeScript.candidateScipPath }
          : output,
      );
      cacheLanguageShards(opts.paths.outputDb, completeOutputs);
      completeScipSanitized = materializeScipOutput(completeOutputs, opts.tempPaths.tempOutputScip, opts.onStatus);
      return completeScipSanitized;
    },
  });

  runPostIndexAugmentation(auxiliaryDocumentsAugmentationStage(), {
    projectRoot: opts.projectRoot,
    dbPath: opts.tempPaths.tempOutputDb,
    onStatus: opts.onStatus,
  });

  const previousSnapshot = previousProjectInputSnapshot(opts.paths.metaPath);
  const shadowRecord =
    sqliteMaterialization.mode === 'incremental' && incrementalTypeScript
      ? buildIncrementalAffectedSetShadowRecord(incrementalTypeScript, sqliteMaterialization.changedDocumentPaths)
      : collectAffectedSetShadowRecord({
          projectRoot: opts.projectRoot,
          previousDbPath: opts.paths.outputDb,
          previousIndexPath: opts.paths.outputScip,
          candidateDbPath: opts.tempPaths.tempOutputDb,
          candidateIndexPath: opts.tempPaths.tempOutputScip,
          previousSnapshot,
          currentSnapshot: opts.fingerprint,
          refreshResult: 'rebuilt',
        });

  const lastRefresh = buildLastRefresh({
    trigger: opts.opts.trigger,
    result: 'rebuilt',
    start: opts.start,
    languages: indexedOutputs.map((o) => o.language),
    skipped: [...skippedLanguages],
  });
  const deferredScipCompanion =
    sqliteMaterialization.mode === 'incremental' && sqliteMaterialization.scipCompanion === 'deferred';
  const publishedLanguageFingerprints = { ...languageFingerprints };
  if (deferredScipCompanion) delete publishedLanguageFingerprints.typescript;
  const { metadata, pruneProjects } = buildPublishedReindexMetadata({
    run: opts,
    indexedOutputs,
    skippedLanguages,
    reusedLanguages,
    languageFingerprints: publishedLanguageFingerprints,
    typescriptProjectShardContext,
    lastRefresh,
  });
  metadata.scipCompanion = deferredScipCompanion ? 'deferred' : 'current';
  pruneTypeScriptProjectShardCache(opts.paths.outputDb, pruneProjects);
  writeReindexMeta(opts.tempPaths.tempMetaPath, metadata);
  promoteReindexArtifacts({
    tempOutputScip: opts.tempPaths.tempOutputScip,
    tempOutputDb: opts.tempPaths.tempOutputDb,
    tempMetaPath: opts.tempPaths.tempMetaPath,
    outputScip: opts.paths.outputScip,
    outputDb: opts.paths.outputDb,
    metaPath: opts.paths.metaPath,
    preserveOutputScip:
      sqliteMaterialization.mode === 'incremental' && sqliteMaterialization.scipCompanion === 'deferred',
    publication:
      sqliteMaterialization.mode === 'incremental'
        ? {
            mode: 'incremental',
            validation: 'passed',
            converterDurationMs: sqliteMaterialization.converterDurationMs,
            affectedDocumentCount: incrementalTypeScript?.affectedFiles.length,
            changedDocumentCount: sqliteMaterialization.changedDocumentPaths.length,
            producerDurationMs: incrementalTypeScript?.timings.serviceMs,
            materializationDurationMs: incrementalTypeScript?.durationMs,
            patchDurationMs: sqliteMaterialization.patchDurationMs,
            scipCompanion: sqliteMaterialization.scipCompanion,
            ...(sqliteMaterialization.scipCompanion === 'deferred' && incrementalTypeScript
              ? { typescriptOverlayGeneration: incrementalTypeScript.nextFragmentGeneration }
              : {}),
          }
        : {
            mode: 'full',
            validation: 'passed',
            converterDurationMs: sqliteMaterialization.converterDurationMs,
            scipCompanion: 'current',
            ...(sqliteMaterialization.fallbackReason ? { fallbackReason: sqliteMaterialization.fallbackReason } : {}),
          },
  });
  pruneTypeScriptOverlays(
    dirname(opts.paths.outputDb),
    sqliteMaterialization.mode === 'incremental' && sqliteMaterialization.scipCompanion === 'deferred'
      ? [incrementalTypeScript!.nextFragmentGeneration]
      : [],
  );
  persistAffectedSetShadowRecord(opts.paths.outputDb, shadowRecord, opts.onStatus);
  return lastRefresh;
}

function publishFullyReusedLanguageShardArtifacts(
  opts: Parameters<typeof runFreshReindex>[0],
  indexedOutputs: readonly IndexedOutput[],
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[],
  reusedLanguages: readonly SupportedLanguage[],
  languageFingerprints: Partial<Record<SupportedLanguage, ReindexFingerprint>>,
  typescriptProjectShardContext: TypeScriptProjectShardContext | undefined,
): LastRefreshMetadata {
  const previousSnapshot = previousProjectInputSnapshot(opts.paths.metaPath);
  let shadowRecord: AffectedSetShadowRecord | null = null;
  try {
    copyFileSync(opts.paths.outputDb, opts.tempPaths.tempOutputDb);
  } catch (error) {
    shadowRecord = createUnavailableAffectedSetShadowRecord(
      'reused',
      'oracle-error',
      `Could not snapshot the prior database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  runPostIndexAugmentation(auxiliaryDocumentsAugmentationStage(), {
    projectRoot: opts.projectRoot,
    dbPath: opts.paths.outputDb,
    onStatus: opts.onStatus,
  });

  shadowRecord ??= collectAffectedSetShadowRecord({
    projectRoot: opts.projectRoot,
    previousDbPath: opts.tempPaths.tempOutputDb,
    previousIndexPath: opts.paths.outputScip,
    candidateDbPath: opts.paths.outputDb,
    candidateIndexPath: opts.paths.outputScip,
    previousSnapshot,
    currentSnapshot: opts.fingerprint,
    refreshResult: 'reused',
  });

  const lastRefresh = buildLastRefresh({
    trigger: opts.opts.trigger,
    result: 'reused',
    start: opts.start,
    languages: indexedOutputs.map((o) => o.language),
    skipped: [...skippedLanguages],
  });
  const { metadata, pruneProjects } = buildPublishedReindexMetadata({
    run: opts,
    indexedOutputs,
    skippedLanguages,
    reusedLanguages,
    languageFingerprints,
    typescriptProjectShardContext,
    lastRefresh,
  });
  pruneTypeScriptProjectShardCache(opts.paths.outputDb, pruneProjects);
  writeReindexMeta(opts.paths.metaPath, metadata);
  refreshSqliteGenerationMetadata(opts.paths.outputDb, opts.paths.metaPath);
  persistAffectedSetShadowRecord(opts.paths.outputDb, shadowRecord, opts.onStatus);
  return lastRefresh;
}

function previousProjectInputSnapshot(metaPath: string): ProjectInputSnapshot | null {
  return projectInputSnapshotOrNull(readReindexMetaOrNull(metaPath)?.fingerprint);
}

function persistAffectedSetShadowRecord(
  outputDb: string,
  record: AffectedSetShadowRecord,
  onStatus: (message: string) => void,
): void {
  try {
    writeAffectedSetShadowRecord(outputDb, record);
    if (record.status === 'evaluated') {
      onStatus(
        `Affected-set shadow: ${(record.evaluation.recall * 100).toFixed(1)}% recall; ` +
          `${record.plan.affectedFiles.length} predicted, ${record.comparison.changedFiles.length} changed.`,
      );
    } else {
      onStatus(`Affected-set shadow unavailable: ${record.reason}.`);
    }
  } catch (error) {
    onStatus(`Affected-set shadow telemetry unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildPublishedReindexMetadata(opts: {
  run: Parameters<typeof runFreshReindex>[0];
  indexedOutputs: readonly IndexedOutput[];
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[];
  reusedLanguages: readonly SupportedLanguage[];
  languageFingerprints: Partial<Record<SupportedLanguage, ReindexFingerprint>>;
  typescriptProjectShardContext: TypeScriptProjectShardContext | undefined;
  lastRefresh: LastRefreshMetadata;
}): { metadata: ReindexMetadata; pruneProjects: readonly string[] | null } {
  const typescriptProjectShards = resolveTypeScriptProjectShardsField({
    mode: opts.run.opts.typescriptProjectMode,
    skippedLanguages: opts.skippedLanguages,
    reusedLanguages: opts.reusedLanguages,
    context: opts.typescriptProjectShardContext,
    metaPath: opts.run.paths.metaPath,
  });
  return {
    metadata: {
      version: 3,
      status: opts.skippedLanguages.length === 0 ? 'complete' : 'partial',
      updatedAt: new Date().toISOString(),
      fingerprint: opts.run.fingerprint,
      languageFingerprints: opts.languageFingerprints,
      typescriptProjectShards: typescriptProjectShards.field,
      requestedLanguages: opts.run.languages,
      indexedLanguages: opts.indexedOutputs.map((o) => o.language),
      skipped: [...opts.skippedLanguages],
      lastRefresh: opts.lastRefresh,
    },
    pruneProjects: typescriptProjectShards.pruneProjects,
  };
}

/**
 * Decides what `typescriptProjectShards` value publish should write and
 * which project slugs the cache directory should retain (2.3). Three
 * outcomes:
 *  - mode isn't workspace, or typescript was skipped this run: omit the
 *    field and prune the whole cache directory (`pruneProjects: null`).
 *  - typescript's whole-language shard was reused: nothing about TS files
 *    changed, so carry the existing meta's field forward unchanged rather
 *    than recomputing it.
 *  - typescript's language shard missed and workspace classification ran
 *    (`context` present): write the freshly-computed per-project
 *    fingerprints and prune to exactly that project set.
 */
function resolveTypeScriptProjectShardsField(opts: {
  mode: TypeScriptProjectMode | undefined;
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[];
  reusedLanguages: readonly SupportedLanguage[];
  context: TypeScriptProjectShardContext | undefined;
  metaPath: string;
}): { field: Record<string, ProjectShardFingerprint> | undefined; pruneProjects: readonly string[] | null } {
  if (opts.mode !== 'workspace') {
    return { field: undefined, pruneProjects: null };
  }
  if (opts.skippedLanguages.some((s) => s.language === 'typescript')) {
    return { field: undefined, pruneProjects: null };
  }
  if (opts.reusedLanguages.includes('typescript')) {
    const existing = readReindexMetaOrNull(opts.metaPath)?.typescriptProjectShards;
    return { field: existing, pruneProjects: existing ? Object.keys(existing) : [] };
  }
  if (opts.context) {
    return { field: opts.context.fingerprints, pruneProjects: opts.context.projects };
  }
  return { field: undefined, pruneProjects: [] };
}

/**
 * `pruneProjects: null` deletes the whole cache directory (mode switched to
 * single, or typescript was skipped this run — fail-closed rather than risk
 * serving a shard from an inconsistent set). Otherwise deletes any cached
 * `.scip` whose slug doesn't belong to a current project (renamed/removed
 * tsconfig projects, or the pre-Phase-3 project list changing shape).
 */
function pruneTypeScriptProjectShardCache(outputDb: string, currentProjects: readonly string[] | null): void {
  const dir = typescriptProjectShardCacheDir(outputDb);
  if (currentProjects === null) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  let existingFiles: string[];
  try {
    existingFiles = readdirSync(dir);
  } catch {
    return;
  }
  for (const file of typescriptProjectShardFilesToDelete(existingFiles, currentProjects)) {
    rmSync(join(dir, file), { force: true });
  }
}

/** Pure: which cached shard filenames are no longer claimed by any current project. */
function typescriptProjectShardFilesToDelete(
  existingFiles: readonly string[],
  currentProjects: readonly string[],
): string[] {
  const keep = new Set(currentProjects.map((project) => `${projectShardSlug(project)}.scip`));
  return existingFiles.filter((file) => !keep.has(file));
}

function cacheLanguageShards(outputDb: string, indexedOutputs: readonly IndexedOutput[]): void {
  for (const output of indexedOutputs) {
    const shardPath = languageShardPath(outputDb, output.language);
    mkdirSync(dirname(shardPath), { recursive: true });
    if (output.scipPath !== shardPath) {
      copyFileSync(output.scipPath, shardPath);
    }
  }
}

async function ensureScipCliAvailable(skipAutoInstall: boolean, onStatus: (message: string) => void): Promise<void> {
  if (resolveScipBinary()) {
    return;
  }

  if (skipAutoInstall) {
    throw new Error(
      'The scip CLI is required but not found on PATH.\n' +
        'Install from: https://github.com/sourcegraph/scip/releases',
    );
  }

  if (platform() === 'win32') {
    throw new Error(
      'The scip CLI was not found. On Windows it ships via the npm sidecar package ' +
        'scip-query-scip-windows (installed automatically with scip-query). ' +
        "Reinstall with optional dependencies enabled, run 'npm install -g scip-query-scip-windows', " +
        'or set SCIP_QUERY_SCIP_BIN to a local scip.exe path.',
    );
  }

  onStatus('scip CLI not found on PATH. Attempting auto-install...');
  if (!tryInstallScipCli(onStatus)) {
    throw new Error(
      'The scip CLI is required but could not be installed.\n' +
        'Install manually from: https://github.com/sourcegraph/scip/releases',
    );
  }
}

function prepareIndexerRuns(opts: {
  languages: readonly SupportedLanguage[];
  tempOutputScip: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  skipAutoInstall: boolean;
  pnpmWorkspaces?: boolean;
  typescriptProjectMode?: TypeScriptProjectMode;
  typescriptProjects?: readonly string[];
  /** Skips re-discovery for the typescript language entry when provided (plan6 2.2 — discover projects once per fresh reindex). */
  preDiscoveredTypeScriptProjects?: readonly string[];
  clojureConfigPath?: string;
  onStatus: (message: string) => void;
}): PreparedIndexerPlan {
  const preparedRuns: PreparedIndexerRun[] = [];
  const skippedLanguages: { language: SupportedLanguage; reason: string }[] = [];
  const languageOutputs = opts.languages.map((language, index) => ({
    language,
    scipPath: opts.languages.length > 1 ? tempScipPath(opts.tempOutputScip, language, index) : opts.tempOutputScip,
  }));
  const languageOutputScipPaths = Object.fromEntries(
    languageOutputs.map(({ language, scipPath }) => [language, scipPath]),
  ) as Partial<Record<SupportedLanguage, string>>;

  for (const { language, scipPath } of languageOutputs) {
    const runs = prepareIndexerRunsForLanguage({ ...opts, language, scipPath });
    for (const run of runs) {
      if ('skipped' in run) {
        appendSkippedLanguage(skippedLanguages, run.skipped);
      } else {
        preparedRuns.push(run.prepared);
      }
    }
  }

  return { preparedRuns, skippedLanguages, languageOutputScipPaths };
}

function prepareIndexerRunsForLanguage(opts: {
  language: SupportedLanguage;
  scipPath: string;
  projectRoot: string;
  tempOutputScip: string;
  env: NodeJS.ProcessEnv;
  skipAutoInstall: boolean;
  pnpmWorkspaces?: boolean;
  typescriptProjectMode?: TypeScriptProjectMode;
  typescriptProjects?: readonly string[];
  preDiscoveredTypeScriptProjects?: readonly string[];
  clojureConfigPath?: string;
  onStatus: (message: string) => void;
}): ({ prepared: PreparedIndexerRun } | { skipped: { language: SupportedLanguage; reason: string } })[] {
  if (opts.language !== 'typescript' || opts.typescriptProjectMode !== 'workspace') {
    return [
      prepareIndexerRun({
        ...opts,
        id: opts.language,
        label: opts.language,
        outputScipPath: opts.scipPath,
      }),
    ];
  }

  const projects =
    opts.preDiscoveredTypeScriptProjects ?? discoverTypeScriptProjectRoots(opts.projectRoot, opts.typescriptProjects);
  if (projects.length === 0) {
    return [
      prepareIndexerRun({
        ...opts,
        id: opts.language,
        label: opts.language,
        outputScipPath: opts.scipPath,
      }),
    ];
  }

  opts.onStatus(`Indexing TypeScript workspace as ${projects.length} project shard(s).`);
  return projects.map((projectPath, index) =>
    prepareIndexerRun({
      ...opts,
      id: `typescript:${projectPath}`,
      label: `typescript (${projectPath})`,
      scipPath: tempScipPath(opts.tempOutputScip, 'typescript-project', index),
      outputScipPath: opts.scipPath,
      pnpmWorkspaces: false,
      projectPath,
    }),
  );
}

function prepareIndexerRun(opts: {
  id: string;
  language: SupportedLanguage;
  label: string;
  scipPath: string;
  outputScipPath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  skipAutoInstall: boolean;
  pnpmWorkspaces?: boolean;
  projectPath?: string;
  clojureConfigPath?: string;
  onStatus: (message: string) => void;
}): { prepared: PreparedIndexerRun } | { skipped: { language: SupportedLanguage; reason: string } } {
  const config = getIndexerConfig(opts.language);
  const binaryLabel = describeIndexerBinary(config);
  const projectLocalBinary = resolveProjectLocalIndexerBinary(config, opts.projectRoot);

  if (!projectLocalBinary && !isIndexerInstalled(config)) {
    if (opts.skipAutoInstall) {
      const reason = `${binaryLabel} not found on PATH (auto-install disabled). ${config.installUrl ?? ''}`.trim();
      opts.onStatus(`Skipping ${opts.language}: ${reason}`);
      return { skipped: { language: opts.language, reason } };
    }
    opts.onStatus(`${binaryLabel} not found. Attempting auto-install...`);
    if (!tryInstallIndexer(config, opts.onStatus)) {
      const reason = `${binaryLabel} could not be auto-installed. ${config.installUrl ? `Install manually from ${config.installUrl}` : `Install ${binaryLabel} and put it on PATH.`}`;
      opts.onStatus(`Skipping ${opts.language}: ${reason}`);
      return { skipped: { language: opts.language, reason } };
    }
  }

  const resolvedBinary = projectLocalBinary ?? resolveIndexerBinary(config);
  if (!resolvedBinary) {
    const reason = `${binaryLabel} was not found after installation checks.`;
    opts.onStatus(`Skipping ${opts.language}: ${reason}`);
    return { skipped: { language: opts.language, reason } };
  }

  const { binary, args } = config.indexArgs({
    projectRoot: opts.projectRoot,
    outputPath: opts.scipPath,
    pnpmWorkspaces: opts.pnpmWorkspaces,
    indexerBinary: resolvedBinary,
    projectPath: opts.projectPath,
    configPath: opts.language === 'clojure' ? opts.clojureConfigPath : undefined,
  });

  return {
    prepared: {
      id: opts.id,
      language: opts.language,
      label: opts.label,
      scipPath: opts.scipPath,
      outputScipPath: opts.outputScipPath,
      config,
      resolvedBinary,
      binary,
      args,
      env: getIndexerExecutionEnv(config, opts.env, resolvedBinary),
    },
  };
}

function collectIndexerOutputs(
  runResults: readonly IndexerRunResult[],
  skippedLanguages: { language: SupportedLanguage; reason: string }[],
): { indexedOutputs: { language: SupportedLanguage; scipPath: string }[] } {
  const groups = new Map<string, { language: SupportedLanguage; outputScipPath: string; scipPaths: string[] }>();
  for (const result of runResults) {
    if (result.skipped) {
      appendSkippedLanguage(skippedLanguages, result.skipped);
    } else {
      const key = `${result.language}\0${result.outputScipPath}`;
      const group = groups.get(key) ?? {
        language: result.language,
        outputScipPath: result.outputScipPath,
        scipPaths: [],
      };
      group.scipPaths.push(result.scipPath);
      groups.set(key, group);
    }
  }

  const indexedOutputs: { language: SupportedLanguage; scipPath: string }[] = [];
  for (const group of groups.values()) {
    if (group.scipPaths.length > 1) {
      mergeScipFiles(group.scipPaths, group.outputScipPath);
      indexedOutputs.push({ language: group.language, scipPath: group.outputScipPath });
    } else {
      const scipPath = group.scipPaths[0]!;
      if (scipPath !== group.outputScipPath) {
        renameSync(scipPath, group.outputScipPath);
      }
      indexedOutputs.push({ language: group.language, scipPath: group.outputScipPath });
    }
  }
  return { indexedOutputs };
}

function appendSkippedLanguage(
  skippedLanguages: { language: SupportedLanguage; reason: string }[],
  skipped: { language: SupportedLanguage; reason: string },
): void {
  const existing = skippedLanguages.find((entry) => entry.language === skipped.language);
  if (!existing) {
    skippedLanguages.push(skipped);
    return;
  }

  if (!existing.reason.includes(skipped.reason)) {
    existing.reason = `${existing.reason}; ${skipped.reason}`;
  }
}

function validateIndexingOutcome(
  indexedOutputs: readonly { language: SupportedLanguage; scipPath: string }[],
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[],
  requestedLanguages: readonly SupportedLanguage[],
  allowPartial: boolean | undefined,
  onStatus: (message: string) => void,
): void {
  if (indexedOutputs.length === 0) {
    const detail = skippedLanguages.map((s) => `  - ${s.language}: ${s.reason}`).join('\n');
    throw new Error(
      'No language indexers ran successfully. Install at least one indexer for the languages in this project.\n' +
        detail,
    );
  }

  if (skippedLanguages.length === 0) {
    return;
  }

  onStatus(
    `Indexed ${indexedOutputs.length} language output(s); skipped or incomplete: ${skippedLanguages.map((s) => s.language).join(', ')}.`,
  );
  if (!allowPartial) {
    throw new Error(
      'Failed to index all required languages; preserving the previous index. ' +
        'Pass --allow-partial to intentionally write an incomplete index.\n' +
        skippedLanguages.map((s) => `  - ${s.language}: ${s.reason}`).join('\n'),
    );
  }
}

function materializeScipOutput(
  indexedOutputs: readonly { language: SupportedLanguage; scipPath: string }[],
  tempOutputScip: string,
  onStatus: (message: string) => void,
): boolean {
  if (indexedOutputs.length > 1) {
    onStatus(`Merging ${indexedOutputs.length} language indexes...`);
    const startedAt = performance.now();
    const sanitized = mergeAndSanitizeScipFiles(
      indexedOutputs.map((entry) => entry.scipPath),
      tempOutputScip,
    );
    reportSanitizedScip(sanitized, onStatus);
    onStatus(`Merged and sanitized SCIP indexes in ${(performance.now() - startedAt).toFixed(0)}ms.`);
    return true;
  } else if (indexedOutputs[0]!.scipPath !== tempOutputScip) {
    renameSync(indexedOutputs[0]!.scipPath, tempOutputScip);
  }
  return false;
}

function materializeSqliteOutput(opts: {
  run: Parameters<typeof runFreshReindex>[0];
  env: NodeJS.ProcessEnv;
  indexedOutputs: readonly IndexedOutput[];
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[];
  reusedLanguages: readonly SupportedLanguage[];
  incrementalTypeScript: MaterializedTypeScriptIncrementalIndex | undefined;
  completeScipAvailable: boolean;
  completeScipSanitized: boolean;
  materializeFullFallback: () => boolean;
}): SqliteMaterializationResult {
  let fallbackReason: string | undefined;
  if (canPublishIncrementalSqlite(opts)) {
    const miniDbPath = join(opts.run.tempPaths.runDir, 'typescript-affected.db');
    try {
      sanitizeScipForSqlite(opts.incrementalTypeScript.affectedScipPath, opts.run.onStatus);
      opts.run.onStatus(
        `Converting ${opts.incrementalTypeScript.affectedFiles.length} affected TypeScript document(s) to SQLite...`,
      );
      const convertStartedAt = performance.now();
      convertScipToSqlite(opts.incrementalTypeScript.affectedScipPath, miniDbPath, opts.env, opts.run.onStatus);
      opts.run.onStatus(`Converted affected SCIP documents in ${(performance.now() - convertStartedAt).toFixed(0)}ms.`);
      const patched = patchIncrementalSqliteGeneration({
        previousDbPath: opts.run.paths.outputDb,
        miniDbPath,
        candidateDbPath: opts.run.tempPaths.tempOutputDb,
        affectedFiles: opts.incrementalTypeScript.affectedFiles,
      });
      opts.run.onStatus(
        `Patched ${patched.affectedDocumentCount} SQLite document(s) in ${(patched.durationMs / 1000).toFixed(3)}s.`,
      );
      return {
        mode: 'incremental',
        changedDocumentPaths: patched.changedDocumentPaths,
        patchDurationMs: patched.durationMs,
        converterDurationMs: performance.now() - convertStartedAt,
        scipCompanion: opts.incrementalTypeScript.completeScipUpdated ? 'current' : 'deferred',
      };
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      rmSync(miniDbPath, { force: true });
      rmSync(opts.run.tempPaths.tempOutputDb, { force: true });
      opts.run.onStatus(
        `Incremental SQLite publication unavailable: ${fallbackReason}. Falling back to complete conversion.`,
      );
    }
  }
  let completeScipSanitized = opts.completeScipSanitized;
  if (!opts.completeScipAvailable) completeScipSanitized = opts.materializeFullFallback();
  const convertStartedAt = performance.now();
  convertScipToSqlite(
    opts.run.tempPaths.tempOutputScip,
    opts.run.tempPaths.tempOutputDb,
    opts.env,
    opts.run.onStatus,
    completeScipSanitized,
  );
  return {
    mode: 'full',
    converterDurationMs: performance.now() - convertStartedAt,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function canPublishIncrementalSqlite(opts: {
  run: Parameters<typeof runFreshReindex>[0];
  indexedOutputs: readonly IndexedOutput[];
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[];
  reusedLanguages: readonly SupportedLanguage[];
  incrementalTypeScript: MaterializedTypeScriptIncrementalIndex | undefined;
}): opts is typeof opts & { incrementalTypeScript: MaterializedTypeScriptIncrementalIndex } {
  if (!opts.incrementalTypeScript || opts.skippedLanguages.length > 0) return false;
  if (!existsSync(opts.run.paths.outputDb) || !existsSync(opts.run.paths.outputScip)) return false;
  const reused = new Set(opts.reusedLanguages);
  return (
    opts.indexedOutputs.length === opts.run.languages.length &&
    opts.run.languages.every((language) => language === 'typescript' || reused.has(language))
  );
}

function buildIncrementalAffectedSetShadowRecord(
  incremental: MaterializedTypeScriptIncrementalIndex,
  changedDocumentPaths: readonly string[],
): AffectedSetShadowRecord {
  const startedAt = Date.now();
  const modifiedFiles = [...changedDocumentPaths].sort();
  const changed = new Set(modifiedFiles);
  const comparison = {
    addedFiles: [],
    modifiedFiles,
    deletedFiles: [],
    changedFiles: modifiedFiles,
    unchangedFiles: incremental.affectedFiles.filter((file) => !changed.has(file)).sort(),
  };
  return {
    version: 1,
    status: 'evaluated',
    refreshResult: 'rebuilt',
    recordedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    manifest: incremental.manifest,
    plan: incremental.plan,
    comparison,
    evaluation: evaluateAffectedSetShadow(incremental.plan, comparison, incremental.projectFileCount),
  };
}

function convertScipToSqlite(
  tempOutputScip: string,
  tempOutputDb: string,
  env: NodeJS.ProcessEnv,
  onStatus: (message: string) => void,
  alreadySanitized = false,
): void {
  onStatus('Converting to SQLite...');
  if (!existsSync(tempOutputScip)) {
    throw new Error(`SCIP index not found at ${tempOutputScip} after indexing`);
  }

  try {
    if (!alreadySanitized) sanitizeScipForSqlite(tempOutputScip, onStatus);
    const scipBinary = resolveScipBinary();
    if (!scipBinary) {
      throw new Error('scip CLI is not available');
    }
    execFileSync(scipBinary, ['expt-convert', '--output', tempOutputDb, tempOutputScip], {
      env,
      stdio: 'pipe',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to convert SCIP index to SQLite: ${msg}`, { cause: err });
  }
}

function sanitizeScipForSqlite(scipPath: string, onStatus: (message: string) => void): void {
  const sanitized = sanitizeScipFile(scipPath);
  reportSanitizedScip(sanitized, onStatus);
}

function reportSanitizedScip(
  sanitized: { removedDefinitionOccurrences: number; touchedDocuments: number },
  onStatus: (message: string) => void,
): void {
  if (sanitized.removedDefinitionOccurrences === 0) return;
  onStatus(
    `Sanitized ${sanitized.removedDefinitionOccurrences} invalid definition occurrences ` +
      `across ${sanitized.touchedDocuments} documents before SQLite conversion.`,
  );
}

function tempScipPath(outputScip: string, label: string, index: number): string {
  const extension = extname(outputScip) || '.scip';
  const stem = basename(outputScip, extension);
  return join(dirname(outputScip), `${stem}.${index + 1}.${label}${extension}`);
}

async function acquireReindexLock(
  lockPath: string,
  opts: { projectRoot: string; trigger?: RefreshTrigger; onStatus: (message: string) => void },
): Promise<() => void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const acquired = tryAcquireReindexLock(lockPath, opts);
    if (acquired) return acquired;

    const existing = readReindexLock(lockPath);
    if (existing && shouldPreemptReindexLock(opts.trigger, existing)) {
      opts.onStatus(`Manual reindex preempting watcher refresh started at ${existing.startedAt}.`);
      const terminated = await terminateReindexLockOwner(existing.pid);
      if (!terminated) {
        // The owner survived SIGTERM and SIGKILL (or PID liveness cannot be
        // confirmed dead, e.g. a stuck/uninterruptible process, a permission
        // failure on kill(2), or PID reuse). Stealing the lock here would let
        // two reindexes publish concurrently — fail closed instead.
        throw new Error(
          `Could not confirm the watcher's in-progress reindex (pid ${existing.pid}) terminated for ${dirname(lockPath)}; refusing to steal an active lock.`,
        );
      }
      rmSync(lockPath, { force: true });
      continue;
    }

    if (existing && !isProcessAlive(existing.pid)) {
      rmSync(lockPath, { force: true });
      continue;
    }

    throw new Error(`Another scip-query reindex is already running for ${dirname(lockPath)}.`);
  }

  throw new Error(`Could not acquire scip-query reindex lock for ${dirname(lockPath)}.`);
}

function tryAcquireReindexLock(
  lockPath: string,
  opts: { projectRoot: string; trigger?: RefreshTrigger },
): (() => void) | null {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code === 'EEXIST') {
      return null;
    }
    throw err;
  }

  const metadata: ReindexLockMetadata = {
    version: 1,
    pid: process.pid,
    projectRoot: opts.projectRoot,
    startedAt: new Date().toISOString(),
    trigger: opts.trigger,
  };
  writeFileSync(fd, JSON.stringify(metadata) + '\n');

  return () => {
    try {
      closeSync(fd);
    } finally {
      rmSync(lockPath, { force: true });
    }
  };
}

function readReindexLock(lockPath: string): ReindexLockMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<ReindexLockMetadata>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      version: 1,
      pid: parsed.pid,
      projectRoot: typeof parsed.projectRoot === 'string' ? parsed.projectRoot : dirname(lockPath),
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown',
      trigger: parsed.trigger,
    };
  } catch {
    return null;
  }
}

function shouldPreemptReindexLock(
  requested: RefreshTrigger | undefined,
  existing: ReindexLockMetadata | null,
): boolean {
  return requested?.kind === 'manual-cli' && isWatcherRefreshTrigger(existing?.trigger);
}

function isWatcherRefreshTrigger(trigger: RefreshTrigger | undefined): boolean {
  return (
    trigger?.kind === 'watch-source' ||
    trigger?.kind === 'watch-git-head' ||
    trigger?.kind === 'watch-git-index' ||
    trigger?.kind === 'watch-git-state'
  );
}

/** Returns true only once the owner's PID is confirmed dead. */
async function terminateReindexLockOwner(pid: number): Promise<boolean> {
  sendSignal(pid, 'SIGTERM');
  if (await waitForProcessExit(pid, 2_000)) return true;
  sendSignal(pid, 'SIGKILL');
  return waitForProcessExit(pid, 1_000);
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The owner already exited.
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(50);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

interface ReindexFingerprint {
  version: 2;
  languages: SupportedLanguage[];
  pnpmWorkspaces: boolean;
  typescriptProjectMode: TypeScriptProjectMode;
  typescriptProjects: string[];
  clojureConfigPath?: string;
  files: { path: string; size: number; hash: string }[];
}

function computeReindexFingerprint(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  opts: {
    pnpmWorkspaces?: boolean;
    typescriptProjectMode?: TypeScriptProjectMode;
    typescriptProjects?: readonly string[];
    clojureConfigPath?: string;
  },
): ReindexFingerprint {
  return {
    version: 2,
    languages: [...languages].sort(),
    pnpmWorkspaces: effectivePnpmWorkspaces(opts),
    typescriptProjectMode: opts.typescriptProjectMode ?? 'single',
    typescriptProjects: normalizeTypeScriptProjects(opts.typescriptProjects),
    clojureConfigPath: normalizeOptionalPath(opts.clojureConfigPath),
    files: fingerprintProjectFiles(projectRoot),
  };
}

// scip-query: ignore-similar - per-language fingerprints intentionally reuse the project fingerprint inputs by language.
function computeLanguageFingerprints(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  opts: {
    pnpmWorkspaces?: boolean;
    typescriptProjectMode?: TypeScriptProjectMode;
    typescriptProjects?: readonly string[];
    clojureConfigPath?: string;
  },
): Partial<Record<SupportedLanguage, ReindexFingerprint>> {
  return Object.fromEntries(
    languages.map((language) => {
      const markerFiles = getIndexerConfig(language).markerFiles;
      const typeScriptOptions =
        language === 'typescript'
          ? {
              typescriptProjectMode: opts.typescriptProjectMode ?? 'single',
              typescriptProjects: normalizeTypeScriptProjects(opts.typescriptProjects),
            }
          : { typescriptProjectMode: 'single' as const, typescriptProjects: [] };
      const clojureConfigPath = language === 'clojure' ? normalizeOptionalPath(opts.clojureConfigPath) : undefined;
      return [
        language,
        {
          version: 2,
          languages: [language],
          pnpmWorkspaces: language === 'typescript' && effectivePnpmWorkspaces(opts),
          ...typeScriptOptions,
          clojureConfigPath,
          files: fingerprintProjectFiles(projectRoot, { language, markerFiles }),
        },
      ];
    }),
  ) as Partial<Record<SupportedLanguage, ReindexFingerprint>>;
}

function normalizeOptionalPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed || undefined;
}

function effectivePnpmWorkspaces(opts: {
  pnpmWorkspaces?: boolean;
  typescriptProjectMode?: TypeScriptProjectMode;
}): boolean {
  return opts.typescriptProjectMode !== 'workspace' && opts.pnpmWorkspaces === true;
}

function languageShardPath(outputDb: string, language: SupportedLanguage): string {
  return join(dirname(outputDb), 'language-indexes', `${language}.scip`);
}

function typescriptProjectShardCacheDir(outputDb: string): string {
  return join(dirname(outputDb), 'language-indexes', 'typescript-projects');
}

function typescriptProjectShardPath(outputDb: string, project: string): string {
  return join(typescriptProjectShardCacheDir(outputDb), `${projectShardSlug(project)}.scip`);
}

function readReindexMetaOrNull(metaPath: string): Partial<ReindexMetadata> | null {
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as Partial<ReindexMetadata>;
  } catch {
    return null;
  }
}

function isUnchangedReindex(metaPath: string, fingerprint: ReindexFingerprint): boolean {
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Partial<ReindexMetadata>;
    return (
      (meta.version === 2 || meta.version === 3) &&
      meta.status === 'complete' &&
      stableJson(meta.fingerprint) === stableJson(fingerprint) &&
      stableJson([...(meta.indexedLanguages ?? [])].sort()) === stableJson(fingerprint.languages)
    );
  } catch {
    return false;
  }
}

function writeReindexMeta(metaPath: string, metadata: ReindexMetadata): void {
  writeJsonAtomic(metaPath, metadata, { spacing: 2, trailingNewline: true });
}

function updateReindexLastRefresh(metaPath: string, lastRefresh: LastRefreshMetadata): void {
  try {
    const metadata = JSON.parse(readFileSync(metaPath, 'utf-8')) as ReindexMetadata;
    if (metadata.version !== 2 && metadata.version !== 3) return;
    writeReindexMeta(metaPath, { ...metadata, lastRefresh });
  } catch {
    // Best-effort operational metadata must never mask the reindex result.
  }
}

function buildLastRefresh(opts: {
  trigger?: RefreshTrigger;
  result: LastRefreshMetadata['result'];
  start: number;
  languages?: readonly SupportedLanguage[];
  skipped?: readonly { language: SupportedLanguage; reason: string }[];
  error?: string;
}): LastRefreshMetadata {
  return {
    trigger: opts.trigger ?? { kind: 'unknown' },
    result: opts.result,
    startedAt: new Date(opts.start).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - opts.start,
    indexedLanguages: opts.languages ? [...opts.languages] : undefined,
    skipped: opts.skipped ? [...opts.skipped] : undefined,
    error: opts.error,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
