import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { runBoundedProcess } from '../platform/bounded-process.js';
import {
  isLanguageRelevantProjectInputPath,
  projectInputSnapshotOrNull,
  type FileDependencyGraph,
  type ProjectFileFingerprint,
  type ProjectInputSnapshot,
} from '../domain/project-input.js';
import {
  acceptedReindexMetadata,
  CURRENT_REINDEX_METADATA_VERSION,
  decodeReindexMetadata,
  reindexMetadataCapabilities,
  type ReindexMetadata as DecodedReindexMetadata,
  type ReindexMetadataV3,
  hasCurrentSqliteQueryLayout,
} from '../domain/reindex-metadata.js';
import { CURRENT_SQLITE_QUERY_LAYOUT_VERSION } from '../domain/sqlite-query-layout.js';
import { monotonicNowMs } from '../domain/time.js';
import type { ProjectInputChangeJournal } from '../domain/project-input-change-journal.js';
import { profileAsyncSpan, profileEnabled, profileSpan, writeProfileEvent } from '../instrumentation/profile.js';
import { hardenOwnedCacheTreeIfOwned } from '../platform/cache-layout.js';
import { recoverTypeScriptPackageSemanticHash } from '../platform/typescript-semantic-hash.js';
import { resolveScipBinary, tryInstallScipCli } from '../platform/scip-cli.js';
import {
  parseProcessIdentity,
  readProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from '../platform/process-identity.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import { resolveGitWorktreeContext } from '../platform/git-worktree.js';
import { acquireProcessFileLock } from '../platform/repository-cache-lock.js';
import {
  readProcessFileLock,
  reclaimProcessFileLock,
  tryAcquireProcessFileLock,
  type LegacyProcessLockDecoder,
  type ProcessFileLockObservation,
} from '../platform/process-file-lock.js';
import {
  describeIndexerBinary,
  getIndexerExecutionEnv,
  isIndexerInstalled,
  resolveIndexerBinary,
  resolveProjectLocalIndexerBinary,
  trustProjectLocalIndexerBinary,
} from '../platform/indexer-toolchain.js';
import { throwIfSignalAborted } from '../platform/abort-signal.js';
import { ReindexLockUnavailableError } from './reindex-worker-protocol.js';
import {
  buildProjectInputFingerprint,
  buildProjectInputFingerprintFromJournal,
  revalidateKnownProjectInputFingerprint,
  normalizeTypeScriptProjects,
  type ProjectInputFingerprint,
} from '../platform/project-files.js';
import { publishedSqliteGenerationIdentity } from '../storage/sqlite-generation.js';
import type { LastRefreshMetadata, RefreshTrigger, SupportedLanguage, TypeScriptProjectMode } from '../domain/types.js';
import {
  cloneFileWithFallback,
  createReindexWriteTelemetry,
  recordFileClone,
  recordIncrementalWrite,
  type ReindexWriteTelemetry,
} from '../platform/file-clone.js';
import { writeJsonDurable } from '../storage/atomic-json.js';
import { ScipDatabase } from '../storage/db.js';
import {
  EVIDENCE_DB_FILENAME,
  projectEvidenceFingerprint,
  rekeyCachedProjectEvidenceKind,
} from '../storage/evidence-cache.js';
import { seedTypeScriptReferenceFragments } from '../semantic/typescript/reference-fragment-shadow.js';
import {
  captureTypeScriptPlanningDependencyGraph,
  carryFileDependencyGraph,
  materializeCarriedFileDependencyGraph,
} from '../symbols/graph/file-dep-graph.js';
import { auxiliaryDocumentsAugmentationStage } from './augmentation/augment.js';
import { runtimeBoundaryAugmentationStage } from './runtime-boundaries.js';
import {
  collectAffectedSetShadowRecord,
  createUnavailableAffectedSetShadowRecord,
  evaluateAffectedSetShadow,
  writeAffectedSetShadowRecord,
  type AffectedSetShadowRecord,
} from './affected-shadow.js';
import { detectLanguages } from './detect.js';
import { getIndexerConfig, temporaryRootConfigContent } from './indexers.js';
import { concatenateScipFiles, mergeAndSanitizeScipFiles, mergeScipFiles } from './merge.js';
import { patchIncrementalSqliteGeneration } from './incremental-sqlite-publication.js';
import { optimizeSqliteQueryLayout } from './sqlite-index-maintenance.js';
import { runPostIndexAugmentation } from './augmentation/post-index-augmentation.js';
import { recordFailedReindexActivity, recordReindexRunActivity } from './reindex-activity.js';
import { inspectIndexDocumentCoverage, type IndexDocumentCoverage } from './index-coverage.js';
import type { ReindexResult, ReindexShardDiagnostic } from './reindex-result.js';
export type { ReindexResult, ReindexShardDiagnostic } from './reindex-result.js';
import {
  assignFilesToProjects,
  computeProjectShardFingerprints,
  deriveProjectDependencies,
  projectShardSlug,
  readProjectManifestInputs,
} from './project-shards.js';
import { sanitizeScipFile } from './sanitize.js';
import {
  acquireSharedGenerationBuildLock,
  buildSharedGenerationSnapshot,
  findSharedBaselineGeneration,
  hydrateSharedGeneration,
  publishSharedGeneration,
  readSharedGeneration,
  sharedCacheBypassReason,
  writeWorktreeOverlayLease,
  writeWorktreeLease,
  type SharedGenerationSnapshot,
} from './shared-generation-store.js';
import {
  ensureImmutableSqliteGeneration,
  inspectSqliteGeneration,
  promoteReindexArtifacts,
  refreshSqliteGenerationMetadata,
} from './sqlite-generation-store.js';
import { pruneTypeScriptOverlays } from './typescript-overlay-store.js';
import {
  activeTypeScriptProjectConfigPaths,
  discoverTypeScriptProjectRoots,
  isTypeScriptProjectConfigPath,
  typeScriptProjectInputPaths,
} from './typescript-projects.js';
import {
  createTypeScriptCompilerShards,
  removeStaleTypeScriptCompilerShardConfigs,
  shouldShardTypeScriptCompilerInputs,
  typescriptCompilerShardCount,
  typescriptCompilerShardParallelism,
  typescriptCompilerShardTargetFiles,
} from './typescript-compiler-shards.js';
import {
  materializeDeferredTypeScriptIndex,
  tryMaterializeTypeScriptIncrementalIndex,
  type MaterializedTypeScriptIncrementalIndex,
} from './typescript-incremental-index.js';
import { pruneTypeScriptFragmentGenerations } from './typescript-fragment-store.js';
import { runPreparedIndexers } from './indexer-runner.js';
import type { PreparedIndexerRun, IndexerRunResult } from './indexer-runner.js';
import { tryInstallIndexer } from './install.js';

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
  /** Explicitly permit installing missing global tools for this operation. */
  installMissing?: boolean;
  /** Permit repository-local indexers after an explicit trust decision. */
  trustProjectTools?: boolean;
  /** Reuse an existing index when tracked source inputs are unchanged (default true). */
  skipIfUnchanged?: boolean;
  /** Permit a partial index when some detected/requested languages fail (default false). */
  allowPartial?: boolean;
  /** Number of language indexers to run at once (default: conservative auto). */
  indexerConcurrency?: number;
  /** Source that requested this refresh, persisted for status and setup diagnostics. */
  trigger?: RefreshTrigger;
  /** Exact watcher-observed changes since one accepted immutable generation. */
  changeJournal?: ProjectInputChangeJournal;
  /** When false, skip full language indexers after incremental misses. Default true. */
  allowExpensiveRebuild?: boolean;
  /** Cancel this reindex and every bounded child process. */
  signal?: AbortSignal;
}

interface PreparedIndexerPlan {
  preparedRuns: PreparedIndexerRun[];
  skippedLanguages: { language: SupportedLanguage; reason: string }[];
  languageOutputScipPaths: Partial<Record<SupportedLanguage, string>>;
}

type PublishedReindexMetadata = ReindexMetadataV3 & {
  status: 'complete' | 'partial';
  updatedAt: string;
  fingerprint: ReindexFingerprint;
  languageFingerprints: Partial<Record<SupportedLanguage, ReindexFingerprint>>;
  sqliteLayoutVersion: typeof CURRENT_SQLITE_QUERY_LAYOUT_VERSION;
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
};

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
  version: 1 | 2;
  pid: number;
  processIdentity?: ProcessIdentity;
  processGroupLeader?: boolean;
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
  const { projectRoot, onStatus = console.log } = opts;
  const maxHeapMb = opts.maxHeapMb ?? inheritedMaxOldSpaceMb(process.env['NODE_OPTIONS']) ?? 8192;
  // Compatibility note: skipAutoInstall=true still wins, but false does not
  // grant host-mutation authority. Only installMissing=true does.
  const skipAutoInstall = opts.skipAutoInstall === true || opts.installMissing !== true;

  const paths = resolveReindexOutputPaths(opts);
  const start = Date.now();
  const monotonicStart = monotonicNowMs();
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

  const previousFingerprint = previousProjectInputSnapshot(paths.metaPath);
  let fingerprintBuild = profileSpan(
    'reindex.fingerprint',
    () =>
      buildProjectInputFingerprintFromJournal(
        projectRoot,
        languages,
        {
          pnpmWorkspaces: opts.pnpmWorkspaces,
          typescriptProjectMode: opts.typescriptProjectMode,
          typescriptProjects: opts.typescriptProjects,
          clojureConfigPath: opts.clojureConfigPath,
        },
        previousFingerprint,
        opts.changeJournal,
        publishedSqliteGenerationIdentity(paths.outputDb),
      ),
    { languages: languages.length },
  );
  let fingerprint = fingerprintBuild.fingerprint;
  const changedAcceptedPaths =
    fingerprintBuild.mode === 'delta'
      ? (opts.changeJournal?.entries.filter((entry) => entry.kind !== 'add').length ?? 0)
      : 0;
  const reusedFingerprintCount = Math.max(0, (previousFingerprint?.files.length ?? 0) - changedAcceptedPaths);
  onStatus(
    fingerprintBuild.mode === 'delta'
      ? `Project fingerprint revalidated ${fingerprintBuild.changedPaths.length} changed path(s), ` +
          `reused ${reusedFingerprintCount} accepted file fingerprint(s), and accepted ${fingerprint.files.length} input(s)`
      : `Project fingerprint used full scan: ${fingerprintBuild.reason}`,
  );
  const sharedGeneration = await prepareSharedGenerationCache({ opts, paths, languages, fingerprint, onStatus });
  let sharedSnapshot = sharedGeneration.snapshot;
  let releaseSharedBuildLock = sharedGeneration.releaseBuildLock;
  const watcherRefresh = isWatcherRefreshTrigger(opts.trigger);
  const cacheLifecycleLock = acquireProcessFileLock(join(dirname(paths.outputDb), 'cache-lifecycle.lock'), {
    // A watcher must not sit on a spare Node process for 30 seconds while a
    // manual refresh owns the cache. Report a retryable outcome and back off.
    waitMs: watcherRefresh ? 1_000 : 30_000,
  });
  if (!cacheLifecycleLock) {
    releaseSharedBuildLock?.();
    throw new ReindexLockUnavailableError(
      watcherRefresh
        ? `Could not acquire scip-query cache lifecycle lock for ${dirname(paths.outputDb)}; another refresh is publishing, so the watcher will retry.`
        : `Could not acquire scip-query cache lifecycle lock for ${dirname(paths.outputDb)}. ` +
            'A watch daemon or another reindex may hold it. Run "scip-query watch --stop", retry the reindex, then restart with "scip-query watch --daemon".',
    );
  }
  let releaseLock: (() => void) | undefined;
  try {
    releaseLock = await profileAsyncSpan(
      'reindex.lock',
      () =>
        acquireReindexLock(join(dirname(paths.outputDb), 'index.lock'), {
          projectRoot,
          trigger: opts.trigger,
          onStatus,
        }),
      { languages: languages.length },
    );
  } catch (error) {
    cacheLifecycleLock.release();
    releaseSharedBuildLock?.();
    throw error;
  }
  let runDir: string | null = null;
  const writeTelemetry = createReindexWriteTelemetry();

  try {
    if (
      fingerprintBuild.mode === 'delta' &&
      publishedSqliteGenerationIdentity(paths.outputDb) !== opts.changeJournal?.baseGeneration
    ) {
      fingerprint = buildProjectInputFingerprint(projectRoot, languages, {
        pnpmWorkspaces: opts.pnpmWorkspaces,
        typescriptProjectMode: opts.typescriptProjectMode,
        typescriptProjects: opts.typescriptProjects,
        clojureConfigPath: opts.clojureConfigPath,
      });
      fingerprintBuild = { mode: 'full', fingerprint, reason: 'accepted-generation-changed-before-lock' };
      sharedSnapshot = undefined;
      releaseSharedBuildLock?.();
      releaseSharedBuildLock = undefined;
      onStatus('Project fingerprint used full scan: accepted-generation-changed-before-lock');
    }
    ensureImmutableSqliteGeneration(paths.outputDb, paths.outputScip, paths.metaPath);
    const staleRunCleanup = pruneStaleReindexRunDirectories(dirname(paths.outputDb));
    if (staleRunCleanup.removed > 0) {
      onStatus(`Removed ${staleRunCleanup.removed} abandoned reindex workspace(s)`);
    }
    for (const error of staleRunCleanup.errors) {
      onStatus(`Could not remove abandoned reindex workspace: ${error}`);
    }

    let reuseObservation: ReindexResult | null = null;
    const reused = profileSpan(
      'reindex.reuse-check',
      () => {
        reuseObservation = reuseExistingIndexIfPossible({
          opts,
          paths,
          languages,
          fingerprint,
          start,
          monotonicStart,
          onStatus,
        });
        return reuseObservation;
      },
      () => ({ languages: languages.length, reused: reuseObservation !== null }),
    );
    if (reused) {
      publishSharedReindexResult({ snapshot: sharedSnapshot, paths, projectRoot, fingerprint, onStatus });
      const activityWrite = recordReindexRunActivity(paths.outputDb, reused);
      if (activityWrite.state === 'failed') {
        onStatus(`Warning: reindex succeeded, but activity telemetry was not recorded: ${activityWrite.reason}`);
      }
      hardenOwnedCacheTreeIfOwned(projectRoot, dirname(paths.outputDb));
      return reused;
    }

    await profileAsyncSpan('reindex.scip-cli-ready', () => ensureScipCliAvailable(skipAutoInstall, onStatus));

    const tempPaths = createTempReindexPaths(paths);
    runDir = tempPaths.runDir;
    let freshObservation: ReindexResult | undefined;
    const freshResult = await profileAsyncSpan(
      'reindex.fresh',
      async () => {
        freshObservation = await runFreshReindex({
          opts,
          languages,
          projectRoot,
          paths,
          tempPaths,
          fingerprint,
          start,
          monotonicStart,
          maxHeapMb,
          skipAutoInstall,
          onStatus,
          writeTelemetry,
        });
        return freshObservation;
      },
      () => ({
        languages: languages.length,
        reused: freshObservation?.reused,
        skipped: freshObservation?.skipped.length,
      }),
    );
    publishSharedReindexResult({ snapshot: sharedSnapshot, paths, projectRoot, fingerprint, onStatus });
    const activityWrite = recordReindexRunActivity(paths.outputDb, freshResult);
    if (activityWrite.state === 'failed') {
      onStatus(`Warning: reindex succeeded, but activity telemetry was not recorded: ${activityWrite.reason}`);
    }
    hardenOwnedCacheTreeIfOwned(projectRoot, dirname(paths.outputDb));
    return freshResult;
  } catch (error) {
    const lastRefresh = buildLastRefresh({
      trigger: opts.trigger,
      result: 'failed',
      start,
      monotonicStart,
      error: error instanceof Error ? error.message : String(error),
    });
    updateReindexLastRefresh(paths.metaPath, lastRefresh);
    const activityWrite = recordFailedReindexActivity(paths.outputDb, lastRefresh);
    if (activityWrite.state === 'failed') {
      onStatus(`Warning: failed reindex activity telemetry was not recorded: ${activityWrite.reason}`);
    }
    throw error;
  } finally {
    if (runDir) {
      rmSync(runDir, { recursive: true, force: true });
    }
    releaseLock();
    cacheLifecycleLock.release();
    releaseSharedBuildLock?.();
  }
}

async function prepareSharedGenerationCache(input: {
  opts: ReindexOptions;
  paths: ReindexOutputPaths;
  languages: SupportedLanguage[];
  fingerprint: ReindexFingerprint;
  onStatus: (message: string) => void;
}): Promise<{ snapshot: SharedGenerationSnapshot | undefined; releaseBuildLock: (() => void) | undefined }> {
  const { opts, paths, languages, fingerprint, onStatus } = input;
  const projectRoot = opts.projectRoot;
  const sharedCacheEligible =
    opts.skipIfUnchanged !== false &&
    !sharedCacheBypassReason(projectRoot, paths.outputDb) &&
    resolve(paths.outputScip) === resolve(join(dirname(paths.outputDb), 'index.scip'));
  if (!sharedCacheEligible) return { snapshot: undefined, releaseBuildLock: undefined };

  const context = resolveGitWorktreeContext(projectRoot);
  const snapshot = context?.clean ? buildSharedGenerationSnapshot(context, fingerprint) : undefined;
  if (context && !context.clean && !localArtifactsCanSeedIncrementalReindex(paths)) {
    hydrateCompatibleSharedBaseline({
      context,
      languages,
      opts,
      paths,
      fingerprint,
      projectRoot,
      onStatus,
      successMessage: 'dirty worktree reindex',
      failurePrefix: 'Shared baseline fork failed',
    });
    return { snapshot, releaseBuildLock: undefined };
  }
  if (!snapshot) return { snapshot: undefined, releaseBuildLock: undefined };

  const shared = readSharedGeneration(snapshot);
  if (shared) {
    if (!localArtifactsMatchFingerprint(paths, fingerprint)) {
      try {
        hydrateSharedGeneration({
          snapshot,
          manifest: shared,
          targetCacheDir: dirname(paths.outputDb),
          targetProjectRoot: projectRoot,
        });
        onStatus(`Attached shared generation ${snapshot.generationId.slice(0, 12)}`);
      } catch (error) {
        onStatus(`Shared generation attach failed; continuing locally: ${errorMessage(error)}`);
      }
    }
    return { snapshot, releaseBuildLock: undefined };
  }

  if (context && !localArtifactsCanSeedIncrementalReindex(paths)) {
    hydrateCompatibleSharedBaseline({
      context,
      languages,
      opts,
      paths,
      fingerprint,
      projectRoot,
      onStatus,
      successMessage: 'cold worktree reindex',
      failurePrefix: 'Compatible shared baseline fork failed',
      compatible: true,
    });
  }
  const sharedLock = await acquireSharedGenerationBuildLock(snapshot);
  if (sharedLock.kind === 'owner') return { snapshot, releaseBuildLock: sharedLock.release };
  if (sharedLock.kind === 'generation-ready') {
    const published = readSharedGeneration(snapshot);
    if (published) {
      try {
        hydrateSharedGeneration({
          snapshot,
          manifest: published,
          targetCacheDir: dirname(paths.outputDb),
          targetProjectRoot: projectRoot,
          action: 'waited',
        });
        onStatus(`Attached shared generation ${snapshot.generationId.slice(0, 12)} after waiting`);
      } catch (error) {
        onStatus(`Shared generation attach failed after waiting; continuing locally: ${errorMessage(error)}`);
      }
    }
  } else {
    onStatus('Shared generation build lock timed out; continuing with an isolated local reindex');
  }
  return { snapshot, releaseBuildLock: undefined };
}

function hydrateCompatibleSharedBaseline(input: {
  context: NonNullable<ReturnType<typeof resolveGitWorktreeContext>>;
  languages: SupportedLanguage[];
  opts: ReindexOptions;
  paths: ReindexOutputPaths;
  fingerprint: ReindexFingerprint;
  projectRoot: string;
  onStatus: (message: string) => void;
  successMessage: string;
  failurePrefix: string;
  compatible?: boolean;
}): void {
  const baseline = findSharedBaselineGeneration(
    input.context,
    input.languages,
    {
      pnpmWorkspaces: input.opts.pnpmWorkspaces,
      typescriptProjectMode: input.opts.typescriptProjectMode,
      typescriptProjects: input.opts.typescriptProjects,
      clojureConfigPath: input.opts.clojureConfigPath,
    },
    input.fingerprint,
  );
  if (!baseline) return;
  try {
    hydrateSharedGeneration({
      snapshot: baseline.snapshot,
      manifest: baseline.manifest,
      targetCacheDir: dirname(input.paths.outputDb),
      targetProjectRoot: input.projectRoot,
      persistLease: false,
    });
    writeWorktreeOverlayLease(baseline.snapshot, dirname(input.paths.outputDb));
    input.onStatus(
      `Forked ${input.compatible ? 'compatible ' : ''}shared baseline ${baseline.snapshot.generationId.slice(0, 12)} for ${input.successMessage}`,
    );
  } catch (error) {
    input.onStatus(`${input.failurePrefix}; continuing locally: ${errorMessage(error)}`);
  }
}

function publishSharedReindexResult(input: {
  snapshot: SharedGenerationSnapshot | undefined;
  paths: ReindexOutputPaths;
  projectRoot: string;
  fingerprint: ReindexFingerprint;
  onStatus: (message: string) => void;
}): void {
  if (!input.snapshot) return;
  try {
    const postContext = resolveGitWorktreeContext(input.projectRoot);
    const postSnapshot = postContext ? buildSharedGenerationSnapshot(postContext, input.fingerprint) : undefined;
    if (!postSnapshot || postSnapshot.generationId !== input.snapshot.generationId) {
      input.onStatus('Skipped shared generation publication because the worktree changed during indexing');
      return;
    }
    const publication = publishSharedGeneration({
      snapshot: input.snapshot,
      sourceCacheDir: dirname(input.paths.outputDb),
      sourceProjectRoot: input.projectRoot,
      sourceStillValid: () => {
        const current = resolveGitWorktreeContext(input.projectRoot);
        return (
          (current ? buildSharedGenerationSnapshot(current, input.fingerprint) : undefined)?.generationId ===
          input.snapshot?.generationId
        );
      },
    });
    writeWorktreeLease(input.snapshot, dirname(input.paths.outputDb), 'built');
    input.onStatus(
      publication.kind === 'published'
        ? `Published shared generation ${input.snapshot.generationId.slice(0, 12)} (${publication.achievedDurability})`
        : `Shared generation ${input.snapshot.generationId.slice(0, 12)} was already available (${publication.achievedDurability})`,
    );
  } catch (error) {
    input.onStatus(`Shared generation publication failed; local index remains valid: ${errorMessage(error)}`);
  }
}

function localArtifactsMatchFingerprint(paths: ReindexOutputPaths, fingerprint: ReindexFingerprint): boolean {
  if (
    !existsSync(paths.outputScip) ||
    !existsSync(paths.outputDb) ||
    reindexFingerprintMatch(paths.metaPath, fingerprint) === null
  ) {
    return false;
  }
  const generation = inspectSqliteGeneration(paths.outputDb, paths.metaPath);
  return generation.state !== 'invalid' && generation.state !== 'drifted';
}

function localArtifactsCanSeedIncrementalReindex(paths: ReindexOutputPaths): boolean {
  if (!existsSync(paths.outputScip) || !existsSync(paths.outputDb) || !readReindexMetaOrNull(paths.metaPath)) {
    return false;
  }
  const generation = inspectSqliteGeneration(paths.outputDb, paths.metaPath);
  return generation.state !== 'invalid' && generation.state !== 'drifted';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inheritedMaxOldSpaceMb(nodeOptions: string | undefined): number | undefined {
  const match = nodeOptions?.match(/--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)/u);
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function nodeOptionsWithMaxOldSpace(nodeOptions: string | undefined, maxHeapMb: number): string {
  const preserved = (nodeOptions ?? '').replace(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/gu, ' ').trim();
  return [preserved, `--max-old-space-size=${maxHeapMb}`].filter(Boolean).join(' ');
}

export { detectLanguages } from './detect.js';
export { augmentAuxiliaryDocuments, auxiliaryDocumentsAugmentationStage } from './augmentation/augment.js';
export { runPostIndexAugmentation } from './augmentation/post-index-augmentation.js';
export {
  augmentVueResolvedReferences,
  augmentVueResolvedReferencesAsync,
  vueResolvedReferencesAugmentationStage,
} from './vue/augment-vue.js';

function runRuntimeBoundaryAugmentation(
  projectRoot: string,
  dbPath: string,
  indexPath: string,
  onStatus: (message: string) => void,
  reuseExisting: boolean,
  affectedFiles?: readonly string[],
  evidenceDbPath?: string,
  forceDerivedRebuild = false,
): void {
  try {
    runPostIndexAugmentation(
      runtimeBoundaryAugmentationStage({
        indexPath,
        evidenceDbPath,
        reuseExisting,
        affectedFiles,
        forceDerivedRebuild,
      }),
      {
        projectRoot,
        dbPath,
        onStatus,
      },
    );
  } catch (error) {
    onStatus(`Runtime-boundary extraction unavailable: ${error instanceof Error ? error.message : String(error)}.`);
  }
}
export { getIndexerConfig, INDEXER_CONFIGS } from './indexers.js';
export { mergeScipFiles, mergeScipIndexes } from './merge.js';
export {
  describeIndexerBinary,
  getIndexerExecutionEnv,
  isIndexerInstalled,
  resolveIndexerBinary,
  resolveProjectLocalIndexerBinary,
} from '../platform/indexer-toolchain.js';
export { isBinaryAvailable } from '../platform/binary.js';
export { tryInstallIndexer } from './install.js';
export { tryInstallScipCli } from '../platform/scip-cli.js';

function resolveReindexOutputPaths(opts: ReindexOptions): ReindexOutputPaths {
  const outputScip = opts.outputScip ?? join(opts.projectRoot, 'index.scip');
  const outputDb = opts.outputDb ?? join(opts.projectRoot, 'index.db');
  return {
    outputScip,
    outputDb,
    metaPath: join(dirname(outputDb), 'meta.json'),
  };
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function reuseExistingIndexIfPossible(opts: {
  opts: ReindexOptions;
  paths: ReindexOutputPaths;
  languages: SupportedLanguage[];
  fingerprint: ReindexFingerprint;
  start: number;
  monotonicStart: number;
  onStatus: (message: string) => void;
}): ReindexResult | null {
  const generation = inspectSqliteGeneration(opts.paths.outputDb, opts.paths.metaPath);
  const fingerprintMatch = reindexFingerprintMatch(opts.paths.metaPath, opts.fingerprint);
  if (
    opts.opts.skipIfUnchanged === false ||
    !existsSync(opts.paths.outputScip) ||
    !existsSync(opts.paths.outputDb) ||
    fingerprintMatch === null ||
    generation.state === 'invalid' ||
    generation.state === 'drifted'
  ) {
    return null;
  }

  const coverage = inspectIndexDocumentCoverage(opts.paths.outputDb, opts.fingerprint, opts.languages);
  if (coverage.state !== 'complete') {
    opts.onStatus(describeIndexCoverageFailure('Accepted SQLite index', coverage));
    return null;
  }

  runPostIndexAugmentation(auxiliaryDocumentsAugmentationStage(), {
    projectRoot: opts.opts.projectRoot,
    dbPath: opts.paths.outputDb,
    onStatus: opts.onStatus,
  });
  runRuntimeBoundaryAugmentation(
    opts.opts.projectRoot,
    opts.paths.outputDb,
    opts.paths.outputScip,
    opts.onStatus,
    true,
  );
  // Reuse normally leaves the immutable SQLite generation untouched. A
  // post-index augmentation may still replace derived tables in the stable
  // database (for example, after an extractor schema upgrade). Publish that
  // completed database as a new immutable generation before returning, or
  // every later command will correctly classify the stable mirror as drifted
  // and pay for another reindex.
  if (inspectSqliteGeneration(opts.paths.outputDb, opts.paths.metaPath).state === 'drifted') {
    refreshSqliteGenerationMetadata(opts.paths.outputDb, opts.paths.metaPath);
    opts.onStatus('Published refreshed SQLite generation after post-index augmentation');
  }
  if (fingerprintMatch === 'operational-config-compatible') {
    updateReindexFingerprintMetadata(opts.paths.metaPath, opts.fingerprint, opts.languages, opts.opts);
    refreshSqliteGenerationMetadata(opts.paths.outputDb, opts.paths.metaPath);
    opts.onStatus('Migrated operational .scipquery.json metadata without rerunning language indexers.');
  }
  const durationMs = monotonicNowMs() - opts.monotonicStart;
  const lastRefresh = buildLastRefresh({
    trigger: opts.opts.trigger,
    result: 'reused',
    start: opts.start,
    monotonicStart: opts.monotonicStart,
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
    shards: buildFullyReusedShardDiagnostics(opts.paths, opts.languages, opts.opts, opts.fingerprint),
  };
}

// Plan 6 6.5.2: every language is reused together on the whole-project reuse
// path (the project fingerprint check above already proved every tracked
// input is unchanged), so each shard's diagnostic is `reused: true` with no
// indexer command or miss reason.
function buildFullyReusedShardDiagnostics(
  paths: ReindexOutputPaths,
  languages: readonly SupportedLanguage[],
  opts: {
    pnpmWorkspaces?: boolean;
    typescriptProjectMode?: TypeScriptProjectMode;
    typescriptProjects?: readonly string[];
    clojureConfigPath?: string;
  },
  projectFingerprint: ReindexFingerprint,
): ReindexShardDiagnostic[] {
  const fingerprints = computeLanguageFingerprints(projectFingerprint, languages, opts);
  return languages.map((language) => ({
    id: language,
    language,
    reused: true,
    strategy: 'reused',
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

function pruneStaleReindexRunDirectories(cacheDir: string): { removed: number; errors: string[] } {
  const errors: string[] = [];
  let entries;
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true });
  } catch (error) {
    return { removed: 0, errors: [errorMessage(error)] };
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith('reindex-') || !entry.isDirectory()) continue;
    try {
      rmSync(join(cacheDir, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      errors.push(`${entry.name}: ${errorMessage(error)}`);
    }
  }
  return { removed, errors };
}

// scip-query: ignore-extract — reviewed E1 workflow owner; fresh indexing, materialization, and publication stay ordered.
async function runFreshReindex(opts: {
  opts: ReindexOptions;
  languages: SupportedLanguage[];
  projectRoot: string;
  paths: ReindexOutputPaths;
  tempPaths: TempReindexPaths;
  fingerprint: ReindexFingerprint;
  start: number;
  monotonicStart: number;
  maxHeapMb: number;
  skipAutoInstall: boolean;
  onStatus: (message: string) => void;
  writeTelemetry: ReindexWriteTelemetry;
}): Promise<ReindexResult> {
  const env = {
    ...process.env,
    NODE_OPTIONS: nodeOptionsWithMaxOldSpace(process.env['NODE_OPTIONS'], opts.maxHeapMb),
  };

  let indexerObservation: FreshIndexRun | undefined;
  const freshIndexRun = await profileAsyncSpan(
    'reindex.language-indexers',
    async () => {
      indexerObservation = await runLanguageIndexersForFreshReindex(opts, env);
      return indexerObservation;
    },
    () => ({
      languages: opts.languages.length,
      indexed: indexerObservation?.indexedOutputs.length,
      reused: indexerObservation?.reusedLanguages.length,
      skipped: indexerObservation?.skippedLanguages.length,
    }),
  );
  const {
    indexedOutputs,
    skippedLanguages,
    reusedLanguages,
    languageFingerprints,
    shards,
    typescriptProjectShardContext,
    incrementalTypeScript,
  } = freshIndexRun;
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
    const lastRefresh = profileSpan(
      'reindex.publish',
      () =>
        publishFullyReusedLanguageShardArtifacts(
          opts,
          indexedOutputs,
          skippedLanguages,
          reusedLanguages,
          languageFingerprints,
          typescriptProjectShardContext,
        ),
      { mode: 'metadata-only', languages: indexedOutputs.length, reused: reusedLanguages.length },
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
      writeTelemetry: opts.writeTelemetry,
    };
  }
  const lastRefresh = await profileAsyncSpan(
    'reindex.publish',
    () =>
      publishFreshReindexArtifacts(
        opts,
        env,
        indexedOutputs,
        skippedLanguages,
        reusedLanguages,
        languageFingerprints,
        typescriptProjectShardContext,
        incrementalTypeScript,
      ),
    {
      mode: incrementalTypeScript ? 'incremental-or-fallback' : 'full',
      languages: indexedOutputs.length,
      reused: reusedLanguages.length,
      skipped: skippedLanguages.length,
    },
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
    writeTelemetry: opts.writeTelemetry,
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

// scip-query: ignore-extract — reviewed E1 workflow owner; shard planning, indexer execution, and reuse accounting stay together.
async function runLanguageIndexersForFreshReindex(
  opts: Parameters<typeof runFreshReindex>[0],
  env: NodeJS.ProcessEnv,
): Promise<FreshIndexRun> {
  // A forced reindex is a request to rebuild from the compilers: cached
  // language shards, per-project shards, and the accepted incremental graph
  // would each carry distrusted state forward, which is exactly what --force
  // exists to escape.
  const forcedRebuild = opts.opts.skipIfUnchanged === false;
  const classification = classifyLanguageShardReuse({
    paths: opts.paths,
    projectRoot: opts.projectRoot,
    languages: opts.languages,
    pnpmWorkspaces: opts.opts.pnpmWorkspaces,
    typescriptProjectMode: opts.opts.typescriptProjectMode,
    typescriptProjects: opts.opts.typescriptProjects,
    clojureConfigPath: opts.opts.clojureConfigPath,
    projectFingerprint: opts.fingerprint,
  });
  if (forcedRebuild) {
    for (const [language, info] of classification) {
      if (info.reused) {
        classification.set(language, { ...info, reused: false, reason: 'forced reindex requested' });
      }
    }
  }
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
  let typescriptIncrementalUnavailableReason: string | undefined;
  if (forcedRebuild && typescriptClassification && !typescriptClassification.reused) {
    typescriptIncrementalUnavailableReason = 'forced reindex rebuilds from the compilers';
  }
  const incrementalTypeScript =
    !forcedRebuild && typescriptClassification && !typescriptClassification.reused && incrementalGenerationUsable
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
          onUnavailable: (reason) => {
            typescriptIncrementalUnavailableReason = reason;
          },
        })
      : null;
  const incrementallyIndexed = new Set<SupportedLanguage>(incrementalTypeScript ? ['typescript'] : []);

  if (opts.opts.allowExpensiveRebuild === false) {
    const unavailable = opts.languages.filter(
      (language) => !reused.has(language) && !incrementallyIndexed.has(language),
    );
    if (unavailable.length > 0) {
      const detail =
        unavailable.length === 1 && unavailable[0] === 'typescript' && typescriptIncrementalUnavailableReason
          ? `: ${typescriptIncrementalUnavailableReason}`
          : '';
      throw new Error(
        `Incremental indexing is unavailable for ${unavailable.join(', ')}${detail}. ` +
          'The accepted index was preserved because whole-project rebuilds are disabled; run scip-query reindex --allow-expensive-rebuild only when you explicitly want that fallback.',
      );
    }
  }

  // Plan6 per-project TS shard caching (2.2): only relevant when the whole
  // typescript language shard missed in workspace mode — an untouched
  // typescript language shard already proves every project unchanged
  // (invariant: the language fingerprint covers the same files every
  // project's fingerprint is built from), so the classification below is
  // skipped entirely on that path (today's behavior, untouched).
  const plannedProjectShards =
    incrementalTypeScript || reused.has('typescript')
      ? undefined
      : planTypeScriptProjectShardReuse(opts, classification);
  // Forced runs still plan (so freshly built project shards are fingerprinted
  // and cached for later reuse) but never serve a cached shard.
  const tsProjectShards =
    plannedProjectShards && forcedRebuild
      ? {
          ...plannedProjectShards,
          classification: new Map(
            [...plannedProjectShards.classification].map(([project, info]) => [
              project,
              info.reused ? { ...info, reused: false, reason: 'forced reindex requested' } : info,
            ]),
          ),
          reusedProjects: [],
          missedProjectIds: new Set(plannedProjectShards.allProjects.map((project) => `typescript:${project}`)),
        }
      : plannedProjectShards;

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
    trustProjectTools: opts.opts.trustProjectTools === true,
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
    opts.opts.signal,
  );
  if (profileEnabled()) {
    for (const result of runResults) {
      writeProfileEvent({
        type: 'span',
        name: `reindex.language-indexer.${result.id}`,
        durationMs: Math.round(result.durationMs),
        ok: !result.skipped,
        language: result.language,
        indexerCommand: result.command,
        outputBytes: result.outputBytes,
        measurement: 'indexer-run-result',
      });
    }
  }

  // Cache freshly produced project shards BEFORE collectIndexerOutputs runs
  // — a single-run group gets renameSync'd into its outputScipPath, which
  // would otherwise destroy the only copy of a freshly-indexed shard before
  // it could be cached.
  let syntheticResults: IndexerRunResult[] = [];
  if (tsProjectShards) {
    cacheFreshTypeScriptProjectShards(opts.paths.outputDb, runResults, opts.writeTelemetry);
    const typescriptOutputScipPath = languageOutputScipPaths['typescript'] ?? opts.tempPaths.tempOutputScip;
    syntheticResults = buildCachedTypeScriptProjectRunResults({
      outputDb: opts.paths.outputDb,
      tempOutputScip: opts.tempPaths.tempOutputScip,
      outputScipPath: typescriptOutputScipPath,
      reusedProjects: tsProjectShards.reusedProjects,
      writeTelemetry: opts.writeTelemetry,
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
          producedOutputBytes: fileSizeOrNull(incrementalTypeScript.affectedScipPath) ?? undefined,
        },
      ]
    : [];
  const shards = buildFreshReindexShardDiagnostics(
    classification,
    [...runResults, ...incrementalRunResults],
    tsProjectShards ? { outputDb: opts.paths.outputDb, classification: tsProjectShards.classification } : undefined,
    typescriptIncrementalUnavailableReason,
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
// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function planTypeScriptProjectShardReuse(
  runOpts: Parameters<typeof runFreshReindex>[0],
  classification: ReadonlyMap<SupportedLanguage, LanguageShardClassification>,
): TypeScriptProjectShardPlan | undefined {
  const tsClassification = classification.get('typescript');
  if (!tsClassification || tsClassification.reused) return undefined;
  if (tsClassification.cacheIntegrityFailed) return undefined;
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
  meta: DecodedReindexMetadata | null,
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
    const cached =
      meta.version === CURRENT_REINDEX_METADATA_VERSION && reindexMetadataCapabilities(meta).typescriptProjectShardReuse
        ? meta.typescriptProjectShards?.[project]
        : undefined;
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
function cacheFreshTypeScriptProjectShards(
  outputDb: string,
  runResults: readonly IndexerRunResult[],
  writeTelemetry: ReindexWriteTelemetry,
): void {
  for (const run of runResults) {
    if (run.skipped || !run.id.startsWith('typescript:')) continue;
    const project = run.id.slice('typescript:'.length);
    const shardPath = typescriptProjectShardPath(outputDb, project);
    mkdirSync(dirname(shardPath), { recursive: true });
    recordFileClone(writeTelemetry, cloneFileWithFallback(run.scipPath, shardPath));
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
  writeTelemetry: ReindexWriteTelemetry;
}): IndexerRunResult[] {
  return opts.reusedProjects.map((project, index) => {
    const cachedPath = typescriptProjectShardPath(opts.outputDb, project);
    const tempCopyPath = tempScipPath(opts.tempOutputScip, 'typescript-project-cached', index);
    recordFileClone(opts.writeTelemetry, cloneFileWithFallback(cachedPath, tempCopyPath));
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
  cacheIntegrityFailed?: boolean;
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
  projectFingerprint: ReindexFingerprint;
}): Map<SupportedLanguage, LanguageShardClassification> {
  const meta = readReindexMetaOrNull(opts.paths.metaPath);
  const current = computeLanguageFingerprints(opts.projectFingerprint, opts.languages, opts);
  const acceptedCoverage =
    meta && existsSync(opts.paths.outputDb)
      ? inspectIndexDocumentCoverage(opts.paths.outputDb, opts.projectFingerprint, opts.languages)
      : null;
  const result = new Map<SupportedLanguage, LanguageShardClassification>();
  for (const language of opts.languages) {
    const scipPath = languageShardPath(opts.paths.outputDb, language);
    const fingerprint = current[language]!;
    if (!meta) {
      result.set(language, { reused: false, reason: 'no reindex metadata found', fingerprint, scipPath });
      continue;
    }
    if (meta.version !== CURRENT_REINDEX_METADATA_VERSION) {
      result.set(language, {
        reused: false,
        reason: `metadata version ${String(meta.version ?? 'unknown')} predates per-language shard caching`,
        fingerprint,
        scipPath,
      });
      continue;
    }
    if (!reindexMetadataCapabilities(meta).languageShardReuse || !meta.languageFingerprints) {
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
    const comparableCached =
      language === 'typescript' ? migrateLegacyTypeScriptLanguageFingerprint(opts.projectRoot, cached) : cached;
    if (stableJson(comparableCached) !== stableJson(fingerprint)) {
      result.set(language, {
        reused: false,
        reason: 'language inputs changed since last index',
        fingerprint,
        scipPath,
      });
      continue;
    }
    if (
      acceptedCoverage?.state === 'unavailable' ||
      (acceptedCoverage?.state === 'incomplete' && acceptedCoverage.affectedLanguages.includes(language))
    ) {
      result.set(language, {
        reused: false,
        reason: describeIndexCoverageFailure('accepted SQLite index', acceptedCoverage),
        cacheIntegrityFailed: true,
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
  typescriptIncrementalUnavailableReason?: string,
): ReindexShardDiagnostic[] {
  const diagnostics: ReindexShardDiagnostic[] = [];
  for (const [language, info] of classification) {
    if (!info.reused) continue;
    diagnostics.push({
      id: language,
      language,
      reused: true,
      strategy: 'reused',
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
      strategy: run.command === 'watch-service:typescript-index' ? 'incremental' : 'full',
      missReason: projectInfo?.reason ?? info?.reason ?? run.skipped?.reason,
      fallbackReason: run.language === 'typescript' ? typescriptIncrementalUnavailableReason : undefined,
      fingerprint: projectInfo
        ? hashFingerprint(projectInfo.fingerprint)
        : info
          ? hashFingerprint(info.fingerprint)
          : 'unknown',
      outputBytes: run.outputBytes ?? null,
      producedOutputBytes: run.producedOutputBytes,
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
        strategy: 'reused',
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
async function publishFreshReindexArtifacts(
  opts: Parameters<typeof runFreshReindex>[0],
  env: NodeJS.ProcessEnv,
  indexedOutputs: readonly IndexedOutput[],
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[],
  reusedLanguages: readonly SupportedLanguage[],
  languageFingerprints: Partial<Record<SupportedLanguage, ReindexFingerprint>>,
  typescriptProjectShardContext: TypeScriptProjectShardContext | undefined,
  incrementalTypeScript: MaterializedTypeScriptIncrementalIndex | undefined,
): Promise<LastRefreshMetadata> {
  throwIfSignalAborted(opts.opts.signal, 'Reindex cancelled by its owner.');
  const completeScipAvailable = !incrementalTypeScript || incrementalTypeScript.completeScipUpdated;
  let completeScipSanitized = false;
  if (completeScipAvailable) {
    completeScipSanitized = profileSpan('reindex.publish.scip-output', () => {
      const publishOutputs = materializeDeferredTypeScriptLanguageOutput({
        run: opts,
        indexedOutputs,
        incrementalTypeScript,
        typescriptReused: reusedLanguages.includes('typescript'),
      });
      cacheLanguageShards(opts.paths.outputDb, publishOutputs, opts.writeTelemetry);
      return materializeScipOutput(publishOutputs, opts.tempPaths.tempOutputScip, opts.onStatus);
    });
  }
  const sqliteMaterialization = await profileAsyncSpan('reindex.publish.sqlite-output', () =>
    materializeSqliteOutput({
      run: opts,
      env,
      indexedOutputs,
      skippedLanguages,
      reusedLanguages,
      incrementalTypeScript,
      completeScipAvailable,
      completeScipSanitized,
      materializeFullFallback: async () => {
        throwIfSignalAborted(opts.opts.signal, 'Reindex cancelled by its owner.');
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
        cacheLanguageShards(opts.paths.outputDb, completeOutputs, opts.writeTelemetry);
        completeScipSanitized = materializeScipOutput(completeOutputs, opts.tempPaths.tempOutputScip, opts.onStatus);
        return completeScipSanitized;
      },
    }),
  );

  throwIfSignalAborted(opts.opts.signal, 'Reindex cancelled by its owner.');
  profileSpan('reindex.publish.auxiliary-documents', () => {
    runPostIndexAugmentation(auxiliaryDocumentsAugmentationStage(), {
      projectRoot: opts.projectRoot,
      dbPath: opts.tempPaths.tempOutputDb,
      onStatus: opts.onStatus,
    });
  });
  profileSpan('reindex.publish.runtime-boundaries', () => {
    const replacingWholeTypeScriptProject = incrementalTypeScript?.plan.mode === 'full-project';
    const relationshipsUnchanged = incrementalTypeScript?.dependencyGraphUnchanged === true;
    if (replacingWholeTypeScriptProject) {
      opts.onStatus(
        'Rebuilding compiler-derived runtime-boundary relationships while retaining unchanged per-file extraction facts.',
      );
    } else if (relationshipsUnchanged) {
      opts.onStatus('Reusing runtime-boundary relationships because TypeScript semantics are unchanged.');
    }
    runRuntimeBoundaryAugmentation(
      opts.projectRoot,
      opts.tempPaths.tempOutputDb,
      opts.tempPaths.tempOutputScip,
      opts.onStatus,
      relationshipsUnchanged,
      relationshipsUnchanged
        ? undefined
        : replacingWholeTypeScriptProject
          ? incrementalTypeScript?.changedFiles
          : incrementalTypeScript?.affectedFiles,
      join(dirname(opts.paths.outputDb), EVIDENCE_DB_FILENAME),
      replacingWholeTypeScriptProject,
    );
  });
  const indexMaintenance = profileSpan('reindex.publish.sqlite-layout', () =>
    optimizeSqliteQueryLayout(opts.tempPaths.tempOutputDb, {
      analyze: needsFreshSqliteStatistics(incrementalTypeScript, sqliteMaterialization.mode),
    }),
  );
  if (indexMaintenance.added.length > 0) {
    opts.onStatus(`Added SQLite query indexes: ${indexMaintenance.added.join(', ')}`);
  }
  if (indexMaintenance.removed.length > 0) {
    opts.onStatus(`Removed redundant SQLite indexes: ${indexMaintenance.removed.join(', ')}`);
  }
  profileSpan('reindex.publish.coverage', () =>
    assertCandidateIndexCoverage(
      opts,
      opts.tempPaths.tempOutputDb,
      indexedOutputs.map((output) => output.language),
    ),
  );

  let carriedDependencyGraph: FileDependencyGraph | undefined;
  let previousDependencyGraphEvidenceFingerprint: string | null = null;
  if (sqliteMaterialization.mode === 'incremental' && incrementalTypeScript) {
    profileSpan('reindex.publish.reference-fragments', () => {
      if (incrementalTypeScript.dependencyGraphUnchanged) {
        const acceptedDb = new ScipDatabase({
          projectRoot: opts.projectRoot,
          dbPath: opts.paths.outputDb,
          indexPath: opts.paths.outputScip,
        });
        try {
          previousDependencyGraphEvidenceFingerprint = projectEvidenceFingerprint(acceptedDb);
          opts.onStatus(
            'Preserved exact TypeScript reference fragments and dependency relationships because only trivia changed.',
          );
        } finally {
          acceptedDb.close();
        }
        return;
      }
      let candidateDb: ScipDatabase | null = null;
      let evidenceDb: ScipDatabase | null = null;
      try {
        candidateDb = profileSpan(
          'reindex.publish.reference-fragments.open-candidate',
          () =>
            new ScipDatabase({
              projectRoot: opts.projectRoot,
              dbPath: opts.tempPaths.tempOutputDb,
              indexPath: opts.tempPaths.tempOutputScip,
            }),
        );
        evidenceDb = profileSpan(
          'reindex.publish.reference-fragments.open-evidence',
          () =>
            new ScipDatabase({
              projectRoot: opts.projectRoot,
              dbPath: opts.paths.outputDb,
              indexPath: opts.paths.outputScip,
            }),
        );
        carriedDependencyGraph = incrementalTypeScript.dependencyGraphSnapshot
          ? (profileSpan('reindex.publish.reference-fragments.dependency-graph', () =>
              materializeCarriedFileDependencyGraph(
                candidateDb!,
                incrementalTypeScript.dependencyGraphSnapshot!,
                incrementalTypeScript.affectedFiles,
                incrementalTypeScript.deletedFiles,
              ),
            ) ?? undefined)
          : undefined;
        const deletedReferenceFiles = new Set(incrementalTypeScript.deletedFiles);
        const currentReferenceFragments =
          deletedReferenceFiles.size === 0
            ? incrementalTypeScript.referenceFragmentsByFile
            : new Map(
                [...incrementalTypeScript.referenceFragmentsByFile].filter(
                  ([relativePath]) => !deletedReferenceFiles.has(relativePath),
                ),
              );
        const seeded = profileSpan('reindex.publish.reference-fragments.seed', () =>
          seedTypeScriptReferenceFragments(
            candidateDb!,
            opts.fingerprint,
            currentReferenceFragments,
            evidenceDb!,
            carriedDependencyGraph,
            new Set(incrementalTypeScript.affectedFiles),
          ),
        );
        opts.onStatus(
          `Cached exact TypeScript reference fragments for ${seeded.affectedFiles} affected document(s) and carried ${seeded.carriedFiles} unaffected document(s) forward.`,
        );
        if (seeded.skippedAffectedFiles > 0) {
          opts.onStatus(
            `Skipped exact TypeScript reference fragment prefill for ${seeded.skippedAffectedFiles} affected document(s) whose semantic identity was unavailable.`,
          );
        }
      } catch (error) {
        opts.onStatus(
          `Exact TypeScript reference fragment prefill unavailable: ${error instanceof Error ? error.message : String(error)}.`,
        );
      } finally {
        candidateDb?.close();
        evidenceDb?.close();
      }
    });
  }

  const previousSnapshot = previousProjectInputSnapshot(opts.paths.metaPath);
  const shadowRecord = profileSpan('reindex.publish.affected-shadow', () =>
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
        }),
  );

  const lastRefresh = buildLastRefresh({
    trigger: opts.opts.trigger,
    result: 'rebuilt',
    start: opts.start,
    monotonicStart: opts.monotonicStart,
    languages: indexedOutputs.map((o) => o.language),
    skipped: [...skippedLanguages],
  });
  const deferredScipCompanion =
    sqliteMaterialization.mode === 'incremental' && sqliteMaterialization.scipCompanion === 'deferred';
  const { metadata, pruneProjects } = buildPublishedReindexMetadata({
    run: opts,
    indexedOutputs,
    skippedLanguages,
    reusedLanguages,
    languageFingerprints,
    typescriptProjectShardContext,
    lastRefresh,
  });
  metadata.scipCompanion = deferredScipCompanion ? 'deferred' : 'current';
  profileSpan('reindex.publish.metadata', () => {
    assertProjectInputsUnchanged(opts);
    pruneTypeScriptProjectShardCache(opts.paths.outputDb, pruneProjects);
    writeReindexMeta(opts.tempPaths.tempMetaPath, metadata);
  });
  const localGenerationPublication = profileSpan('reindex.publish.generation-handoff', () =>
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
    }),
  );
  if (localGenerationPublication.achievedDurability === 'file-flushed') {
    opts.onStatus(
      `Published local generation ${localGenerationPublication.currentGeneration.slice(0, 12)} ` +
        '(file-flushed; directory sync unsupported)',
    );
  }
  if (sqliteMaterialization.mode === 'incremental' && incrementalTypeScript) {
    profileSpan('reindex.publish.dependency-graph', () => {
      let acceptedDb: ScipDatabase | null = null;
      try {
        acceptedDb = new ScipDatabase({
          projectRoot: opts.projectRoot,
          dbPath: opts.paths.outputDb,
          indexPath: opts.paths.outputScip,
        });
        const replacementFiles =
          incrementalTypeScript.plan.mode === 'full-project' && incrementalTypeScript.plan.reasons.length === 0
            ? incrementalTypeScript.changedFiles
            : incrementalTypeScript.affectedFiles;
        let carried = false;
        if (incrementalTypeScript.dependencyGraphUnchanged) {
          const nextFingerprint = projectEvidenceFingerprint(acceptedDb);
          const carriedProducts =
            previousDependencyGraphEvidenceFingerprint && nextFingerprint
              ? rekeyCachedProjectEvidenceKind(
                  acceptedDb,
                  'file-dependency-graph',
                  previousDependencyGraphEvidenceFingerprint,
                  nextFingerprint,
                )
              : 0;
          carried = carriedProducts > 0;
          opts.onStatus(
            carried
              ? `Carried ${carriedProducts} unchanged dependency graph product(s) forward without rebuilding them.`
              : 'No persisted dependency graph product required rekeying; the next graph consumer can materialize it.',
          );
        } else if (incrementalTypeScript.dependencyGraphSnapshot) {
          carried = carryFileDependencyGraph(
            acceptedDb,
            incrementalTypeScript.dependencyGraphSnapshot,
            replacementFiles,
            carriedDependencyGraph,
          );
        } else {
          captureTypeScriptPlanningDependencyGraph(acceptedDb);
        }
        if (!incrementalTypeScript.dependencyGraphUnchanged) {
          opts.onStatus(
            carried
              ? `Carried the dependency graph forward by replacing ${replacementFiles.length} changed dependency owner(s).`
              : 'Materialized a fresh dependency graph for the accepted generation because no compatible prior graph was available.',
          );
        }
      } catch (error) {
        opts.onStatus(
          `Dependency graph carry-forward unavailable: ${error instanceof Error ? error.message : String(error)}. ` +
            'The next graph consumer will rebuild it.',
        );
      } finally {
        acceptedDb?.close();
      }
    });
  }
  profileSpan('reindex.publish.cleanup', () => {
    pruneTypeScriptOverlays(
      dirname(opts.paths.outputDb),
      sqliteMaterialization.mode === 'incremental' && sqliteMaterialization.scipCompanion === 'deferred'
        ? [incrementalTypeScript!.nextFragmentGeneration]
        : [],
    );
    pruneTypeScriptFragmentGenerations(
      dirname(opts.paths.outputDb),
      incrementalTypeScript?.completeScipUpdated ? [incrementalTypeScript.nextFragmentGeneration] : [],
    );
  });
  profileSpan('reindex.publish.shadow-telemetry', () =>
    persistAffectedSetShadowRecord(opts.paths.outputDb, shadowRecord, opts.onStatus),
  );
  return lastRefresh;
}

function needsFreshSqliteStatistics(
  incrementalTypeScript: MaterializedTypeScriptIncrementalIndex | undefined,
  publicationMode: SqliteMaterializationResult['mode'],
): boolean {
  if (publicationMode !== 'incremental' || !incrementalTypeScript) return true;
  if (incrementalTypeScript.plan.mode === 'full-project') return true;
  return incrementalTypeScript.affectedFiles.length * 20 >= incrementalTypeScript.projectFileCount;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
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
    recordFileClone(opts.writeTelemetry, cloneFileWithFallback(opts.paths.outputDb, opts.tempPaths.tempOutputDb));
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
  runRuntimeBoundaryAugmentation(opts.projectRoot, opts.paths.outputDb, opts.paths.outputScip, opts.onStatus, true);
  const indexMaintenance = optimizeSqliteQueryLayout(opts.paths.outputDb);
  if (indexMaintenance.added.length > 0) {
    opts.onStatus(`Added SQLite query indexes: ${indexMaintenance.added.join(', ')}`);
  }
  if (indexMaintenance.removed.length > 0) {
    opts.onStatus(`Removed redundant SQLite indexes: ${indexMaintenance.removed.join(', ')}`);
  }

  assertCandidateIndexCoverage(
    opts,
    opts.paths.outputDb,
    indexedOutputs.map((output) => output.language),
  );

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
    monotonicStart: opts.monotonicStart,
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
  assertProjectInputsUnchanged(opts);
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
}): { metadata: PublishedReindexMetadata; pruneProjects: readonly string[] | null } {
  const typescriptProjectShards = resolveTypeScriptProjectShardsField({
    mode: opts.run.opts.typescriptProjectMode,
    skippedLanguages: opts.skippedLanguages,
    reusedLanguages: opts.reusedLanguages,
    context: opts.typescriptProjectShardContext,
    metaPath: opts.run.paths.metaPath,
  });
  return {
    metadata: {
      version: CURRENT_REINDEX_METADATA_VERSION,
      status: opts.skippedLanguages.length === 0 ? 'complete' : 'partial',
      updatedAt: new Date().toISOString(),
      fingerprint: opts.run.fingerprint,
      sqliteLayoutVersion: CURRENT_SQLITE_QUERY_LAYOUT_VERSION,
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

function assertProjectInputsUnchanged(opts: Parameters<typeof runFreshReindex>[0]): void {
  throwIfSignalAborted(opts.opts.signal, 'Reindex cancelled by its owner.');
  const currentFingerprint = revalidateKnownProjectInputFingerprint(opts.projectRoot, opts.fingerprint);
  if (stableJson(currentFingerprint) === stableJson(opts.fingerprint)) return;

  const acceptedFiles = new Map(opts.fingerprint.files.map((file) => [file.path, file]));
  const currentFiles = new Map(currentFingerprint.files.map((file) => [file.path, file]));
  const changedPaths = [...new Set([...acceptedFiles.keys(), ...currentFiles.keys()])]
    .filter((path) => stableJson(acceptedFiles.get(path)) !== stableJson(currentFiles.get(path)))
    .slice(0, 5);

  throw new Error(
    `Project inputs changed during reindex (${changedPaths.join(', ') || 'unknown path'}); ` +
      'refusing to publish artifacts built from a different filesystem snapshot.',
  );
}

function assertCandidateIndexCoverage(
  opts: Parameters<typeof runFreshReindex>[0],
  dbPath: string,
  indexedLanguages: readonly SupportedLanguage[],
): void {
  const coverage = inspectIndexDocumentCoverage(dbPath, opts.fingerprint, indexedLanguages);
  if (coverage.state === 'complete') return;
  throw new Error(`${describeIndexCoverageFailure('Candidate SQLite index', coverage)} Refusing to publish it.`);
}

function describeIndexCoverageFailure(
  label: string,
  coverage: Exclude<IndexDocumentCoverage, { state: 'complete' }>,
): string {
  if (coverage.state === 'unavailable') {
    return `${label} document coverage could not be verified (${coverage.reason}); rebuilding cached language shards.`;
  }
  const sample = coverage.missingPaths.length > 0 ? ` First missing path: ${coverage.missingPaths[0]}.` : '';
  return (
    `${label} is missing ${coverage.missingDocumentCount} fingerprinted source document` +
    `${coverage.missingDocumentCount === 1 ? '' : 's'}; rebuilding affected language shards.${sample}`
  );
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
    const metadata = readReindexMetaOrNull(opts.metaPath);
    const existing =
      metadata?.version === CURRENT_REINDEX_METADATA_VERSION ? metadata.typescriptProjectShards : undefined;
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

function materializeDeferredTypeScriptLanguageOutput(opts: {
  run: Parameters<typeof runFreshReindex>[0];
  indexedOutputs: readonly IndexedOutput[];
  incrementalTypeScript: MaterializedTypeScriptIncrementalIndex | undefined;
  typescriptReused: boolean;
}): IndexedOutput[] {
  if (opts.incrementalTypeScript?.completeScipUpdated) return [...opts.indexedOutputs];
  const typescriptOutput = opts.indexedOutputs.find((output) => output.language === 'typescript');
  if (!typescriptOutput) return [...opts.indexedOutputs];
  // A typescript output built fresh this run already covers every current
  // input; only a reused cached shard can still carry the previous
  // generation's deferred companion and need its overlay applied. Applying a
  // stale overlay onto a fresh complete index is wasted whole-index work
  // (and, on large repositories, a coordinator heap spike).
  if (!opts.typescriptReused) return [...opts.indexedOutputs];
  const generation = inspectSqliteGeneration(opts.run.paths.outputDb, opts.run.paths.metaPath);
  const overlayGeneration =
    generation.state === 'current' ? generation.generation.publication?.typescriptOverlayGeneration : undefined;
  const companionDeferred =
    generation.state === 'current'
      ? generation.generation.publication?.scipCompanion === 'deferred'
      : readReindexMetaOrNull(opts.run.paths.metaPath)?.scipCompanion === 'deferred';
  if (!companionDeferred || !overlayGeneration) return [...opts.indexedOutputs];
  const candidateShardPath = tempScipPath(opts.run.tempPaths.tempOutputScip, 'typescript-deferred', 0);
  opts.run.onStatus('Materializing the deferred whole TypeScript SCIP companion for complete publication...');
  materializeDeferredTypeScriptIndex({
    cacheDir: dirname(opts.run.paths.outputDb),
    generationIdentity: overlayGeneration,
    baseShardPath: typescriptOutput.scipPath,
    candidateShardPath,
  });
  return opts.indexedOutputs.map((output) =>
    output.language === 'typescript' ? { language: output.language, scipPath: candidateShardPath } : output,
  );
}

function cacheLanguageShards(
  outputDb: string,
  indexedOutputs: readonly IndexedOutput[],
  writeTelemetry: ReindexWriteTelemetry,
): void {
  for (const output of indexedOutputs) {
    const shardPath = languageShardPath(outputDb, output.language);
    mkdirSync(dirname(shardPath), { recursive: true });
    if (output.scipPath !== shardPath) {
      recordFileClone(writeTelemetry, cloneFileWithFallback(output.scipPath, shardPath));
    }
  }
}

async function ensureScipCliAvailable(skipAutoInstall: boolean, onStatus: (message: string) => void): Promise<void> {
  if (resolveScipBinary()) {
    return;
  }

  if (platform() === 'win32') {
    throw new Error(
      'The scip CLI was not found. On Windows it ships via the npm sidecar package ' +
        'scip-query-scip-windows (installed automatically with scip-query). ' +
        "Reinstall scip-query with optional dependencies enabled, or follow 'scip-query setup' guidance " +
        'for the exact sidecar package version, ' +
        'or set SCIP_QUERY_SCIP_BIN to a local scip.exe path.',
    );
  }

  if (skipAutoInstall) {
    throw new Error(
      'The scip CLI is required but not found on PATH.\n' +
        'To install the reviewed version, run: scip-query reindex --install-missing\n' +
        'Or install manually from: https://github.com/sourcegraph/scip/releases',
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
  trustProjectTools: boolean;
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
  trustProjectTools: boolean;
  pnpmWorkspaces?: boolean;
  typescriptProjectMode?: TypeScriptProjectMode;
  typescriptProjects?: readonly string[];
  preDiscoveredTypeScriptProjects?: readonly string[];
  clojureConfigPath?: string;
  onStatus: (message: string) => void;
}): ({ prepared: PreparedIndexerRun } | { skipped: { language: SupportedLanguage; reason: string } })[] {
  if (opts.language !== 'typescript') {
    return [
      prepareIndexerRun({
        ...opts,
        id: opts.language,
        label: opts.language,
        outputScipPath: opts.scipPath,
      }),
    ];
  }

  const workspaceMode = opts.typescriptProjectMode === 'workspace';
  const projects = workspaceMode
    ? (opts.preDiscoveredTypeScriptProjects ??
      discoverTypeScriptProjectRoots(opts.projectRoot, opts.typescriptProjects))
    : ['.'];
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

  if (workspaceMode) opts.onStatus(`Indexing TypeScript workspace as ${projects.length} project shard(s).`);
  return projects.flatMap((projectPath, index) => {
    const id = workspaceMode ? `typescript:${projectPath}` : 'typescript';
    const label = workspaceMode ? `typescript (${projectPath})` : 'typescript';
    const runScipPath = workspaceMode ? tempScipPath(opts.tempOutputScip, 'typescript-project', index) : opts.scipPath;
    const common = {
      ...opts,
      id,
      label,
      scipPath: runScipPath,
      outputScipPath: opts.scipPath,
      pnpmWorkspaces: false,
    };

    if (!workspaceMode && projectPath === '.' && !opts.pnpmWorkspaces) {
      const compilerShardRuns = prepareBoundedTypeScriptCompilerShardRuns(opts, common);
      if (compilerShardRuns) return compilerShardRuns;
    }

    return [
      prepareIndexerRun({
        ...common,
        ...(workspaceMode ? { projectPath } : {}),
      }),
    ];
  });
}

/**
 * A single-project TypeScript repository above the shard threshold is indexed
 * as several bounded compiler programs instead of one monolithic program
 * whose checker state can exceed the child heap. Shards are disjoint by
 * construction (each shard config overrides the inherited include contract),
 * so their streamed outputs concatenate into one complete index.
 */
function prepareBoundedTypeScriptCompilerShardRuns(
  opts: Parameters<typeof prepareIndexerRunsForLanguage>[0],
  common: Omit<Parameters<typeof prepareIndexerRun>[0], 'projectPath'>,
): ({ prepared: PreparedIndexerRun } | { skipped: { language: SupportedLanguage; reason: string } })[] | null {
  const targetFiles = typescriptCompilerShardTargetFiles();
  const inputPaths = typeScriptProjectInputPaths(opts.projectRoot, 'single');
  if (!inputPaths || !shouldShardTypeScriptCompilerInputs(inputPaths.size, targetFiles)) return null;

  removeStaleTypeScriptCompilerShardConfigs(opts.projectRoot);
  const parallelism = typescriptCompilerShardParallelism();
  const shardCount = typescriptCompilerShardCount(inputPaths.size, targetFiles, parallelism);
  const compilerShards = createTypeScriptCompilerShards({
    projectRoot: opts.projectRoot,
    rootConfigPath: 'tsconfig.json',
    inputPaths: [...inputPaths],
    targetFiles,
    shardCount,
    // Balance shards by source bytes: shard wall time is the slowest shard
    // of a wave, and file counts alone left waves ~40% ragged.
    weightOf: (relativePath) => {
      try {
        return statSync(join(opts.projectRoot, relativePath)).size;
      } catch {
        return 1;
      }
    },
  });
  const boundedConcurrency = Math.min(parallelism, compilerShards.length);
  opts.onStatus(
    `Indexing ${inputPaths.size} TypeScript inputs as ${compilerShards.length} byte-balanced compiler shard(s), ` +
      `${boundedConcurrency} at a time.`,
  );
  return compilerShards.map((shard, shardIndex) =>
    prepareIndexerRun({
      ...common,
      id: `typescript-compiler-shard:${shardIndex}`,
      label: `typescript compiler shard ${shardIndex + 1}/${compilerShards.length}`,
      scipPath: tempScipPath(opts.tempOutputScip, 'typescript-compiler-shard', shardIndex),
      projectPath: shard.configPath,
      temporaryProjectConfigs: [{ path: shard.configPath, content: shard.content }],
      boundedConcurrency,
      outputComposition: 'protobuf-concatenate',
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
  trustProjectTools: boolean;
  pnpmWorkspaces?: boolean;
  projectPath?: string;
  temporaryProjectConfigs?: readonly { path: string; content: string }[];
  boundedConcurrency?: number;
  outputComposition?: 'protobuf-concatenate';
  clojureConfigPath?: string;
  onStatus: (message: string) => void;
}): { prepared: PreparedIndexerRun } | { skipped: { language: SupportedLanguage; reason: string } } {
  const config = getIndexerConfig(opts.language);
  const binaryLabel = describeIndexerBinary(config);
  const discoveredProjectLocalBinary = resolveProjectLocalIndexerBinary(config, opts.projectRoot);
  const trustedProjectTool =
    opts.trustProjectTools && discoveredProjectLocalBinary
      ? trustProjectLocalIndexerBinary(config, opts.projectRoot)
      : null;
  const installedBinary = resolveIndexerBinary(config);

  if (!trustedProjectTool && !installedBinary && discoveredProjectLocalBinary) {
    const reason =
      `${binaryLabel} is available only as repository-local code at ${discoveredProjectLocalBinary}. ` +
      'Review that exact tool and rerun with --trust-project-tools.';
    opts.onStatus(`Skipping ${opts.language}: ${reason}`);
    return { skipped: { language: opts.language, reason } };
  }

  if (!trustedProjectTool && !installedBinary && !isIndexerInstalled(config)) {
    if (opts.skipAutoInstall) {
      const reason =
        `${binaryLabel} not found on PATH. To install the reviewed version, run: ` +
        `scip-query reindex --install-missing${config.installUrl ? ` (manual source: ${config.installUrl})` : ''}`;
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

  const resolvedBinary = trustedProjectTool?.canonicalPath ?? resolveIndexerBinary(config);
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
  const rootConfigContent = temporaryRootConfigContent({
    language: opts.language,
    projectPath: opts.projectPath,
    pnpmWorkspaces: opts.pnpmWorkspaces,
  });
  if (trustedProjectTool && !trustedProjectTool.executable) {
    const reason = `${trustedProjectTool.relativePath} is not executable; refusing project-local indexer.`;
    opts.onStatus(`Skipping ${opts.language}: ${reason}`);
    return { skipped: { language: opts.language, reason } };
  }
  if (trustedProjectTool) {
    opts.onStatus(
      `Trusted project-local ${opts.language} indexer ${trustedProjectTool.relativePath} ` +
        `(${trustedProjectTool.sha256.slice(0, 12)}…, ${trustedProjectTool.canonicalPath}).`,
    );
  }

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
      ...(rootConfigContent === undefined ? {} : { temporaryRootConfigContent: rootConfigContent }),
      ...(opts.temporaryProjectConfigs === undefined ? {} : { temporaryProjectConfigs: opts.temporaryProjectConfigs }),
      ...(opts.boundedConcurrency === undefined ? {} : { boundedConcurrency: opts.boundedConcurrency }),
      ...(opts.outputComposition ? { outputComposition: opts.outputComposition } : {}),
      ...(trustedProjectTool ? { trustedProjectTool } : {}),
    },
  };
}

function collectIndexerOutputs(
  runResults: readonly IndexerRunResult[],
  skippedLanguages: { language: SupportedLanguage; reason: string }[],
): { indexedOutputs: { language: SupportedLanguage; scipPath: string }[] } {
  // A concatenated composition is complete only when every shard succeeded;
  // one failed shard blocks the whole language output rather than publishing
  // a silently incomplete index.
  const blockedCompositions = new Set(
    runResults
      .filter((result) => result.skipped && result.outputComposition)
      .map((result) => `${result.language}\0${result.outputScipPath}`),
  );
  const groups = new Map<
    string,
    { language: SupportedLanguage; outputScipPath: string; scipPaths: string[]; concatenate: boolean }
  >();
  for (const result of runResults) {
    if (result.skipped) {
      appendSkippedLanguage(skippedLanguages, result.skipped);
    } else {
      const key = `${result.language}\0${result.outputScipPath}`;
      if (blockedCompositions.has(key)) continue;
      const group = groups.get(key) ?? {
        language: result.language,
        outputScipPath: result.outputScipPath,
        scipPaths: [],
        concatenate: true,
      };
      group.scipPaths.push(result.scipPath);
      if (result.outputComposition !== 'protobuf-concatenate') group.concatenate = false;
      groups.set(key, group);
    }
  }

  const indexedOutputs: { language: SupportedLanguage; scipPath: string }[] = [];
  for (const group of groups.values()) {
    if (group.scipPaths.length > 1) {
      if (group.concatenate) concatenateScipFiles(group.scipPaths, group.outputScipPath);
      else mergeScipFiles(group.scipPaths, group.outputScipPath);
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
async function materializeSqliteOutput(opts: {
  run: Parameters<typeof runFreshReindex>[0];
  env: NodeJS.ProcessEnv;
  indexedOutputs: readonly IndexedOutput[];
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[];
  reusedLanguages: readonly SupportedLanguage[];
  incrementalTypeScript: MaterializedTypeScriptIncrementalIndex | undefined;
  completeScipAvailable: boolean;
  completeScipSanitized: boolean;
  materializeFullFallback: () => Promise<boolean>;
}): Promise<SqliteMaterializationResult> {
  let fallbackReason: string | undefined;
  if (canPublishIncrementalSqlite(opts)) {
    try {
      const batches =
        opts.incrementalTypeScript.affectedBatches.length > 0
          ? opts.incrementalTypeScript.affectedBatches
          : [
              {
                scipPath: opts.incrementalTypeScript.affectedScipPath,
                affectedFiles: opts.incrementalTypeScript.affectedFiles,
                deletedFiles: opts.incrementalTypeScript.deletedFiles,
              },
            ];
      const changedDocumentPaths = new Set<string>();
      let converterDurationMs = 0;
      let patchDurationMs = 0;
      for (const [batchIndex, batch] of batches.entries()) {
        const miniDbPath = join(opts.run.tempPaths.runDir, `typescript-affected-${batchIndex}.db`);
        sanitizeScipForSqlite(batch.scipPath, opts.run.onStatus);
        opts.run.onStatus(
          `Converting bounded TypeScript batch ${batchIndex + 1}/${batches.length} (${batch.affectedFiles.length - batch.deletedFiles.length} emitted, ${batch.deletedFiles.length} removed) to SQLite...`,
        );
        const convertStartedAt = performance.now();
        await convertScipToSqlite(batch.scipPath, miniDbPath, opts.env, opts.run.onStatus, true, opts.run.opts.signal);
        converterDurationMs += performance.now() - convertStartedAt;
        recordIncrementalWrite(opts.run.writeTelemetry, fileSizeOrNull(miniDbPath) ?? 0);
        const patched = patchIncrementalSqliteGeneration({
          previousDbPath: opts.run.paths.outputDb,
          miniDbPath,
          candidateDbPath: opts.run.tempPaths.tempOutputDb,
          affectedFiles: batch.affectedFiles,
          deletedFiles: batch.deletedFiles,
          reuseCandidate: batchIndex > 0,
          deferIntegrity: batchIndex < batches.length - 1,
          trustedPriorGeneration: true,
          writeTelemetry: opts.run.writeTelemetry,
        });
        patchDurationMs += patched.durationMs;
        for (const path of patched.changedDocumentPaths) changedDocumentPaths.add(path);
        rmSync(miniDbPath, { force: true });
      }
      opts.run.onStatus(
        `Patched ${opts.incrementalTypeScript.affectedFiles.length} SQLite document path(s) across ${batches.length} bounded batch(es) in ${(patchDurationMs / 1000).toFixed(3)}s.`,
      );
      return {
        mode: 'incremental',
        changedDocumentPaths: [...changedDocumentPaths].sort(),
        patchDurationMs,
        converterDurationMs,
        scipCompanion: opts.incrementalTypeScript.completeScipUpdated ? 'current' : 'deferred',
      };
    } catch (error) {
      throwIfSignalAborted(opts.run.opts.signal, 'Reindex cancelled by its owner.');
      fallbackReason = error instanceof Error ? error.message : String(error);
      rmSync(opts.run.tempPaths.tempOutputDb, { force: true });
      if (opts.run.opts.allowExpensiveRebuild === false) {
        throw new Error(
          `Bounded incremental SQLite publication failed and the whole-project fallback is disabled: ${fallbackReason}`,
          { cause: error },
        );
      }
      opts.run.onStatus(
        `Incremental SQLite publication unavailable: ${fallbackReason}. Falling back to complete conversion.`,
      );
    }
  }
  let completeScipSanitized = opts.completeScipSanitized;
  if (!opts.completeScipAvailable) completeScipSanitized = await opts.materializeFullFallback();
  const convertStartedAt = performance.now();
  await convertScipToSqlite(
    opts.run.tempPaths.tempOutputScip,
    opts.run.tempPaths.tempOutputDb,
    opts.env,
    opts.run.onStatus,
    completeScipSanitized,
    opts.run.opts.signal,
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
  const startedAt = monotonicNowMs();
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
    durationMs: monotonicNowMs() - startedAt,
    manifest: incremental.manifest,
    plan: incremental.plan,
    comparison,
    evaluation: evaluateAffectedSetShadow(incremental.plan, comparison, incremental.projectFileCount),
  };
}

async function convertScipToSqlite(
  tempOutputScip: string,
  tempOutputDb: string,
  env: NodeJS.ProcessEnv,
  onStatus: (message: string) => void,
  alreadySanitized = false,
  signal?: AbortSignal,
): Promise<void> {
  throwIfSignalAborted(signal, 'Reindex cancelled by its owner.');
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
    const completed = await runBoundedProcess({
      command: scipBinary,
      args: ['expt-convert', '--output', tempOutputDb, tempOutputScip],
      label: 'SCIP SQLite conversion',
      env,
      maxStdoutBytes: 50 * 1024 * 1024,
      maxStderrBytes: 50 * 1024 * 1024,
      timeoutMs: 300_000,
      signal,
    });
    if (completed.status !== 0) {
      throw new Error(
        `scip expt-convert exited with ${completed.status}${
          completed.stderr.trim() ? `: ${completed.stderr.trim()}` : ''
        }`,
      );
    }
  } catch (err) {
    throwIfSignalAborted(signal, 'Reindex cancelled by its owner.');
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

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
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
      let terminated: boolean;
      try {
        terminated = await terminateReindexLockOwner(existing);
      } catch (error) {
        throw new Error(
          `Could not verify the watcher's in-progress reindex owner (pid ${existing.pid}); refusing to steal an active lock: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (!terminated) {
        // The owner survived SIGTERM and SIGKILL (or PID liveness cannot be
        // confirmed dead, e.g. a stuck/uninterruptible process, a permission
        // failure on kill(2), or PID reuse). Stealing the lock here would let
        // two reindexes publish concurrently — fail closed instead.
        throw new Error(
          `Could not confirm the watcher's in-progress reindex (pid ${existing.pid}) terminated for ${dirname(lockPath)}; refusing to steal an active lock.`,
        );
      }
      const observed = readProcessFileLock(lockPath, { parseLegacy: parseLegacyReindexOwner });
      if (!reclaimProcessFileLock(lockPath, observed, { parseLegacy: parseLegacyReindexOwner })) {
        throw new Error(`Reindex lock ownership changed before preemption completed for ${dirname(lockPath)}.`);
      }
      continue;
    }

    throw new ReindexLockUnavailableError(`Another scip-query reindex is already running for ${dirname(lockPath)}.`);
  }

  throw new ReindexLockUnavailableError(`Could not acquire scip-query reindex lock for ${dirname(lockPath)}.`);
}

function tryAcquireReindexLock(
  lockPath: string,
  opts: { projectRoot: string; trigger?: RefreshTrigger; onStatus: (message: string) => void },
): (() => void) | null {
  const processIdentity = readProcessIdentity(process.pid);
  const acquired = tryAcquireProcessFileLock(lockPath, {
    kind: 'reindex',
    processIdentity,
    detail: {
      projectRoot: opts.projectRoot,
      ...(process.env['SCIP_REINDEX_PROCESS_GROUP_LEADER'] === '1' ? { processGroupLeader: true } : {}),
      ...(opts.trigger ? { trigger: opts.trigger } : {}),
    },
    parseLegacy: parseLegacyReindexOwner,
  });
  if (acquired.kind === 'acquired' && acquired.reclaimed) {
    const previous = reindexMetadataFromObservation(acquired.reclaimed, lockPath);
    if (previous && shouldPreemptReindexLock(opts.trigger, previous)) {
      opts.onStatus(
        `Manual reindex preempting watcher refresh started at ${previous.startedAt}; its prior owner was already stale.`,
      );
    } else {
      opts.onStatus(`Recovered an abandoned or incomplete reindex lock for ${dirname(lockPath)}.`);
    }
  }
  return acquired.kind === 'acquired' ? () => void acquired.lock.release() : null;
}

function readReindexLock(lockPath: string): ReindexLockMetadata | null {
  return reindexMetadataFromObservation(
    readProcessFileLock(lockPath, { parseLegacy: parseLegacyReindexOwner }),
    lockPath,
  );
}

const parseLegacyReindexOwner: LegacyProcessLockDecoder = (value) => {
  const metadata = parseLegacyReindexMetadata(value, '');
  return metadata
    ? {
        pid: metadata.pid,
        ...(metadata.processIdentity ? { processIdentity: metadata.processIdentity } : {}),
      }
    : null;
};

function reindexMetadataFromObservation(
  observation: ProcessFileLockObservation,
  lockPath: string,
): ReindexLockMetadata | null {
  if (observation.state === 'valid' && observation.record?.kind === 'reindex') {
    const detail = observation.record.detail ?? {};
    return {
      version: 2,
      pid: observation.record.pid,
      ...(observation.record.processIdentity ? { processIdentity: observation.record.processIdentity } : {}),
      ...(detail['processGroupLeader'] === true ? { processGroupLeader: true } : {}),
      projectRoot: typeof detail['projectRoot'] === 'string' ? detail['projectRoot'] : dirname(lockPath),
      startedAt: observation.record.startedAt,
      trigger: detail['trigger'] as RefreshTrigger | undefined,
    };
  }
  return parseLegacyReindexMetadata(observation.parsed, lockPath);
}

function parseLegacyReindexMetadata(value: unknown, lockPath: string): ReindexLockMetadata | null {
  try {
    const parsed = value as Partial<ReindexLockMetadata>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      version: parsed.version === 2 ? 2 : 1,
      pid: parsed.pid,
      ...(parsed.processIdentity === undefined
        ? {}
        : (() => {
            const processIdentity = parseProcessIdentity(parsed.processIdentity);
            return processIdentity?.pid === parsed.pid ? { processIdentity } : {};
          })()),
      ...(parsed.processGroupLeader === true ? { processGroupLeader: true } : {}),
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

/** Returns true only once the recorded owner exited or its PID was reused. */
async function terminateReindexLockOwner(owner: ReindexLockMetadata): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) return true;
  assertReindexOwnerIdentity(owner);
  sendSignal(owner, 'SIGTERM');
  if (await waitForProcessExit(owner, 2_000)) return true;
  assertReindexOwnerIdentity(owner);
  sendSignal(owner, 'SIGKILL');
  return waitForProcessExit(owner, 1_000);
}

function sendSignal(owner: ReindexLockMetadata, signal: NodeJS.Signals): void {
  if (owner.processGroupLeader) {
    try {
      process.kill(-owner.pid, signal);
      return;
    } catch {
      // Fall back to the owner only after proving it still occupies the PID.
      if (!isProcessAlive(owner.pid)) return;
      assertReindexOwnerIdentity(owner);
    }
  }
  try {
    process.kill(owner.pid, signal);
  } catch {
    // The verified owner already exited.
  }
}

async function waitForProcessExit(owner: ReindexLockMetadata, timeoutMs: number): Promise<boolean> {
  const deadline = monotonicNowMs() + timeoutMs;
  while (monotonicNowMs() < deadline) {
    if (reindexOwnerExited(owner)) return true;
    await delay(50);
  }
  return reindexOwnerExited(owner);
}

function assertReindexOwnerIdentity(owner: ReindexLockMetadata): void {
  if (!owner.processIdentity) {
    throw new Error(`Refusing to signal reindex pid ${owner.pid}: its ownership record has no process identity.`);
  }
  const actual = readProcessIdentity(owner.pid);
  if (!actual) {
    throw new Error(`Refusing to signal reindex pid ${owner.pid}: its process identity is unavailable.`);
  }
  if (!sameProcessIdentity(owner.processIdentity, actual)) {
    throw new Error(
      `Refusing to signal reindex pid ${owner.pid}: its process identity does not match the ownership record.`,
    );
  }
}

function reindexOwnerExited(owner: ReindexLockMetadata): boolean {
  if (!isProcessAlive(owner.pid)) return true;
  if (!owner.processIdentity) return false;
  const actual = readProcessIdentity(owner.pid);
  return actual !== null && !sameProcessIdentity(owner.processIdentity, actual);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

type ReindexFingerprint = ProjectInputFingerprint;

// scip-query: ignore-similar - per-language fingerprints intentionally reuse the project fingerprint inputs by language.
function computeLanguageFingerprints(
  projectFingerprint: ReindexFingerprint,
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
      const normalizedTypeScriptProjects =
        language === 'typescript' ? normalizeTypeScriptProjects(opts.typescriptProjects) : [];
      const clojureConfigPath = language === 'clojure' ? normalizeOptionalPath(opts.clojureConfigPath) : undefined;
      const markerFiles = [
        ...getIndexerConfig(language).markerFiles,
        ...normalizedTypeScriptProjects,
        ...(clojureConfigPath ? [clojureConfigPath] : []),
      ];
      const typeScriptOptions =
        language === 'typescript'
          ? {
              typescriptProjectMode: opts.typescriptProjectMode ?? 'single',
              typescriptProjects: normalizedTypeScriptProjects,
            }
          : { typescriptProjectMode: 'single' as const, typescriptProjects: [] };
      return [
        language,
        {
          version: 2,
          languages: [language],
          pnpmWorkspaces: language === 'typescript' && effectivePnpmWorkspaces(opts),
          ...typeScriptOptions,
          clojureConfigPath,
          files: projectFingerprint.files
            .filter((file) => isLanguageRelevantProjectInputPath(file.path, language, markerFiles))
            .map((file) => languageFingerprintFile(file, language)),
        },
      ];
    }),
  ) as Partial<Record<SupportedLanguage, ReindexFingerprint>>;
}

function languageFingerprintFile(file: ProjectFileFingerprint, language: SupportedLanguage): ProjectFileFingerprint {
  const packageSemanticHash =
    language === 'typescript' && /(?:^|\/)package\.json$/iu.test(file.path) ? file.semanticHash : undefined;
  return {
    path: file.path,
    size: packageSemanticHash === undefined ? file.size : 0,
    hash: packageSemanticHash ?? file.hash,
  };
}

function migrateLegacyTypeScriptLanguageFingerprint(projectRoot: string, value: unknown): unknown {
  const snapshot = projectInputSnapshotOrNull(value);
  if (!snapshot) return value;
  const projectRoots =
    snapshot.typescriptProjectMode === 'workspace'
      ? discoverTypeScriptProjectRoots(projectRoot, snapshot.typescriptProjects)
      : ['.'];
  const activeTypeScriptConfigs = activeTypeScriptProjectConfigPaths(projectRoots);
  return {
    ...snapshot,
    files: snapshot.files
      .filter((file) => !isTypeScriptProjectConfigPath(file.path) || activeTypeScriptConfigs.has(file.path))
      .map((file) => {
        const semanticHash =
          file.semanticHash ?? recoverTypeScriptPackageSemanticHash(projectRoot, file.path, file.hash);
        return languageFingerprintFile(semanticHash === undefined ? file : { ...file, semanticHash }, 'typescript');
      }),
  };
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

function readReindexMetaOrNull(metaPath: string): DecodedReindexMetadata | null {
  try {
    return acceptedReindexMetadata(decodeReindexMetadata(readSmallArtifactText(metaPath, 'reindex metadata')));
  } catch {
    return null;
  }
}

function reindexFingerprintMatch(
  metaPath: string,
  fingerprint: ReindexFingerprint,
): 'exact' | 'operational-config-compatible' | null {
  try {
    const decoded = decodeReindexMetadata(readSmallArtifactText(metaPath, 'reindex metadata'));
    if (decoded.kind !== 'legacy' && decoded.kind !== 'supported') return null;
    const meta = decoded.metadata;
    if (
      !decoded.capabilities.publishableGeneration ||
      !hasCurrentSqliteQueryLayout(meta) ||
      stableJson([...(meta.indexedLanguages ?? [])].sort()) !== stableJson(fingerprint.languages)
    ) {
      return null;
    }
    if (stableJson(meta.fingerprint) === stableJson(fingerprint)) return 'exact';
    return stableJson(withoutOperationalProjectConfig(meta.fingerprint)) ===
      stableJson(withoutOperationalProjectConfig(fingerprint))
      ? 'operational-config-compatible'
      : null;
  } catch {
    return null;
  }
}

function withoutOperationalProjectConfig(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['files'])) return value;
  return {
    ...record,
    files: record['files'].filter(
      (file) =>
        typeof file !== 'object' ||
        file === null ||
        Array.isArray(file) ||
        (file as Record<string, unknown>)['path'] !== '.scipquery.json',
    ),
  };
}

function updateReindexFingerprintMetadata(
  metaPath: string,
  fingerprint: ReindexFingerprint,
  languages: readonly SupportedLanguage[],
  opts: {
    pnpmWorkspaces?: boolean;
    typescriptProjectMode?: TypeScriptProjectMode;
    typescriptProjects?: readonly string[];
    clojureConfigPath?: string;
  },
): void {
  const metadata = acceptedReindexMetadata(decodeReindexMetadata(readSmallArtifactText(metaPath, 'reindex metadata')));
  if (!metadata) return;
  writeReindexMeta(metaPath, {
    ...metadata,
    fingerprint,
    ...(metadata.version === CURRENT_REINDEX_METADATA_VERSION
      ? { languageFingerprints: computeLanguageFingerprints(fingerprint, languages, opts) }
      : {}),
  });
}

function writeReindexMeta(metaPath: string, metadata: DecodedReindexMetadata): void {
  writeJsonDurable(metaPath, metadata, { spacing: 2, trailingNewline: true });
}

function updateReindexLastRefresh(metaPath: string, lastRefresh: LastRefreshMetadata): void {
  try {
    const metadata = acceptedReindexMetadata(
      decodeReindexMetadata(readSmallArtifactText(metaPath, 'reindex metadata')),
    );
    if (!metadata) return;
    writeReindexMeta(metaPath, { ...metadata, lastRefresh });
  } catch {
    // Best-effort operational metadata must never mask the reindex result.
  }
}

function buildLastRefresh(opts: {
  trigger?: RefreshTrigger;
  result: LastRefreshMetadata['result'];
  start: number;
  monotonicStart: number;
  languages?: readonly SupportedLanguage[];
  skipped?: readonly { language: SupportedLanguage; reason: string }[];
  error?: string;
}): LastRefreshMetadata {
  return {
    trigger: opts.trigger ?? { kind: 'unknown' },
    result: opts.result,
    startedAt: new Date(opts.start).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: monotonicNowMs() - opts.monotonicStart,
    indexedLanguages: opts.languages ? [...opts.languages] : undefined,
    skipped: opts.skipped ? [...opts.skipped] : undefined,
    error: opts.error,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
