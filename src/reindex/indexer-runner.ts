import { execFile } from 'node:child_process';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { IndexerConfig, SupportedLanguage } from '../domain/types.js';

// scip-query: ignore-stale — exported handoff record between reindex planning
// and the runner; inlining would smear indexer execution state across modules.
export interface PreparedIndexerRun {
  id: string;
  language: SupportedLanguage;
  label: string;
  scipPath: string;
  outputScipPath: string;
  config: IndexerConfig;
  resolvedBinary: string;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

// scip-query: ignore-stale — exported runner result consumed by reindex
// orchestration; the name keeps successful and skipped indexer outcomes explicit.
export interface IndexerRunResult {
  id: string;
  language: SupportedLanguage;
  label: string;
  scipPath: string;
  outputScipPath: string;
  /** Wall time spent invoking this indexer, including a failed attempt. */
  durationMs: number;
  /** The resolved binary and args this shard's indexer was invoked with. */
  command: string;
  /** Size in bytes of the produced SCIP shard; absent when the run failed. */
  outputBytes?: number;
  skipped?: { language: SupportedLanguage; reason: string };
}

interface DefaultOutputBackup {
  defaultOutputPath: string;
  backupPath: string | null;
}

function moveDefaultOutputIfNeeded(config: IndexerConfig, projectRoot: string, outputScip: string): void {
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

export function resolveIndexerConcurrency(runCount: number, configured?: number): number {
  if (runCount <= 1) {
    return 1;
  }

  const envValue = Number(process.env['SCIP_QUERY_INDEXER_CONCURRENCY'] ?? 0);
  const requested =
    Number.isFinite(configured) && configured && configured > 0
      ? configured
      : Number.isFinite(envValue) && envValue > 0
        ? envValue
        : Math.min(8, Math.max(1, cpus().length));
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

  const directResults = await runWithConcurrency(directOutputRuns, concurrency, (run) =>
    runPreparedIndexer(run, projectRoot, onStatus),
  );

  if (concurrency > 1) {
    const retryResults = new Map<string, IndexerRunResult>();
    for (const failed of directResults.filter((result) => result.skipped)) {
      const run = directOutputRuns.find((candidate) => candidate.id === failed.id);
      if (!run) continue;
      onStatus(`Retrying ${run.label} indexer serially after parallel failure...`);
      retryResults.set(run.id, await runPreparedIndexer(run, projectRoot, onStatus));
    }
    results.push(...directResults.map((result) => retryResults.get(result.id) ?? result));
  } else {
    results.push(...directResults);
  }

  for (const run of defaultOutputRuns) {
    results.push(await runPreparedIndexer(run, projectRoot, onStatus));
  }

  return results.sort((a, b) => runs.findIndex((run) => run.id === a.id) - runs.findIndex((run) => run.id === b.id));
}

// scip-query: ignore-extract — this is the per-indexer backup/run/restore
// safety sequence; the default-output recovery has to remain in one visible
// try/finally block.
async function runPreparedIndexer(
  run: PreparedIndexerRun,
  projectRoot: string,
  onStatus: (message: string) => void,
): Promise<IndexerRunResult> {
  onStatus(`Indexing ${run.label} with ${run.resolvedBinary}...`);
  rmSync(run.scipPath, { force: true });
  const defaultOutputBackup = takeDefaultOutputBackup(run.config, projectRoot, run.scipPath);
  const command = [run.binary, ...run.args].join(' ');
  const startedAt = Date.now();

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
    const skippedReason = run.label === run.language ? reason : `${run.label}: ${reason}`;
    onStatus(`Skipping ${run.label}: ${reason}`);
    return {
      id: run.id,
      language: run.language,
      label: run.label,
      scipPath: run.scipPath,
      outputScipPath: run.outputScipPath,
      durationMs: Date.now() - startedAt,
      command,
      skipped: { language: run.language, reason: skippedReason },
    };
  } finally {
    restoreDefaultOutputBackup(defaultOutputBackup);
  }

  if (!existsSync(run.scipPath)) {
    const reason = `${run.resolvedBinary} indexer completed but did not produce ${run.scipPath}`;
    const skippedReason = run.label === run.language ? reason : `${run.label}: ${reason}`;
    onStatus(`Skipping ${run.label}: ${reason}`);
    return {
      id: run.id,
      language: run.language,
      label: run.label,
      scipPath: run.scipPath,
      outputScipPath: run.outputScipPath,
      durationMs: Date.now() - startedAt,
      command,
      skipped: { language: run.language, reason: skippedReason },
    };
  }
  let outputBytes: number | undefined;
  try {
    outputBytes = statSync(run.scipPath).size;
  } catch {
    outputBytes = undefined;
  }
  return {
    id: run.id,
    language: run.language,
    label: run.label,
    scipPath: run.scipPath,
    outputScipPath: run.outputScipPath,
    durationMs: Date.now() - startedAt,
    command,
    outputBytes,
  };
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

// scip-query: ignore-twin — indexer scheduling and Rust request scheduling have different failure policy.
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
