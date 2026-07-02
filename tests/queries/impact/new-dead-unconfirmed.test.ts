/**
 * 23.4 honesty valve: `new-dead` must not assert a flat "dead" claim for
 * the one archetype 23.2 could not fully close — a symbol whose leaf name
 * is ambiguous project-wide (a same-named definition exists elsewhere) AND
 * lives in a workspace package, when it still shows zero fan-in after the
 * SCIP + semantic + source-fallback tiers. That combination is exactly the
 * shape `attributeIdentifier`'s strict same-file import match can't
 * resolve through a re-exporting barrel (see remediation 23.2's commit
 * message: `ProjectAgentSettings`/`CodexModelCapability`/etc. on Vega).
 * A genuinely unique-named symbol in the same workspace package must still
 * get the normal, confident `graph-fact` dead claim — the downgrade is
 * narrowly scoped, not a blanket hedge on every workspace-package finding.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { diffGate } from '../../../src/queries/impact/diff-gate.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

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

function commit(root: string, message: string): void {
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-m', message, '--no-gpg-sign');
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('diff-gate new-dead — honesty valve', () => {
  it('downgrades to unconfirmed for an ambiguous-leaf-name symbol newly added in a workspace package', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'scip-new-dead-unconfirmed-'));
    tempRoots.push(repoRoot);
    gitIn(repoRoot, 'init');

    writeFile(join(repoRoot, 'pnpm-workspace.yaml'), ['packages:', '  - "packages/*"', ''].join('\n'));
    writeFile(join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true }));
    writeFile(join(repoRoot, 'packages/shared/package.json'), JSON.stringify({ name: '@fixture/shared' }));
    writeFile(join(repoRoot, 'packages/other/package.json'), JSON.stringify({ name: '@fixture/other' }));
    // A same-named definition already exists elsewhere in the workspace —
    // this is what makes the new one's leaf name ambiguous.
    writeFile(
      join(repoRoot, 'packages/other/src/AmbiguousName.ts'),
      ['export interface AmbiguousName {', '  otherField: string;', '}', ''].join('\n'),
    );
    commit(repoRoot, 'base: unrelated package with a same-named type');

    // New file, new symbol, zero consumers anywhere — genuinely
    // unattributable by design in this fixture, not a bug to fix.
    writeFile(
      join(repoRoot, 'packages/shared/src/contracts.ts'),
      ['export interface AmbiguousName {', '  id: string;', '}', ''].join('\n'),
    );
    writeFile(
      join(repoRoot, 'packages/shared/src/unique.ts'),
      ['export interface UniquelyNamedType {', '  id: string;', '}', ''].join('\n'),
    );

    const dbPath = join(repoRoot, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'packages/other/src/AmbiguousName.ts')
      .document(2, 'typescript', 'packages/shared/src/contracts.ts')
      .document(3, 'typescript', 'packages/shared/src/unique.ts')
      .symbol(1, 'scip-typescript npm @fixture/other 1.0.0 src/`AmbiguousName.ts`/AmbiguousName#', 'AmbiguousName', 11)
      .symbol(2, 'scip-typescript npm @fixture/shared 1.0.0 src/`contracts.ts`/AmbiguousName#', 'AmbiguousName', 11)
      .symbol(
        3,
        'scip-typescript npm @fixture/shared 1.0.0 src/`unique.ts`/UniquelyNamedType#',
        'UniquelyNamedType',
        11,
      )
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .definition(3, 3, 3, 0, 0, 2, 1)
      .chunk(1, 1, 0, 2)
      .chunk(2, 2, 0, 2)
      .chunk(3, 3, 0, 2)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(3, 3, 1)
      .write();

    const config: ScipQueryConfig = { dbPath, indexPath: join(repoRoot, 'index.scip'), projectRoot: repoRoot };
    const db = new ScipDatabase(config);
    openDbs.push(db);

    const result = diffGate(db, {
      base: 'HEAD',
      semantic: false,
      skip: ['echo', 'incomplete-migration', 'unused-params', 'doc-reference', 'co-change-partner', 'twin-partner'],
    });

    const newDead = result.findings.filter((finding) => finding.check === 'new-dead');
    const ambiguous = newDead.find((finding) => finding.symbol?.includes('contracts.ts'));
    const unique = newDead.find((finding) => finding.symbol?.includes('unique.ts'));

    expect(ambiguous).toBeDefined();
    expect(ambiguous!.evidence).toBe('heuristic');
    expect(ambiguous!.message).toContain('unconfirmed');
    expect(ambiguous!.confidence).toBeLessThan(0.6);

    expect(unique).toBeDefined();
    expect(unique!.evidence).toBe('graph-fact');
    expect(unique!.message).not.toContain('unconfirmed');
    expect(unique!.confidence).toBeGreaterThanOrEqual(0.9);
  });
});
