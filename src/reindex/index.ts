import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
import { auxiliaryDocumentsAugmentationStage } from './augment.js';
import { detectLanguages } from './detect.js';
import { getIndexerConfig } from './indexers.js';
import { mergeScipFiles } from './merge.js';
import { runPostIndexAugmentation } from './post-index-augmentation.js';
import { fingerprintProjectFiles, normalizeTypeScriptProjects } from './project-files.js';
import { sanitizeScipFile } from './sanitize.js';
import { discoverTypeScriptProjectRoots } from './typescript-projects.js';
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
}

interface ReindexMetadata {
  version: 2 | 3;
  status: 'complete' | 'partial';
  updatedAt: string;
  fingerprint: ReindexFingerprint;
  languageFingerprints?: Partial<Record<SupportedLanguage, ReindexFingerprint>>;
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
  shards: ReindexShardDiagnostic[];
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
  if (
    opts.opts.skipIfUnchanged === false ||
    !existsSync(opts.paths.outputScip) ||
    !existsSync(opts.paths.outputDb) ||
    !isUnchangedReindex(opts.paths.metaPath, opts.fingerprint)
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

  const { indexedOutputs, skippedLanguages, reusedLanguages, shards } = await runLanguageIndexersForFreshReindex(
    opts,
    env,
  );
  if (reusedLanguages.length > 0) {
    opts.onStatus(`Reused ${reusedLanguages.length} cached language shard(s): ${reusedLanguages.join(', ')}`);
  }
  const lastRefresh = publishFreshReindexArtifacts(opts, env, indexedOutputs, skippedLanguages);
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
  const { preparedRuns, skippedLanguages } = prepareIndexerRuns({
    languages: opts.languages.filter((language) => !reused.has(language)),
    tempOutputScip: opts.tempPaths.tempOutputScip,
    projectRoot: opts.projectRoot,
    env,
    skipAutoInstall: opts.skipAutoInstall,
    pnpmWorkspaces: opts.opts.pnpmWorkspaces,
    typescriptProjectMode: opts.opts.typescriptProjectMode,
    typescriptProjects: opts.opts.typescriptProjects,
    clojureConfigPath: opts.opts.clojureConfigPath,
    onStatus: opts.onStatus,
  });

  const runResults = await runPreparedIndexers(
    preparedRuns,
    opts.projectRoot,
    opts.onStatus,
    opts.opts.indexerConcurrency,
  );
  const { indexedOutputs } = collectIndexerOutputs(runResults, skippedLanguages);
  const allIndexedOutputs = [...reusableOutputs, ...indexedOutputs];
  validateIndexingOutcome(allIndexedOutputs, skippedLanguages, opts.languages, opts.opts.allowPartial, opts.onStatus);
  const shards = buildFreshReindexShardDiagnostics(classification, runResults);
  return { indexedOutputs: allIndexedOutputs, skippedLanguages, reusedLanguages: [...reused], shards };
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
  let meta: Partial<ReindexMetadata> | null;
  try {
    meta = JSON.parse(readFileSync(opts.paths.metaPath, 'utf-8')) as Partial<ReindexMetadata>;
  } catch {
    meta = null;
  }
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

function buildFreshReindexShardDiagnostics(
  classification: ReadonlyMap<SupportedLanguage, LanguageShardClassification>,
  runResults: readonly IndexerRunResult[],
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
    diagnostics.push({
      id: run.id,
      language: run.language,
      reused: false,
      missReason: info?.reason ?? run.skipped?.reason,
      fingerprint: info ? hashFingerprint(info.fingerprint) : 'unknown',
      outputBytes: run.outputBytes ?? null,
      durationMs: run.durationMs,
      command: run.command,
    });
  }
  return diagnostics;
}

function hashFingerprint(fingerprint: ReindexFingerprint | undefined): string {
  return createHash('sha256').update(stableJson(fingerprint)).digest('hex').slice(0, 16);
}

function fileSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

// scip-query: ignore-extract — this is the publish phase for a fresh index:
// materialize SCIP, convert to SQLite, promote both artifacts, and write
// metadata are one atomic handoff.
function publishFreshReindexArtifacts(
  opts: Parameters<typeof runFreshReindex>[0],
  env: NodeJS.ProcessEnv,
  indexedOutputs: readonly IndexedOutput[],
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[],
): LastRefreshMetadata {
  cacheLanguageShards(opts.paths.outputDb, indexedOutputs);
  materializeScipOutput(indexedOutputs, opts.tempPaths.tempOutputScip, opts.onStatus);
  convertScipToSqlite(opts.tempPaths.tempOutputScip, opts.tempPaths.tempOutputDb, env, opts.onStatus);

  runPostIndexAugmentation(auxiliaryDocumentsAugmentationStage(), {
    projectRoot: opts.projectRoot,
    dbPath: opts.tempPaths.tempOutputDb,
    onStatus: opts.onStatus,
  });

  const lastRefresh = buildLastRefresh({
    trigger: opts.opts.trigger,
    result: 'rebuilt',
    start: opts.start,
    languages: indexedOutputs.map((o) => o.language),
    skipped: [...skippedLanguages],
  });
  writeReindexMeta(opts.tempPaths.tempMetaPath, {
    version: 3,
    status: skippedLanguages.length === 0 ? 'complete' : 'partial',
    updatedAt: new Date().toISOString(),
    fingerprint: opts.fingerprint,
    languageFingerprints: computeLanguageFingerprints(opts.projectRoot, opts.languages, {
      pnpmWorkspaces: opts.opts.pnpmWorkspaces,
      typescriptProjectMode: opts.opts.typescriptProjectMode,
      typescriptProjects: opts.opts.typescriptProjects,
      clojureConfigPath: opts.opts.clojureConfigPath,
    }),
    requestedLanguages: opts.languages,
    indexedLanguages: indexedOutputs.map((o) => o.language),
    skipped: [...skippedLanguages],
    lastRefresh,
  });
  promoteReindexArtifacts({
    tempOutputScip: opts.tempPaths.tempOutputScip,
    tempOutputDb: opts.tempPaths.tempOutputDb,
    tempMetaPath: opts.tempPaths.tempMetaPath,
    outputScip: opts.paths.outputScip,
    outputDb: opts.paths.outputDb,
    metaPath: opts.paths.metaPath,
  });
  return lastRefresh;
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
  clojureConfigPath?: string;
  onStatus: (message: string) => void;
}): PreparedIndexerPlan {
  const preparedRuns: PreparedIndexerRun[] = [];
  const skippedLanguages: { language: SupportedLanguage; reason: string }[] = [];
  const languageOutputs = opts.languages.map((language, index) => ({
    language,
    scipPath: opts.languages.length > 1 ? tempScipPath(opts.tempOutputScip, language, index) : opts.tempOutputScip,
  }));

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

  return { preparedRuns, skippedLanguages };
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

  const projects = discoverTypeScriptProjectRoots(opts.projectRoot, opts.typescriptProjects);
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
): void {
  if (indexedOutputs.length > 1) {
    onStatus(`Merging ${indexedOutputs.length} language indexes...`);
    mergeScipFiles(
      indexedOutputs.map((entry) => entry.scipPath),
      tempOutputScip,
    );
  } else if (indexedOutputs[0]!.scipPath !== tempOutputScip) {
    renameSync(indexedOutputs[0]!.scipPath, tempOutputScip);
  }
}

function convertScipToSqlite(
  tempOutputScip: string,
  tempOutputDb: string,
  env: NodeJS.ProcessEnv,
  onStatus: (message: string) => void,
): void {
  onStatus('Converting to SQLite...');
  if (!existsSync(tempOutputScip)) {
    throw new Error(`SCIP index not found at ${tempOutputScip} after indexing`);
  }

  try {
    const sanitized = sanitizeScipFile(tempOutputScip);
    if (sanitized.removedDefinitionOccurrences > 0) {
      onStatus(
        `Sanitized ${sanitized.removedDefinitionOccurrences} invalid definition occurrences ` +
          `across ${sanitized.touchedDocuments} documents before SQLite conversion.`,
      );
    }
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

function promoteReindexArtifacts(opts: {
  tempOutputScip: string;
  tempOutputDb: string;
  tempMetaPath: string;
  outputScip: string;
  outputDb: string;
  metaPath: string;
}): void {
  replaceFile(opts.tempOutputScip, opts.outputScip);
  replaceFile(opts.tempOutputDb, opts.outputDb);
  replaceFile(opts.tempMetaPath, opts.metaPath);
}

function replaceFile(source: string, target: string): void {
  rmSync(`${target}.tmp-replace`, { force: true });
  renameSync(source, `${target}.tmp-replace`);
  renameSync(`${target}.tmp-replace`, target);
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
  const tempPath = `${metaPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(metadata, null, 2)}\n`);
  renameSync(tempPath, metaPath);
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
