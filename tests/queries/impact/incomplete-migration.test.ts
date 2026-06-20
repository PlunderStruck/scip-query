import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { diffGate } from '../../../src/queries/impact/diff-gate.js';
import { diffImpactPlan } from '../../../src/queries/impact/diff-impact.js';
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
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t.t',
      GIT_AUTHOR_DATE: '1700000000 +0000',
      GIT_COMMITTER_DATE: '1700000000 +0000',
    },
  });
}

function git(...args: string[]): void {
  gitIn(repoRoot, ...args);
}

const sym = (path: string, name: string) =>
  `scip-typescript npm pkg 1.0.0 src/\`${path}\`/${name}().`;

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
  writeFileSync(join(repoRoot, 'src', 'core.ts'), [
    'export function coreOne() { return 1; }',
    'export function coreTwo() { return 2; }',
    'export function coreThree() { return 3; }',
    '',
  ].join('\n'));
  writeFileSync(join(repoRoot, 'src', 'util.ts'), 'export const placeholder = 1;\n');
  writeFileSync(join(repoRoot, 'src', 'site-a.ts'), 'export function siteA() { return 0; }\n');
  writeFileSync(join(repoRoot, 'src', 'site-b.ts'), [
    "import { coreOne, coreTwo, coreThree } from './core.js';",
    'export function extraB() { return 9; }',
    'export function siteB() {',
    '  const a = coreOne();',
    '  const b = coreTwo();',
    '  const c = coreThree();',
    '  return a + b + c + extraB();',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(repoRoot, 'src', 'site-c.ts'), SITE_BODY.replace('%NAME%', 'siteC'));
  writeFileSync(join(repoRoot, 'src', 'site-d.ts'), [
    "import { coreOne, coreTwo, coreThree } from './core.js';",
    "import { formatThing } from './util.js';",
    'export function siteD() {',
    '  const a = coreOne();',
    '  const b = coreTwo();',
    '  const c = coreThree();',
    '  return a + b + c + formatThing();',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(repoRoot, 'src', 'site-e.ts'), 'export function siteE() { return 5; }\n');
}

function writeWorkingTreeChanges(): void {
  writeFileSync(join(repoRoot, 'src', 'util.ts'), [
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
  ].join('\n'));
  writeFileSync(join(repoRoot, 'src', 'site-a.ts'), [
    "import { formatThing } from './util.js';",
    '',
    'export function siteA() {',
    '  return formatThing();',
    '}',
    '',
  ].join('\n'));
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
      (7, 'typescript', 'src/site-e.ts');

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
      (12, '${sym('site-e.ts', 'siteE')}', 'siteE', 3, 'function');

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
      (12, 7, 12, 2, 0, 7, 1);

    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 2, X'00'),
      (2, 2, 0, 2, 7, X'00'),
      (3, 2, 1, 8, 8, X'00'),
      (4, 2, 2, 9, 9, X'00'),
      (5, 3, 0, 2, 4, X'00'),
      (6, 4, 0, 2, 7, X'00'),
      (7, 4, 1, 1, 1, X'00'),
      (8, 5, 0, 2, 7, X'00'),
      (9, 6, 0, 2, 7, X'00'),
      (10, 7, 0, 2, 7, X'00');

    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (1, 2, 1),
      (1, 3, 1),
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
      (10, 3, 0);
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
  it('reports un-migrated sites for a freshly wired helper', () => {
    const result = incompleteMigration(db, { base: 'HEAD', semantic: false });

    expect(result.available).toBe(true);
    expect(result.changedFiles.sort()).toEqual(['src/site-a.ts', 'src/site-e.ts', 'src/util.ts']);
    expect(result.helpersChecked).toBe(1);
    expect(result.findings).toHaveLength(1);

    const finding = result.findings[0]!;
    expect(finding.helperShortName).toContain('formatThing');
    expect(finding.helperFile).toBe('src/util.ts');
    expect(finding.migratedFiles).toContain('src/site-a.ts');

    const leftoverFiles = finding.leftovers.map((leftover) => leftover.file);
    expect(leftoverFiles).toEqual(['src/site-b.ts', 'src/site-c.ts']);
    expect(finding.leftovers[0]!.containment).toBe(1);
    expect(finding.leftovers[0]!.sharedCallees).toHaveLength(3);
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
      migratedFiles: expect.arrayContaining(['src/site-a.ts']),
      leftovers: [
        expect.objectContaining({ file: 'src/site-b.ts', containment: 1 }),
        expect.objectContaining({ file: 'src/site-c.ts', containment: 1 }),
      ],
    });
  });

  it('does not report already-migrated sites or files inside the diff', () => {
    const result = incompleteMigration(db, { base: 'HEAD', semantic: false });
    const leftoverFiles = result.findings.flatMap((finding) =>
      finding.leftovers.map((leftover) => leftover.file));

    // site-d calls the helper; site-e is part of the diff itself.
    expect(leftoverFiles).not.toContain('src/site-d.ts');
    expect(leftoverFiles).not.toContain('src/site-e.ts');
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
      writeFileSync(join(movedRepo, 'src', 'queries', 'doc-drift.ts'), [
        'export function docPathCandidates(path: string) {',
        '  return path.split("/").filter(Boolean);',
        '}',
        '',
      ].join('\n'));
      gitIn(movedRepo, 'add', '-A');
      gitIn(movedRepo, 'commit', '-m', 'base', '--no-gpg-sign');
      rmSync(join(movedRepo, 'src', 'queries', 'doc-drift.ts'));
      writeFileSync(join(movedRepo, 'src', 'queries', 'cleanup', 'doc-drift.ts'), [
        'export function docPathCandidates(path: string) {',
        '  return path.split("/").filter(Boolean);',
        '}',
        '',
      ].join('\n'));

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
        expect(plan.renamedFiles).toContainEqual(expect.objectContaining({
          from: 'src/queries/doc-drift.ts',
          to: 'src/queries/cleanup/doc-drift.ts',
        }));

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
      writeFileSync(join(movedRepo, 'src', 'queries', 'doc-drift.ts'), [
        'export function docPathCandidates(path: string) {',
        '  return path.split("/").filter(Boolean);',
        '}',
        '',
      ].join('\n'));
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
        expect(plan.renamedFiles).toContainEqual(expect.objectContaining({
          from: 'src/queries/doc-drift.ts',
          to: 'src/queries/cleanup/doc-drift.ts',
        }));
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
      expect(result.findings).toHaveLength(0);
      noGitDb.close();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('surfaces incomplete-migration findings through diff-gate', () => {
    const result = diffGate(db, { base: 'HEAD' });

    expect(result.checksRun).toContain('incomplete-migration');
    const findings = result.findings.filter((finding) => finding.check === 'incomplete-migration');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]!.message).toContain('formatThing');
    expect(findings[0]!.message).toContain('src/site-b.ts');
    expect(findings[0]!.remediation).toContain('formatThing');
    expect(findings[0]!).toMatchObject({
      id: expect.stringMatching(/^SQ[A-F0-9]{12}$/),
      severity: 'warning',
      evidence: 'heuristic',
      file: 'src/util.ts',
      symbol: expect.stringContaining('formatThing'),
      relatedFiles: expect.arrayContaining(['src/site-a.ts', 'src/site-b.ts', 'src/site-c.ts']),
      suppressionHint: expect.stringContaining('scip-query: ignore incomplete-migration'),
    });
    expect(findings[0]!.confidence).toBeGreaterThan(0);
    expect(findings[0]!.why).toEqual(expect.arrayContaining([
      expect.stringContaining('formatThing'),
    ]));
  });

  it('honors structured diff-gate suppressions from config', () => {
    const unsuppressed = diffGate(db, { base: 'HEAD' });
    const finding = unsuppressed.findings.find((candidate) => candidate.check === 'incomplete-migration');
    expect(finding).toBeDefined();

    const suppressedDb = new ScipDatabase({
      dbPath: join(repoRoot, 'index.db'),
      indexPath: join(repoRoot, 'index.scip'),
      projectRoot: repoRoot,
      suppressions: [{ id: finding!.id, reason: 'accepted fixture finding' }],
    });
    try {
      const result = diffGate(suppressedDb, { base: 'HEAD' });

      expect(result.findings.some((candidate) => candidate.id === finding!.id)).toBe(false);
      expect(result.suppressed).toEqual([
        expect.objectContaining({
          finding: expect.objectContaining({ id: finding!.id }),
          suppression: expect.objectContaining({ reason: 'accepted fixture finding' }),
        }),
      ]);
    } finally {
      suppressedDb.close();
    }
  });

  it('runs uncapped by default — no cap-skip entries', () => {
    const result = diffGate(db, { base: 'HEAD' });

    expect(result.skipped.filter((skip) => skip.reason.includes('capped'))).toHaveLength(0);
  });

  it('honors finite caps and reports them as skips', () => {
    const result = diffGate(db, { base: 'HEAD', maxEchoChecks: 1, maxHelpers: 0 });

    const echoSkip = result.skipped.find((skip) => skip.check === 'echo');
    expect(echoSkip).toBeDefined();
    expect(echoSkip!.reason).toContain('capped at 1');

    const migrationSkip = result.skipped.find((skip) => skip.check === 'incomplete-migration');
    expect(migrationSkip).toBeDefined();
    expect(migrationSkip!.reason).toContain('capped at 0');
    expect(result.findings.filter((finding) => finding.check === 'incomplete-migration')).toHaveLength(0);
  });

  it('skips named checks via the skip option', () => {
    const result = diffGate(db, { base: 'HEAD', skip: ['incomplete-migration', 'doc-reference'] });

    expect(result.checksRun).not.toContain('incomplete-migration');
    expect(result.checksRun).not.toContain('doc-reference');
    expect(result.checksRun).toContain('echo');
    expect(result.skipped).toContainEqual({ check: 'incomplete-migration', reason: 'skipped via --skip' });
    expect(result.skipped).toContainEqual({ check: 'doc-reference', reason: 'skipped via --skip' });
    expect(result.findings.filter((finding) => finding.check === 'incomplete-migration')).toHaveLength(0);
  });

  it('does not ask docs to update for import-only source path rewrites', () => {
    const importOnlyRepo = mkdtempSync(join(tmpdir(), 'scip-doc-reference-import-only-'));
    try {
      mkdirSync(join(importOnlyRepo, 'src'), { recursive: true });
      gitIn(importOnlyRepo, 'init');
      writeFileSync(join(importOnlyRepo, 'README.md'), 'The cleanup detector lives in src/dead.ts.\n');
      writeFileSync(join(importOnlyRepo, 'src', 'dead.ts'), [
        "import { helper } from './old-helper.js';",
        '',
        'export function cleanupDetector() {',
        '  return helper();',
        '}',
        '',
      ].join('\n'));
      gitIn(importOnlyRepo, 'add', '-A');
      gitIn(importOnlyRepo, 'commit', '-m', 'base', '--no-gpg-sign');
      writeFileSync(join(importOnlyRepo, 'src', 'dead.ts'), [
        "import { helper } from './new-helper.js';",
        '',
        'export function cleanupDetector() {',
        '  return helper();',
        '}',
        '',
      ].join('\n'));

      const dbPath = join(importOnlyRepo, 'index.db');
      const sqliteDb = new Database(dbPath);
      createEvidenceSchema(sqliteDb);
      sqliteDb.exec(`
        INSERT INTO documents (id, language, relative_path) VALUES
          (1, 'typescript', 'src/dead.ts');
      `);
      sqliteDb.close();

      const importOnlyDb = new ScipDatabase({
        dbPath,
        indexPath: join(importOnlyRepo, 'index.scip'),
        projectRoot: importOnlyRepo,
      });
      try {
        const result = diffGate(importOnlyDb, {
          base: 'HEAD',
          skip: ['echo', 'incomplete-migration', 'co-change-partner', 'unused-params', 'new-dead', 'baseline'],
        });
        expect(result.checksRun).toEqual(['doc-reference']);
        expect(result.findings).toHaveLength(0);
      } finally {
        importOnlyDb.close();
      }
    } finally {
      rmSync(importOnlyRepo, { recursive: true, force: true });
    }
  });
});
