import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTypeScriptCompilerShards,
  partitionTypeScriptCompilerInputs,
  removeStaleTypeScriptCompilerShardConfigs,
  shouldShardTypeScriptCompilerInputs,
  typescriptCompilerShardConcurrency,
  typescriptCompilerShardTargetFiles,
  TYPESCRIPT_COMPILER_SHARD_TARGET_FILES,
} from '../../src/reindex/typescript-compiler-shards.js';
import {
  isTypeScriptCompilerShardConfigPath,
  typescriptCompilerShardConfigFileName,
} from '../../src/platform/typescript-projects.js';

describe('bounded TypeScript compiler shards', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('partitions every unique input deterministically into balanced shards', () => {
    const inputs = ['src/d.ts', 'src/a.ts', 'src/c.ts', 'src/b.ts', 'src/a.ts', 'src/e.ts'];

    expect(partitionTypeScriptCompilerInputs(inputs, 2)).toEqual([
      ['src/a.ts', 'src/b.ts'],
      ['src/c.ts', 'src/d.ts'],
      ['src/e.ts'],
    ]);
    // Balancing avoids a tiny remainder shard: 5 unique inputs at target 4 become 3+2, not 4+1.
    expect(partitionTypeScriptCompilerInputs(inputs, 4).map((shard) => shard.length)).toEqual([3, 2]);
  });

  it('rejects an invalid bound instead of silently creating an unbounded project', () => {
    expect(() => partitionTypeScriptCompilerInputs(['src/a.ts'], 0)).toThrow('positive safe integer');
  });

  it('creates in-project configs that override the inherited include contract', () => {
    const shards = createTypeScriptCompilerShards({
      projectRoot: '/repo',
      rootConfigPath: 'tsconfig.json',
      inputPaths: ['src/b.ts', 'src/a.ts', 'src/c.ts'],
      targetFiles: 2,
    });

    expect(shards.map((shard) => shard.configPath)).toEqual([
      '/repo/.scipquery-compiler-shard-0.tsconfig.json',
      '/repo/.scipquery-compiler-shard-1.tsconfig.json',
    ]);
    expect(shards.flatMap((shard) => shard.inputPaths)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    // `files` alone does not bound the program: the root config's `include`
    // is inherited through `extends` and unioned with `files`, so a shard
    // config missing these overrides silently compiles the whole repository.
    expect(JSON.parse(shards[0]!.content)).toEqual({
      extends: './tsconfig.json',
      compilerOptions: { incremental: false },
      files: ['./src/a.ts', './src/b.ts'],
      include: [],
      exclude: [],
    });
  });

  it('shards only above the threshold where a monolithic program stops being cheaper', () => {
    const target = TYPESCRIPT_COMPILER_SHARD_TARGET_FILES;
    expect(shouldShardTypeScriptCompilerInputs(Math.floor(target * 1.5), target)).toBe(false);
    expect(shouldShardTypeScriptCompilerInputs(Math.floor(target * 1.5) + 1, target)).toBe(true);
  });

  it('reads the shard size from the environment with a measured default', () => {
    expect(typescriptCompilerShardTargetFiles({})).toBe(TYPESCRIPT_COMPILER_SHARD_TARGET_FILES);
    expect(typescriptCompilerShardTargetFiles({ SCIP_QUERY_TS_COMPILER_SHARD_FILES: '512' })).toBe(512);
    expect(typescriptCompilerShardTargetFiles({ SCIP_QUERY_TS_COMPILER_SHARD_FILES: 'nope' })).toBe(
      TYPESCRIPT_COMPILER_SHARD_TARGET_FILES,
    );
  });

  it('gates shard parallelism by physical memory and CPUs', () => {
    const gib = 1024 ** 3;
    // 48 GB / 14 CPUs: memory allows 4 concurrent 6 GB children.
    expect(typescriptCompilerShardConcurrency(4, {}, { totalmemBytes: 48 * gib, cpuCount: 14 })).toBe(4);
    // 16 GB: only one bounded child may run at a time.
    expect(typescriptCompilerShardConcurrency(4, {}, { totalmemBytes: 16 * gib, cpuCount: 8 })).toBe(1);
    // 24 GB: two children fit in half of physical memory.
    expect(typescriptCompilerShardConcurrency(4, {}, { totalmemBytes: 24 * gib, cpuCount: 8 })).toBe(2);
    // Never more slots than shards, and one shard never parallelizes.
    expect(typescriptCompilerShardConcurrency(2, {}, { totalmemBytes: 48 * gib, cpuCount: 14 })).toBe(2);
    expect(typescriptCompilerShardConcurrency(1, {}, { totalmemBytes: 48 * gib, cpuCount: 14 })).toBe(1);
    // An explicit override wins, still capped by the shard count.
    expect(
      typescriptCompilerShardConcurrency(
        4,
        { SCIP_QUERY_TS_COMPILER_SHARD_CONCURRENCY: '2' },
        { totalmemBytes: 48 * gib, cpuCount: 14 },
      ),
    ).toBe(2);
    expect(
      typescriptCompilerShardConcurrency(
        4,
        { SCIP_QUERY_TS_COMPILER_SHARD_CONCURRENCY: '9' },
        { totalmemBytes: 8 * gib, cpuCount: 2 },
      ),
    ).toBe(4);
  });

  it('names shard configs so fingerprinting can recognize and exclude them', () => {
    expect(typescriptCompilerShardConfigFileName(3)).toBe('.scipquery-compiler-shard-3.tsconfig.json');
    expect(isTypeScriptCompilerShardConfigPath('.scipquery-compiler-shard-0.tsconfig.json')).toBe(true);
    expect(isTypeScriptCompilerShardConfigPath('.scipquery-compiler-shard-12.tsconfig.json')).toBe(true);
    expect(isTypeScriptCompilerShardConfigPath('tsconfig.json')).toBe(false);
    expect(isTypeScriptCompilerShardConfigPath('src/.scipquery-compiler-shard-0.tsconfig.json')).toBe(false);
    expect(isTypeScriptCompilerShardConfigPath('.scipquery-compiler-shard-.tsconfig.json')).toBe(false);
  });

  it('removes only owned stale shard configs from the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-shard-configs-'));
    tempDirs.push(root);
    writeFileSync(join(root, '.scipquery-compiler-shard-0.tsconfig.json'), '{}');
    writeFileSync(join(root, '.scipquery-compiler-shard-7.tsconfig.json'), '{}');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(join(root, '.scipquery.json'), '{}');

    removeStaleTypeScriptCompilerShardConfigs(root);

    expect(readdirSync(root).sort()).toEqual(['.scipquery.json', 'tsconfig.json']);
  });
});
