import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notImplemented } from '../../../src/queries/cleanup/not-implemented.js';
import { productionCallableDefinitions } from '../../../src/queries/internal/production-callables.js';
import {
  suppressionCommentCategory,
  hasSuppressionCommentCategory,
} from '../../../src/source/primitives/source-text.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('suppression isolation', () => {
  it('keeps unrelated annotations from hiding reachable placeholders', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-suppression-isolation-'));
    const categories = ['extract', 'wrapper', 'stale', 'passthrough', 'similar', 'twin', 'unknown-check'];
    const dbPath = join(root, 'index.db');
    const fixture = evidenceFixtureDb(dbPath).document(1, 'typescript', 'cli.ts');
    const lines: string[] = [];
    for (const [i, category] of categories.entries()) {
      lines.push(
        `// scip-query: ignore-${category}`,
        `export function pending${i}(): void {`,
        '  throw new Error("not implemented");',
        '}',
      );
      fixture
        .symbol(i + 1, `scip-typescript npm fixture 1.0.0 cli.ts/pending${i}().`, `pending${i}`, 12)
        .definition(i + 1, 1, i + 1, i * 4 + 1, 0, i * 4 + 3, 1);
    }
    writeFixtureFiles(root, { 'cli.ts': lines });
    fixture.write();
    const db = new ScipDatabase({ dbPath, projectRoot: root, indexPath: join(root, 'index.scip') });
    try {
      expect(hasSuppressionCommentCategory(db, 'cli.ts', 1, 'extract')).toBe(true);
      expect(hasSuppressionCommentCategory(db, 'cli.ts', 1, 'similar')).toBe(false);
      expect(hasSuppressionCommentCategory(db, 'cli.ts', 5, 'passthrough')).toBe(true);
      expect(hasSuppressionCommentCategory(db, 'cli.ts', 9, 'dead')).toBe(true);
      expect(productionCallableDefinitions(db)).toHaveLength(categories.length);
      expect(notImplemented(db, { semantic: false })).toHaveLength(categories.length);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['// scip-query: ignore', ''],
    ['// scip-query: ignore-extract: reviewed', 'extract'],
    ['/* scip-query-ignore: dead-code */', 'dead-code'],
    ['# scip-query: ignore-twin', 'twin'],
    [' * scip-query: ignore-SIMILAR', 'similar'],
    ['// Example scip-query: ignore-extract', null],
  ])('parses the complete directive %s', (line, category) => {
    expect(suppressionCommentCategory(line!)).toBe(category);
  });

  it.each(['unknown-check', 'deadly', 'extract-extra'])(
    'does not interpret %s as a blanket or partial suppression',
    (category) => {
      expect(suppressionCommentCategory(`// scip-query: ignore-${category}`)).toBe(category);
    },
  );
});
