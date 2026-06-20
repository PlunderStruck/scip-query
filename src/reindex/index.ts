import { execFileSync } from 'node:child_process';
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
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { tryInstallScipCli } from '../runtime/scip-cli.js';
import type { SupportedLanguage } from '../domain/types.js';
import { augmentAuxiliaryDocuments } from './augment.js';
import { detectLanguages } from './detect.js';
import { getIndexerConfig } from './indexers.js';
import { mergeScipFiles } from './merge.js';
import { fingerprintProjectFiles } from './project-files.js';
import { sanitizeScipFile } from './sanitize.js';
import { runPreparedIndexers } from './indexer-runner.js';
import type { PreparedIndexerRun, IndexerRunResult } from './indexer-runner.js';
import {
  describeIndexerBinary,
  getIndexerExecutionEnv,
  isBinaryAvailable,
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
  /** Skip auto-install prompts */
  skipAutoInstall?: boolean;
  /** Reuse an existing index when tracked source inputs are unchanged (default true). */
  skipIfUnchanged?: boolean;
  /** Permit a partial index when some detected/requested languages fail (default false). */
  allowPartial?: boolean;
  /** Number of language indexers to run at once (default: conservative auto). */
  indexerConcurrency?: number;
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
}

/**
 * Reindex a project: detect languages, run the appropriate SCIP indexer(s),
 * and convert the output to SQLite.
 */
// scip-query: ignore-extract — this is the lock/cleanup safety envelope for
// reindex; hiding the ordered steps behind another helper would make failure
// behavior harder to audit.
export async function reindex(opts: ReindexOptions): Promise<ReindexResult> {
  const {
    projectRoot,
    maxHeapMb = 8192,
    onStatus = console.log,
    skipAutoInstall = false,
  } = opts;

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
  });
  const releaseLock = acquireReindexLock(join(dirname(paths.outputDb), 'index.lock'));
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

    ensureScipCliAvailable(skipAutoInstall, onStatus);

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
  } finally {
    if (runDir) {
      rmSync(runDir, { recursive: true, force: true });
    }
    releaseLock();
  }
}

export { detectLanguages } from './detect.js';
export { augmentAuxiliaryDocuments } from './augment.js';
export { augmentVueResolvedReferences } from './vue/augment-vue.js';
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
    opts.opts.skipIfUnchanged === false
    || !existsSync(opts.paths.outputScip)
    || !existsSync(opts.paths.outputDb)
    || !isUnchangedReindex(opts.paths.metaPath, opts.fingerprint)
  ) {
    return null;
  }

  augmentAuxiliaryDocuments({
    projectRoot: opts.opts.projectRoot,
    dbPath: opts.paths.outputDb,
    onStatus: opts.onStatus,
  });
  const durationMs = Date.now() - opts.start;
  opts.onStatus(`Index unchanged; reused existing SQLite index in ${(durationMs / 1000).toFixed(1)}s`);
  return {
    languages: opts.languages,
    indexPath: opts.paths.outputScip,
    dbPath: opts.paths.outputDb,
    durationMs,
    reused: true,
    skipped: [],
  };
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

  const { indexedOutputs, skippedLanguages, reusedLanguages } = await runLanguageIndexersForFreshReindex(opts, env);
  if (reusedLanguages.length > 0) {
    opts.onStatus(`Reused ${reusedLanguages.length} cached language shard(s): ${reusedLanguages.join(', ')}`);
  }
  publishFreshReindexArtifacts(opts, env, indexedOutputs, skippedLanguages);

  const durationMs = Date.now() - opts.start;
  opts.onStatus(`Done in ${(durationMs / 1000).toFixed(1)}s`);
  return {
    languages: indexedOutputs.map((o) => o.language),
    indexPath: opts.paths.outputScip,
    dbPath: opts.paths.outputDb,
    durationMs,
    reused: false,
    skipped: skippedLanguages,
  };
}

async function runLanguageIndexersForFreshReindex(
  opts: Parameters<typeof runFreshReindex>[0],
  env: NodeJS.ProcessEnv,
): Promise<FreshIndexRun> {
  const reusableOutputs = reusableLanguageOutputs(opts);
  const reused = new Set(reusableOutputs.map((output) => output.language));
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
  return { indexedOutputs: allIndexedOutputs, skippedLanguages, reusedLanguages: [...reused] };
}

// scip-query: ignore-extract — this is the publish phase for a fresh index:
// materialize SCIP, convert to SQLite, promote both artifacts, and write
// metadata are one atomic handoff.
function publishFreshReindexArtifacts(
  opts: Parameters<typeof runFreshReindex>[0],
  env: NodeJS.ProcessEnv,
  indexedOutputs: readonly IndexedOutput[],
  skippedLanguages: readonly { language: SupportedLanguage; reason: string }[],
): void {
  cacheLanguageShards(opts.paths.outputDb, indexedOutputs);
  materializeScipOutput(indexedOutputs, opts.tempPaths.tempOutputScip, opts.onStatus);
  convertScipToSqlite(opts.tempPaths.tempOutputScip, opts.tempPaths.tempOutputDb, env, opts.onStatus);

  augmentAuxiliaryDocuments({
    projectRoot: opts.projectRoot,
    dbPath: opts.tempPaths.tempOutputDb,
    onStatus: opts.onStatus,
  });

  writeReindexMeta(opts.tempPaths.tempMetaPath, {
    version: 3,
    status: skippedLanguages.length === 0 ? 'complete' : 'partial',
    updatedAt: new Date().toISOString(),
    fingerprint: opts.fingerprint,
    languageFingerprints: computeLanguageFingerprints(opts.projectRoot, opts.languages, {
      pnpmWorkspaces: opts.opts.pnpmWorkspaces,
    }),
    requestedLanguages: opts.languages,
    indexedLanguages: indexedOutputs.map((o) => o.language),
    skipped: [...skippedLanguages],
  });
  promoteReindexArtifacts({
    tempOutputScip: opts.tempPaths.tempOutputScip,
    tempOutputDb: opts.tempPaths.tempOutputDb,
    tempMetaPath: opts.tempPaths.tempMetaPath,
    outputScip: opts.paths.outputScip,
    outputDb: opts.paths.outputDb,
    metaPath: opts.paths.metaPath,
  });
}

function reusableLanguageOutputs(opts: Parameters<typeof runFreshReindex>[0]): IndexedOutput[] {
  let meta: Partial<ReindexMetadata>;
  try {
    meta = JSON.parse(readFileSync(opts.paths.metaPath, 'utf-8')) as Partial<ReindexMetadata>;
  } catch {
    return [];
  }
  if (meta.version !== 3 || !meta.languageFingerprints) return [];
  const outputs: IndexedOutput[] = [];
  const current = computeLanguageFingerprints(opts.projectRoot, opts.languages, {
    pnpmWorkspaces: opts.opts.pnpmWorkspaces,
  });
  for (const language of opts.languages) {
    const scipPath = languageShardPath(opts.paths.outputDb, language);
    if (
      existsSync(scipPath)
      && stableJson(meta.languageFingerprints[language]) === stableJson(current[language])
    ) {
      outputs.push({ language, scipPath });
    }
  }
  return outputs;
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

function ensureScipCliAvailable(skipAutoInstall: boolean, onStatus: (message: string) => void): void {
  if (isBinaryAvailable('scip')) {
    return;
  }

  if (skipAutoInstall) {
    throw new Error(
      'The scip CLI is required but not found on PATH.\n' +
      'Install from: https://github.com/sourcegraph/scip/releases',
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
  onStatus: (message: string) => void;
}): PreparedIndexerPlan {
  const preparedRuns: PreparedIndexerRun[] = [];
  const skippedLanguages: { language: SupportedLanguage; reason: string }[] = [];
  const languageOutputs = opts.languages.map((language, index) => ({
    language,
    scipPath: opts.languages.length > 1
      ? tempScipPath(opts.tempOutputScip, language, index)
      : opts.tempOutputScip,
  }));

  for (const { language, scipPath } of languageOutputs) {
    const run = prepareIndexerRun({ ...opts, language, scipPath });
    if ('skipped' in run) {
      skippedLanguages.push(run.skipped);
    } else {
      preparedRuns.push(run.prepared);
    }
  }

  return { preparedRuns, skippedLanguages };
}

function prepareIndexerRun(opts: {
  language: SupportedLanguage;
  scipPath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  skipAutoInstall: boolean;
  pnpmWorkspaces?: boolean;
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
  });

  return {
    prepared: {
      language: opts.language,
      scipPath: opts.scipPath,
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
  const indexedOutputs: { language: SupportedLanguage; scipPath: string }[] = [];
  for (const result of runResults) {
    if (result.skipped) {
      skippedLanguages.push(result.skipped);
    } else {
      indexedOutputs.push({ language: result.language, scipPath: result.scipPath });
    }
  }
  return { indexedOutputs };
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

  onStatus(`Indexed ${indexedOutputs.length} of ${requestedLanguages.length} languages; skipped ${skippedLanguages.map((s) => s.language).join(', ')}.`);
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
    mergeScipFiles(indexedOutputs.map((entry) => entry.scipPath), tempOutputScip);
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
    execFileSync('scip', ['expt-convert', '--output', tempOutputDb, tempOutputScip], {
      env,
      stdio: 'pipe',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to convert SCIP index to SQLite: ${msg}`, { cause: err });
  }
}

function tempScipPath(outputScip: string, language: SupportedLanguage, index: number): string {
  const extension = extname(outputScip) || '.scip';
  const stem = basename(outputScip, extension);
  return join(dirname(outputScip), `${stem}.${index + 1}.${language}${extension}`);
}

function acquireReindexLock(lockPath: string): () => void {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code === 'EEXIST') {
      throw new Error(`Another scip-query reindex is already running for ${dirname(lockPath)}.`, { cause: err });
    }
    throw err;
  }

  writeFileSync(fd, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }) + '\n');

  return () => {
    try {
      closeSync(fd);
    } finally {
      rmSync(lockPath, { force: true });
    }
  };
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
  version: 1;
  languages: SupportedLanguage[];
  pnpmWorkspaces: boolean;
  files: { path: string; size: number; hash: string }[];
}

function computeReindexFingerprint(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  opts: { pnpmWorkspaces?: boolean },
): ReindexFingerprint {
  return {
    version: 1,
    languages: [...languages].sort(),
    pnpmWorkspaces: opts.pnpmWorkspaces === true,
    files: fingerprintProjectFiles(projectRoot),
  };
}

function computeLanguageFingerprints(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  opts: { pnpmWorkspaces?: boolean },
): Partial<Record<SupportedLanguage, ReindexFingerprint>> {
  return Object.fromEntries(languages.map((language) => {
    const markerFiles = getIndexerConfig(language).markerFiles;
    return [language, {
      version: 1,
      languages: [language],
      pnpmWorkspaces: language === 'typescript' && opts.pnpmWorkspaces === true,
      files: fingerprintProjectFiles(projectRoot, { language, markerFiles }),
    }];
  })) as Partial<Record<SupportedLanguage, ReindexFingerprint>>;
}

function languageShardPath(outputDb: string, language: SupportedLanguage): string {
  return join(dirname(outputDb), 'language-indexes', `${language}.scip`);
}

function isUnchangedReindex(metaPath: string, fingerprint: ReindexFingerprint): boolean {
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Partial<ReindexMetadata>;
    return (meta.version === 2 || meta.version === 3)
      && meta.status === 'complete'
      && stableJson(meta.fingerprint) === stableJson(fingerprint)
      && stableJson([...(meta.indexedLanguages ?? [])].sort()) === stableJson(fingerprint.languages);
  } catch {
    return false;
  }
}

function writeReindexMeta(metaPath: string, metadata: ReindexMetadata): void {
  writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
