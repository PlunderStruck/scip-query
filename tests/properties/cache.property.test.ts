import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { it } from 'vitest';
import type { ScipDatabase } from '../../src/storage/db.js';
import { createPerDbSourceCache } from '../../src/storage/per-db-cache.js';
import { clearRegisteredCaches } from '../../src/storage/cache-registry.js';
import { getSourceText, getSourceLines, readSourceTextUncached } from '../../src/source/primitives/source-text.js';
import { checkProperty, textArbitrary, PROPERTY_TIMEOUT } from './support.js';
import { withSourceDb } from './fixture.js';

// Register once, not once per generated case: the production registry has process lifetime.
const cache = createPerDbSourceCache<{ text: string }>('property-source-cache', {
  clearGroups: ['source-file', 'whole-project'],
  maxEntries: 3,
});
const operation = fc.record({
  owner: fc.integer({ min: 0, max: 1 }),
  key: fc.integer({ min: 0, max: 4 }),
  action: fc.constantFrom('read', 'read', 'file', 'all', 'fail'),
  text: textArbitrary,
});

it(
  'cache: source changes, eviction, failed computation and invalidation obey an independent cache model',
  async () => {
    await checkProperty(
      'cache',
      'source-cache-state-sequences',
      fc.property(fc.array(operation, { minLength: 1, maxLength: 25 }), (operations) => {
        // These keys exercise WeakMap ownership only; no database behavior is mocked.
        const owners = [{}, {}] as ScipDatabase[];
        const models: Array<Array<{ key: string; text: string; value: { text: string } }>> = [[], []];
        for (const op of operations) {
          const db = owners[op.owner]!;
          const key = `src/f${op.key}.ts`;
          const model = models[op.owner]!;
          if (op.action === 'all') {
            clearRegisteredCaches(db, { groups: ['whole-project'] });
            model.length = 0;
            continue;
          }
          if (op.action === 'file') {
            clearRegisteredCaches(db, { groups: ['source-file'], file: key });
            models[op.owner] = model.filter((entry) => entry.key !== key);
            continue;
          }
          const hit = model.find((entry) => entry.key === key && entry.text === op.text);
          let computed = 0;
          const get = () =>
            cache.get(db, key, op.text, () => {
              computed += 1;
              if (op.action === 'fail') throw new Error('generated computation failure');
              return { text: op.text };
            });
          if (op.action === 'fail' && !hit) {
            assert.throws(get, /generated computation failure/);
            continue;
          }
          const value = get();
          assert.equal(computed, hit ? 0 : 1);
          assert.deepEqual(value, { text: op.text });
          if (hit) assert.equal(value, hit.value);
          models[op.owner] = [...model.filter((entry) => entry.key !== key), { key, text: op.text, value }].slice(-3);
        }
      }),
    );
  },
  PROPERTY_TIMEOUT,
);

it(
  'cache: real source reads follow file invalidation through edits and deletion without changing earlier observations',
  async () => {
    await checkProperty(
      'cache',
      'source-reader-invalidation',
      fc.property(fc.array(fc.option(textArbitrary, { nil: null }), { minLength: 1, maxLength: 10 }), (edits) => {
        withSourceDb({ 'a.ts': 'initial', 'other.ts': 'retained' }, (db, root) => {
          const oldLines = getSourceLines(db, 'a.ts');
          for (const edit of edits) {
            if (edit === null) rmSync(join(root, 'a.ts'), { force: true });
            else writeFileSync(join(root, 'a.ts'), edit);
            clearRegisteredCaches(db, { groups: ['source-file'], file: 'a.ts' });
            assert.equal(getSourceText(db, 'a.ts'), edit ?? '');
            assert.equal(getSourceText(db, 'a.ts'), readSourceTextUncached(db, 'a.ts'));
            assert.deepEqual(getSourceLines(db, 'a.ts'), edit ? edit.split('\n') : []);
            assert.equal(getSourceText(db, 'other.ts'), 'retained');
          }
          assert.deepEqual(oldLines, ['initial']);
        });
      }),
      'integration',
    );
  },
  PROPERTY_TIMEOUT,
);
