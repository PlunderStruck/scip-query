import { execFile } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { IndexerConfig, SupportedLanguage } from '../domain/types.js';

export interface PreparedIndexerRun {
  language: SupportedLanguage;
  scipPath: string;
  config: IndexerConfig;
  resolvedBinary: string;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface IndexerRunResult {
  language: SupportedLanguage;
  scipPath: string;
  skipped?: { language: SupportedLanguage; reason: string };
}

interface DefaultOutputBackup {
  defaultOutputPath: string;
  backupPath: string | null;
}

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

export async function runPreparedIndexers(
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

// scip-query: ignore-extract — this is the per-indexer backup/run/restore
// safety sequence; the default-output recovery has to remain in one visible
// try/finally block.
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
