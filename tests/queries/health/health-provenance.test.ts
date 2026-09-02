import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SymbolInformation_Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { health, healthProvenance } from '../../../src/queries/health/health.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

function gitIn(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t.t',
    },
  });
}

describe('health provenance', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('names the index generation and the git commit a report was computed from', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-health-provenance-'));
    tempDirs.push(root);
    writeFixtureFiles(root, { 'src/a.ts': ['export function a() {', '  return 1;', '}'] });
    // The fixture index and the evidence cache live inside the project
    // root; ignore them so the dirt count reflects source edits only.
    writeFileSync(join(root, '.gitignore'), 'index.db*\nindex.scip\nevidence.db*\n');
    gitIn(root, 'init', '-q', '-b', 'trunk');
    gitIn(root, 'add', '.gitignore', 'src/a.ts');
    gitIn(root, 'commit', '-q', '-m', 'seed');
    const head = gitIn(root, 'rev-parse', 'HEAD').trim();
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/a().', 'a', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .chunk(1, 1, 0, 3)
      .mention(1, 1, 1)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const report = health(db);
      expect(report.provenance).toEqual({
        computedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        generation: { identity: db.generation.identity, publishedAt: null, mode: null },
        git: { head, branch: 'trunk', dirtyPaths: 0 },
      });

      // The same generation with an uncommitted edit is a different input.
      writeFileSync(join(root, 'src/b.ts'), 'export const b = 2;\n');
      expect(healthProvenance(db).git).toEqual({ head, branch: 'trunk', dirtyPaths: 1 });
    } finally {
      db.close();
    }
  });

  it('reports a non-repository as having no git provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-health-provenance-nogit-'));
    tempDirs.push(root);
    writeFixtureFiles(root, { 'src/a.ts': ['export function a() {', '  return 1;', '}'] });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/a().', 'a', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .chunk(1, 1, 0, 3)
      .mention(1, 1, 1)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      expect(healthProvenance(db).git).toBeNull();
    } finally {
      db.close();
    }
  });
});
