import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { blockingFindings, diffGate, type DiffGateCheck } from '../../../src/queries/impact/diff-gate.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

// 21.2 calibration retune (external calibration: Stable_Management §4 — 91%
// of gate volume was doc-reference at ~13% actionable; Vega_2.0 §4.4 — 70%
// of volume, 1/7 sampled actionable, the one real hit line-anchored).
// Citations with a line anchor (`file.ts:123`) or that point at a
// deleted/renamed file stay blocking; bare file-mention citations become
// advisory (print, suppressible, never solely fail the gate).

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

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SKIP_UNRELATED: DiffGateCheck[] = [
  'echo',
  'incomplete-migration',
  'co-change-partner',
  'twin-partner',
  'coverage-contract',
  'unused-params',
  'new-dead',
];

function buildRepo(docFile: string, docContent: string): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'scip-doc-reference-severity-'));
  tempRoots.push(repoRoot);
  gitIn(repoRoot, 'init');
  writeFile(join(repoRoot, 'src', 'a.ts'), 'export const version = 1;\nexport const label = "a";\n');
  writeFile(join(repoRoot, docFile), docContent);
  gitIn(repoRoot, 'add', '-A');
  gitIn(repoRoot, 'commit', '-m', 'base', '--no-gpg-sign');
  return repoRoot;
}

function fixtureDb(repoRoot: string): ScipDatabase {
  const dbPath = join(repoRoot, 'index.db');
  evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/a.ts').write();
  const config: ScipQueryConfig = { dbPath, indexPath: join(repoRoot, 'index.scip'), projectRoot: repoRoot };
  const db = new ScipDatabase(config);
  openDbs.push(db);
  return db;
}

describe('diff-gate doc-reference citation-granularity severity split', () => {
  it('keeps a line-anchored citation blocking and part of the exit-code decision', () => {
    const repoRoot = buildRepo('docs/line-anchored.md', 'The version constant lives at src/a.ts:1.\n');
    const db = fixtureDb(repoRoot);
    writeFile(join(repoRoot, 'src', 'a.ts'), 'export const version = 2;\nexport const label = "a";\n');

    const result = diffGate(db, { base: 'HEAD', skip: SKIP_UNRELATED });
    const finding = result.findings.find((f) => f.check === 'doc-reference' && f.file === 'docs/line-anchored.md');

    expect(finding).toBeDefined();
    expect(finding?.advisory).not.toBe(true);
    expect(blockingFindings(result.findings)).toEqual(expect.arrayContaining([finding]));
    expect(blockingFindings(result.findings).length).toBeGreaterThan(0);
  });

  it('demotes a bare file-mention citation to advisory and out of the exit-code decision', () => {
    const repoRoot = buildRepo(
      'docs/bare-mention.md',
      'src/a.ts stores the initial version constant used elsewhere.\n',
    );
    const db = fixtureDb(repoRoot);
    writeFile(join(repoRoot, 'src', 'a.ts'), 'export const version = 1;\nexport const label = "b";\n');

    const result = diffGate(db, { base: 'HEAD', skip: SKIP_UNRELATED });
    const finding = result.findings.find((f) => f.check === 'doc-reference' && f.file === 'docs/bare-mention.md');

    expect(finding).toBeDefined();
    expect(finding?.advisory).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    // Advisory findings still print (result.findings) but must never be the
    // sole cause of a nonzero exit — see blockingFindings' doc comment.
    expect(blockingFindings(result.findings)).toHaveLength(0);
  });

  it('keeps a citation blocking when the cited file was deleted, even with no line anchor', () => {
    const repoRoot = buildRepo(
      'docs/bare-mention.md',
      'src/a.ts stores the initial version constant used elsewhere.\n',
    );
    const db = fixtureDb(repoRoot);
    gitIn(repoRoot, 'rm', 'src/a.ts');

    const result = diffGate(db, { base: 'HEAD', skip: SKIP_UNRELATED });
    const finding = result.findings.find((f) => f.check === 'doc-reference' && f.file === 'docs/bare-mention.md');

    expect(finding).toBeDefined();
    expect(finding?.advisory).not.toBe(true);
    expect(blockingFindings(result.findings)).toEqual(expect.arrayContaining([finding]));
  });
});
