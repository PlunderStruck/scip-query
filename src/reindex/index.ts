import { execFile, execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { tryInstallScipCli } from '../runtime/scip-cli.js';
import type { SupportedLanguage, IndexerConfig } from '../domain/types.js';
import { augmentAuxiliaryDocuments } from './augment.js';
import { detectLanguages } from './detect.js';
import { getIndexerConfig } from './indexers.js';
import { mergeScipFiles } from './merge.js';
import { fingerprintProjectFiles } from './project-files.js';
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

interface PreparedIndexerRun {
  language: SupportedLanguage;
  scipPath: string;
  config: IndexerConfig;
  resolvedBinary: string;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface IndexerRunResult {
  language: SupportedLanguage;
  scipPath: string;
  skipped?: { language: SupportedLanguage; reason: string };
}

interface DefaultOutputBackup {
  defaultOutputPath: string;
  backupPath: string | null;
}

interface ReindexMetadata {
  version: 2;
  status: 'complete' | 'partial';
  updatedAt: string;
  fingerprint: ReindexFingerprint;
  requestedLanguages: SupportedLanguage[];
  indexedLanguages: SupportedLanguage[];
  skipped: { language: SupportedLanguage; reason: string }[];
}

/**
 * Reindex a project: detect languages, run the appropriate SCIP indexer(s),
 * and convert the output to SQLite.
 */
export async function reindex(opts: ReindexOptions): Promise<ReindexResult> {
  const {
    projectRoot,
    maxHeapMb = 8192,
    onStatus = console.log,
    skipAutoInstall = false,
  } = opts;

  const outputScip = opts.outputScip ?? join(projectRoot, 'index.scip');
  const outputDb = opts.outputDb ?? join(projectRoot, 'index.db');
  const metaPath = join(dirname(outputDb), 'meta.json');
  const start = Date.now();
  mkdirSync(dirname(outputScip), { recursive: true });
  mkdirSync(dirname(outputDb), { recursive: true });

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
  const releaseLock = acquireReindexLock(join(dirname(outputDb), 'index.lock'));
  let runDir: string | null = null;

  try {
    if (
      opts.skipIfUnchanged !== false
      && existsSync(outputScip)
      && existsSync(outputDb)
      && isUnchangedReindex(metaPath, fingerprint)
    ) {
      augmentAuxiliaryDocuments({
        projectRoot,
        dbPath: outputDb,
        onStatus,
      });
      const durationMs = Date.now() - start;
      onStatus(`Index unchanged; reused existing SQLite index in ${(durationMs / 1000).toFixed(1)}s`);
      return {
        languages,
        indexPath: outputScip,
        dbPath: outputDb,
        durationMs,
        reused: true,
        skipped: [],
      };
    }

    // Check that the scip CLI is available, auto-install if needed
    if (!isBinaryAvailable('scip')) {
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

    runDir = mkdtempSync(join(dirname(outputDb), 'reindex-'));
    const tempOutputScip = join(runDir, basename(outputScip));
    const tempOutputDb = join(runDir, basename(outputDb));
    const tempMetaPath = join(runDir, basename(metaPath));

    const env = {
      ...process.env,
      NODE_OPTIONS: `--max-old-space-size=${maxHeapMb}`,
    };

    const languageOutputs = languages.map((language, index) => ({
      language,
      scipPath: languages.length > 1
        ? tempScipPath(tempOutputScip, language, index)
        : tempOutputScip,
    }));

    const indexedOutputs: { language: SupportedLanguage; scipPath: string }[] = [];
    const skippedLanguages: { language: SupportedLanguage; reason: string }[] = [];
    const preparedRuns: PreparedIndexerRun[] = [];

    for (const { language: lang, scipPath } of languageOutputs) {
      const config = getIndexerConfig(lang);
      const binaryLabel = describeIndexerBinary(config);
      const projectLocalBinary = resolveProjectLocalIndexerBinary(config, projectRoot);

      if (!projectLocalBinary && !isIndexerInstalled(config)) {
        if (skipAutoInstall) {
          const reason = `${binaryLabel} not found on PATH (auto-install disabled). ${config.installUrl ?? ''}`.trim();
          onStatus(`Skipping ${lang}: ${reason}`);
          skippedLanguages.push({ language: lang, reason });
          continue;
        }
        onStatus(`${binaryLabel} not found. Attempting auto-install...`);
        if (!tryInstallIndexer(config, onStatus)) {
          const reason = `${binaryLabel} could not be auto-installed. ${config.installUrl ? `Install manually from ${config.installUrl}` : `Install ${binaryLabel} and put it on PATH.`}`;
          onStatus(`Skipping ${lang}: ${reason}`);
          skippedLanguages.push({ language: lang, reason });
          continue;
        }
      }

      const resolvedBinary = projectLocalBinary ?? resolveIndexerBinary(config);
      if (!resolvedBinary) {
        const reason = `${binaryLabel} was not found after installation checks.`;
        onStatus(`Skipping ${lang}: ${reason}`);
        skippedLanguages.push({ language: lang, reason });
        continue;
      }

      const indexerEnv = getIndexerExecutionEnv(config, env, resolvedBinary);
      const { binary, args } = config.indexArgs({
        projectRoot,
        outputPath: scipPath,
        pnpmWorkspaces: opts.pnpmWorkspaces,
        indexerBinary: resolvedBinary,
      });

      preparedRuns.push({
        language: lang,
        scipPath,
        config,
        resolvedBinary,
        binary,
        args,
        env: indexerEnv,
      });
    }

    const runResults = await runPreparedIndexers(
      preparedRuns,
      projectRoot,
      onStatus,
      opts.indexerConcurrency,
    );
    for (const result of runResults) {
      if (result.skipped) {
        skippedLanguages.push(result.skipped);
      } else {
        indexedOutputs.push({ language: result.language, scipPath: result.scipPath });
      }
    }

    if (indexedOutputs.length === 0) {
      const detail = skippedLanguages.map((s) => `  - ${s.language}: ${s.reason}`).join('\n');
      throw new Error(
        'No language indexers ran successfully. Install at least one indexer for the languages in this project.\n' +
        detail,
      );
    }

    if (skippedLanguages.length > 0) {
      onStatus(`Indexed ${indexedOutputs.length} of ${languages.length} languages; skipped ${skippedLanguages.map((s) => s.language).join(', ')}.`);
      if (!opts.allowPartial) {
        throw new Error(
          'Failed to index all required languages; preserving the previous index. ' +
          'Pass --allow-partial to intentionally write an incomplete index.\n' +
          skippedLanguages.map((s) => `  - ${s.language}: ${s.reason}`).join('\n'),
        );
      }
    }

    if (indexedOutputs.length > 1) {
      onStatus(`Merging ${indexedOutputs.length} language indexes...`);
      mergeScipFiles(indexedOutputs.map((entry) => entry.scipPath), tempOutputScip);
    } else if (indexedOutputs[0]!.scipPath !== tempOutputScip) {
      renameSync(indexedOutputs[0]!.scipPath, tempOutputScip);
    }

    onStatus('Converting to SQLite...');
    if (!existsSync(tempOutputScip)) {
      throw new Error(`SCIP index not found at ${tempOutputScip} after indexing`);
    }

    try {
      execFileSync('scip', ['expt-convert', '--output', tempOutputDb, tempOutputScip], {
        env,
        stdio: 'pipe',
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to convert SCIP index to SQLite: ${msg}`, { cause: err });
    }

    augmentAuxiliaryDocuments({
      projectRoot,
      dbPath: tempOutputDb,
      onStatus,
    });

    writeReindexMeta(tempMetaPath, {
      version: 2,
      status: skippedLanguages.length === 0 ? 'complete' : 'partial',
      updatedAt: new Date().toISOString(),
      fingerprint,
      requestedLanguages: languages,
      indexedLanguages: indexedOutputs.map((o) => o.language),
      skipped: skippedLanguages,
    });
    promoteReindexArtifacts({
      tempOutputScip,
      tempOutputDb,
      tempMetaPath,
      outputScip,
      outputDb,
      metaPath,
    });

    const durationMs = Date.now() - start;
    onStatus(`Done in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      languages: indexedOutputs.map((o) => o.language),
      indexPath: outputScip,
      dbPath: outputDb,
      durationMs,
      reused: false,
      skipped: skippedLanguages,
    };
  } finally {
    if (runDir) {
      rmSync(runDir, { recursive: true, force: true });
    }
    releaseLock();
  }
}

export { detectLanguages } from './detect.js';
export { augmentAuxiliaryDocuments } from './augment.js';
export { augmentVueResolvedReferences } from './augment-vue.js';
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

function moveDefaultOutputIfNeeded(
  config: IndexerConfig,
  projectRoot: string,
  outputScip: string,
): void {
  if (!config.defaultOutputPath) {
    return;
  }

  const defaultOutputPath = join(projectRoot, config.defaultOutputPath);
  if (outputScip !== defaultOutputPath && existsSync(defaultOutputPath)) {
    renameSync(defaultOutputPath, outputScip);
  }
}

function takeDefaultOutputBackup(
  config: IndexerConfig,
  projectRoot: string,
  outputScip: string,
): DefaultOutputBackup | null {
  if (!config.defaultOutputPath) {
    return null;
  }

  const defaultOutputPath = join(projectRoot, config.defaultOutputPath);
  if (defaultOutputPath === outputScip) {
    return null;
  }

  const backupPath = `${outputScip}.default-output-backup`;
  rmSync(backupPath, { force: true });
  if (existsSync(defaultOutputPath)) {
    renameSync(defaultOutputPath, backupPath);
    return { defaultOutputPath, backupPath };
  }
  return { defaultOutputPath, backupPath: null };
}

function restoreDefaultOutputBackup(backup: DefaultOutputBackup | null): void {
  if (!backup) {
    return;
  }

  rmSync(backup.defaultOutputPath, { force: true });
  if (backup.backupPath && existsSync(backup.backupPath)) {
    renameSync(backup.backupPath, backup.defaultOutputPath);
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

function resolveIndexerConcurrency(runCount: number, configured?: number): number {
  if (runCount <= 1) {
    return 1;
  }

  const envValue = Number(process.env['SCIP_QUERY_INDEXER_CONCURRENCY'] ?? 0);
  const requested = Number.isFinite(configured) && configured && configured > 0
    ? configured
    : Number.isFinite(envValue) && envValue > 0
      ? envValue
      : Math.min(2, Math.max(1, cpus().length - 1));
  return Math.max(1, Math.min(runCount, Math.floor(requested)));
}

async function runPreparedIndexers(
  runs: readonly PreparedIndexerRun[],
  projectRoot: string,
  onStatus: (message: string) => void,
  configuredConcurrency?: number,
): Promise<IndexerRunResult[]> {
  const defaultOutputRuns = runs.filter((run) => run.config.defaultOutputPath);
  const directOutputRuns = runs.filter((run) => !run.config.defaultOutputPath);
  const results: IndexerRunResult[] = [];
  const concurrency = resolveIndexerConcurrency(directOutputRuns.length, configuredConcurrency);

  const directResults = await runWithConcurrency(
    directOutputRuns,
    concurrency,
    (run) => runPreparedIndexer(run, projectRoot, onStatus),
  );

  if (concurrency > 1) {
    const retryResults = new Map<SupportedLanguage, IndexerRunResult>();
    for (const failed of directResults.filter((result) => result.skipped)) {
      const run = directOutputRuns.find((candidate) => candidate.language === failed.language);
      if (!run) continue;
      onStatus(`Retrying ${run.language} indexer serially after parallel failure...`);
      retryResults.set(run.language, await runPreparedIndexer(run, projectRoot, onStatus));
    }
    results.push(...directResults.map((result) => retryResults.get(result.language) ?? result));
  } else {
    results.push(...directResults);
  }

  for (const run of defaultOutputRuns) {
    results.push(await runPreparedIndexer(run, projectRoot, onStatus));
  }

  return results.sort((a, b) => runs.findIndex((run) => run.language === a.language)
    - runs.findIndex((run) => run.language === b.language));
}

async function runPreparedIndexer(
  run: PreparedIndexerRun,
  projectRoot: string,
  onStatus: (message: string) => void,
): Promise<IndexerRunResult> {
  onStatus(`Indexing ${run.language} with ${run.resolvedBinary}...`);
  rmSync(run.scipPath, { force: true });
  const defaultOutputBackup = takeDefaultOutputBackup(run.config, projectRoot, run.scipPath);

  try {
    await execFileBuffered(run.binary, run.args, {
      cwd: projectRoot,
      env: run.env,
      maxBuffer: 50 * 1024 * 1024,
    });
    moveDefaultOutputIfNeeded(run.config, projectRoot, run.scipPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = `${run.resolvedBinary} indexer failed: ${msg.split('\n')[0]}`;
    onStatus(`Skipping ${run.language}: ${reason}`);
    return {
      language: run.language,
      scipPath: run.scipPath,
      skipped: { language: run.language, reason },
    };
  } finally {
    restoreDefaultOutputBackup(defaultOutputBackup);
  }

  if (!existsSync(run.scipPath)) {
    const reason = `${run.resolvedBinary} indexer completed but did not produce ${run.scipPath}`;
    onStatus(`Skipping ${run.language}: ${reason}`);
    return {
      language: run.language,
      scipPath: run.scipPath,
      skipped: { language: run.language, reason },
    };
  }
  return { language: run.language, scipPath: run.scipPath };
}

function execFileBuffered(
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number },
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(binary, [...args], options, (err) => {
      if (err) {
        rejectRun(err);
      } else {
        resolveRun();
      }
    });
  });
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(items.length, concurrency));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
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

function isUnchangedReindex(metaPath: string, fingerprint: ReindexFingerprint): boolean {
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Partial<ReindexMetadata>;
    return meta.version === 2
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
