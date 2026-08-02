import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import {
  GIT_DIFF_UNAVAILABLE_NOTE,
  baseContentPathsForDiffPlan,
  createBaseContentResultReader,
  diffImpactPlan,
  fileContentAtBase,
  fileContentsAtBase,
  readBaseContent,
  readBaseContents,
} from '../../../src/queries/impact/diff-impact.js';
import { incompleteMigration } from '../../../src/queries/impact/incomplete-migration.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { createEvidenceSchema } from '../../fixtures/evidence-fixture.js';

// Scenario: an agent extracted formatThing() (calls coreOne/coreTwo/coreThree)
// into src/util.ts and wired src/site-a.ts into it, but site-b and site-c
// still hold the same callee pattern inline. site-d already calls the helper
// (migrated), site-e holds the pattern but is part of the diff itself.
//
// Git state: base commit has every file WITHOUT the helper; the working tree
// adds the helper and the site-a wiring (uncommitted), so `base: 'HEAD'`
// sees util.ts / site-a.ts / site-e.ts as the diff.

let repoRoot: string;
let db: ScipDatabase;

function gitIn(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t.t',
      GIT_AUTHOR_DATE: '1700000000 +0000',
      GIT_COMMITTER_DATE: '1700000000 +0000',
    },
  });
}

function git(...args: string[]): void {
  gitIn(repoRoot, ...args);
}

const sym = (path: string, name: string) => `scip-typescript npm pkg 1.0.0 src/\`${path}\`/${name}().`;

const SITE_BODY = [
  "import { coreOne, coreTwo, coreThree } from './core.js';",
  '',
  'export function %NAME%() {',
  '  const a = coreOne();',
  '  const b = coreTwo();',
  '  const c = coreThree();',
  '  return a + b + c;',
  '}',
  '',
].join('\n');

function writeBaseFiles(): void {
  writeFileSync(
    join(repoRoot, 'src', 'core.ts'),
    [
      'export function coreOne() { return 1; }',
      'export function coreTwo() { return 2; }',
      'export function coreThree() { return 3; }',
      'export function extraFOne() { return 4; }',
      'export function extraFTwo() { return 5; }',
      'export function extraFThree() { return 6; }',
      'export function extraFFour() { return 7; }',
      'export function extraFFive() { return 8; }',
      'export function extraFSix() { return 9; }',
      '',
    ].join('\n'),
  );
  writeFileSync(join(repoRoot, 'src', 'util.ts'), 'export const placeholder = 1;\n');
  writeFileSync(join(repoRoot, 'src', 'site-a.ts'), 'export function siteA() { return 0; }\n');
  writeFileSync(
    join(repoRoot, 'src', 'site-b.ts'),
    [
      "import { coreOne, coreTwo, coreThree } from './core.js';",
      'export function extraB() { return 9; }',
      'export function siteB() {',
      '  const a = coreOne();',
      '  const b = coreTwo();',
      '  const c = coreThree();',
      '  return a + b + c + extraB();',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(repoRoot, 'src', 'site-c.ts'), SITE_BODY.replace('%NAME%', 'siteC'));
  writeFileSync(join(repoRoot, 'src', 'billing.ts'), SITE_BODY.replace('%NAME%', 'processBilling'));
  writeFileSync(
    join(repoRoot, 'src', 'site-f.ts'),
    [
      "import { coreOne, coreTwo, coreThree, extraFFive, extraFFour, extraFOne, extraFSix, extraFThree, extraFTwo } from './core.js';",
      'export function siteF() {',
      '  const a = coreOne();',
      '  const b = coreTwo();',
      '  const c = coreThree();',
      '  const d = extraFOne();',
      '  const e = extraFTwo();',
      '  const f = extraFThree();',
      '  const g = extraFFour();',
      '  const h = extraFFive();',
      '  const i = extraFSix();',
      '  return a + b + c + d + e + f + g + h + i;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repoRoot, 'src', 'site-d.ts'),
    [
      "import { coreOne, coreTwo, coreThree } from './core.js';",
      "import { formatThing } from './util.js';",
      'export function siteD() {',
      '  const a = coreOne();',
      '  const b = coreTwo();',
      '  const c = coreThree();',
      '  return a + b + c + formatThing();',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(repoRoot, 'src', 'site-e.ts'), 'export function siteE() { return 5; }\n');
}

function writeWorkingTreeChanges(): void {
  writeFileSync(
    join(repoRoot, 'src', 'util.ts'),
    [
      "import { coreOne, coreTwo, coreThree } from './core.js';",
      '',
      'export function formatThing() {',
      '  const a = coreOne();',
      '  const b = coreTwo();',
      '  const c = coreThree();',
      '  return a + b + c;',
      '}',
      'export function tinyHelper() { return coreOne(); }',
      'export function orphanHelper() { return coreOne() + coreTwo() + coreThree(); }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repoRoot, 'src', 'site-a.ts'),
    [
      "import { formatThing } from './util.js';",
      '',
      'export function siteA() {',
      '  return formatThing();',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(repoRoot, 'src', 'site-e.ts'), SITE_BODY.replace('%NAME%', 'siteE'));
}

function createFixtureDb(dbPath: string): void {
  const sqliteDb = new Database(dbPath);
  createEvidenceSchema(sqliteDb);

  sqliteDb.exec(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'src/core.ts'),
      (2, 'typescript', 'src/util.ts'),
      (3, 'typescript', 'src/site-a.ts'),
      (4, 'typescript', 'src/site-b.ts'),
      (5, 'typescript', 'src/site-c.ts'),
      (6, 'typescript', 'src/site-d.ts'),
      (7, 'typescript', 'src/site-e.ts'),
      (8, 'typescript', 'src/site-f.ts'),
      (9, 'typescript', 'src/billing.ts');

    INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
      (1, '${sym('core.ts', 'coreOne')}', 'coreOne', 3, 'function'),
      (2, '${sym('core.ts', 'coreTwo')}', 'coreTwo', 3, 'function'),
      (3, '${sym('core.ts', 'coreThree')}', 'coreThree', 3, 'function'),
      (4, '${sym('util.ts', 'formatThing')}', 'formatThing', 3, 'function'),
      (5, '${sym('util.ts', 'tinyHelper')}', 'tinyHelper', 3, 'function'),
      (6, '${sym('util.ts', 'orphanHelper')}', 'orphanHelper', 3, 'function'),
      (7, '${sym('site-a.ts', 'siteA')}', 'siteA', 3, 'function'),
      (8, '${sym('site-b.ts', 'siteB')}', 'siteB', 3, 'function'),
      (9, '${sym('site-b.ts', 'extraB')}', 'extraB', 3, 'function'),
      (10, '${sym('site-c.ts', 'siteC')}', 'siteC', 3, 'function'),
      (11, '${sym('site-d.ts', 'siteD')}', 'siteD', 3, 'function'),
      (12, '${sym('site-e.ts', 'siteE')}', 'siteE', 3, 'function'),
      (13, '${sym('site-f.ts', 'siteF')}', 'siteF', 3, 'function'),
      (14, '${sym('core.ts', 'extraFOne')}', 'extraFOne', 3, 'function'),
      (15, '${sym('core.ts', 'extraFTwo')}', 'extraFTwo', 3, 'function'),
      (16, '${sym('core.ts', 'extraFThree')}', 'extraFThree', 3, 'function'),
      (17, '${sym('core.ts', 'extraFFour')}', 'extraFFour', 3, 'function'),
      (18, '${sym('core.ts', 'extraFFive')}', 'extraFFive', 3, 'function'),
      (19, '${sym('core.ts', 'extraFSix')}', 'extraFSix', 3, 'function'),
      (20, '${sym('billing.ts', 'processBilling')}', 'processBilling', 3, 'function');

    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 1, 1, 0, 0, 0, 40),
      (2, 1, 2, 1, 0, 1, 40),
      (3, 1, 3, 2, 0, 2, 42),
      (4, 2, 4, 2, 0, 7, 1),
      (5, 2, 5, 8, 0, 8, 50),
      (6, 2, 6, 9, 0, 9, 78),
      (7, 3, 7, 2, 0, 4, 1),
      (8, 4, 8, 2, 0, 7, 1),
      (9, 4, 9, 1, 0, 1, 38),
      (10, 5, 10, 2, 0, 7, 1),
      (11, 6, 11, 2, 0, 7, 1),
      (12, 7, 12, 2, 0, 7, 1),
      (13, 8, 13, 1, 0, 11, 1),
      (14, 1, 14, 3, 0, 3, 42),
      (15, 1, 15, 4, 0, 4, 42),
      (16, 1, 16, 5, 0, 5, 44),
      (17, 1, 17, 6, 0, 6, 43),
      (18, 1, 18, 7, 0, 7, 43),
      (19, 1, 19, 8, 0, 8, 42),
      (20, 9, 20, 2, 0, 7, 1);

    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 8, X'00'),
      (2, 2, 0, 2, 7, X'00'),
      (3, 2, 1, 8, 8, X'00'),
      (4, 2, 2, 9, 9, X'00'),
      (5, 3, 0, 2, 4, X'00'),
      (6, 4, 0, 2, 7, X'00'),
      (7, 4, 1, 1, 1, X'00'),
      (8, 5, 0, 2, 7, X'00'),
      (9, 6, 0, 2, 7, X'00'),
      (10, 7, 0, 2, 7, X'00'),
      (11, 8, 0, 1, 11, X'00'),
      (12, 9, 0, 2, 7, X'00');

    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (1, 2, 1),
      (1, 3, 1),
      (1, 14, 1),
      (1, 15, 1),
      (1, 16, 1),
      (1, 17, 1),
      (1, 18, 1),
      (1, 19, 1),
      (2, 4, 1),
      (2, 1, 0),
      (2, 2, 0),
      (2, 3, 0),
      (3, 5, 1),
      (3, 1, 0),
      (4, 6, 1),
      (4, 1, 0),
      (4, 2, 0),
      (4, 3, 0),
      (5, 7, 1),
      (5, 4, 0),
      (6, 8, 1),
      (6, 1, 0),
      (6, 2, 0),
      (6, 3, 0),
      (6, 9, 0),
      (7, 9, 1),
      (8, 10, 1),
      (8, 1, 0),
      (8, 2, 0),
      (8, 3, 0),
      (9, 11, 1),
      (9, 1, 0),
      (9, 2, 0),
      (9, 3, 0),
      (9, 4, 0),
      (10, 12, 1),
      (10, 1, 0),
      (10, 2, 0),
      (10, 3, 0),
      (11, 13, 1),
      (11, 1, 0),
      (11, 2, 0),
      (11, 3, 0),
      (11, 14, 0),
      (11, 15, 0),
      (11, 16, 0),
      (11, 17, 0),
      (11, 18, 0),
      (11, 19, 0),
      (12, 20, 1),
      (12, 1, 0),
      (12, 2, 0),
      (12, 3, 0);
  `);

  sqliteDb.close();
}

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'scip-incomplete-migration-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  git('init');
  writeBaseFiles();
  git('add', '-A');
  git('commit', '-m', 'base', '--no-gpg-sign');
  writeWorkingTreeChanges();

  const dbPath = join(repoRoot, 'index.db');
  createFixtureDb(dbPath);
  const config: ScipQueryConfig = {
    dbPath,
    indexPath: join(repoRoot, 'index.scip'),
    projectRoot: repoRoot,
  };
  db = new ScipDatabase(config);
});

afterAll(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('incomplete-migration', () => {
  it('batch reads base file contents while preserving missing and non-blob paths', () => {
    const contents = fileContentsAtBase({
      projectRoot: repoRoot,
      base: 'HEAD',
      relativePaths: ['src', 'src/util.ts', 'src/does-not-exist.ts', 'src/util.ts'],
    });

    expect(contents.size).toBe(3);
    expect(contents.get('src')).toBeNull();
    expect(contents.get('src/util.ts')).toContain('placeholder');
    expect(contents.get('src/does-not-exist.ts')).toBeNull();

    const strict = readBaseContents({
      projectRoot: repoRoot,
      base: 'HEAD',
      relativePaths: ['src', 'src/util.ts', 'src/does-not-exist.ts', 'src/util.ts'],
    });
    expect(strict).toEqual(
      new Map([
        ['src', { state: 'absent' }],
        ['src/util.ts', { state: 'present', content: expect.stringContaining('placeholder') }],
        ['src/does-not-exist.ts', { state: 'absent' }],
      ]),
    );
  });

  it('distinguishes confirmed absence from Git/base unavailability', () => {
    expect(
      readBaseContent({
        projectRoot: repoRoot,
        base: 'HEAD',
        relativePath: 'src/does-not-exist.ts',
      }),
    ).toEqual({ state: 'absent' });

    const invalid = readBaseContent({
      projectRoot: repoRoot,
      base: 'definitely-not-a-real-base',
      relativePath: 'src/util.ts',
    });
    expect(invalid).toEqual({
      state: 'unavailable',
      reason: expect.stringContaining('definitely-not-a-real-base'),
    });
    expect(() =>
      fileContentAtBase({
        projectRoot: repoRoot,
        base: 'definitely-not-a-real-base',
        relativePath: 'src/util.ts',
      }),
    ).toThrow('Base content unavailable');
    expect(() =>
      readBaseContent({
        projectRoot: repoRoot,
        base: 'HEAD',
        relativePath: '../outside.ts',
      }),
    ).toThrow('refusing unsafe project file path');

    const timedOut = readBaseContents(
      {
        projectRoot: repoRoot,
        base: 'HEAD',
        relativePaths: ['src/util.ts'],
      },
      {
        resolveCommit: () => 'resolved',
        readBatch: () => {
          throw Object.assign(new Error('Git batch timed out'), { code: 'ETIMEDOUT' });
        },
      },
    );
    expect(timedOut.get('src/util.ts')).toEqual({
      state: 'unavailable',
      reason: expect.stringContaining('Git batch timed out'),
    });

    const malformed = readBaseContents(
      {
        projectRoot: repoRoot,
        base: 'HEAD',
        relativePaths: ['src/util.ts'],
      },
      {
        resolveCommit: () => 'resolved',
        readBatch: () => Buffer.from('not a valid cat-file batch'),
      },
    );
    expect(malformed.get('src/util.ts')).toEqual({
      state: 'unavailable',
      reason: expect.stringContaining('Malformed git cat-file'),
    });

    const reader = createBaseContentResultReader({
      projectRoot: repoRoot,
      base: 'definitely-not-a-real-base',
      preloadPaths: ['src/util.ts'],
    });
    expect(reader('src/util.ts')).toEqual({
      state: 'unavailable',
      reason: expect.stringContaining('definitely-not-a-real-base'),
    });
  });

  it('reports un-migrated sites for a freshly wired helper', () => {
    const result = incompleteMigration(db, { base: 'HEAD', semantic: false });

    expect(result.available).toBe(true);
    expect(result.changedFiles.sort()).toEqual(['src/site-a.ts', 'src/site-e.ts', 'src/util.ts']);
    expect(result.helpersChecked).toBe(1);
    expect(result.findings).toHaveLength(1);

    const finding = result.findings[0]!;
    expect(finding.helperShortName).toContain('formatThing');
    expect(finding.helperFile).toBe('src/util.ts');
    expect(finding).toMatchObject({
      helperShape: 'specific-callee-cluster',
      helperCalleeCount: 3,
      specificHelperCalleeCount: 3,
    });
    expect(finding.migratedFiles).toContain('src/site-a.ts');

    const leftoverFiles = finding.leftovers.map((leftover) => leftover.file);
    expect(leftoverFiles).toEqual(['src/site-c.ts', 'src/site-b.ts', 'src/billing.ts']);
    expect(leftoverFiles).not.toContain('src/site-f.ts');
    const siteB = finding.leftovers.find((leftover) => leftover.file === 'src/site-b.ts')!;
    const siteC = finding.leftovers.find((leftover) => leftover.file === 'src/site-c.ts')!;
    const billing = finding.leftovers.find((leftover) => leftover.file === 'src/billing.ts')!;
    expect(siteB).toMatchObject({
      containment: 1,
      siteCoverage: 0.75,
      uniqueSiteCalleeCount: 1,
      migrationScope: 'same-scope',
    });
    expect(siteB.migrationScopeReasons[0]).toContain('site');
    expect(siteC.migrationScope).toBe('same-scope');
    expect(billing).toMatchObject({
      containment: 1,
      siteCoverage: 1,
      uniqueSiteCalleeCount: 0,
      migrationScope: 'possible-subtype',
    });
    expect(billing.migrationScopeReasons[0]).toContain('no path/name tokens shared');
    expect(siteB.sharedCallees).toHaveLength(3);
  });

  it('reuses a supplied diff plan without changing incomplete-migration findings', () => {
    const diffPlan = diffImpactPlan(db, { base: 'HEAD' });
    const result = incompleteMigration(db, { base: 'HEAD', semantic: false, diffPlan });

    expect(result.available).toBe(true);
    expect(result.changedFiles.sort()).toEqual(['src/site-a.ts', 'src/site-e.ts', 'src/util.ts']);
    expect(result.helpersChecked).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      helperShortName: expect.stringContaining('formatThing'),
      helperFile: 'src/util.ts',
      helperShape: 'specific-callee-cluster',
      helperCalleeCount: 3,
      specificHelperCalleeCount: 3,
      migratedFiles: expect.arrayContaining(['src/site-a.ts']),
      leftovers: expect.arrayContaining([
        expect.objectContaining({ file: 'src/site-b.ts', containment: 1, siteCoverage: 0.75 }),
        expect.objectContaining({ file: 'src/site-c.ts', containment: 1, siteCoverage: 1 }),
        expect.objectContaining({ file: 'src/billing.ts', migrationScope: 'possible-subtype' }),
      ]),
    });
  });

  it('reuses a supplied base-content reader without changing incomplete-migration findings', () => {
    const diffPlan = diffImpactPlan(db, { base: 'HEAD' });
    const baseContentAt = createBaseContentResultReader({
      projectRoot: repoRoot,
      base: 'HEAD',
      preloadPaths: baseContentPathsForDiffPlan(diffPlan),
    });
    const result = incompleteMigration(db, {
      base: 'HEAD',
      semantic: false,
      diffPlan,
      baseContentResultAt: baseContentAt,
    });

    expect(result.available).toBe(true);
    expect(result.helpersChecked).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      helperShortName: expect.stringContaining('formatThing'),
      helperFile: 'src/util.ts',
      migratedFiles: expect.arrayContaining(['src/site-a.ts']),
      leftovers: expect.arrayContaining([
        expect.objectContaining({ file: 'src/site-b.ts', containment: 1, siteCoverage: 0.75 }),
        expect.objectContaining({ file: 'src/site-c.ts', containment: 1, siteCoverage: 1 }),
        expect.objectContaining({ file: 'src/billing.ts', migrationScope: 'possible-subtype' }),
      ]),
    });
  });

  it('retains the legacy nullable base-content reader contract', () => {
    const diffPlan = diffImpactPlan(db, { base: 'HEAD' });
    const result = incompleteMigration(db, {
      base: 'HEAD',
      semantic: false,
      diffPlan,
      baseContentAt: (relativePath) => fileContentAtBase(repoRoot, 'HEAD', relativePath),
    });

    expect(result.available).toBe(true);
    expect(result.helpersChecked).toBe(1);
    expect(result.findings).toHaveLength(1);
  });

  it('rejects competing legacy and strict base-content readers', () => {
    const diffPlan = diffImpactPlan(db, { base: 'HEAD' });

    expect(() =>
      incompleteMigration(db, {
        base: 'HEAD',
        diffPlan,
        baseContentAt: () => null,
        baseContentResultAt: () => ({ state: 'absent' }),
      }),
    ).toThrow('Specify only one');
  });

  it('reports base-content unavailability instead of treating every helper as new', () => {
    const diffPlan = diffImpactPlan(db, { base: 'HEAD' });
    const result = incompleteMigration(db, {
      base: 'HEAD',
      semantic: false,
      diffPlan,
      baseContentResultAt: () => ({ state: 'unavailable', reason: 'historical storage offline' }),
    });

    expect(result.available).toBe(false);
    expect(result.note).toContain('historical storage offline');
    expect(result.helpersChecked).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('does not report already-migrated sites or files inside the diff', () => {
    const result = incompleteMigration(db, { base: 'HEAD', semantic: false });
    const leftoverFiles = result.findings.flatMap((finding) => finding.leftovers.map((leftover) => leftover.file));

    // site-d calls the helper; site-e is part of the diff itself.
    expect(leftoverFiles).not.toContain('src/site-d.ts');
    expect(leftoverFiles).not.toContain('src/site-e.ts');
    expect(leftoverFiles).not.toContain('src/site-f.ts');
  });

  it('skips unscoreable helpers with explicit reasons instead of silence', () => {
    const result = incompleteMigration(db, { base: 'HEAD', semantic: false });

    const tiny = result.skipped.find((skip) => skip.helperShortName.includes('tinyHelper'));
    expect(tiny).toBeDefined();
    expect(tiny!.reason).toMatch(/meaningful callees/);

    const orphan = result.skipped.find((skip) => skip.helperShortName.includes('orphanHelper'));
    expect(orphan).toBeDefined();
    expect(orphan!.reason).toMatch(/no references/);
  });

  it('reports existing symbols as not-new (no findings for untouched helpers)', () => {
    // siteB/siteC/siteE exist at base — none may be treated as a new helper.
    const result = incompleteMigration(db, { base: 'HEAD', semantic: false });
    const helperNames = result.findings.map((finding) => finding.helperShortName);
    expect(helperNames.every((name) => name.includes('formatThing'))).toBe(true);
  });

  it('does not score existing callables as new helpers when a file is moved unstaged', () => {
    const movedRepo = mkdtempSync(join(tmpdir(), 'scip-moved-query-'));
    try {
      mkdirSync(join(movedRepo, 'src', 'queries', 'cleanup'), { recursive: true });
      mkdirSync(join(movedRepo, 'src', 'queries'), { recursive: true });
      gitIn(movedRepo, 'init');
      writeFileSync(
        join(movedRepo, 'src', 'queries', 'doc-drift.ts'),
        [
          'export function docPathCandidates(path: string) {',
          '  return path.split("/").filter(Boolean);',
          '}',
          '',
        ].join('\n'),
      );
      gitIn(movedRepo, 'add', '-A');
      gitIn(movedRepo, 'commit', '-m', 'base', '--no-gpg-sign');
      rmSync(join(movedRepo, 'src', 'queries', 'doc-drift.ts'));
      writeFileSync(
        join(movedRepo, 'src', 'queries', 'cleanup', 'doc-drift.ts'),
        [
          'export function docPathCandidates(path: string) {',
          '  return path.split("/").filter(Boolean);',
          '}',
          '',
        ].join('\n'),
      );

      const dbPath = join(movedRepo, 'index.db');
      const sqliteDb = new Database(dbPath);
      createEvidenceSchema(sqliteDb);
      sqliteDb.exec(`
        INSERT INTO documents (id, language, relative_path) VALUES
          (1, 'typescript', 'src/queries/cleanup/doc-drift.ts');

        INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
          (1, '${sym('queries/cleanup/doc-drift.ts', 'docPathCandidates')}', 'docPathCandidates', 3, 'function');

        INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
          (1, 1, 1, 0, 0, 2, 1);
      `);
      sqliteDb.close();

      const movedDb = new ScipDatabase({
        dbPath,
        indexPath: join(movedRepo, 'index.scip'),
        projectRoot: movedRepo,
      });
      try {
        const plan = diffImpactPlan(movedDb, { base: 'HEAD' });
        expect(plan.renamedFiles).toContainEqual(
          expect.objectContaining({
            from: 'src/queries/doc-drift.ts',
            to: 'src/queries/cleanup/doc-drift.ts',
          }),
        );

        const result = incompleteMigration(movedDb, { base: 'HEAD', semantic: false, diffPlan: plan });
        expect(result.changedFiles).toEqual(['src/queries/cleanup/doc-drift.ts']);
        expect(result.helpersChecked).toBe(0);
        expect(result.findings).toHaveLength(0);
        expect(result.skipped.map((skip) => skip.helperShortName)).not.toContain(
          expect.stringContaining('docPathCandidates'),
        );
      } finally {
        movedDb.close();
      }
    } finally {
      rmSync(movedRepo, { recursive: true, force: true });
    }
  });

  it('detects pure git renames even when there are no deleted-only files', () => {
    const movedRepo = mkdtempSync(join(tmpdir(), 'scip-renamed-query-'));
    try {
      mkdirSync(join(movedRepo, 'src', 'queries', 'cleanup'), { recursive: true });
      mkdirSync(join(movedRepo, 'src', 'queries'), { recursive: true });
      gitIn(movedRepo, 'init');
      writeFileSync(
        join(movedRepo, 'src', 'queries', 'doc-drift.ts'),
        [
          'export function docPathCandidates(path: string) {',
          '  return path.split("/").filter(Boolean);',
          '}',
          '',
        ].join('\n'),
      );
      gitIn(movedRepo, 'add', '-A');
      gitIn(movedRepo, 'commit', '-m', 'base', '--no-gpg-sign');
      gitIn(movedRepo, 'mv', 'src/queries/doc-drift.ts', 'src/queries/cleanup/doc-drift.ts');

      const dbPath = join(movedRepo, 'index.db');
      const sqliteDb = new Database(dbPath);
      createEvidenceSchema(sqliteDb);
      sqliteDb.exec(`
        INSERT INTO documents (id, language, relative_path) VALUES
          (1, 'typescript', 'src/queries/cleanup/doc-drift.ts');

        INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
          (1, '${sym('queries/cleanup/doc-drift.ts', 'docPathCandidates')}', 'docPathCandidates', 3, 'function');

        INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
          (1, 1, 1, 0, 0, 2, 1);
      `);
      sqliteDb.close();

      const movedDb = new ScipDatabase({
        dbPath,
        indexPath: join(movedRepo, 'index.scip'),
        projectRoot: movedRepo,
      });
      try {
        const deletedOnly = execFileSync('git', ['-C', movedRepo, 'diff', '--name-only', '--diff-filter=D', 'HEAD'], {
          encoding: 'utf-8',
        }).trim();
        expect(deletedOnly).toBe('');

        const plan = diffImpactPlan(movedDb, { base: 'HEAD' });
        expect(plan.renamedFiles).toContainEqual(
          expect.objectContaining({
            from: 'src/queries/doc-drift.ts',
            to: 'src/queries/cleanup/doc-drift.ts',
          }),
        );
      } finally {
        movedDb.close();
      }
    } finally {
      rmSync(movedRepo, { recursive: true, force: true });
    }
  });

  it('returns unavailable outside a git repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'scip-no-git-'));
    try {
      const noGitDb = new ScipDatabase({
        dbPath: join(repoRoot, 'index.db'),
        indexPath: join(outside, 'index.scip'),
        projectRoot: outside,
      });
      const result = incompleteMigration(noGitDb, { base: 'HEAD' });
      expect(result.available).toBe(false);
      expect(result.note).toBe(GIT_DIFF_UNAVAILABLE_NOTE);
      expect(result.findings).toHaveLength(0);
      noGitDb.close();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
