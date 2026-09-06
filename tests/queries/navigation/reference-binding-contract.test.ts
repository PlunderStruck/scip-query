import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SymbolInformation_Kind as Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { refs } from '../../../src/queries/navigation/refs.js';
import { referencePage } from '../../../src/runtime/refs-pagination.js';

const target = 'scip-typescript npm fixture 1.0.0 src/`a.ts`/target().';
describe('reference binding contract', () => {
  it('uses compiler bindings for aliases, shadows and recursion, with identical paged locations', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-ref-bindings-'));
    try {
      writeFixtureFiles(root, {
        'src/a.ts': 'export function target(n: number): number { return n ? target(n - 1) : 0; }',
        'src/b.ts':
          "import { target as alias } from './a';\nconst value = alias(2);\nfunction shadow(target: number) { return target; }",
      });
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/a.ts')
        .document(2, 'typescript', 'src/b.ts')
        .symbol(1, target, 'target', Kind.Function)
        .definition(1, 1, 1, 0, 0, 0, 73)
        .chunk(1, 1, 0, 0)
        .chunk(2, 2, 0, 2)
        .mention(1, 1, 1)
        .mention(1, 1, 0)
        .mention(2, 1, 0)
        .occurrence(1, target, 0, 1, 16, 22)
        .occurrence(1, target, 0, 0, 54, 60)
        .occurrence(2, target, 0, 0, 9, 15)
        .occurrence(2, target, 1, 0, 14, 19)
        .occurrence(2, 'local 0', 2, 1, 16, 22)
        .occurrence(2, 'local 0', 2, 0, 41, 47)
        .write();
      const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
      try {
        const locations = refs(db, target, { semantic: false }).map((row) => [row.relativePath, row.line]);
        expect(locations).toEqual([
          ['src/a.ts', 0],
          ['src/b.ts', 0],
          ['src/b.ts', 1],
        ]);
        const paged: Array<[string, number]> = [];
        let after;
        let producer;
        for (let i = 0; i < 5; i++) {
          const page = referencePage(db, target, { limit: 1, after, producer, semantic: false });
          paged.push(...page.rows.map((row) => [row.relativePath, row.line] as [string, number]));
          if (!page.hasMore) break;
          after = page.rows.at(-1);
          producer = page.producer;
        }
        expect(paged).toEqual(locations);
        expect(locations).not.toContainEqual(['src/b.ts', 2]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
