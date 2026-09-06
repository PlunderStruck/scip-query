import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { localityCandidates } from '../../../src/queries/cleanup/locality-candidates.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const SQLITE_FIXTURE_TIMEOUT_MS = 15_000;

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
      'src/features/horses/shared/index.ts': ['export const horseFeatureSharedMarker = true;'],
      'src/shared/unused-format.ts': [
        'export function unusedFormat(name: string) {',
        '  return name.toLowerCase();',
        '}',
      ],
      'backend/src/prisma.ts': ['export const prisma = {};'],
      'backend/src/workflows/horses.ts': [
        "import prisma from '../prisma';",
        "import { AppServices } from '../effect/services';",
        '',
        'export const horsesWorkflow = { prisma, services: AppServices };',
      ],
      'backend/prisma/seed.ts': ["import prisma from '../src/prisma';", '', 'export const seed = prisma;'],
      'backend/src/effect/services.ts': ['export const AppServices = {};'],
      'backend/src/effect/runWorkflow.ts': [
        "import { AppServices } from './services';",
        '',
        'export const runWorkflow = AppServices;',
      ],
      'backend/src/shared/index.ts': ['export const backendSharedMarker = true;'],
      'backend/src/policies/accessRules.ts': ['export function canEditHorse() {', '  return true;', '}'],
      'backend/src/routes/horses.ts': [
        "import { canEditHorse } from '../policies/accessRules';",
        '',
        'export const horseRouteAccess = canEditHorse();',
      ],
      'backend/src/workflows/auditPolicyUse.ts': [
        "import { canEditHorse } from '../policies/accessRules';",
        '',
        'export const auditPolicyUse = canEditHorse();',
      ],
      'backend/src/middleware/validate.ts': ['export function validateBody() {', '  return true;', '}'],
      'backend/src/effect/defineRoute.ts': [
        "import { validateBody } from '../middleware/validate';",
        '',
        'export const defineRoute = validateBody;',
      ],
      'backend/src/services/private/serviceSecret.ts': ['export function serviceSecret() {', '  return true;', '}'],
      'backend/src/services/serviceA.ts': [
        "import { serviceSecret } from './private/serviceSecret';",
        '',
        'export const serviceA = serviceSecret();',
      ],
      'backend/src/services/serviceB.ts': [
        "import { serviceSecret } from './private/serviceSecret';",
        '',
        'export const serviceB = serviceSecret();',
      ],
      'src/hooks/useAsyncLoader.ts': ['export function useAsyncLoader() {', '  return true;', '}'],
      'src/components/board/Board.ts': [
        "import { useAsyncLoader } from '../../hooks/useAsyncLoader';",
        '',
        'export const boardLoader = useAsyncLoader();',
      ],
      'src/components/chat/Chat.ts': [
        "import { useAsyncLoader } from '../../hooks/useAsyncLoader';",
        '',
        'export const chatLoader = useAsyncLoader();',
      ],
      'packages/companion/src/agent-command-options.ts': [
        'export function toOptionalString(value: unknown) {',
        "  return typeof value === 'string' ? value : undefined;",
        '}',
      ],
      'packages/companion/src/agent-dispatch-client.ts': [
        "import { toOptionalString } from './agent-command-options';",
        '',
        "export const dispatchClientOption = toOptionalString('client');",
      ],
      'packages/companion/src/agent-session.ts': [
        "import { toOptionalString } from './agent-command-options';",
        '',
        "export const sessionOption = toOptionalString('session');",
      ],
    });

    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/shared/horse-format.ts')
      .document(2, 'typescript', 'src/features/horses/screens/HorseList.ts')
      .document(3, 'typescript', 'src/features/horses/routes/HorseRoute.ts')
      .document(4, 'typescript', 'src/features/horses/shared/index.ts')
      .document(5, 'typescript', 'src/shared/unused-format.ts')
      .document(6, 'typescript', 'backend/src/prisma.ts')
      .document(7, 'typescript', 'backend/src/workflows/horses.ts')
      .document(8, 'typescript', 'backend/prisma/seed.ts')
      .document(9, 'typescript', 'backend/src/effect/services.ts')
      .document(10, 'typescript', 'backend/src/effect/runWorkflow.ts')
      .document(11, 'typescript', 'backend/src/shared/index.ts')
      .document(12, 'typescript', 'backend/src/policies/accessRules.ts')
      .document(13, 'typescript', 'backend/src/routes/horses.ts')
      .document(14, 'typescript', 'backend/src/workflows/auditPolicyUse.ts')
      .document(15, 'typescript', 'backend/src/middleware/validate.ts')
      .document(16, 'typescript', 'backend/src/effect/defineRoute.ts')
      .document(17, 'typescript', 'backend/src/services/private/serviceSecret.ts')
      .document(18, 'typescript', 'backend/src/services/serviceA.ts')
      .document(19, 'typescript', 'backend/src/services/serviceB.ts')
      .document(20, 'typescript', 'src/hooks/useAsyncLoader.ts')
      .document(21, 'typescript', 'src/components/board/Board.ts')
      .document(22, 'typescript', 'src/components/chat/Chat.ts')
      .document(23, 'typescript', 'packages/companion/src/agent-command-options.ts')
      .document(24, 'typescript', 'packages/companion/src/agent-dispatch-client.ts')
      .document(25, 'typescript', 'packages/companion/src/agent-session.ts')
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
      .symbol(
        4,
        'scip-typescript npm fixture 1.0.0 src/`features/horses/shared/index.ts`/horseFeatureSharedMarker.',
        'horseFeatureSharedMarker',
        6,
      )
      .symbol(5, 'scip-typescript npm fixture 1.0.0 src/`shared/unused-format.ts`/unusedFormat().', 'unusedFormat', 6)
      .symbol(6, 'scip-typescript npm fixture 1.0.0 backend/src/`prisma.ts`/prisma.', 'prisma', 6)
      .symbol(
        7,
        'scip-typescript npm fixture 1.0.0 backend/src/workflows/`horses.ts`/horsesWorkflow.',
        'horsesWorkflow',
        6,
      )
      .symbol(8, 'scip-typescript npm fixture 1.0.0 backend/prisma/`seed.ts`/seed.', 'seed', 6)
      .symbol(9, 'scip-typescript npm fixture 1.0.0 backend/src/effect/`services.ts`/AppServices.', 'AppServices', 6)
      .symbol(
        10,
        'scip-typescript npm fixture 1.0.0 backend/src/effect/`runWorkflow.ts`/runWorkflow.',
        'runWorkflow',
        6,
      )
      .symbol(
        11,
        'scip-typescript npm fixture 1.0.0 backend/src/shared/`index.ts`/backendSharedMarker.',
        'backendSharedMarker',
        6,
      )
      .symbol(
        12,
        'scip-typescript npm fixture 1.0.0 backend/src/policies/`accessRules.ts`/canEditHorse().',
        'canEditHorse',
        6,
      )
      .symbol(
        13,
        'scip-typescript npm fixture 1.0.0 backend/src/routes/`horses.ts`/horseRouteAccess.',
        'horseRouteAccess',
        6,
      )
      .symbol(
        14,
        'scip-typescript npm fixture 1.0.0 backend/src/workflows/`auditPolicyUse.ts`/auditPolicyUse.',
        'auditPolicyUse',
        6,
      )
      .symbol(
        15,
        'scip-typescript npm fixture 1.0.0 backend/src/middleware/`validate.ts`/validateBody().',
        'validateBody',
        6,
      )
      .symbol(
        16,
        'scip-typescript npm fixture 1.0.0 backend/src/effect/`defineRoute.ts`/defineRoute.',
        'defineRoute',
        6,
      )
      .symbol(
        17,
        'scip-typescript npm fixture 1.0.0 backend/src/services/private/`serviceSecret.ts`/serviceSecret().',
        'serviceSecret',
        6,
      )
      .symbol(18, 'scip-typescript npm fixture 1.0.0 backend/src/services/`serviceA.ts`/serviceA.', 'serviceA', 6)
      .symbol(19, 'scip-typescript npm fixture 1.0.0 backend/src/services/`serviceB.ts`/serviceB.', 'serviceB', 6)
      .symbol(
        20,
        'scip-typescript npm fixture 1.0.0 src/hooks/`useAsyncLoader.ts`/useAsyncLoader().',
        'useAsyncLoader',
        6,
      )
      .symbol(21, 'scip-typescript npm fixture 1.0.0 src/components/board/`Board.ts`/boardLoader.', 'boardLoader', 6)
      .symbol(22, 'scip-typescript npm fixture 1.0.0 src/components/chat/`Chat.ts`/chatLoader.', 'chatLoader', 6)
      .symbol(
        23,
        'scip-typescript npm fixture 1.0.0 packages/companion/src/`agent-command-options.ts`/toOptionalString().',
        'toOptionalString',
        6,
      )
      .symbol(
        24,
        'scip-typescript npm fixture 1.0.0 packages/companion/src/`agent-dispatch-client.ts`/dispatchClientOption.',
        'dispatchClientOption',
        6,
      )
      .symbol(
        25,
        'scip-typescript npm fixture 1.0.0 packages/companion/src/`agent-session.ts`/sessionOption.',
        'sessionOption',
        6,
      )
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 2, 0, 4, 1)
      .definition(3, 3, 3, 2, 0, 4, 1)
      .definition(4, 4, 4, 0, 0, 2, 1)
      .definition(5, 5, 5, 0, 0, 2, 1)
      .definition(6, 6, 6, 0, 0, 1, 1)
      .definition(7, 7, 7, 3, 0, 4, 1)
      .definition(8, 8, 8, 2, 0, 3, 1)
      .definition(9, 9, 9, 0, 0, 1, 1)
      .definition(10, 10, 10, 2, 0, 3, 1)
      .definition(11, 11, 11, 0, 0, 1, 1)
      .definition(12, 12, 12, 0, 0, 2, 1)
      .definition(13, 13, 13, 2, 0, 3, 1)
      .definition(14, 14, 14, 2, 0, 3, 1)
      .definition(15, 15, 15, 0, 0, 2, 1)
      .definition(16, 16, 16, 2, 0, 3, 1)
      .definition(17, 17, 17, 0, 0, 2, 1)
      .definition(18, 18, 18, 2, 0, 3, 1)
      .definition(19, 19, 19, 2, 0, 3, 1)
      .definition(20, 20, 20, 0, 0, 2, 1)
      .definition(21, 21, 21, 2, 0, 3, 1)
      .definition(22, 22, 22, 2, 0, 3, 1)
      .definition(23, 23, 23, 0, 0, 2, 1)
      .definition(24, 24, 24, 2, 0, 3, 1)
      .definition(25, 25, 25, 2, 0, 3, 1)
      .chunk(1, 1, 0, 2)
      .chunk(2, 2, 2, 4)
      .chunk(3, 3, 2, 4)
      .chunk(4, 4, 0, 2)
      .chunk(5, 5, 0, 2)
      .chunk(6, 6, 0, 1)
      .chunk(7, 7, 3, 4)
      .chunk(8, 8, 2, 3)
      .chunk(9, 9, 0, 1)
      .chunk(10, 10, 2, 3)
      .chunk(11, 11, 0, 1)
      .chunk(12, 12, 0, 2)
      .chunk(13, 13, 2, 3)
      .chunk(14, 14, 2, 3)
      .chunk(15, 15, 0, 2)
      .chunk(16, 16, 2, 3)
      .chunk(17, 17, 0, 2)
      .chunk(18, 18, 2, 3)
      .chunk(19, 19, 2, 3)
      .chunk(20, 20, 0, 2)
      .chunk(21, 21, 2, 3)
      .chunk(22, 22, 2, 3)
      .chunk(23, 23, 0, 2)
      .chunk(24, 24, 2, 3)
      .chunk(25, 25, 2, 3)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(2, 1, 0)
      .mention(3, 3, 1)
      .mention(3, 1, 0)
      .mention(4, 4, 1)
      .mention(5, 5, 1)
      .mention(6, 6, 1)
      .mention(7, 7, 1)
      .mention(7, 6, 0)
      .mention(7, 9, 0)
      .mention(8, 8, 1)
      .mention(8, 6, 0)
      .mention(9, 9, 1)
      .mention(10, 10, 1)
      .mention(10, 9, 0)
      .mention(11, 11, 1)
      .mention(12, 12, 1)
      .mention(13, 13, 1)
      .mention(13, 12, 0)
      .mention(14, 14, 1)
      .mention(14, 12, 0)
      .mention(15, 15, 1)
      .mention(16, 16, 1)
      .mention(16, 15, 0)
      .mention(17, 17, 1)
      .mention(18, 18, 1)
      .mention(18, 17, 0)
      .mention(19, 19, 1)
      .mention(19, 17, 0)
      .mention(20, 20, 1)
      .mention(21, 21, 1)
      .mention(21, 20, 0)
      .mention(22, 22, 1)
      .mention(22, 20, 0)
      .mention(23, 23, 1)
      .mention(24, 24, 1)
      .mention(24, 23, 0)
      .mention(25, 25, 1)
      .mention(25, 23, 0)
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

// Every case builds and queries a complete SQLite fixture. Keep the budget local
// so parallel full-suite I/O contention cannot be mistaken for a product hang.
describe('localityCandidates', { timeout: SQLITE_FIXTURE_TIMEOUT_MS }, () => {
  it('reports symbol-level directory ancestry and feature-local ownership', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, { target: 'formatHorseName', semantic: false });

      expect(results).toHaveLength(1);
      const candidate = results[0]!;
      expect(candidate).toMatchObject({
        actionTier: 'signal',
        candidatePath: 'src/shared/horse-format.ts',
        consumerCoverage: 'symbol-observations',
        currentDirectory: 'src/shared',
        nearestCommonDirectory: 'src/features/horses',
        recommendedTier: 'feature-local-shared',
        suggestedHome: 'src/features/horses/shared',
        destinationConfidence: 'candidate',
        whyNoSuggestedHome: null,
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
        expect.arrayContaining([
          'Path and observed-consumer heuristic; confirm conceptual ownership, complete consumers and behavior before moving files.',
        ]),
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
        nearestCommonDirectory: 'src/features/horses',
        recommendedTier: 'feature-local-shared',
        suggestedHome: 'src/features/horses/shared',
        destinationConfidence: 'candidate',
        whyNoSuggestedHome: null,
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
        nearestCommonDirectory: null,
        recommendedTier: 'no-observed-consumers',
        suggestedHome: null,
        destinationConfidence: 'withheld',
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
      const results = localityCandidates(db, { semantic: false, limit: 5, scope: 'src/' });

      const horseFormat = results.find((result) => result.candidatePath === 'src/shared/horse-format.ts');
      expect(horseFormat).toMatchObject({
        candidatePath: 'src/shared/horse-format.ts',
        consumerCoverage: 'file-level',
        nearestCommonDirectory: 'src/features/horses',
      });
    });
  });

  it('withholds suggested homes that would leave the candidate source root', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, { target: 'backend/src/prisma.ts', semantic: false });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        candidatePath: 'backend/src/prisma.ts',
        consumerCoverage: 'file-level',
        nearestCommonDirectory: 'backend',
        recommendedTier: 'sibling-folder',
        suggestedHome: null,
        destinationConfidence: 'withheld',
      });
      expect(results[0]!.whyNoSuggestedHome).toContain('outside source root backend/src');
      expect(results[0]!.counterevidence).toEqual(
        expect.arrayContaining([expect.stringContaining('No suggested home')]),
      );
    });
  });

  it('withholds generic shared homes for named architectural boundaries', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, { target: 'backend/src/effect/services.ts', semantic: false });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        candidatePath: 'backend/src/effect/services.ts',
        consumerCoverage: 'file-level',
        nearestCommonDirectory: 'backend/src',
        recommendedTier: 'sibling-folder',
        suggestedHome: null,
        destinationConfidence: 'withheld',
      });
      expect(results[0]!.whyNoSuggestedHome).toContain('protected directory-name marker');
      expect(results[0]!.reasons).toEqual(expect.arrayContaining([expect.stringContaining('No suggested home')]));
    });
  });

  it('honors repo-specific architectural boundary segments from config', () => {
    withLocalityFixture((db) => {
      const defaultResults = localityCandidates(db, {
        target: 'backend/src/policies/accessRules.ts',
        semantic: false,
      });

      expect(defaultResults).toHaveLength(1);
      expect(defaultResults[0]).toMatchObject({
        candidatePath: 'backend/src/policies/accessRules.ts',
        consumerCoverage: 'file-level',
        nearestCommonDirectory: 'backend/src',
        suggestedHome: 'backend/src/shared',
        destinationConfidence: 'candidate',
        whyNoSuggestedHome: null,
      });

      db.config.locality = { architecturalBoundarySegments: ['policies'] };
      const configuredResults = localityCandidates(db, {
        target: 'backend/src/policies/accessRules.ts',
        semantic: false,
      });

      expect(configuredResults).toHaveLength(1);
      expect(configuredResults[0]).toMatchObject({
        candidatePath: 'backend/src/policies/accessRules.ts',
        consumerCoverage: 'file-level',
        nearestCommonDirectory: 'backend/src',
        suggestedHome: null,
        destinationConfidence: 'withheld',
      });
      expect(configuredResults[0]!.whyNoSuggestedHome).toContain('protected directory-name marker');
    });
  });

  it('withholds direct one-consumer moves out of built-in architectural boundaries', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, {
        target: 'backend/src/middleware/validate.ts',
        semantic: false,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        candidatePath: 'backend/src/middleware/validate.ts',
        consumerCoverage: 'file-level',
        nearestCommonDirectory: 'backend/src/effect',
        recommendedTier: 'sibling-folder',
        suggestedHome: null,
        destinationConfidence: 'withheld',
      });
      expect(results[0]!.whyNoSuggestedHome).toContain(
        'backend/src/middleware matches a protected directory-name marker',
      );
    });
  });

  it('withholds moves from boundary subfolders to broad existing shared owners', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, {
        target: 'backend/src/services/private/serviceSecret.ts',
        semantic: false,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        candidatePath: 'backend/src/services/private/serviceSecret.ts',
        consumerCoverage: 'file-level',
        nearestCommonDirectory: 'backend/src/services',
        recommendedTier: 'sibling-folder',
        suggestedHome: null,
        destinationConfidence: 'withheld',
      });
      expect(results[0]!.whyNoSuggestedHome).toContain(
        'backend/src/services/private matches a protected directory-name marker',
      );
    });
  });

  it('treats hooks as a built-in architectural boundary instead of inventing shared', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, {
        target: 'src/hooks/useAsyncLoader.ts',
        semantic: false,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        candidatePath: 'src/hooks/useAsyncLoader.ts',
        consumerCoverage: 'file-level',
        nearestCommonDirectory: 'src/components',
        suggestedHome: null,
        destinationConfidence: 'withheld',
      });
      expect(results[0]!.whyNoSuggestedHome).toContain('src/hooks matches a protected directory-name marker');
      expect(results[0]!.whyNoSuggestedHome).not.toContain('does not exist');
    });
  });

  it('withholds when a candidate already lives at the nearest common directory', () => {
    withLocalityFixture((db) => {
      const results = localityCandidates(db, {
        target: 'packages/companion/src/agent-command-options.ts',
        semantic: false,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        candidatePath: 'packages/companion/src/agent-command-options.ts',
        consumerCoverage: 'file-level',
        nearestCommonDirectory: 'packages/companion/src',
        suggestedHome: null,
        destinationConfidence: 'withheld',
      });
      expect(results[0]!.whyNoSuggestedHome).toBe(
        'packages/companion/src is already the nearest common directory for its consumers.',
      );
    });
  });
});

describe('locality command scope and identity contracts', () => {
  it('includes external consumers when the candidate scope is narrow', () => {
    withLocalityFixture((db) => {
      const result = localityCandidates(db, { scope: 'src/shared' });
      const horse = result.find((entry) => entry.candidatePath === 'src/shared/horse-format.ts');
      expect(horse?.consumerFiles).toEqual([
        'src/features/horses/routes/HorseRoute.ts',
        'src/features/horses/screens/HorseList.ts',
      ]);
    });
  });

  it('rejects ambiguous symbol targets', () => {
    withLocalityFixture((db) => {
      expect(() => localityCandidates(db, { target: 'format' })).toThrow(/ambiguous/i);
    });
  });
});
