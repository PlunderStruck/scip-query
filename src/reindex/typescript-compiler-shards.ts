import { readdirSync, rmSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  isTypeScriptCompilerShardConfigPath,
  typescriptCompilerShardConfigFileName,
} from '../platform/typescript-projects.js';

/**
 * A compiler shard is one ordinary TypeScript project config whose explicit
 * input list is small enough to keep one scip-typescript Program bounded.
 *
 * Shard configs are written inside the project root (not the cache directory)
 * because TypeScript resolves automatic `@types` inclusion by walking up from
 * the directory that contains the config file; a config outside the project
 * silently drops ambient typings and degrades emitted occurrences.
 */
export interface TypeScriptCompilerShard {
  configPath: string;
  content: string;
  inputPaths: readonly string[];
}

/**
 * Target declared inputs per shard. Measured on a 7.7k-file Next.js repo, a
 * 2,048-file shard peaks near 5 GB RSS inside the default 8 GB child heap,
 * while the monolithic program exceeds the heap entirely.
 */
export const TYPESCRIPT_COMPILER_SHARD_TARGET_FILES = 2048;

/**
 * Estimated peak RSS of one shard child, used only to gate how many shards
 * may run concurrently on this machine. Deliberately above the measured
 * ~5 GB peak so parallelism errs toward fewer simultaneous children.
 */
const SHARD_ESTIMATED_PEAK_BYTES = 6 * 1024 ** 3;
const SHARD_MAX_PARALLELISM = 4;

export function typescriptCompilerShardTargetFiles(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['SCIP_QUERY_TS_COMPILER_SHARD_FILES'] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : TYPESCRIPT_COMPILER_SHARD_TARGET_FILES;
}

/**
 * Shard only when the monolithic program would meaningfully exceed one shard's
 * bounded footprint; below this, a single program is faster because shards
 * re-parse their shared dependency closure.
 */
export function shouldShardTypeScriptCompilerInputs(inputCount: number, targetFiles: number): boolean {
  return inputCount > Math.floor(targetFiles * 1.5);
}

/**
 * A shard may exceed the target by this factor when doing so saves a whole
 * execution wave; the measured per-file memory slope leaves that much
 * headroom inside the default child heap.
 */
const SHARD_HARD_MAX_FACTOR = 1.25;

/**
 * Wave-optimal shard count: shard wall time is the slowest wave, so a count
 * that divides evenly into the machine's parallelism beats one that leaves a
 * ragged final wave. A count below the target-derived base is allowed only
 * while per-shard inputs stay under the hard cap.
 */
export function typescriptCompilerShardCount(inputCount: number, targetFiles: number, parallelism: number): number {
  if (!Number.isSafeInteger(targetFiles) || targetFiles < 1) {
    throw new Error(`TypeScript compiler shard targetFiles must be a positive safe integer; received ${targetFiles}.`);
  }
  const base = Math.max(1, Math.ceil(inputCount / targetFiles));
  if (base <= 1 || parallelism <= 1) return base;
  const hardMax = Math.floor(targetFiles * SHARD_HARD_MAX_FACTOR);
  const candidates = new Set([
    base,
    parallelism * Math.floor(base / parallelism),
    parallelism * Math.ceil(base / parallelism),
  ]);
  // Wall time ≈ waves × per-shard duration, and per-shard duration grows with
  // per-shard inputs, so rank by waves × per-shard size; fewer shards win
  // ties because every extra shard re-parses the shared dependency closure.
  const makespan = (count: number): number => Math.ceil(count / parallelism) * Math.ceil(inputCount / count);
  let best = base;
  for (const candidate of candidates) {
    if (candidate < 1 || Math.ceil(inputCount / candidate) > hardMax) continue;
    if (makespan(candidate) < makespan(best) || (makespan(candidate) === makespan(best) && candidate < best)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Deterministic partition of the sorted unique input list into `shardCount`
 * contiguous shards of near-equal cumulative weight. Sorting by path keeps
 * each shard directory-coherent, which keeps its parsed dependency closure
 * (and therefore its memory floor) well below the whole program's; weighting
 * by source bytes keeps shard durations balanced, since wall time is the
 * slowest shard of a wave.
 */
export function partitionTypeScriptCompilerInputsIntoShards(
  inputPaths: readonly string[],
  shardCount: number,
  weightOf: (path: string) => number = () => 1,
): string[][] {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`TypeScript compiler shard count must be a positive safe integer; received ${shardCount}.`);
  }
  const sorted = [...new Set(inputPaths)].sort((left, right) => left.localeCompare(right));
  if (shardCount === 1 || sorted.length <= shardCount) {
    return sorted.length <= shardCount && shardCount > 1
      ? sorted.map((path) => [path])
      : sorted.length > 0
        ? [sorted]
        : [];
  }
  const weights = sorted.map((path) => Math.max(1, weightOf(path)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const shards: string[][] = [];
  let current: string[] = [];
  let cumulative = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    current.push(sorted[index]!);
    cumulative += weights[index]!;
    const remainingShards = shardCount - shards.length - 1;
    const remainingFiles = sorted.length - index - 1;
    if (
      remainingShards > 0 &&
      remainingFiles >= remainingShards &&
      (cumulative >= (totalWeight * (shards.length + 1)) / shardCount || remainingFiles === remainingShards)
    ) {
      shards.push(current);
      current = [];
    }
  }
  if (current.length > 0) shards.push(current);
  return shards;
}

/** Target-derived partition used when no weights or parallelism are known. */
export function partitionTypeScriptCompilerInputs(inputPaths: readonly string[], targetFiles: number): string[][] {
  if (!Number.isSafeInteger(targetFiles) || targetFiles < 1) {
    throw new Error(`TypeScript compiler shard targetFiles must be a positive safe integer; received ${targetFiles}.`);
  }
  const uniqueCount = new Set(inputPaths).size;
  return partitionTypeScriptCompilerInputsIntoShards(inputPaths, Math.max(1, Math.ceil(uniqueCount / targetFiles)));
}

export function createTypeScriptCompilerShards(opts: {
  projectRoot: string;
  rootConfigPath: string;
  inputPaths: readonly string[];
  targetFiles?: number;
  shardCount?: number;
  weightOf?: (path: string) => number;
}): TypeScriptCompilerShard[] {
  const targetFiles = opts.targetFiles ?? typescriptCompilerShardTargetFiles();
  const shardCount =
    opts.shardCount ?? Math.max(1, Math.ceil(new Set(opts.inputPaths).size / Math.max(1, targetFiles)));
  return partitionTypeScriptCompilerInputsIntoShards(opts.inputPaths, shardCount, opts.weightOf).map(
    (inputPaths, index) => {
      const configPath = join(opts.projectRoot, typescriptCompilerShardConfigFileName(index));
      // `files` alone does not bound the program: `include` inherited through
      // `extends` is unioned with `files`, so both `include` and `exclude` must
      // be overridden explicitly or every shard silently compiles (and emits)
      // the whole repository again.
      const content = `${JSON.stringify(
        {
          extends: `./${opts.rootConfigPath}`,
          compilerOptions: { incremental: false },
          files: inputPaths.map((relativePath) => `./${relativePath}`),
          include: [],
          exclude: [],
        },
        null,
        2,
      )}\n`;
      return { configPath, content, inputPaths };
    },
  );
}

/**
 * How many shard children may run at once on this machine, independent of how
 * many shards exist. Each child holds an independent compiler program, so
 * parallelism is gated by physical memory, not just CPUs.
 */
export function typescriptCompilerShardParallelism(
  env: NodeJS.ProcessEnv = process.env,
  machine: { totalmemBytes: number; cpuCount: number } = { totalmemBytes: totalmem(), cpuCount: cpus().length },
): number {
  const configured = Number.parseInt(env['SCIP_QUERY_TS_COMPILER_SHARD_CONCURRENCY'] ?? '', 10);
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  const byMemory = Math.floor(machine.totalmemBytes / 2 / SHARD_ESTIMATED_PEAK_BYTES);
  const byCpu = Math.floor(machine.cpuCount / 2);
  return Math.max(1, Math.min(SHARD_MAX_PARALLELISM, byMemory, byCpu));
}

/** Concurrency for an already-planned shard set. */
export function typescriptCompilerShardConcurrency(
  shardCount: number,
  env: NodeJS.ProcessEnv = process.env,
  machine: { totalmemBytes: number; cpuCount: number } = { totalmemBytes: totalmem(), cpuCount: cpus().length },
): number {
  if (shardCount <= 1) return 1;
  return Math.min(shardCount, typescriptCompilerShardParallelism(env, machine));
}

/**
 * Removes shard configs left behind by an interrupted earlier run. Only
 * top-level files matching the exact owned pattern are touched.
 */
export function removeStaleTypeScriptCompilerShardConfigs(projectRoot: string): void {
  let entries: string[];
  try {
    entries = readdirSync(projectRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!isTypeScriptCompilerShardConfigPath(name)) continue;
    try {
      rmSync(join(projectRoot, name));
    } catch {
      // A vanished or unremovable stale config cannot block indexing; the
      // runner replaces owned shard configs when it creates them.
    }
  }
}
