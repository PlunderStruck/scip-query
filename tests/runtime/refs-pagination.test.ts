import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScipDatabase } from '../../src/storage/db.js';
import { refs } from '../../src/queries/navigation/refs.js';
import { compareReferenceKey, referencePage } from '../../src/runtime/refs-pagination.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('producer-bounded refs pagination', () => {
  it('stops after a bounded source prefix and concatenates to the complete oracle', () => {
    const fixture = createHighFanoutFixture();
    const scanned: string[] = [];
    const first = referencePage(fixture.db, 'target', {
      limit: 1,
      instrumentation: { fileScanned: (file) => scanned.push(file) },
    });

    expect(first.rows).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.producer).toBe('source-keyset');
    expect(scanned).toEqual(['src/00-target.ts', 'src/01-consumer.ts']);

    const combined = [...first.rows];
    let page = first;
    while (page.hasMore) {
      page = referencePage(fixture.db, 'target', {
        limit: 1,
        after: combined.at(-1),
        producer: page.producer,
      });
      combined.push(...page.rows);
    }

    const oracle = refs(fixture.db, 'target', { semantic: false }).sort(compareReferenceKey);
    expect(combined).toEqual(oracle);
    expect(new Set(combined.map((row) => `${row.relativePath}:${row.line}`)).size).toBe(combined.length);
    fixture.db.close();
  });

  it('labels an unpageable SCIP fallback as complete-only', () => {
    const fixture = createFallbackFixture();
    const page = referencePage(fixture.db, 'target', { limit: 1 });

    expect(page.producer).toBe('complete-only');
    expect(page.semanticEnrichment).toBe(false);
    expect(page.rows).toEqual([{ relativePath: 'src/consumer.ts', line: 2, evidence: 'source-or-chunk-candidate' }]);
    fixture.db.close();
  });
});

function createHighFanoutFixture(): { db: ScipDatabase } {
  const root = temporaryRoot();
  const dbPath = join(root, 'index.db');
  const files: Record<string, string> = {
    'src/00-target.ts': 'export function target(): void {}',
    'src/01-consumer.ts': ['target();', 'target();', 'target();', 'target();', 'target();'].join('\n'),
  };
  for (let index = 2; index < 20; index += 1) {
    files[`src/${String(index).padStart(2, '0')}-unrelated.ts`] = `export const value${index} = ${index};`;
  }
  writeFixtureFiles(root, files);

  const fixture = evidenceFixtureDb(dbPath)
    .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`00-target.ts`/target().', 'target', 12)
    .definition(1, 1, 1, 0, 0, 0, 38);
  Object.keys(files).forEach((relativePath, index) => fixture.document(index + 1, 'typescript', relativePath));
  fixture.write();
  return { db: openDatabase(root, dbPath) };
}

function createFallbackFixture(): { db: ScipDatabase } {
  const root = temporaryRoot();
  const dbPath = join(root, 'index.db');
  writeFixtureFiles(root, {
    'src/target.ts': 'export function target(): void {}',
    'src/consumer.ts': ['const unrelated = true;', 'void unrelated;', 'const done = true;'].join('\n'),
  });
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/target.ts')
    .document(2, 'typescript', 'src/consumer.ts')
    .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`target.ts`/target().', 'target', 12)
    .definition(1, 1, 1, 0, 0, 0, 38)
    .chunk(1, 2, 2, 2)
    .mention(1, 1, 8)
    .write();
  return { db: openDatabase(root, dbPath) };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-refs-page-'));
  roots.push(root);
  return root;
}

function openDatabase(root: string, dbPath: string): ScipDatabase {
  return new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
}
