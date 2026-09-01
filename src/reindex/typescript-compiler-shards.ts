import { readdirSync, rmSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { readSourceArtifactText } from '../platform/bounded-file.js';
import {
  isTypeScriptCompilerShardConfigPath,
  typescriptCompilerShardConfigFileName,
} from '../platform/typescript-projects.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';

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
 * One measured shard from a previous run: the contiguous path range it
 * covered, its raw source-byte weight at partition time, and its wall time.
 * Ranges follow the same locale sort the partitioner uses, so a later run can
 * map any input path to the range that contained it.
 */
export interface TypeScriptShardCostSample {
  firstPath: string;
  lastPath: string;
  totalBytes: number;
  durationMs: number;
}

export interface TypeScriptShardCostModel {
  version: 1;
  samples: TypeScriptShardCostSample[];
}

export const TYPESCRIPT_SHARD_COST_MODEL_FILE = 'typescript-shard-costs.json';

/**
 * A measured rate may only move a file's weight this far from the median
 * rate, so one contended or mismeasured run cannot capsize the partition.
 */
const SHARD_COST_RATE_CLAMP = 4;

export function readTypeScriptShardCostModel(cacheDir: string): TypeScriptShardCostModel | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readSourceArtifactText(join(cacheDir, TYPESCRIPT_SHARD_COST_MODEL_FILE), 'shard cost model'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) return null;
  const samples = (raw as { samples?: unknown }).samples;
  if (!Array.isArray(samples)) return null;
  const valid = samples.every(
    (sample: unknown) =>
      typeof sample === 'object' &&
      sample !== null &&
      typeof (sample as TypeScriptShardCostSample).firstPath === 'string' &&
      typeof (sample as TypeScriptShardCostSample).lastPath === 'string' &&
      Number.isFinite((sample as TypeScriptShardCostSample).totalBytes) &&
      (sample as TypeScriptShardCostSample).totalBytes > 0 &&
      Number.isFinite((sample as TypeScriptShardCostSample).durationMs) &&
      (sample as TypeScriptShardCostSample).durationMs > 0,
  );
  return valid ? { version: 1, samples: samples as TypeScriptShardCostSample[] } : null;
}

export function writeTypeScriptShardCostModel(cacheDir: string, model: TypeScriptShardCostModel): void {
  writeJsonAtomic(join(cacheDir, TYPESCRIPT_SHARD_COST_MODEL_FILE), model);
}

/**
 * Turns measured shard costs into a byte-weight adjuster for the next
 * partition. Byte-balanced shards still finish up to ~40% apart because
 * compile cost tracks type-check density, not bytes; scaling each file's byte
 * weight by its previous range's measured ms/byte moves the boundaries toward
 * equal duration instead of equal bytes. Files outside every measured range
 * (new files, or a reshaped repository) keep their plain byte weight.
 */
export function typescriptShardCostWeightAdjuster(
  model: TypeScriptShardCostModel | null,
): (path: string, byteWeight: number) => number {
  const measured = (model?.samples ?? []).filter((sample) => sample.totalBytes > 0 && sample.durationMs > 0);
  if (measured.length < 2) return (_path, byteWeight) => byteWeight;
  const rates = measured.map((sample) => sample.durationMs / sample.totalBytes).sort((left, right) => left - right);
  const median = rates[Math.floor(rates.length / 2)]!;
  if (!(median > 0)) return (_path, byteWeight) => byteWeight;
  const samples = [...measured].sort((left, right) => left.firstPath.localeCompare(right.firstPath));
  return (path, byteWeight) => {
    for (const sample of samples) {
      if (path.localeCompare(sample.firstPath) < 0) break;
      if (path.localeCompare(sample.lastPath) > 0) continue;
      const relative = sample.durationMs / sample.totalBytes / median;
      return byteWeight * Math.min(SHARD_COST_RATE_CLAMP, Math.max(1 / SHARD_COST_RATE_CLAMP, relative));
    }
    return byteWeight;
  };
}

/**
 * Builds the cost model for the shards that just ran. Weights are the shards'
 * raw byte weights (not the cost-adjusted partition weights), so recorded
 * rates stay in ms per source byte across runs.
 */
export function buildTypeScriptShardCostModel(
  shards: readonly { inputPaths: readonly string[]; durationMs: number }[],
  byteWeightOf: (path: string) => number,
): TypeScriptShardCostModel | null {
  const samples: TypeScriptShardCostSample[] = [];
  for (const shard of shards) {
    const firstPath = shard.inputPaths[0];
    const lastPath = shard.inputPaths[shard.inputPaths.length - 1];
    if (firstPath === undefined || lastPath === undefined || !(shard.durationMs > 0)) return null;
    const totalBytes = shard.inputPaths.reduce((sum, path) => sum + Math.max(1, byteWeightOf(path)), 0);
    samples.push({ firstPath, lastPath, totalBytes, durationMs: shard.durationMs });
  }
  return samples.length > 0 ? { version: 1, samples } : null;
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
