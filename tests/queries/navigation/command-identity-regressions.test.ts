import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { members } from '../../../src/queries/navigation/members.js';
import { localityCandidates } from '../../../src/queries/cleanup/locality-candidates.js';
import { findFirstSymbolMatch } from '../../../src/symbols/symbol-lookup.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('command identities on mixed SCIP definitions', () => {
  it('locates a symbol before a filename substring and includes fields without enclosing ranges', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-command-identities-'));
    const dbPath = join(root, 'index.db');
    const store = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/Store#';
    const sum = 'scip-typescript npm fixture 1.0.0 src/`math.ts`/sum().';
    writeFixtureFiles(root, {
      'src/store.ts': ['export class Store {', '  value = 0;', '  read() { return this.value; }', '}'],
      'src/math.ts': ['export function sum(left: number, right: number) { return left + right; }'],
      'src/consumer.ts': ["import { sum } from './math';", 'export const result = sum(1, 2);'],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/store.ts')
      .document(2, 'typescript', 'src/math.ts')
      .document(3, 'typescript', 'src/consumer.ts')
      .symbol(1, store, 'Store', 7)
      .definition(1, 1, 1, 0, 0, 3, 1)
      .symbol(2, store + 'value.', 'value', 8)
      .symbol(3, store + 'read().', 'read', 26)
      .definition(3, 1, 3, 2, 2, 2, 31)
      .symbol(4, sum, 'sum', 17)
      .definition(4, 2, 4, 0, 0, 0, 80)
      .chunk(1, 1, 0, 3)
      .mention(1, 1, 1)
      .mention(1, 2, 1)
      .mention(1, 3, 1)
      .occurrence(1, store + 'value.', 1, 1, 2, 7)
      .chunk(2, 2, 0, 0)
      .mention(2, 4, 1)
      .chunk(3, 3, 0, 1)
      .mention(3, 4, 0)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const candidates = localityCandidates(db, { target: 'sum', semantic: false });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.sourceUnit).toMatchObject({ kind: 'symbol', symbol: sum, file: 'src/math.ts' });
      expect(members(db, store)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ symbol: store + 'value.', startLine: 1, endLine: 1 }),
          expect.objectContaining({ symbol: store + 'read().', startLine: 2, endLine: 2 }),
        ]),
      );
      expect(findFirstSymbolMatch(db, store + 'value.')).toMatchObject({
        symbol: store + 'value.',
        startLine: 1,
        endLine: 1,
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
