import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyFacadeEvidence, passthroughCandidates } from '../../../src/queries/cleanup/passthrough-candidates.js';
import { health } from '../../../src/queries/health/health.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

function withPassthroughFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-passthrough-candidates-'));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');
  try {
    mkdirSync(projectRoot, { recursive: true });
    writeFixtureFiles(projectRoot, {
      'package.json': JSON.stringify({ exports: { '.': './src/contracts.ts' } }),
      'src/passthrough.ts': [
        'export function storageAdapterDelete(key: string) {',
        '  return providerDelete(key);',
        '}',
        '',
        'function providerDelete(key: string) {',
        '  return key.length;',
        '}',
        '',
        'export function forwardValue(value: string) {',
        '  return innerValue(value);',
        '}',
        '',
        'function innerValue(value: string) {',
        '  return value.length;',
        '}',
      ],
      'src/contracts.ts': [
        'export function deleteHorse(name: string) {',
        '  return deleteHorseImpl(name);',
        '}',
        '',
        'function deleteHorseImpl(name: string) {',
        '  return name.length;',
        '}',
        '',
        'function forwardHorse(name: string) {',
        '  return deleteHorseImpl(name);',
        '}',
      ],
    });

    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/passthrough.ts')
      .document(2, 'typescript', 'src/contracts.ts')
      .symbol(
        1,
        'scip-typescript npm fixture 1.0.0 src/`passthrough.ts`/storageAdapterDelete().',
        'storageAdapterDelete',
        6,
      )
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`passthrough.ts`/providerDelete().', 'providerDelete', 6)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`passthrough.ts`/forwardValue().', 'forwardValue', 6)
      .symbol(4, 'scip-typescript npm fixture 1.0.0 src/`passthrough.ts`/innerValue().', 'innerValue', 6)
      .symbol(5, 'scip-typescript npm fixture 1.0.0 src/`contracts.ts`/deleteHorse().', 'deleteHorse', 6)
      .symbol(6, 'scip-typescript npm fixture 1.0.0 src/`contracts.ts`/deleteHorseImpl().', 'deleteHorseImpl', 6)
      .symbol(7, 'scip-typescript npm fixture 1.0.0 src/`contracts.ts`/forwardHorse().', 'forwardHorse', 6)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 1, 2, 4, 0, 6, 1)
      .definition(3, 1, 3, 8, 0, 10, 1)
      .definition(4, 1, 4, 12, 0, 14, 1)
      .definition(5, 2, 5, 0, 0, 2, 1)
      .definition(6, 2, 6, 4, 0, 6, 1)
      .definition(7, 2, 7, 8, 0, 10, 1)
      .chunk(1, 1, 0, 2)
      .chunk(2, 1, 4, 6, 1)
      .chunk(3, 1, 8, 10, 2)
      .chunk(4, 1, 12, 14, 3)
      .chunk(5, 2, 0, 2)
      .chunk(6, 2, 4, 6, 1)
      .chunk(7, 2, 8, 10, 2)
      .mention(1, 1, 1)
      .mention(1, 2, 0)
      .mention(2, 2, 1)
      .mention(3, 3, 1)
      .mention(3, 4, 0)
      .mention(4, 4, 1)
      .mention(5, 5, 1)
      .mention(5, 6, 0)
      .mention(6, 6, 1)
      .mention(7, 7, 1)
      .mention(7, 6, 0)
      .write();

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot,
    };
    const db = new ScipDatabase(config);
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('passthroughCandidates output classification', () => {
  it('separates boundary-shaped passthroughs from direct inline candidates', () => {
    withPassthroughFixture((db) => {
      const results = passthroughCandidates(db, { maxLoc: 5, semantic: false, limit: 10 });

      const boundary = results.find((result) => result.shortName.endsWith('storageAdapterDelete()'));
      expect(boundary).toBeDefined();
      expect(boundary).toMatchObject({
        actionTier: 'signal',
        forwardsToShort: 'src:passthrough:providerDelete()',
        publicFacadeEvidence: [],
        recommendation: expect.stringContaining('Review the boundary before inlining'),
      });
      expect(boundary!.boundaryEvidence).toEqual(
        expect.arrayContaining([expect.stringContaining('passthrough name has adapter term: adapter')]),
      );

      const direct = results.find((result) => result.shortName.endsWith('forwardValue()'));
      expect(direct).toBeDefined();
      expect(direct).toMatchObject({
        actionTier: 'direct',
        forwardsToShort: 'src:passthrough:innerValue()',
        boundaryEvidence: [],
        publicFacadeEvidence: [],
        recommendation: expect.stringContaining('Inline or remove this passthrough'),
      });

      const publicFacade = results.find((result) => result.shortName.endsWith('deleteHorse()'));
      expect(publicFacade).toBeDefined();
      expect(publicFacade).toMatchObject({
        actionTier: 'signal',
        forwardsToShort: 'src:contracts:deleteHorseImpl()',
        boundaryEvidence: [],
        recommendation: expect.stringContaining('Review the public API before inlining'),
      });
      expect(publicFacade!.publicFacadeEvidence).toContain(
        'exported passthrough is declared on the package public surface',
      );

      const privateForward = results.find((result) => result.shortName.endsWith('forwardHorse()'));
      expect(privateForward).toBeDefined();
      expect(privateForward).toMatchObject({
        actionTier: 'direct',
        boundaryEvidence: [],
        publicFacadeEvidence: [],
        recommendation: expect.stringContaining('Inline or remove this passthrough'),
      });

      const report = health(db);
      const passthroughScore = report.scoreBreakdown.find((deduction) => deduction.axis === 'passthroughs');
      expect(passthroughScore?.detail).toContain('4 passthrough candidate(s) (2.5 score-weighted)');
    });
  });
});

describe('applyFacadeEvidence', () => {
  it('tiers sibling forwards from one file to one collaborator as a facade boundary', () => {
    const forward = (name: string, file: string, target: string) => ({
      symbol: `sym:${name}`,
      shortName: name,
      file,
      startLine: 0,
      endLine: 2,
      loc: 3,
      forwardsTo: `sym:${name}-target`,
      forwardsToShort: name,
      forwardsToFile: target,
      actionTier: 'direct' as const,
      boundaryEvidence: [] as string[],
      publicFacadeEvidence: [] as string[],
      recommendation: 'inline',
    });
    const results = applyFacadeEvidence([
      forward('login', 'src/auth.service.ts', 'src/auth-browser.service.ts'),
      forward('logout', 'src/auth.service.ts', 'src/auth-browser.service.ts'),
      forward('refresh', 'src/auth.service.ts', 'src/auth-browser.service.ts'),
      forward('lone', 'src/other.service.ts', 'src/helper.ts'),
    ]);
    expect(results.slice(0, 3).map((row) => row.actionTier)).toEqual(['signal', 'signal', 'signal']);
    expect(results[0]?.boundaryEvidence).toEqual([
      'facade: 3 sibling forwards from this file to src/auth-browser.service.ts',
    ]);
    expect(results[3]).toEqual(expect.objectContaining({ actionTier: 'direct', boundaryEvidence: [] }));
  });
});
