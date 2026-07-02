import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { diffGate, type DiffGateCheck } from '../../../src/queries/impact/diff-gate.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

// followup #8: one heavily-cited hub file produced 36 of 107 doc-reference
// findings across a 15-commit retro-gate sample (4 commits, ~9-13
// near-identical findings each — every living doc that cites the hub file
// gets its own finding when it changes). Docs citing more than
// DOC_REFERENCE_HUB_FILE_EXEMPLAR_LIMIT (3) of the same changed hub file
// collapse into one clustered finding with citationCount/citationExemplars/
// suppressedCount; distinct-file citations stay untouched.

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

describe('diff-gate doc-reference hub-file cascade damping', () => {
  it('collapses 12 docs citing the same hub file into one clustered finding with a correct suppressedCount', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'scip-doc-reference-hub-cascade-'));
    tempRoots.push(repoRoot);
    gitIn(repoRoot, 'init');
    writeFile(join(repoRoot, 'src', 'shared', 'endpoints.ts'), 'export const endpoints = { users: "/users" };\n');
    const docNames: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const docName = `docs/policy-${String(i).padStart(2, '0')}.md`;
      docNames.push(docName);
      writeFile(
        join(repoRoot, docName),
        `Policy ${i} relies on the endpoint contract at src/shared/endpoints.ts for its API surface.\n`,
      );
    }
    gitIn(repoRoot, 'add', '-A');
    gitIn(repoRoot, 'commit', '-m', 'base', '--no-gpg-sign');

    const dbPath = join(repoRoot, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/shared/endpoints.ts').write();
    const config: ScipQueryConfig = { dbPath, indexPath: join(repoRoot, 'index.scip'), projectRoot: repoRoot };
    const db = new ScipDatabase(config);
    openDbs.push(db);

    writeFile(join(repoRoot, 'src', 'shared', 'endpoints.ts'), 'export const endpoints = { users: "/v2/users" };\n');

    const result = diffGate(db, { base: 'HEAD', skip: SKIP_UNRELATED });
    const docReferenceFindings = result.findings.filter((finding) => finding.check === 'doc-reference');

    expect(docReferenceFindings).toHaveLength(1);
    const clustered = docReferenceFindings[0]!;
    expect(clustered.citationCount).toBe(12);
    expect(clustered.citationExemplars).toHaveLength(3);
    expect(clustered.suppressedCount).toBe(9);
    expect(clustered.relatedFiles).toEqual(['src/shared/endpoints.ts']);
    // Not silently dropped: every original per-doc finding id is still addressable.
    expect(clustered.legacySuppressionIds).toBeDefined();
    expect(clustered.legacySuppressionIds!.length).toBeGreaterThanOrEqual(12);
    // Exemplars are the first 3 docs in deterministic (sorted) order.
    expect(clustered.citationExemplars?.map((exemplar) => exemplar.doc)).toEqual(docNames.slice(0, 3).sort());
    // Not silently dropped: every citing doc is named somewhere in `why`.
    const whyText = clustered.why.join(' ');
    for (const docName of docNames) {
      expect(whyText).toContain(docName);
    }

    const rootCauseGroup = result.rootCauseGroups?.find((group) => group.rootCauseKey === 'src/shared/endpoints.ts');
    expect(rootCauseGroup).toBeDefined();
    expect(rootCauseGroup?.count).toBe(1);
  });

  it('leaves citations of distinct files untouched (no clustering below the threshold)', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'scip-doc-reference-hub-cascade-distinct-'));
    tempRoots.push(repoRoot);
    gitIn(repoRoot, 'init');
    writeFile(join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFile(join(repoRoot, 'src', 'b.ts'), 'export const b = 2;\n');
    writeFile(join(repoRoot, 'docs', 'about-a.md'), 'This describes src/a.ts and its role.\n');
    writeFile(join(repoRoot, 'docs', 'about-b.md'), 'This describes src/b.ts and its role.\n');
    gitIn(repoRoot, 'add', '-A');
    gitIn(repoRoot, 'commit', '-m', 'base', '--no-gpg-sign');

    const dbPath = join(repoRoot, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/a.ts').document(2, 'typescript', 'src/b.ts').write();
    const config: ScipQueryConfig = { dbPath, indexPath: join(repoRoot, 'index.scip'), projectRoot: repoRoot };
    const db = new ScipDatabase(config);
    openDbs.push(db);

    writeFile(join(repoRoot, 'src', 'a.ts'), 'export const a = 11;\n');
    writeFile(join(repoRoot, 'src', 'b.ts'), 'export const b = 22;\n');

    const result = diffGate(db, { base: 'HEAD', skip: SKIP_UNRELATED });
    const docReferenceFindings = result.findings.filter((finding) => finding.check === 'doc-reference');

    expect(docReferenceFindings).toHaveLength(2);
    for (const finding of docReferenceFindings) {
      expect(finding.citationCount).toBeUndefined();
      expect(finding.suppressedCount).toBeUndefined();
    }
    expect(docReferenceFindings.map((finding) => finding.file).sort()).toEqual(['docs/about-a.md', 'docs/about-b.md']);
  });
});
