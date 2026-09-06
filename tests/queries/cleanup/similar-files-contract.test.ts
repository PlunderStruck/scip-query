import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScipDatabase } from '../../../src/storage/db.js';
import { similarFiles } from '../../../src/queries/cleanup/similar-files.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(externalConsumers: number, dependencyCount: number) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-similar-files-contract-'));
  roots.push(projectRoot);
  const dbPath = join(projectRoot, 'index.db');
  const files: Record<string, string[]> = {};
  for (let i = 0; i < dependencyCount; i++) files[`src/dep${i}.ts`] = [`export const dep${i} = ${i};`];
  for (const name of ['feature/a', 'feature/b', ...Array.from({ length: externalConsumers }, (_, n) => `other${n}`)]) {
    const prefix = name.includes('/') ? '../' : './';
    files[`src/${name}.ts`] = Array.from({ length: dependencyCount }, (_, i) => `import '${prefix}dep${i}.js';`);
  }
  writeFixtureFiles(projectRoot, files);
  const builder = evidenceFixtureDb(dbPath);
  let id = 0;
  for (const file of Object.keys(files)) builder.document(++id, 'typescript', file);
  builder.write();
  return new ScipDatabase({ projectRoot, dbPath, indexPath: join(projectRoot, 'index.scip') });
}
describe('dependency similarity contracts', () => {
  it('honors an explicit three-dependency minimum', () => {
    const db = fixture(0, 3);
    try {
      const rows = similarFiles(db, { scope: 'src/feature', minDeps: 3 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.similarity).toBe(1);
      expect(rows[0]!.sharedDeps).toHaveLength(3);
    } finally {
      db.close();
    }
  });
  it('uses global dependency popularity even when candidate files are scoped', () => {
    const db = fixture(4, 4);
    try {
      expect(similarFiles(db, { scope: 'src/feature', minDeps: 4 })).toEqual([]);
    } finally {
      db.close();
    }
  });
});
