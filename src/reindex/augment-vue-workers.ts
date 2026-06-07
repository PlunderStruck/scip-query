import { readFileSync, rmSync, statSync, mkdtempSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { VueReferenceComputationResult, VueReferenceTask } from './augment-vue-contracts.js';

// scip-query: ignore-wrapper — named Vue worker dispatch policy; callers
// should not duplicate the file-count threshold plus worker-count check.
export function shouldUseVueWorkers(vueFiles: readonly string[]): boolean {
  return vueFiles.length >= 8 && resolveVueWorkerCount(vueFiles.length) > 1;
}

export function awaitVueReferenceWorkers(opts: {
  projectRoot: string;
  dbPath: string;
  tsconfig: string;
  vueFiles: string[];
}): VueReferenceComputationResult {
  const workerCount = resolveVueWorkerCount(opts.vueFiles.length);
  const tasks = createVueReferenceTasks(opts.vueFiles);
  const partitions = partitionTasks(tasks, workerCount);
  const workerUrl = new URL('./augment-vue-worker.js', import.meta.url);
  const resultDir = mkdtempSync(join(tmpdir(), 'scip-query-vue-workers-'));
  const sharedBuffer = new SharedArrayBuffer(4);
  const signal = new Int32Array(sharedBuffer);
  const timeoutMs = resolveVueWorkerTimeoutMs();
  const startedAt = Date.now();

  try {
    for (let index = 0; index < partitions.length; index++) {
      new Worker(workerUrl, {
        workerData: {
          projectRoot: opts.projectRoot,
          dbPath: opts.dbPath,
          tsconfig: opts.tsconfig,
          tasks: partitions[index],
          resultPath: join(resultDir, `${index}.json`),
          sharedBuffer,
        },
      });
    }

    while (Atomics.load(signal, 0) < partitions.length) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Vue reference workers timed out after ${(timeoutMs / 1000).toFixed(0)}s`);
      }
      Atomics.wait(signal, 0, Atomics.load(signal, 0), 100);
    }

    const results = partitions.map((_, index) => {
      const raw = JSON.parse(readFileSync(join(resultDir, `${index}.json`), 'utf-8')) as
        | { ok: true; result: VueReferenceComputationResult }
        | { ok: false; error: string };
      if (!raw.ok) {
        throw new Error(`Vue reference worker failed: ${raw.error}`);
      }
      return raw.result;
    });

    return {
      occurrences: results.flatMap((result) => result.occurrences),
      skippedReferences: results.reduce((sum, result) => sum + result.skippedReferences, 0),
    };
  } finally {
    rmSync(resultDir, { recursive: true, force: true });
  }
}

function resolveVueWorkerCount(fileCount: number): number {
  const configured = Number(process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'] ?? 0);
  const maxWorkers = Number.isFinite(configured) && configured > 0
    ? configured
    : Math.min(8, Math.max(1, cpus().length - 1));
  return Math.max(1, Math.min(fileCount, maxWorkers));
}

function resolveVueWorkerTimeoutMs(): number {
  const configured = Number(process.env['SCIP_QUERY_AUGMENT_VUE_WORKER_TIMEOUT_MS'] ?? 0);
  return Number.isFinite(configured) && configured > 0 ? configured : 300_000;
}

function createVueReferenceTasks(files: readonly string[]): VueReferenceTask[] {
  const targetBytes = resolveVueShardBytes();
  const tasks: VueReferenceTask[] = [];
  for (const fileName of files) {
    const weight = fileWeight(fileName);
    const shardCount = Math.max(1, Math.ceil(weight / targetBytes));
    for (let shard = 0; shard < shardCount; shard++) {
      tasks.push({
        fileName,
        startOffset: Math.floor((weight * shard) / shardCount),
        endOffset: shard === shardCount - 1
          ? Number.POSITIVE_INFINITY
          : Math.floor((weight * (shard + 1)) / shardCount),
        countFileSkip: shard === 0,
      });
    }
  }
  return tasks;
}

function resolveVueShardBytes(): number {
  return Number.POSITIVE_INFINITY;
}

function partitionTasks(tasks: readonly VueReferenceTask[], workerCount: number): VueReferenceTask[][] {
  const partitions = Array.from({ length: workerCount }, () => ({
    tasks: [] as VueReferenceTask[],
    weight: 0,
  }));
  const weightedTasks = tasks
    .map((task) => ({ task, weight: taskWeight(task) }))
    .sort((a, b) => b.weight - a.weight);

  for (const entry of weightedTasks) {
    const partition = partitions.reduce((lightest, current) => (
      current.weight < lightest.weight ? current : lightest
    ));
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
