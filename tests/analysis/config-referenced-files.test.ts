import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import { configReferencedFiles } from '../../src/analysis/config-referenced-files.js';
import { isEntrySurface } from '../../src/analysis/file-classifier.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('config-referenced files', () => {
  it('treats source files a root configuration names by path as entry surfaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-config-referenced-'));
    try {
      writeFixtureFiles(root, {
        'next.config.js': [
          'module.exports = {',
          '  images: {',
          '    loader: "custom",',
          '    loaderFile: "./src/lib/media/image-loader.ts",',
          '  },',
          '};',
        ],
        'package.json': JSON.stringify({ scripts: { backfill: 'tsx src/scripts/backfill.ts --dry-run' } }),
        'src/lib/media/image-loader.ts': ['export default function imageLoader() {', '  return "";', '}'],
        'src/scripts/backfill.ts': ['export async function main() {', '  return 1;', '}'],
        'src/lib/plain.ts': ['export const plain = 1;'],
      });
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/lib/media/image-loader.ts')
        .document(2, 'typescript', 'src/scripts/backfill.ts')
        .document(3, 'typescript', 'src/lib/plain.ts')
        .write();
      const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
      try {
        expect([...configReferencedFiles(db)].sort()).toEqual([
          'src/lib/media/image-loader.ts',
          'src/scripts/backfill.ts',
        ]);
        expect(isEntrySurface(db, 'src/lib/media/image-loader.ts')).toBe(true);
        expect(isEntrySurface(db, 'src/lib/plain.ts')).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
