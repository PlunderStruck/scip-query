import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { it, vi } from 'vitest';
import type { FindingSuppression } from '../../src/domain/config-types.js';
import { evaluateSuppressionAdjudication } from '../../src/domain/suppression-adjudication.js';
import { getSuppressionInventory } from '../../src/analysis/suppressions.js';
import { suppressionCommentCategory, hasSuppressionCommentCategory } from '../../src/source/primitives/source-text.js';
import { clearRegisteredCaches } from '../../src/storage/cache-registry.js';
import { checkProperty, textArbitrary, PROPERTY_TIMEOUT } from './support.js';
import { withSourceDb } from './fixture.js';

const categories = ['dead', 'passthrough', 'drift', 'similar', 'twin', 'extract'] as const;
const decision = (hash: string): FindingSuppression => ({
  id: 'finding',
  check: 'complexity',
  file: 'a.ts',
  reason: 'Generated independently checked exception',
  decision: {
    kind: 'automated-adjudication',
    policyVersion: 1,
    decidedBy: 'human',
    reasonCode: 'detector-counterexample',
    evidence: [{ kind: 'source', referent: 'a.ts', contentHash: hash, claim: 'Exact source was inspected.' }],
    invalidateOn: { targetContentChange: true, detectorMajorChange: true },
  },
});

it(
  'suppressions: exact categories and evidence identity/expiry govern acceptance',
  async () => {
    await checkProperty(
      'suppressions',
      'category-and-evidence-policy',
      fc.property(
        fc.constantFrom(...categories),
        fc.constantFrom('//', '#', '/*', '*'),
        textArbitrary,
        fc.integer({ min: -1000, max: 1000 }),
        fc.boolean(),
        fc.boolean(),
        (category, prefix, reason, expiryDelta, sameId, sameContent) => {
          const line = `${prefix} scip-query: ignore-${category} -- ${JSON.stringify(reason)}`;
          assert.equal(suppressionCommentCategory(line), category);
          assert.equal(
            suppressionCommentCategory(`${prefix} scip-query: ignore-${category}-unknown`),
            `${category}-unknown`,
          );
          assert.equal(suppressionCommentCategory(`const value = ${JSON.stringify(line)}`), null);
          const now = Date.parse('2030-01-01T00:00:00Z');
          const suppression = {
            ...decision('hash:' + reason),
            id: sameId ? 'finding' : 'different',
            expiresAt: new Date(now + expiryDelta).toISOString(),
          };
          const result = evaluateSuppressionAdjudication(
            suppression,
            { id: 'finding', check: 'complexity', evidence: 'graph-fact', file: 'a.ts' },
            {
              now,
              contentHash: () => (sameContent ? 'hash:' + reason : 'changed:' + reason),
            },
          );
          const expected =
            expiryDelta <= 0 ? 'expired' : !sameContent ? 'invalidated' : !sameId ? 'escalated' : 'accepted';
          assert.equal(result.kind, expected);
        },
      ),
    );
  },
  PROPERTY_TIMEOUT,
);

it(
  'suppressions: real source scope and cached inventories remain isolated across categories, configuration and expiry',
  async () => {
    await checkProperty(
      'suppressions',
      'inventory-scope-and-expiry',
      fc.property(
        fc.constantFrom(...categories),
        fc.integer({ min: 0, max: 7 }),
        fc.boolean(),
        (category, gap, barrier) => {
          const initial = [
            `// scip-query: ignore-${category} -- Reviewed`,
            ...Array<string>(gap).fill('// detail'),
            ...(barrier ? ['const barrier = 0;'] : []),
            'function work() {}',
          ];
          withSourceDb({ 'a.ts': initial.join('\n') }, (db, root) => {
            for (const checked of categories)
              assert.equal(
                hasSuppressionCommentCategory(db, 'a.ts', initial.length - 1, checked),
                !barrier && gap < 5 && category === checked,
              );
            const now = Date.parse('2030-01-01T00:00:00Z');
            const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
            try {
              db.config.suppressions = [
                { check: 'dead', reason: 'fixture', expiresAt: new Date(now + 1).toISOString() },
              ];
              const first = getSuppressionInventory(db);
              assert.equal(first.total, 2);
              clock.mockReturnValue(now + 1);
              assert.equal(getSuppressionInventory(db).total, 1);
              db.config.suppressions = [];
              writeFileSync(join(root, 'a.ts'), 'function work() {}');
              clearRegisteredCaches(db, { groups: ['source-file'], file: 'a.ts' });
              assert.equal(getSuppressionInventory(db).total, 0);
              assert.equal(first.total, 2);
            } finally {
              clock.mockRestore();
            }
          });
        },
      ),
      'integration',
    );
  },
  PROPERTY_TIMEOUT,
);
