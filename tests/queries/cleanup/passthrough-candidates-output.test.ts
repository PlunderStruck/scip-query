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
        '',
        'export function handler(req: string, res: string, next: string) {',
        '  return jsonHandler(async () => deleteHorseImpl(req))(req, res, next);',
        '}',
        '',
        'export function reveal(progress: number, start: number, end = start + 6) {',
        '  return smoothstep(progress, start, end);',
        '}',
        '',
        'function smoothstep(progress: number, start: number, end: number) {',
        '  return progress + start + end;',
        '}',
      ],
      'src/auth/rates.ts': [
        'export function toBaseRate(raw: string) {',
        '  return parseBaseRate(raw);',
        '}',
        '',
        'function parseBaseRate(raw: string) {',
        '  return raw.length;',
        '}',
      ],
    });

    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/passthrough.ts')
      .document(2, 'typescript', 'src/contracts.ts')
      .document(3, 'typescript', 'src/auth/rates.ts')
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
      .symbol(8, 'scip-typescript npm fixture 1.0.0 src/auth/`rates.ts`/toBaseRate().', 'toBaseRate', 6)
      .symbol(9, 'scip-typescript npm fixture 1.0.0 src/auth/`rates.ts`/parseBaseRate().', 'parseBaseRate', 6)
      .symbol(10, 'scip-typescript npm fixture 1.0.0 src/`contracts.ts`/handler().', 'handler', 6)
      .symbol(11, 'scip-typescript npm fixture 1.0.0 src/`contracts.ts`/reveal().', 'reveal', 6)
      .symbol(12, 'scip-typescript npm fixture 1.0.0 src/`contracts.ts`/smoothstep().', 'smoothstep', 6)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 1, 2, 4, 0, 6, 1)
      .definition(3, 1, 3, 8, 0, 10, 1)
      .definition(4, 1, 4, 12, 0, 14, 1)
      .definition(5, 2, 5, 0, 0, 2, 1)
      .definition(6, 2, 6, 4, 0, 6, 1)
      .definition(7, 2, 7, 8, 0, 10, 1)
      .definition(8, 3, 8, 0, 0, 2, 1)
      .definition(9, 3, 9, 4, 0, 6, 1)
      .definition(10, 2, 10, 12, 0, 14, 1)
      .definition(11, 2, 11, 16, 0, 18, 1)
      .definition(12, 2, 12, 20, 0, 22, 1)
      .chunk(1, 1, 0, 2)
      .chunk(2, 1, 4, 6, 1)
      .chunk(3, 1, 8, 10, 2)
      .chunk(4, 1, 12, 14, 3)
      .chunk(5, 2, 0, 2)
      .chunk(6, 2, 4, 6, 1)
      .chunk(7, 2, 8, 10, 2)
      .chunk(8, 3, 0, 2)
      .chunk(9, 3, 4, 6, 1)
      .chunk(10, 2, 12, 14, 3)
      .chunk(11, 2, 16, 18, 4)
      .chunk(12, 2, 20, 22, 5)
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
      .mention(8, 8, 1)
      .mention(8, 9, 0)
      .mention(9, 9, 1)
      .mention(10, 10, 1)
      .mention(10, 6, 0)
      .mention(11, 11, 1)
      .mention(11, 12, 0)
      .mention(12, 12, 1)
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

      // `toBaseRate` and `parseBaseRate` share the `rate` token, and `auth`
      // is the directory both live in: shared vocabulary and a shared path
      // are not a boundary between the forward and its target.
      const sharedVocabulary = results.find((result) => result.shortName.endsWith('toBaseRate()'));
      expect(sharedVocabulary).toBeDefined();
      expect(sharedVocabulary).toMatchObject({
        actionTier: 'direct',
        forwardsToShort: 'src:auth:rates:parseBaseRate()',
        boundaryEvidence: [],
        publicFacadeEvidence: [],
      });

      // `handler` returns `jsonHandler(async () => ...)(req, res, next)`: the
      // matching outer arguments do not make a curried handler a forward.
      expect(results.find((result) => result.shortName.endsWith('handler()'))).toBeUndefined();
      // `reveal` adds a parameter default before forwarding; that default is behavior.
      expect(results.find((result) => result.shortName.endsWith('reveal()'))).toBeUndefined();

      const report = health(db);
      expect(report.findings.passthroughs).toBe(5);
    });
  });
});

describe('applyFacadeEvidence (composed service)', () => {
  it('tiers a class whose methods forward to members of several collaborators as a facade', () => {
    const member = (owner: string, name: string, file: string, target: string, targetFile: string) => ({
      symbol: `scip-typescript npm fixture 1.0.0 src/\`${file}\`/${owner}#${name}().`,
      shortName: `${owner}:${name}()`,
      file: `src/${file}`,
      startLine: 0,
      endLine: 2,
      loc: 3,
      forwardsTo: `scip-typescript npm fixture 1.0.0 src/\`${targetFile}\`/${target}#${name}().`,
      forwardsToShort: `${target}:${name}()`,
      forwardsToFile: `src/${targetFile}`,
      actionTier: 'direct' as const,
      boundaryEvidence: [] as string[],
      publicFacadeEvidence: [] as string[],
      recommendation: 'inline',
    });
    const results = applyFacadeEvidence([
      member(
        'NotificationsService',
        'notifyAssigned',
        'notifications.service.ts',
        'TriggersService',
        'triggers.service.ts',
      ),
      member('NotificationsService', 'markAsRead', 'notifications.service.ts', 'InboxService', 'inbox.service.ts'),
      member(
        'NotificationsService',
        'updatePreferences',
        'notifications.service.ts',
        'PreferencesService',
        'preferences.service.ts',
      ),
      member('ReportsService', 'getPulse', 'reports.service.ts', 'PulseService', 'pulse.service.ts'),
    ]);
    expect(results.slice(0, 3).map((row) => row.actionTier)).toEqual(['signal', 'signal', 'signal']);
    expect(results[0]?.boundaryEvidence).toEqual([
      'facade: 3 methods of NotificationsService forward to members of its collaborators',
    ]);
    expect(results[3]).toEqual(expect.objectContaining({ actionTier: 'direct', boundaryEvidence: [] }));
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
