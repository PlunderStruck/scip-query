import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { emptySkippedReferenceDiagnostics, mergeSkippedReferenceDiagnostics } from './augment-vue-contracts.js';
import type { VueReferenceComputationResult, VueReferenceTask } from './augment-vue-contracts.js';
import { readTextFileWithinLimit } from '../../platform/bounded-file.js';

const DEFAULT_VUE_WORKER_TIMEOUT_MS = 300_000;
const DEFAULT_VUE_WORKER_RESULT_MAX_BYTES = 64 * 1024 * 1024;

interface IdentifiedVueReferenceTask extends VueReferenceTask {
  taskId: string;
}

export interface VueWorkerData {
  projectRoot: string;
  dbPath: string;
  tsconfig: string;
  tasks: IdentifiedVueReferenceTask[];
  resultPath: string;
  runId: string;
  workerId: number;
  taskIds: string[];
}

export interface VueWorkerRuntimePort {
  createResultDirectory(): string;
  spawn(workerUrl: URL, workerData: VueWorkerData): Worker;
  resultSize(path: string): number;
  readResult(path: string): string;
  removeResultDirectory(path: string): void;
}

const NODE_VUE_WORKER_RUNTIME: VueWorkerRuntimePort = {
  createResultDirectory: () => mkdtempSync(join(tmpdir(), 'scip-query-vue-workers-')),
  spawn: (workerUrl, workerData) => new Worker(workerUrl, { workerData }),
  resultSize: (path) => statSync(path).size,
  readResult: (path) =>
    readTextFileWithinLimit(path, {
      maxBytes: DEFAULT_VUE_WORKER_RESULT_MAX_BYTES,
      inputKind: 'Vue worker result',
    }),
  removeResultDirectory: (path) => rmSync(path, { recursive: true, force: true }),
};

// scip-query: ignore-wrapper — named Vue worker dispatch policy; callers
// should not duplicate the file-count threshold plus worker-count check.
export function shouldUseVueWorkers(vueFiles: readonly string[]): boolean {
  return vueFiles.length >= 8 && resolveVueWorkerCount(vueFiles.length) > 1;
}

interface OwnedVueWorker {
  workerId: number;
  taskIds: string[];
  resultPath: string;
  handle: Worker;
  completion: Promise<void>;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; worker ownership,
// terminal-state collection, result authentication, and cleanup form one lifecycle.
export async function awaitVueReferenceWorkers(
  opts: {
    projectRoot: string;
    dbPath: string;
    tsconfig: string;
    vueFiles: string[];
    timeoutMs?: number;
    maxResultBytes?: number;
  },
  runtime: VueWorkerRuntimePort = NODE_VUE_WORKER_RUNTIME,
): Promise<VueReferenceComputationResult> {
  const workerCount = resolveVueWorkerCount(opts.vueFiles.length);
  const tasks = createVueReferenceTasks(opts.vueFiles);
  const partitions = partitionTasks(tasks, workerCount);
  const workerUrl = new URL('./augment-vue-worker.js', import.meta.url);
  const timeoutMs = opts.timeoutMs ?? resolveVueWorkerTimeoutMs();
  const maxResultBytes = opts.maxResultBytes ?? resolveVueWorkerResultMaxBytes();
  validateWorkerBudget('timeoutMs', timeoutMs);
  validateWorkerBudget('maxResultBytes', maxResultBytes);
  const runId = randomUUID();
  const resultDir = runtime.createResultDirectory();
  const workers: OwnedVueWorker[] = [];
  let operationError: unknown;
  let cleanupError: AggregateError | undefined;
  let result: VueReferenceComputationResult | undefined;

  try {
    for (let index = 0; index < partitions.length; index++) {
      const workerId = index;
      const workerTasks = partitions[index] ?? [];
      const taskIds = workerTasks.map((task) => task.taskId);
      const resultPath = join(resultDir, `${workerId}.json`);
      const handle = runtime.spawn(workerUrl, {
        projectRoot: opts.projectRoot,
        dbPath: opts.dbPath,
        tsconfig: opts.tsconfig,
        tasks: workerTasks,
        resultPath,
        runId,
        workerId,
        taskIds,
      });
      workers.push({
        workerId,
        taskIds,
        resultPath,
        handle,
        completion: workerCompletion(handle, workerId),
      });
    }

    await waitForWorkerCompletion(workers, timeoutMs);

    const results = workers
      .sort((left, right) => left.workerId - right.workerId)
      .map((worker) => readWorkerResult(worker, runId, maxResultBytes, runtime));

    result = {
      occurrences: results.flatMap((result) => result.occurrences),
      ...emptySkippedReferenceDiagnostics(),
    };
    for (const workerResult of results) mergeSkippedReferenceDiagnostics(result, workerResult);
  } catch (error) {
    operationError = error;
  } finally {
    const terminationFailures = await terminateOwnedWorkers(workers);
    if (terminationFailures.length === 0) {
      try {
        runtime.removeResultDirectory(resultDir);
      } catch (error) {
        terminationFailures.push(error);
      }
    }
    if (terminationFailures.length > 0) {
      const failures = operationError === undefined ? terminationFailures : [operationError, ...terminationFailures];
      cleanupError = new AggregateError(failures, `Vue worker cleanup failed: ${errorMessage(failures[0])}`);
    }
  }

  if (cleanupError) throw cleanupError;
  if (operationError !== undefined) throw operationError;
  if (!result) throw new Error('Vue workers completed without producing a merged result.');
  return result;
}

function workerCompletion(handle: Worker, workerId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      handle.off('error', onError);
      handle.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => {
      finish(new Error(`Vue reference worker ${workerId} failed: ${error.message}`, { cause: error }));
    };
    const onExit = (code: number): void => {
      finish(code === 0 ? undefined : new Error(`Vue reference worker ${workerId} exited with code ${code}`));
    };
    handle.once('error', onError);
    handle.once('exit', onExit);
  });
}

async function waitForWorkerCompletion(workers: readonly OwnedVueWorker[], timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(workers.map((worker) => worker.completion)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Vue reference workers timed out after ${(timeoutMs / 1000).toFixed(3)}s`)),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function terminateOwnedWorkers(workers: readonly OwnedVueWorker[]): Promise<unknown[]> {
  const settlements = await Promise.allSettled(workers.map(async (worker) => worker.handle.terminate()));
  return settlements.flatMap((settlement) => (settlement.status === 'rejected' ? [settlement.reason] : []));
}

function readWorkerResult(
  worker: Pick<OwnedVueWorker, 'workerId' | 'taskIds' | 'resultPath'>,
  runId: string,
  maxResultBytes: number,
  runtime: VueWorkerRuntimePort,
): VueReferenceComputationResult {
  const size = runtime.resultSize(worker.resultPath);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxResultBytes) {
    throw new Error(
      `Vue reference worker ${worker.workerId} result is ${size} bytes; limit is ${maxResultBytes} bytes`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(runtime.readResult(worker.resultPath));
  } catch (error) {
    throw new Error(`Vue reference worker ${worker.workerId} produced invalid JSON`, { cause: error });
  }
  if (!isRecord(raw) || raw['version'] !== 1 || raw['runId'] !== runId || raw['workerId'] !== worker.workerId) {
    throw new Error(`Vue reference worker ${worker.workerId} result identity does not match its assignment`);
  }
  if (!sameStringArray(raw['taskIds'], worker.taskIds)) {
    throw new Error(`Vue reference worker ${worker.workerId} result task identities do not match its assignment`);
  }
  if (raw['ok'] === false) {
    if (typeof raw['error'] !== 'string') {
      throw new Error(`Vue reference worker ${worker.workerId} failure payload is malformed`);
    }
    throw new Error(`Vue reference worker ${worker.workerId} failed: ${raw['error']}`);
  }
  if (raw['ok'] !== true || !isVueReferenceComputationResult(raw['result'])) {
    throw new Error(`Vue reference worker ${worker.workerId} success payload is malformed`);
  }
  return raw['result'];
}

function isVueReferenceComputationResult(value: unknown): value is VueReferenceComputationResult {
  if (!isRecord(value) || !Array.isArray(value['occurrences'])) return false;
  if (!value['occurrences'].every(isResolvedOccurrence)) return false;
  if (!isNonNegativeInteger(value['skippedReferences'])) return false;
  if (!isRecord(value['skippedReferenceReasons'])) return false;
  for (const reason of [
    'missing-source-file',
    'missing-service-script',
    'no-definition',
    'same-file-definition',
    'unindexed-definition',
  ]) {
    if (!isNonNegativeInteger(value['skippedReferenceReasons'][reason])) return false;
  }
  return Array.isArray(value['skippedReferenceSamples']) && value['skippedReferenceSamples'].every(isSkippedSample);
}

function isResolvedOccurrence(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['sourceFile'] === 'string' &&
    isNonNegativeInteger(value['sourceLine']) &&
    isNonNegativeInteger(value['sourceStartChar']) &&
    isNonNegativeInteger(value['sourceEndChar']) &&
    typeof value['sourceToken'] === 'string' &&
    typeof value['definitionFile'] === 'string' &&
    isNonNegativeInteger(value['symbolId'])
  );
}

function isSkippedSample(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['sourceFile'] === 'string' &&
    isNonNegativeInteger(value['sourceLine']) &&
    isNonNegativeInteger(value['sourceStartChar']) &&
    isNonNegativeInteger(value['sourceEndChar']) &&
    typeof value['token'] === 'string' &&
    isSkippedReason(value['reason'])
  );
}

function isSkippedReason(value: unknown): boolean {
  return (
    value === 'missing-source-file' ||
    value === 'missing-service-script' ||
    value === 'no-definition' ||
    value === 'same-file-definition' ||
    value === 'unindexed-definition'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// scip-query: ignore-twin — this guard belongs to the Vue worker wire decoder;
// storage payload decoders must evolve with their own schema boundary.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => typeof entry === 'string' && entry === expected[index])
  );
}

function validateWorkerBudget(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveVueWorkerCount(fileCount: number): number {
  const configured = Number(process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'] ?? 0);
  // Every worker constructs a full TypeScript/Volar project. Keep the reliable
  // single-context path as the default; parallelism remains an explicit opt-in
  // for projects that have calibrated its memory and worker-exit behavior.
  const maxWorkers = Number.isFinite(configured) && configured > 0 ? configured : 1;
  return Math.max(1, Math.min(fileCount, maxWorkers));
}

function resolveVueWorkerTimeoutMs(): number {
  const configured = Number(process.env['SCIP_QUERY_AUGMENT_VUE_WORKER_TIMEOUT_MS'] ?? 0);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_VUE_WORKER_TIMEOUT_MS;
}

function resolveVueWorkerResultMaxBytes(): number {
  const configured = Number(process.env['SCIP_QUERY_AUGMENT_VUE_WORKER_RESULT_MAX_BYTES'] ?? 0);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_VUE_WORKER_RESULT_MAX_BYTES;
}

function createVueReferenceTasks(files: readonly string[]): IdentifiedVueReferenceTask[] {
  const targetBytes = resolveVueShardBytes();
  const tasks: IdentifiedVueReferenceTask[] = [];
  for (const fileName of files) {
    const weight = fileWeight(fileName);
    const shardCount = Math.max(1, Math.ceil(weight / targetBytes));
    for (let shard = 0; shard < shardCount; shard++) {
      tasks.push({
        taskId: `${tasks.length}:${fileName}:${shard}`,
        fileName,
        startOffset: Math.floor((weight * shard) / shardCount),
        endOffset:
          shard === shardCount - 1 ? Number.POSITIVE_INFINITY : Math.floor((weight * (shard + 1)) / shardCount),
        countFileSkip: shard === 0,
      });
    }
  }
  return tasks;
}

function resolveVueShardBytes(): number {
  return Number.POSITIVE_INFINITY;
}

function partitionTasks(
  tasks: readonly IdentifiedVueReferenceTask[],
  workerCount: number,
): IdentifiedVueReferenceTask[][] {
  const partitions = Array.from({ length: workerCount }, () => ({
    tasks: [] as IdentifiedVueReferenceTask[],
    weight: 0,
  }));
  const weightedTasks = tasks.map((task) => ({ task, weight: taskWeight(task) })).sort((a, b) => b.weight - a.weight);

  for (const entry of weightedTasks) {
    const partition = partitions.reduce((lightest, current) => (current.weight < lightest.weight ? current : lightest));
    partition.tasks.push(entry.task);
    partition.weight += entry.weight;
  }
  return partitions.map((partition) => partition.tasks).filter((partition) => partition.length > 0);
}

function taskWeight(task: VueReferenceTask): number {
  if (!Number.isFinite(task.endOffset)) {
    return Math.max(1, fileWeight(task.fileName) - task.startOffset);
  }
  return Math.max(1, task.endOffset - task.startOffset);
}

function fileWeight(fileName: string): number {
  try {
    return statSync(fileName).size;
  } catch {
    return 1;
  }
}
