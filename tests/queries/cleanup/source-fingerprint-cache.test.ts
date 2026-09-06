import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { similar, similarityFingerprintProduct } from '../../../src/queries/cleanup/similar.js';
import {
  fileContentHash,
  readCachedFileEvidence,
  writeCachedFileEvidence,
} from '../../../src/storage/evidence-cache.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { getSourceText } from '../../../src/source/primitives/source-text.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const A_FILE = 'src/a.ts';
const B_FILE = 'src/b.ts';

describe('source fingerprint cache', () => {
  let tempDir: string;
  let projectRoot: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-fingerprints-'));
    projectRoot = join(tempDir, 'project');
    dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, {
      [A_FILE]: [
        'export function alphaWorker(): string {',
        "  const invoiceDraft = 'shared customer token';",
        '  const statusBadge = invoiceDraft.trim();',
        '  return statusBadge.toUpperCase();',
        '}',
      ],
      [B_FILE]: [
        'export function betaWorker(): string {',
        "  const invoiceDraft = 'shared customer token';",
        '  const statusBadge = invoiceDraft.trim();',
        '  return statusBadge.toUpperCase();',
        '}',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', A_FILE)
      .document(2, 'typescript', B_FILE)
      .symbol(1, symbol(A_FILE, 'alphaWorker'), 'alphaWorker', 12)
      .symbol(2, symbol(B_FILE, 'betaWorker'), 'betaWorker', 12)
      .definition(1, 1, 1, 0, 0, 4, 1)
      .definition(2, 2, 2, 0, 0, 4, 1)
      .write();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves source-token corpus entries from persisted file evidence', () => {
    const db1 = openDb();
    try {
      expect(similar(db1, 'alphaWorker', { minSimilarity: 0.1, limit: 5 })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shortNameB: 'src:b:betaWorker()',
            similarityBasis: 'source-tokens',
          }),
        ]),
      );

      const bHash = fileContentHash(db1, B_FILE, getSourceText(db1, B_FILE));
      const rawPayload = readCachedFileEvidence(db1, 'source-fingerprints', B_FILE, bHash);
      expect(rawPayload).not.toBeNull();
      const planted = JSON.parse(rawPayload!) as { entries: Array<{ tokens: string[] }> };
      planted.entries = planted.entries.map((entry) => ({ ...entry, tokens: ['planted'] }));
      writeCachedFileEvidence(db1, 'source-fingerprints', B_FILE, bHash, JSON.stringify(planted));
    } finally {
      db1.close();
    }

    const db2 = openDb();
    try {
      expect(
        similar(db2, 'alphaWorker', { minSimilarity: 0.1, limit: 5 }).some(
          (result) => result.shortNameB === 'src:b:betaWorker()',
        ),
      ).toBe(false);
    } finally {
      db2.close();
    }
  });

  it('uses complete callable source without including same-line siblings', () => {
    rmSync(dbPath);
    const source = [
      'export function alphaWorker() {',
      ...Array.from({ length: 16 }, (_, n) => `  const padding${n} = ${n};`),
      "  return 'unmistakableTailMarker';",
      '}',
    ];
    writeFixtureFiles(projectRoot, {
      [A_FILE]: source,
      [B_FILE]: [
        "export function betaWorker() { return 'invoice'; } export function unrelated() { return 'unrelatedContamination'; }",
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', A_FILE)
      .document(2, 'typescript', B_FILE)
      .symbol(1, symbol(A_FILE, 'alphaWorker'), 'alphaWorker', 12)
      .symbol(2, symbol(B_FILE, 'betaWorker'), 'betaWorker', 12)
      .definition(1, 1, 1, 0, 0, source.length - 1, 1)
      .definition(2, 2, 2, 0, 0, 0, 49)
      .write();
    const db = openDb();
    try {
      const corpus = similarityFingerprintProduct(db).sourceCorpus();
      expect(corpus.find((entry) => entry.symbol === symbol(A_FILE, 'alphaWorker'))?.tokens).toContain('unmistakable');
      expect(corpus.find((entry) => entry.symbol === symbol(B_FILE, 'betaWorker'))?.tokens).not.toContain(
        'contamination',
      );
    } finally {
      db.close();
    }
  });

  it('rejects an ambiguous target before comparing source or calls', () => {
    rmSync(dbPath);
    writeFixtureFiles(projectRoot, { [B_FILE]: ['export function alphaWorker() { return 2; }'] });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', A_FILE)
      .document(2, 'typescript', B_FILE)
      .symbol(1, symbol(A_FILE, 'alphaWorker'), 'alphaWorker', 12)
      .symbol(2, symbol(B_FILE, 'alphaWorker'), 'alphaWorker', 12)
      .definition(1, 1, 1, 0, 0, 4, 1)
      .definition(2, 2, 2, 0, 0, 0, 49)
      .write();
    const db = openDb();
    try {
      expect(() => similar(db, 'alphaWorker')).toThrow(/ambiguous/i);
    } finally {
      db.close();
    }
  });

  function openDb(): ScipDatabase {
    return new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
  }
});

function symbol(file: string, name: string): string {
  return `scip-typescript npm fixture 1.0.0 src/\`${file.split('/').at(-1)}\`/${name}().`;
}
