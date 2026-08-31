import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { IndexerConfig, SupportedLanguage } from '../domain/types.js';
import { monotonicNowMs } from '../domain/time.js';
import { abortSignalReason, throwIfSignalAborted } from '../platform/abort-signal.js';
import { readFileWithinLimit } from '../platform/bounded-file.js';
import { toPortableCommand } from '../platform/binary.js';
import { BoundedProcessError, PROCESS_TIMEOUT_MS, runBoundedProcess } from '../platform/bounded-process.js';
import { revalidateTrustedProjectTool, type TrustedProjectToolIdentity } from '../platform/indexer-toolchain.js';
import { runWithConcurrency } from '../platform/structured-concurrency.js';

const INDEXER_FAILURE_DETAIL_LIMIT = 8 * 1024;

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
  temporaryRootConfigContent?: string;
  temporaryProjectConfigs?: readonly { path: string; content: string }[];
  /**
   * Runs carrying this limit execute in their own memory-bounded pool: at
   * most this many of them run at once, regardless of the general indexer
   * concurrency. Used by bounded TypeScript compiler shards, where each child
   * holds an independent compiler program.
   */
  boundedConcurrency?: number;
  outputComposition?: 'protobuf-concatenate';
  trustedProjectTool?: TrustedProjectToolIdentity;
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
  /** Bytes newly emitted by this run when outputBytes names a larger accepted base shard. */
  producedOutputBytes?: number;
  outputComposition?: 'protobuf-concatenate';
  skipped?: { language: SupportedLanguage; reason: string };
}

interface IndexerAttempt {
  result: IndexerRunResult;
  retryable: boolean;
}

interface DefaultOutputBackup {
  defaultOutputPath: string;
  backupPath: string | null;
}

interface OwnedTemporaryRootConfig {
  path: string;
  content: Buffer;
  device: number;
  inode: number;
}

function takeTemporaryConfig(
  path: string,
  source: string,
  onExisting: 'skip' | 'replace',
): OwnedTemporaryRootConfig | null {
  const content = Buffer.from(source, 'utf8');
  const openOwned = (): number => openSync(path, 'wx', 0o600);
  let descriptor: number;
  try {
    descriptor = openOwned();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (onExisting === 'skip') return null;
    // An existing file at an owned temporary-config path is a leftover from
    // an interrupted earlier run; replace it rather than failing forever.
    rmSync(path, { force: true });
    descriptor = openOwned();
  }
  try {
    writeSync(descriptor, content);
    const stats = fstatSync(descriptor);
    return { path, content, device: stats.dev, inode: stats.ino };
  } finally {
    closeSync(descriptor);
  }
}

function takeTemporaryConfigs(run: PreparedIndexerRun, projectRoot: string): OwnedTemporaryRootConfig[] {
  const owned: OwnedTemporaryRootConfig[] = [];
  try {
    if (run.temporaryRootConfigContent !== undefined) {
      // The project's real tsconfig.json is never replaced — an existing file
      // there belongs to the user, so the synthesized root config steps aside.
      const rootConfig = takeTemporaryConfig(
        join(projectRoot, 'tsconfig.json'),
        run.temporaryRootConfigContent,
        'skip',
      );
      if (rootConfig) owned.push(rootConfig);
    }
    for (const config of run.temporaryProjectConfigs ?? []) {
      const temporary = takeTemporaryConfig(config.path, config.content, 'replace');
      if (temporary) owned.push(temporary);
    }
    return owned;
  } catch (error) {
    for (const config of owned.reverse()) releaseTemporaryRootConfig(config);
    throw error;
  }
}

function releaseTemporaryRootConfig(owned: OwnedTemporaryRootConfig | null): void {
  if (!owned) return;
  try {
    const current = lstatSync(owned.path);
    if (!current.isFile() || current.dev !== owned.device || current.ino !== owned.inode) return;
    if (current.size !== owned.content.byteLength) return;
    let currentContent: Buffer;
    try {
      currentContent = readFileWithinLimit(owned.path, {
        maxBytes: owned.content.byteLength,
        inputKind: 'temporary TypeScript index configuration',
      });
    } catch {
      return;
    }
    if (!currentContent.equals(owned.content)) return;
    rmSync(owned.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
  signal?: AbortSignal,
): Promise<IndexerRunResult[]> {
  throwIfSignalAborted(signal, 'Reindex cancelled by its owner.');
  const defaultOutputRuns = runs.filter((run) => run.config.defaultOutputPath);
  const boundedRuns = runs.filter((run) => !run.config.defaultOutputPath && run.boundedConcurrency !== undefined);
  const directOutputRuns = runs.filter((run) => !run.config.defaultOutputPath && run.boundedConcurrency === undefined);
  const results: IndexerRunResult[] = [];

  results.push(
    ...(await runIndexerPool(
      directOutputRuns,
      resolveIndexerConcurrency(directOutputRuns.length, configuredConcurrency),
      projectRoot,
      onStatus,
      signal,
    )),
  );

  if (boundedRuns.length > 0) {
    const boundedLimit = Math.max(1, Math.min(...boundedRuns.map((run) => run.boundedConcurrency!)));
    results.push(...(await runIndexerPool(boundedRuns, boundedLimit, projectRoot, onStatus, signal)));
  }

  for (const run of defaultOutputRuns) {
    throwIfSignalAborted(signal, 'Reindex cancelled by its owner.');
    results.push((await runPreparedIndexer(run, projectRoot, onStatus, signal)).result);
  }

  return results.sort((a, b) => runs.findIndex((run) => run.id === a.id) - runs.findIndex((run) => run.id === b.id));
}

async function runIndexerPool(
  pool: readonly PreparedIndexerRun[],
  concurrency: number,
  projectRoot: string,
  onStatus: (message: string) => void,
  signal?: AbortSignal,
): Promise<IndexerRunResult[]> {
  const attempts = await runWithConcurrency(pool, Math.max(1, concurrency), (run) =>
    runPreparedIndexer(run, projectRoot, onStatus, signal),
  );
  if (concurrency <= 1) return attempts.map(({ result }) => result);

  const retryResults = new Map<string, IndexerRunResult>();
  for (const failed of attempts.filter((attempt) => attempt.result.skipped && attempt.retryable)) {
    const run = pool.find((candidate) => candidate.id === failed.result.id);
    if (!run) continue;
    onStatus(`Retrying ${run.label} indexer serially after parallel failure...`);
    throwIfSignalAborted(signal, 'Reindex cancelled by its owner.');
    retryResults.set(run.id, (await runPreparedIndexer(run, projectRoot, onStatus, signal)).result);
  }
  return attempts.map(({ result }) => retryResults.get(result.id) ?? result);
}

// scip-query: ignore-extract — this is the per-indexer backup/run/restore
// safety sequence; the default-output recovery has to remain in one visible
// try/finally block.
async function runPreparedIndexer(
  run: PreparedIndexerRun,
  projectRoot: string,
  onStatus: (message: string) => void,
  signal?: AbortSignal,
): Promise<IndexerAttempt> {
  throwIfSignalAborted(signal, 'Reindex cancelled by its owner.');
  onStatus(`Indexing ${run.label} with ${run.resolvedBinary}...`);
  rmSync(run.scipPath, { force: true });
  const defaultOutputBackup = takeDefaultOutputBackup(run.config, projectRoot, run.scipPath);
  let temporaryConfigs: OwnedTemporaryRootConfig[] = [];
  const command = [run.binary, ...run.args].join(' ');
  const startedAt = monotonicNowMs();

  try {
    temporaryConfigs = takeTemporaryConfigs(run, projectRoot);
    if (run.trustedProjectTool) {
      revalidateTrustedProjectTool(projectRoot, run.trustedProjectTool);
    }
    const spawnable = toPortableCommand(run.binary, run.args);
    const completed = await runBoundedProcess({
      command: spawnable.binary,
      args: spawnable.args,
      label: `${run.label} indexer`,
      cwd: projectRoot,
      env: run.env,
      timeoutMs: resolveIndexerTimeoutMs(),
      maxStdoutBytes: 50 * 1024 * 1024,
      maxStderrBytes: 50 * 1024 * 1024,
      signal,
    });
    if (completed.status !== 0) {
      const detail = completed.stderr.trim();
      throw new Error(`${run.resolvedBinary} exited with status ${completed.status}${detail ? `:\n${detail}` : ''}`);
    }
    moveDefaultOutputIfNeeded(run.config, projectRoot, run.scipPath);
  } catch (err) {
    if (signal?.aborted) throw abortSignalReason(signal, 'Reindex cancelled by its owner.');
    const msg = err instanceof Error ? err.message : String(err);
    const boundedMessage =
      msg.length <= INDEXER_FAILURE_DETAIL_LIMIT
        ? msg
        : `${msg.slice(0, INDEXER_FAILURE_DETAIL_LIMIT)}\n[indexer failure detail truncated]`;
    const reason = `${run.resolvedBinary} indexer failed: ${boundedMessage}`;
    const skippedReason = run.label === run.language ? reason : `${run.label}: ${reason}`;
    onStatus(`Skipping ${run.label}: ${reason}`);
    return {
      result: {
        id: run.id,
        language: run.language,
        label: run.label,
        scipPath: run.scipPath,
        outputScipPath: run.outputScipPath,
        durationMs: monotonicNowMs() - startedAt,
        command,
        ...(run.outputComposition ? { outputComposition: run.outputComposition } : {}),
        skipped: { language: run.language, reason: skippedReason },
      },
      retryable: isTransientIndexerFailure(err),
    };
  } finally {
    restoreDefaultOutputBackup(defaultOutputBackup);
    for (const config of temporaryConfigs.reverse()) releaseTemporaryRootConfig(config);
  }

  if (!existsSync(run.scipPath)) {
    const reason = `${run.resolvedBinary} indexer completed but did not produce ${run.scipPath}`;
    const skippedReason = run.label === run.language ? reason : `${run.label}: ${reason}`;
    onStatus(`Skipping ${run.label}: ${reason}`);
    return {
      result: {
        id: run.id,
        language: run.language,
        label: run.label,
        scipPath: run.scipPath,
        outputScipPath: run.outputScipPath,
        durationMs: monotonicNowMs() - startedAt,
        command,
        ...(run.outputComposition ? { outputComposition: run.outputComposition } : {}),
        skipped: { language: run.language, reason: skippedReason },
      },
      retryable: false,
    };
  }
  let outputBytes: number | undefined;
  try {
    outputBytes = statSync(run.scipPath).size;
  } catch {
    outputBytes = undefined;
  }
  return {
    result: {
      id: run.id,
      language: run.language,
      label: run.label,
      scipPath: run.scipPath,
      outputScipPath: run.outputScipPath,
      durationMs: monotonicNowMs() - startedAt,
      command,
      ...(run.outputComposition ? { outputComposition: run.outputComposition } : {}),
      outputBytes,
    },
    retryable: false,
  };
}

function resolveIndexerTimeoutMs(): number {
  const configured = Number(process.env['SCIP_QUERY_INDEXER_TIMEOUT_MS']);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : PROCESS_TIMEOUT_MS.indexer;
}

function isTransientIndexerFailure(error: unknown): boolean {
  if (error instanceof BoundedProcessError) {
    return error.kind === 'spawn' && isTransientErrorCode(error.cause);
  }
  return isTransientErrorCode(error);
}

function isTransientErrorCode(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EAGAIN' || code === 'ENOMEM' || code === 'EMFILE' || code === 'ENFILE' || code === 'ETXTBSY';
}

// scip-query: ignore-twin — indexer scheduling and Rust request scheduling have different failure policy.
