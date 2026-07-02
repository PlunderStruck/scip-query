import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { blockingFindings, diffGate } from '../../../src/queries/impact/diff-gate.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

// Scenario: src/a.ts and src/b.ts each define a same-name helper with
// identical bodies at the base commit. The working tree then edits ONLY
// src/a.ts's body (uncommitted, so `base: 'HEAD'` sees it as the diff) —
// twin-partner should flag that src/b.ts's twin was left behind.

const tempRoots: string[] = [];
const openDbs: ScipDatabase[] = [];

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

const BODY_A = ['export function formatUser(value: string) {', '  return value.trim().toLowerCase();', '}', ''].join(
  '\n',
);
const BODY_B_MATCHING = [
  'export function formatUser(value: string) {',
  '  return value.trim().toLowerCase();',
  '}',
  '',
].join('\n');
const BODY_A_EDITED = [
  'export function formatUser(value: string) {',
  "  return value.trim().toLowerCase().normalize('NFKC');",
  '}',
  '',
].join('\n');

function writeFileEnsuringDir(path: string, content: string): void {
  writeFileSync(path, content);
}

function commit(root: string, message: string): void {
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-m', message, '--no-gpg-sign');
}

function buildRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'scip-twin-partner-'));
  tempRoots.push(repoRoot);
  gitIn(repoRoot, 'init');
  execFileSync('mkdir', ['-p', join(repoRoot, 'src')]);
  writeFileEnsuringDir(join(repoRoot, 'src', 'a.ts'), BODY_A);
  writeFileEnsuringDir(join(repoRoot, 'src', 'b.ts'), BODY_B_MATCHING);
  commit(repoRoot, 'base: matching twins');
  return repoRoot;
}

function fixtureDb(repoRoot: string): ScipDatabase {
  const dbPath = join(repoRoot, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/a.ts')
    .document(2, 'typescript', 'src/b.ts')
    .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/formatUser().', 'formatUser', 12)
    .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`b.ts`/formatUser().', 'formatUser', 12)
    .definition(1, 1, 1, 0, 0, 2, 1)
    .definition(2, 2, 2, 0, 0, 2, 1)
    .write();

  const config: ScipQueryConfig = {
    dbPath,
    indexPath: join(repoRoot, 'index.scip'),
    projectRoot: repoRoot,
  };
  const db = new ScipDatabase(config);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('diff-gate twin-partner check', () => {
  it('flags a same-name twin left behind by a one-sided edit', () => {
    const repoRoot = buildRepo();
    const db = fixtureDb(repoRoot);

    // Uncommitted edit to src/a.ts only — `base: 'HEAD'` sees this as the diff.
    writeFileEnsuringDir(join(repoRoot, 'src', 'a.ts'), BODY_A_EDITED);

    const result = diffGate(db, { base: 'HEAD', skip: ['echo', 'incomplete-migration', 'unused-params', 'new-dead'] });

    const twinFindings = result.findings.filter((finding) => finding.check === 'twin-partner');
    expect(twinFindings).toHaveLength(1);
    expect(twinFindings[0]?.file).toBe('src/a.ts');
    expect(twinFindings[0]?.relatedFiles).toEqual(['src/b.ts']);
    expect(twinFindings[0]?.advisory).toBe(true);

    // Advisory: never the sole cause of a nonzero exit.
    expect(blockingFindings(result.findings)).toHaveLength(0);
  });

  it('does not flag when both twins change together', () => {
    const repoRoot = buildRepo();
    const db = fixtureDb(repoRoot);

    writeFileEnsuringDir(join(repoRoot, 'src', 'a.ts'), BODY_A_EDITED);
    writeFileEnsuringDir(join(repoRoot, 'src', 'b.ts'), BODY_A_EDITED.replace('formatUser', 'formatUser'));
    // Both files are identical again after the coordinated edit — no drift, no finding.

    const result = diffGate(db, { base: 'HEAD', skip: ['echo', 'incomplete-migration', 'unused-params', 'new-dead'] });

    expect(result.findings.filter((finding) => finding.check === 'twin-partner')).toHaveLength(0);
  });

  it('respects structured suppressions for twin-partner findings', () => {
    const repoRoot = buildRepo();
    const db = fixtureDb(repoRoot);
    writeFileEnsuringDir(join(repoRoot, 'src', 'a.ts'), BODY_A_EDITED);

    const unsuppressed = diffGate(db, {
      base: 'HEAD',
      skip: ['echo', 'incomplete-migration', 'unused-params', 'new-dead'],
    });
    const finding = unsuppressed.findings.find((entry) => entry.check === 'twin-partner');
    expect(finding).toBeDefined();

    const suppressedDbPath = join(repoRoot, 'index.db');
    const suppressedDb = new ScipDatabase({
      dbPath: suppressedDbPath,
      indexPath: join(repoRoot, 'index.scip'),
      projectRoot: repoRoot,
      suppressions: [{ id: finding!.id, reason: 'intentional divergence for this test' }],
    });
    openDbs.push(suppressedDb);

    const result = diffGate(suppressedDb, {
      base: 'HEAD',
      skip: ['echo', 'incomplete-migration', 'unused-params', 'new-dead'],
    });
    expect(result.findings.filter((entry) => entry.check === 'twin-partner')).toHaveLength(0);
    expect(result.suppressed.some((entry) => entry.finding.check === 'twin-partner')).toBe(true);
  });
});
