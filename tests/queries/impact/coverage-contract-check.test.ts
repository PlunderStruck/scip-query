import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoverageContractConfig, ScipQueryConfig } from '../../../src/domain/types.js';
import { diffGate } from '../../../src/queries/impact/diff-gate.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

// Scenario: policy.ts declares ALLOWED = { a: 1 } and must track src/*'s
// top-level dirs. The base commit has src/a/ only (contract satisfied). The
// working tree then adds src/b/ (uncommitted) without updating policy.ts —
// coverage-contract should flag the drift because the ground-truth side
// (src/*) changed in this diff.

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

function buildRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'scip-coverage-contract-check-'));
  tempRoots.push(repoRoot);
  gitIn(repoRoot, 'init');
  writeFile(join(repoRoot, 'src', 'policy.ts'), 'export const ALLOWED: Record<string, unknown> = {\n  a: 1,\n};\n');
  writeFile(join(repoRoot, 'src', 'a', 'x.ts'), 'export const x = 1;\n');
  gitIn(repoRoot, 'add', '-A');
  gitIn(repoRoot, 'commit', '-m', 'base', '--no-gpg-sign');
  return repoRoot;
}

function fixtureDb(repoRoot: string, coverageContracts: CoverageContractConfig[]): ScipDatabase {
  const dbPath = join(repoRoot, 'index.db');
  evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/policy.ts').write();

  const config: ScipQueryConfig = {
    dbPath,
    indexPath: join(repoRoot, 'index.scip'),
    projectRoot: repoRoot,
    coverageContracts,
  };
  const db = new ScipDatabase(config);
  openDbs.push(db);
  return db;
}

const CONTRACT: CoverageContractConfig = {
  name: 'policy covers src dirs',
  file: 'src/policy.ts',
  keys: { type: 'object-literal-keys', identifier: 'ALLOWED' },
  mustEqual: { type: 'top-level-dirs', path: 'src' },
  allowExtra: true,
};

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('diff-gate coverage-contract check', () => {
  it('flags a contract when the ground-truth side changed in the diff', () => {
    const repoRoot = buildRepo();
    const db = fixtureDb(repoRoot, [CONTRACT]);

    writeFile(join(repoRoot, 'src', 'b', 'y.ts'), 'export const y = 1;\n');

    const result = diffGate(db, {
      base: 'HEAD',
      skip: ['echo', 'incomplete-migration', 'co-change-partner', 'twin-partner', 'unused-params', 'new-dead'],
    });

    const findings = result.findings.filter((finding) => finding.check === 'coverage-contract');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('missing b');
    // Errors block the gate — coverage-contract is not advisory.
    expect(result.findings.some((finding) => finding.check === 'coverage-contract' && !finding.advisory)).toBe(true);
  });

  it('does not run the check when neither side of the contract changed', () => {
    const repoRoot = buildRepo();
    const db = fixtureDb(repoRoot, [CONTRACT]);

    writeFile(join(repoRoot, 'README.md'), '# unrelated change\n');

    const result = diffGate(db, {
      base: 'HEAD',
      skip: ['echo', 'incomplete-migration', 'co-change-partner', 'twin-partner', 'unused-params', 'new-dead'],
    });

    expect(result.findings.filter((finding) => finding.check === 'coverage-contract')).toHaveLength(0);
  });

  it('is a no-op when no contracts are configured', () => {
    const repoRoot = buildRepo();
    const db = fixtureDb(repoRoot, []);

    writeFile(join(repoRoot, 'src', 'b', 'y.ts'), 'export const y = 1;\n');

    const result = diffGate(db, {
      base: 'HEAD',
      skip: ['echo', 'incomplete-migration', 'co-change-partner', 'twin-partner', 'unused-params', 'new-dead'],
    });

    expect(result.checksRun).toContain('coverage-contract');
    expect(result.findings.filter((finding) => finding.check === 'coverage-contract')).toHaveLength(0);
  });
});
