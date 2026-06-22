import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { localityCandidates } from '../../../src/queries/cleanup/locality-candidates.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

function withLocalityFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-locality-candidates-'));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');
  try {
    mkdirSync(projectRoot, { recursive: true });
    writeFixtureFiles(projectRoot, {
      'src/shared/horse-format.ts': [
        'export function formatHorseName(name: string) {',
        '  return name.trim().toUpperCase();',
        '}',
      ],
      'src/features/horses/screens/HorseList.ts': [
        "import { formatHorseName } from '../../../shared/horse-format';",
        '',
        'export function renderHorseList(names: string[]) {',
        '  return names.map(formatHorseName);',
        '}',
      ],
      'src/features/horses/routes/HorseRoute.ts': [
        "import { formatHorseName } from '../../../shared/horse-format';",
        '',
        'export function horseRoute(name: string) {',
        '  return `/horses/${formatHorseName(name)}`;',
        '}',
      ],
      'src/shared/unused-format.ts': [
        'export function unusedFormat(name: string) {',
        '  return name.toLowerCase();',
        '}',
      ],
    });

    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/shared/horse-format.ts')
      .document(2, 'typescript', 'src/features/horses/screens/HorseList.ts')
      .document(3, 'typescript', 'src/features/horses/routes/HorseRoute.ts')
      .document(4, 'typescript', 'src/shared/unused-format.ts')
      .symbol(
        1,
        'scip-typescript npm fixture 1.0.0 src/`shared/horse-format.ts`/formatHorseName().',
        'formatHorseName',
        6,
      )
      .symbol(
        2,
        'scip-typescript npm fixture 1.0.0 src/`features/horses/screens/HorseList.ts`/renderHorseList().',
        'renderHorseList',
        6,
      )
      .symbol(
        3,
        'scip-typescript npm fixture 1.0.0 src/`features/horses/routes/HorseRoute.ts`/horseRoute().',
        'horseRoute',
        6,
      )
      .symbol(4, 'scip-typescript npm fixture 1.0.0 src/`shared/unused-format.ts`/unusedFormat().', 'unusedFormat', 6)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 2, 0, 4, 1)
      .definition(3, 3, 3, 2, 0, 4, 1)
      .definition(4, 4, 4, 0, 0, 2, 1)
      .chunk(1, 1, 0, 2)
      .chunk(2, 2, 2, 4)
      .chunk(3, 3, 2, 4)
      .chunk(4, 4, 0, 2)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(2, 1, 0)
      .mention(3, 3, 1)
      .mention(3, 1, 0)
      .mention(4, 4, 1)
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

describe('localityCandidates', () => {
  it('reports symbol-level directory ancestry and feature-local ownership', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, { target: 'formatHorseName', semantic: false });

      expect(results).toHaveLength(1);
      const candidate = results[0]!;
      expect(candidate).toMatchObject({
        actionTier: 'signal',
        candidatePath: 'src/shared/horse-format.ts',
        consumerCoverage: 'exact',
        currentDirectory: 'src/shared',
        nearestCommonOwner: 'src/features/horses',
        recommendedTier: 'feature-local-shared',
        suggestedHome: 'src/features/horses/shared',
        sourceUnit: {
          kind: 'symbol',
          file: 'src/shared/horse-format.ts',
          symbol: 'scip-typescript npm fixture 1.0.0 src/`shared/horse-format.ts`/formatHorseName().',
        },
      });
      expect(candidate.consumerFiles).toEqual([
        'src/features/horses/routes/HorseRoute.ts',
        'src/features/horses/screens/HorseList.ts',
      ]);
      expect(candidate.directoryAncestry).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'src/shared',
            markers: expect.arrayContaining(['shared']),
          }),
        ]),
      );
      expect(candidate.boundaryMarkers).toEqual(
        expect.arrayContaining(['shared: src/shared', 'feature: src/features']),
      );
      expect(candidate.counterevidence).toEqual(
        expect.arrayContaining(['Report-only signal; review ownership before moving files.']),
      );
    });
  });

  it('reports file-level module locality when the target is a path', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, { target: 'src/shared/horse-format.ts', semantic: false });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        actionTier: 'signal',
        consumerCoverage: 'file-level',
        nearestCommonOwner: 'src/features/horses',
        recommendedTier: 'feature-local-shared',
        suggestedHome: 'src/features/horses/shared',
        sourceUnit: {
          kind: 'file',
          file: 'src/shared/horse-format.ts',
        },
      });
      expect(results[0]!.counterevidence).toEqual(
        expect.arrayContaining([
          'File-level import evidence can hide which exported unit is actually used.',
          'File targets describe module locality, not symbol-level usage.',
        ]),
      );
    });
  });

  it('keeps no-consumer targets as report-only counterevidence', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, { target: 'unusedFormat', semantic: false });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        actionTier: 'signal',
        consumerCoverage: 'none',
        nearestCommonOwner: null,
        recommendedTier: 'no-exact-consumers',
        suggestedHome: null,
        sourceUnit: {
          kind: 'symbol',
          file: 'src/shared/unused-format.ts',
        },
      });
      expect(results[0]!.counterevidence).toEqual(
        expect.arrayContaining(['No consumers were found in the current index.']),
      );
      expect(results[0]!.recommendation).toContain('no consumers were found');
    });
  });

  it('uses scan mode to surface files with consumer-backed locality evidence', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, { semantic: false, limit: 5 });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        candidatePath: 'src/shared/horse-format.ts',
        consumerCoverage: 'file-level',
        nearestCommonOwner: 'src/features/horses',
      });
    });
  });
});
