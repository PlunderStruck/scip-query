import assert from 'node:assert/strict';
import fc from 'fast-check';
import { it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProjectChangeManifest, type ProjectInputSnapshot } from '../../src/domain/project-input.js';
import { planAffectedFiles } from '../../src/reindex/affected-set.js';
import { partitionTypeScriptCompilerInputs } from '../../src/reindex/typescript-compiler-shards.js';
import { patchIncrementalSqliteGeneration } from '../../src/reindex/incremental-sqlite-publication.js';
import { writePropertyDatabase, assertPropertyDatabase } from './indexing-fixtures.js';
import './indexing-compiler.js';
import { checkProperty, graphArbitrary, reachability, PROPERTY_TIMEOUT } from './support.js';

function snapshot(values: readonly (number | null)[]): ProjectInputSnapshot {
  return {
    version: 2,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'single',
    typescriptProjects: [],
    files: values.flatMap((value, n) =>
      value === null ? [] : [{ path: `src/f${n}.ts`, hash: String(value), size: String(value).length }],
    ),
  };
}

it(
  'indexing: manifests, affected consumers and compiler shards retain every required input',
  async () => {
    await checkProperty(
      'indexing',
      'manifest-closure-and-shards',
      fc.property(
        graphArbitrary,
        fc.array(fc.option(fc.integer({ min: -100, max: 100 }), { nil: null }), { maxLength: 10 }),
        fc.array(fc.option(fc.integer({ min: -100, max: 100 }), { nil: null }), { maxLength: 10 }),
        fc.integer({ min: 1, max: 8 }),
        ({ size, edges }, oldValues, newValues, shardSize) => {
          const previous = snapshot(oldValues);
          const current = snapshot(newValues);
          const manifest = buildProjectChangeManifest(previous, current);
          const expected = [];
          for (let n = 0; n < Math.max(oldValues.length, newValues.length); n += 1) {
            const old = oldValues[n] ?? null;
            const next = newValues[n] ?? null;
            if (old !== next)
              expected.push({
                path: `src/f${n}.ts`,
                kind: old === null ? 'added' : next === null ? 'deleted' : 'modified',
              });
          }
          assert.deepEqual(
            manifest.changes.map(({ path, kind }) => ({ path, kind })),
            expected,
          );
          assert.deepEqual(manifest.uncertainty, []);
          assert.equal(manifest.projectIdentityChanged, false);

          const files = Array.from({ length: size }, (_, n) => `src/f${n}.ts`);
          const graph = new Map(files.map((file) => [file, new Set<string>()]));
          for (const [from, to] of edges) graph.get(files[from]!)!.add(files[to]!);
          const plan = planAffectedFiles(manifest, graph, files);
          const changed = expected.map(({ path }) => path);
          const full = expected.some(({ path, kind }) => kind !== 'modified' || !files.includes(path));
          const paths = reachability(size, edges);
          const affected = files.filter((_, from) => changed.some((path) => paths[from]![files.indexOf(path)]));
          assert.equal(plan.mode, changed.length === 0 ? 'none' : full ? 'full-project' : 'closure');
          assert.deepEqual(plan.affectedFiles, full ? files : affected);
          const shards = partitionTypeScriptCompilerInputs([...files].reverse().concat(files), shardSize);
          assert.deepEqual(shards.flat(), files);
          assert.ok(shards.every((shard) => shard.length > 0 && shard.length <= shardSize));
        },
      ),
    );
  },
  PROPERTY_TIMEOUT,
);

it(
  'indexing: generated SQLite patch sequences preserve independent final facts and roll back every publication stage',
  async () => {
    await checkProperty(
      'indexing',
      'sqlite-publication-sequences',
      fc.property(
        fc.array(
          fc.record({
            file: fc.integer({ min: 0, max: 4 }),
            value: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
            fail: fc.option(
              fc.constantFrom('after-delete', 'after-symbol-reconciliation', 'after-insert', 'before-commit'),
              { nil: null },
            ),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (steps) => {
          const root = mkdtempSync(join(tmpdir(), 'scip-query-property-sqlite-'));
          const state = new Map([
            [0, 0],
            [5, 999],
          ]);
          let accepted = join(root, 'initial.db');
          try {
            writePropertyDatabase(accepted, state);
            for (const [n, step] of steps.entries()) {
              const mini = join(root, `mini${n}.db`);
              const candidate = join(root, `candidate${n}.db`);
              writePropertyDatabase(mini, step.value === null ? new Map() : new Map([[step.file, step.value]]));
              const bytes = readFileSync(accepted);
              const patch = () =>
                patchIncrementalSqliteGeneration({
                  previousDbPath: accepted,
                  miniDbPath: mini,
                  candidateDbPath: candidate,
                  affectedFiles: [`f${step.file}.ts`],
                  deletedFiles: step.value === null ? [`f${step.file}.ts`] : [],
                  onStage: (stage) => {
                    if (stage === step.fail) throw new Error('injected publication failure');
                  },
                });
              if (step.fail) {
                assert.throws(patch, /injected publication failure/);
                assert.equal(existsSync(candidate), false);
              } else {
                patch();
                if (step.value === null) state.delete(step.file);
                else state.set(step.file, step.value);
                assertPropertyDatabase(candidate, state);
              }
              assert.deepEqual(readFileSync(accepted), bytes);
              if (!step.fail) accepted = candidate;
              assertPropertyDatabase(accepted, state);
            }
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      ),
      'integration',
    );
  },
  PROPERTY_TIMEOUT,
);
