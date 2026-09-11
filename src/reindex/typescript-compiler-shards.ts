import { readdirSync, rmSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  isTypeScriptCompilerShardConfigPath,
  typescriptCompilerShardConfigFileName,
} from '../platform/typescript-projects.js';

/**
 * A compiler shard is a document-emission subset of one complete TypeScript
 * compiler project. Each child retains all roots for type resolution.
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
 * Target emitted documents per shard. Compiler context remains complete;
 * the existing child heap limit applies independently of this work bound.
 */
export const TYPESCRIPT_COMPILER_SHARD_TARGET_FILES = 2048;

/**
 * Estimated peak RSS of one shard child, used only to gate how many shards
 * may run concurrently on this machine. Deliberately above the measured
 * ~5 GB peak so parallelism errs toward fewer simultaneous children.
 */
const SHARD_ESTIMATED_PEAK_BYTES = 6 * 1024 ** 3;
// Four complete compiler contexts reached 23.4 GiB on the LaunchPoint cold
// benchmark. Two halve that peak; an explicit concurrency override remains
// available when a caller chooses the higher-memory throughput tradeoff.
const SHARD_MAX_PARALLELISM = 2;

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
 * Deterministic partition of the sorted unique input list into `shardCount`
 * contiguous shards of near-equal cumulative weight. Sorting by path keeps
 * each emission subset directory-coherent; weighting by source bytes
 * approximates document-emission work, since wall time is the
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
    return partitionUnweightedCompilerInputs(sorted, shardCount);
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
      shouldFinishCompilerShard(remainingShards, remainingFiles, cumulative, totalWeight, shards.length, shardCount)
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
      // Preserve the entire compiler project, including ambient declarations.
      // The shared compiler adapter limits emission after constructing the program.
      const content = `${JSON.stringify(
        {
          extends: `./${opts.rootConfigPath}`,
          compilerOptions: { incremental: false },
          scipQueryEmissionFiles: inputPaths,
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

function partitionUnweightedCompilerInputs(sorted: string[], shardCount: number): string[][] {
  return sorted.length <= shardCount && shardCount > 1
    ? sorted.map((path) => [path])
    : sorted.length > 0
      ? [sorted]
      : [];
}

function shouldFinishCompilerShard(
  remainingShards: number,
  remainingFiles: number,
  cumulative: number,
  totalWeight: number,
  completedShards: number,
  shardCount: number,
): boolean {
  return (
    remainingShards > 0 &&
    remainingFiles >= remainingShards &&
    (cumulative >= (totalWeight * (completedShards + 1)) / shardCount || remainingFiles === remainingShards)
  );
}
