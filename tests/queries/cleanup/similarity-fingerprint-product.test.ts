import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { similarityFingerprintProduct } from '../../../src/queries/cleanup/similar.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const WORKFLOW_FILE = 'src/workflow.ts';

describe('similarity fingerprint product', () => {
  let tempDir: string;
  let projectRoot: string;
  let dbPath: string;
  let db: ScipDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-similarity-product-'));
    projectRoot = join(tempDir, 'project');
    dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, {
      [WORKFLOW_FILE]: [
        'export function sharedOne() { return 1; }',
        'export function sharedTwo() { return 2; }',
        'export function sharedThree() { return 3; }',
        'export function sharedFour() { return 4; }',
        'export function alphaWorker() {',
        '  sharedOne();',
        '  sharedThree();',
        '  sharedFour();',
        "  const invoiceDraft = 'shared customer token';",
        '  return invoiceDraft;',
        '}',
        'export function betaWorker() {',
        '  sharedTwo();',
        '  sharedThree();',
        '  sharedFour();',
        "  const invoiceDraft = 'shared customer token';",
        '  return invoiceDraft;',
        '}',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', WORKFLOW_FILE)
      .symbol(1, symbol('sharedOne'), 'sharedOne', 12)
      .symbol(2, symbol('sharedTwo'), 'sharedTwo', 12)
      .symbol(3, symbol('sharedThree'), 'sharedThree', 12)
      .symbol(4, symbol('sharedFour'), 'sharedFour', 12)
      .symbol(5, symbol('alphaWorker'), 'alphaWorker', 12)
      .symbol(6, symbol('betaWorker'), 'betaWorker', 12)
      .definition(1, 1, 1, 0, 0, 0, 0)
      .definition(2, 1, 2, 1, 0, 1, 0)
      .definition(3, 1, 3, 2, 0, 2, 0)
      .definition(4, 1, 4, 3, 0, 3, 0)
      .definition(5, 1, 5, 4, 0, 10, 0)
      .definition(6, 1, 6, 11, 0, 17, 0)
      .chunk(1, 1, 5, 5)
      .chunk(2, 1, 6, 6)
      .chunk(3, 1, 7, 7)
      .chunk(4, 1, 12, 12)
      .chunk(5, 1, 13, 13)
      .chunk(6, 1, 14, 14)
      .mention(1, 1, 0)
      .mention(2, 3, 0)
      .mention(3, 4, 0)
      .mention(4, 2, 0)
      .mention(5, 3, 0)
      .mention(6, 4, 0)
      .write();

    db = new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reuses callee and source indexes while owning source candidate routing', () => {
    const product = similarityFingerprintProduct(db);

    const firstCalleeIndex = product.calleeIndex({ minCallees: 2, semantic: false });
    const secondCalleeIndex = product.calleeIndex({ minCallees: 2, semantic: false });
    expect(secondCalleeIndex).toBe(firstCalleeIndex);
    expect(firstCalleeIndex.corpus.map((fingerprint) => fingerprint.symbol)).toEqual([
      symbol('alphaWorker'),
      symbol('betaWorker'),
    ]);

    expect(
      product
        .calleeCorpus({ minCallees: 2, excludeSymbol: symbol('alphaWorker'), semantic: false })
        .map((fingerprint) => fingerprint.symbol),
    ).toEqual([symbol('betaWorker')]);

    const firstSourceIndex = product.sourceIndex();
    const secondSourceIndex = product.sourceIndex();
    expect(secondSourceIndex).toBe(firstSourceIndex);

    const target = product.sourceCorpus().find((fingerprint) => fingerprint.symbol === symbol('alphaWorker'));
    expect(target).toBeDefined();

    const fullCandidates = product.sourceCandidates(target!, { minSimilarity: 0.1, candidateMode: 'full' });
    const prunedCandidates = product.sourceCandidates(target!, { minSimilarity: 0.1, candidateMode: 'target-pruned' });
    expect(fullCandidates.map((fingerprint) => fingerprint.symbol)).toContain(symbol('betaWorker'));
    expect(prunedCandidates.map((fingerprint) => fingerprint.symbol)).toContain(symbol('betaWorker'));
    expect(fullCandidates.map((fingerprint) => fingerprint.symbol)).not.toContain(symbol('alphaWorker'));
    expect(prunedCandidates.map((fingerprint) => fingerprint.symbol)).not.toContain(symbol('alphaWorker'));
  });
});

function symbol(name: string): string {
  return `scip-typescript npm fixture 1.0.0 src/\`workflow.ts\`/${name}().`;
}
