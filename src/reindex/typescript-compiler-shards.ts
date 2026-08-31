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
 * Deterministic, balanced partition of the sorted unique input list. Sorting
 * by path keeps each shard directory-coherent, which keeps its parsed
 * dependency closure (and therefore its memory floor) well below the whole
 * program's.
 */
export function partitionTypeScriptCompilerInputs(inputPaths: readonly string[], targetFiles: number): string[][] {
  if (!Number.isSafeInteger(targetFiles) || targetFiles < 1) {
    throw new Error(`TypeScript compiler shard targetFiles must be a positive safe integer; received ${targetFiles}.`);
  }
  const sorted = [...new Set(inputPaths)].sort((left, right) => left.localeCompare(right));
  const shardCount = Math.max(1, Math.ceil(sorted.length / targetFiles));
  const shardSize = Math.ceil(sorted.length / shardCount);
  const shards: string[][] = [];
  for (let offset = 0; offset < sorted.length; offset += shardSize) {
    shards.push(sorted.slice(offset, offset + shardSize));
  }
  return shards;
}

export function createTypeScriptCompilerShards(opts: {
  projectRoot: string;
  rootConfigPath: string;
  inputPaths: readonly string[];
  targetFiles?: number;
}): TypeScriptCompilerShard[] {
  const targetFiles = opts.targetFiles ?? typescriptCompilerShardTargetFiles();
  return partitionTypeScriptCompilerInputs(opts.inputPaths, targetFiles).map((inputPaths, index) => {
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
  });
}

/**
 * How many shard children may run at once on this machine. Each child holds
 * an independent compiler program, so parallelism is gated by physical
 * memory, not just CPUs.
 */
export function typescriptCompilerShardConcurrency(
  shardCount: number,
  env: NodeJS.ProcessEnv = process.env,
  machine: { totalmemBytes: number; cpuCount: number } = { totalmemBytes: totalmem(), cpuCount: cpus().length },
): number {
  if (shardCount <= 1) return 1;
  const configured = Number.parseInt(env['SCIP_QUERY_TS_COMPILER_SHARD_CONCURRENCY'] ?? '', 10);
  if (Number.isSafeInteger(configured) && configured > 0) return Math.min(shardCount, configured);
  const byMemory = Math.floor(machine.totalmemBytes / 2 / SHARD_ESTIMATED_PEAK_BYTES);
  const byCpu = Math.floor(machine.cpuCount / 2);
  return Math.max(1, Math.min(shardCount, SHARD_MAX_PARALLELISM, byMemory, byCpu));
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
