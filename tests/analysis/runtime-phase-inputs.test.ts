import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { materializeRuntimePhase, runtimePhaseScope } from '../../src/analysis/runtime-boundaries/phase-inputs.js';
import { getAst } from '../../src/source/ast/ast-core.js';
import * as astRuntime from '../../src/source/ast/ast-runtime.js';
import { getSourceText } from '../../src/source/primitives/source-text.js';
import { recordFileAccess } from '../../src/domain/file-access-recorder.js';
import { createPerDbCache } from '../../src/storage/per-db-cache.js';
import { withSourceDb } from '../properties/fixture.js';

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

test('requires unchanged compiler data, input scope, seeds and build', () => {
  withSourceDb({ 'a.ts': 'const a = 1;' }, (db) => {
    const compute = vi.fn((reader: typeof db) => ({ errors: [], value: getSourceText(reader, 'a.ts') }));
    const opts = { db, scope: runtimePhaseScope(db, ['a.ts']), seeds: 'seed', compilerFactsUnchanged: true, compute };
    const first = materializeRuntimePhase(opts);
    for (const changed of [
      { compilerFactsUnchanged: false },
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
