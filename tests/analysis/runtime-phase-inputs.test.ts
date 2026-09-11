import { rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { materializeRuntimePhase, runtimePhaseScope } from '../../src/analysis/runtime-boundaries/phase-inputs.js';
import { getAst } from '../../src/source/ast/ast-core.js';
import * as astRuntime from '../../src/source/ast/ast-runtime.js';
import { getSourceText } from '../../src/source/primitives/source-text.js';
import { recordFileAccess } from '../../src/domain/file-access-recorder.js';
import { createPerDbCache } from '../../src/storage/per-db-cache.js';
import { withSourceDb } from '../properties/fixture.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { readRepositoryTextFile } from '../../src/source/primitives/repository-text.js';
import { scipOccurrenceTargetsForFile } from '../../src/symbols/graph/scip-occurrence-call-targets.js';

test('retains a negative phase result only while all consumed inputs match', () => {
  withSourceDb({ 'helper.ts': 'old', 'unrelated.ts': 'one' }, (db, root) => {
    const compute = vi.fn((reader: typeof db) => ({ errors: [], value: getSourceText(reader, 'helper.ts') }));
    const opts = {
      db,
      scope: runtimePhaseScope(db, ['helper.ts', 'unrelated.ts']),
      seeds: 'seed',
      compilerFactsUnchanged: true,
      compute,
    };
    const first = materializeRuntimePhase(opts);
    expect(first.record?.sources.map(({ file }) => file)).toEqual(['helper.ts']);
    writeFileSync(join(root, 'unrelated.ts'), 'two');
    const second = materializeRuntimePhase({ ...opts, previous: JSON.parse(JSON.stringify(first.record)) });
    expect(second.reused).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    writeFileSync(join(root, 'helper.ts'), 'new');
    const third = materializeRuntimePhase({ ...opts, previous: second.record });
    expect(third.reused).toBe(false);
    expect(third.result.value).toBe('new');
    writeFileSync(join(root, 'helper.ts'), 'old');
    const restored = materializeRuntimePhase({ ...opts, previous: third.record });
    expect(restored.result.value).toBe('old');
    expect(restored.reused).toBe(false);
    rmSync(join(root, 'helper.ts'));
    expect(materializeRuntimePhase({ ...opts, previous: restored.record }).record).toBeUndefined();
  });
});

test('requires a compiler proof, input scope, seeds and build', () => {
  withSourceDb({ 'a.ts': 'const a = 1;' }, (db) => {
    const compute = vi.fn((reader: typeof db) => ({ errors: [], value: getSourceText(reader, 'a.ts') }));
    const opts = { db, scope: runtimePhaseScope(db, ['a.ts']), seeds: 'seed', compilerFactsUnchanged: true, compute };
    const first = materializeRuntimePhase(opts);
    for (const changed of [
      { compilerFactsUnchanged: false, previous: { ...first.record!, database: undefined } },
      { scope: 'changed' },
      { seeds: 'changed' },
      { previous: { ...first.record!, build: 'old' } },
      { previous: undefined },
    ]) {
      expect(materializeRuntimePhase({ ...opts, previous: first.record, ...changed }).reused).toBe(false);
    }
    expect(compute).toHaveBeenCalledTimes(6);
    expect(runtimePhaseScope(db, ['a.ts', 'added.ts'])).not.toBe(opts.scope);
  });
});

test('uses cold caches even when a caller has warmed source-derived database caches', () => {
  withSourceDb({ 'a.ts': 'const a = 1;' }, (db) => {
    const cached = createPerDbCache<string, string>('runtime-phase-test-read', { clearGroups: [] });
    const read = (reader: typeof db) => cached.get(reader, 'answer', () => getSourceText(reader, 'a.ts'));
    read(db);
    const compute = vi.fn((reader: typeof db) => {
      expect(reader).not.toBe(db);
      expect(reader.generation.identity).toBe(db.generation.identity);
      return { errors: [], value: read(reader) };
    });
    const opts = { db, scope: 'scope', seeds: 'seed', compilerFactsUnchanged: false, compute };
    const cold = materializeRuntimePhase(opts);
    const warm = materializeRuntimePhase(opts);
    expect(cold.record?.sources).toHaveLength(1);
    expect(warm.record?.sources).toEqual(cold.record?.sources);
  });
});

test('does not attach newly read bytes to results computed from older source', () => {
  withSourceDb({ 'a.ts': 'old' }, (db, root) => {
    const computed = materializeRuntimePhase({
      db,
      scope: 'scope',
      seeds: 'seed',
      compilerFactsUnchanged: false,
      compute(reader) {
        const value = getSourceText(reader, 'a.ts');
        writeFileSync(join(root, 'a.ts'), 'new');
        return { errors: [], value };
      },
    });
    expect(computed.result.value).toBe('old');
    expect(computed.record).toBeUndefined();
  });
});

test('rejects reads with unrecorded bytes and failed computations', () => {
  withSourceDb({ 'a.ts': 'old' }, (db) => {
    const opts = { db, scope: 'scope', seeds: 'seed', compilerFactsUnchanged: false };
    expect(
      materializeRuntimePhase({
        ...opts,
        compute() {
          recordFileAccess('a.ts');
          return { errors: [] };
        },
      }).record,
    ).toBeUndefined();
    expect(() =>
      materializeRuntimePhase({
        ...opts,
        compute() {
          throw Error('retry');
        },
      }),
    ).toThrow('retry');
    expect(
      materializeRuntimePhase({
        ...opts,
        compute() {
          return { errors: ['failed'] };
        },
      }).record,
    ).toBeUndefined();
    expect(
      materializeRuntimePhase({
        ...opts,
        compute(reader) {
          getSourceText(reader, 'a.ts');
          return { errors: [] };
        },
      }).record,
    ).toBeDefined();
  });
});

test('unavailable parsing is retried and cannot become a reusable negative', () => {
  withSourceDb({ 'a.ts': 'export const a = 1;' }, (db) => {
    const parse = vi.spyOn(astRuntime, 'parseAstSource').mockReturnValueOnce(null);
    try {
      const opts = {
        db,
        scope: 'scope',
        seeds: 'seed',
        compilerFactsUnchanged: true,
        compute: (reader: typeof db) => ({ errors: [], parsed: getAst(reader, 'a.ts') !== null }),
      };
      const failed = materializeRuntimePhase(opts);
      expect(failed.result.parsed).toBe(false);
      expect(failed.record).toBeUndefined();
      const recovered = materializeRuntimePhase({ ...opts, previous: failed.record });
      expect(recovered.result.parsed).toBe(true);
      expect(recovered.record?.sources).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });
});

test('retained output is isolated from later result mutation', () => {
  withSourceDb({ 'a.ts': 'old' }, (db) => {
    const opts = {
      db,
      scope: 'scope',
      seeds: 'seed',
      compilerFactsUnchanged: true,
      compute: () => ({ errors: [] as string[], values: ['original'] }),
    };
    const first = materializeRuntimePhase(opts);
    first.result.values.push('mutated');
    const second = materializeRuntimePhase({ ...opts, previous: first.record });
    expect(second.result.values).toEqual(['original']);
    second.result.values.length = 0;
    expect(materializeRuntimePhase({ ...opts, previous: second.record }).result.values).toEqual(['original']);
  });
});

test('validates the actual compiler reads across unrelated changes and new or removed callers', () => {
  withSourceDb({ 'helper.ts': 'export function helper() {}', 'other.ts': '' }, (initial) => {
    const writer = new Database(initial.config.dbPath);
    writer.exec('CREATE TABLE phase_calls (caller TEXT, callee TEXT)');
    const compute = vi.fn((db: ScipDatabase) => ({
      errors: [] as string[],
      source: getSourceText(db, 'helper.ts'),
      callers: db.all('SELECT caller FROM phase_calls WHERE callee = ?', 'helper'),
    }));
    type Phase = ReturnType<typeof materializeRuntimePhase<ReturnType<typeof compute>>>;
    const run = (previous?: Phase['record']) => {
      const db = new ScipDatabase(initial.config);
      try {
        return materializeRuntimePhase({
          db,
          scope: 'scope',
          seeds: 'seed',
          compilerFactsUnchanged: false,
          previous,
          compute,
        });
      } finally {
        db.close();
      }
    };
    try {
      const first = run();
      expect(first.record?.database?.reads).toHaveLength(1);
      writer.exec("INSERT INTO phase_calls VALUES ('other', 'unrelated')");
      expect(run(first.record).reused).toBe(true);
      writer.exec("INSERT INTO phase_calls VALUES ('entry', 'helper')");
      const called = run(first.record);
      expect(called.reused).toBe(false);
      expect(called.result.callers).toEqual([{ caller: 'entry' }]);
      expect(called.result).toEqual(run().result);
      writer.exec("DELETE FROM phase_calls WHERE callee = 'helper'");
      const removed = run(called.record);
      expect(removed.reused).toBe(false);
      expect(removed.result.callers).toEqual([]);
    } finally {
      writer.close();
    }
  });
});

test('source freshness metadata is an input even when SQLite and source bytes are unchanged', () => {
  withSourceDb({ 'helper.ts': 'export const helper = 1;', 'other.ts': '' }, (initial, root) => {
    const sourceHash = createHash('sha256').update('export const helper = 1;').digest('hex');
    const metadata = (helper: string, other: string) =>
      writeFileSync(
        join(root, 'meta.json'),
        JSON.stringify({
          version: 2,
          status: 'complete',
          fingerprint: {
            files: [
              { path: 'helper.ts', hash: helper },
              { path: 'other.ts', hash: other },
            ],
          },
        }),
      );
    const compute = (db: ScipDatabase) => ({
      errors: [] as string[],
      freshness: readRepositoryTextFile(db, 'helper.ts')!.freshness.semantic.state,
    });
    type Phase = ReturnType<typeof materializeRuntimePhase<ReturnType<typeof compute>>>;
    const run = (previous?: Phase['record']) => {
      const db = new ScipDatabase(initial.config);
      try {
        return materializeRuntimePhase({
          db,
          scope: 'scope',
          seeds: 'seed',
          compilerFactsUnchanged: true,
          previous,
          compute,
        });
      } finally {
        db.close();
      }
    };
    metadata(sourceHash, 'old');
    const first = run();
    expect(first.result.freshness).toBe('aligned');
    expect(first.record?.sources).toEqual([{ file: 'helper.ts', hash: sourceHash, indexedHash: sourceHash }]);
    metadata(sourceHash, 'new');
    expect(run(first.record).reused).toBe(true);
    metadata('different', 'new');
    const stale = run(first.record);
    expect(stale.reused).toBe(false);
    expect(stale.result.freshness).toBe('stale');
    metadata(sourceHash, 'new');
    expect(run(stale.record).result.freshness).toBe('aligned');
  });
});

test('the separate SCIP artifact fallback cannot be certified by SQLite reads, including a missing artifact', () => {
  withSourceDb({ 'helper.ts': 'export function helper() {}' }, (db) => {
    const compute = vi.fn((reader: ScipDatabase) => ({
      errors: [] as string[],
      targets: scipOccurrenceTargetsForFile(reader, 'helper.ts'),
    }));
    const opts = { db, scope: 'scope', seeds: 'seed', compilerFactsUnchanged: false, compute };
    const first = materializeRuntimePhase(opts);
    expect(first.result.targets).toBeNull();
    expect(first.record).toBeDefined();
    expect(first.record!.database).toBeUndefined();
    expect(materializeRuntimePhase({ ...opts, previous: first.record }).reused).toBe(false);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

test.each(['\uFEFFexport const helper = 1;', 'export const helper = "\u0000";'])(
  'records the original bytes for text classification and BOM decoding: %j',
  (source) => {
    withSourceDb({ 'helper.ts': source }, (db, root) => {
      const compute = (reader: ScipDatabase) => ({
        errors: [] as string[],
        raw: getSourceText(reader, 'helper.ts'),
        text: readRepositoryTextFile(reader, 'helper.ts')?.text ?? null,
      });
      const opts = { db, scope: 'scope', seeds: 'seed', compilerFactsUnchanged: false, compute };
      const first = materializeRuntimePhase(opts);
      expect(first.record).toBeDefined();
      expect(materializeRuntimePhase({ ...opts, previous: first.record }).reused).toBe(true);
      writeFileSync(join(root, 'helper.ts'), 'export const helper = "changed";');
      const changed = materializeRuntimePhase({ ...opts, previous: first.record });
      expect(changed.reused).toBe(false);
      expect(changed.result.text).toBe('export const helper = "changed";');
    });
  },
);

test('invalid UTF-8 cannot establish an exact source-text proof', () => {
  withSourceDb({ 'helper.ts': '' }, (db, root) => {
    writeFileSync(join(root, 'helper.ts'), Buffer.from([255]));
    const result = materializeRuntimePhase({
      db,
      scope: 'scope',
      seeds: 'seed',
      compilerFactsUnchanged: false,
      compute: (reader) => ({ errors: [] as string[], text: readRepositoryTextFile(reader, 'helper.ts') }),
    });
    expect(result.result.text).toBeNull();
    expect(result.record).toBeUndefined();
  });
});
