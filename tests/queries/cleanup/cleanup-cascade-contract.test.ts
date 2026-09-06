import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SymbolInformation_Kind as Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { cleanupPlan } from '../../../src/queries/cleanup/cleanup-plan.js';

it('reconsiders a blocked cascade after another branch removes its final consumer', () => {
  const root = mkdtempSync(join(tmpdir(), 'scip-cleanup-cascade-contract-'));
  const names = ['seed', 'first', 'other', 'later', 'shared'];
  const bodies = ['first(); other(); shared();', 'shared();', 'later();', 'shared();', 'return 1;'];
  const source = names.map((name, i) => `export function ${name}() { ${bodies[i]} }`);
  const symbol = (name: string) => `scip-typescript npm fixture 1.0.0 src/\`functions.ts\`/${name}().`;
  try {
    writeFixtureFiles(root, { 'src/functions.ts': source });
    const builder = evidenceFixtureDb(join(root, 'index.db'))
      .document(1, 'typescript', 'src/functions.ts')
      .chunk(1, 1, 0, 4);
    names.forEach((name, i) =>
      builder
        .symbol(i + 1, symbol(name), name, Kind.Function)
        .definition(i + 1, 1, i + 1, i, 0, i, source[i]!.length)
        .mention(1, i + 1, 1),
    );
    for (const [line, callees] of [
      [0, ['first', 'other', 'shared']],
      [1, ['shared']],
      [2, ['later']],
      [3, ['shared']],
    ] as const)
      for (const name of callees) {
        const column = source[line]!.lastIndexOf(name);
        builder.occurrence(1, symbol(name), line, 0, column, column + name.length);
      }
    for (let id = 2; id <= 5; id++) builder.mention(1, id, 0);
    builder.write();
    const db = new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db') });
    try {
      const result = cleanupPlan(db, { minLoc: 1, maxDepth: 5 });
      expect(result.batches.map((batch) => batch.entries.map((entry) => entry.shortName.split(':').at(-1)))).toEqual([
        ['seed()'],
        ['first()', 'other()'],
        ['later()'],
        ['shared()'],
      ]);
      expect(result.blocked).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
