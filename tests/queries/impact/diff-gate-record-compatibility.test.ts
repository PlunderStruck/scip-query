import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { diffGate } from '../../../src/queries/impact/diff-gate.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

const roots: string[] = [];
const dbs: ScipDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('diff-gate committed suppression compatibility', () => {
  it('reports future records even when the source diff is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-diff-gate-records-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', 'a.ts'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@t.t', 'commit', '-m', 'base'], {
      cwd: root,
      stdio: 'ignore',
    });

    const suppressionDir = join(root, '.scipquery', 'suppressions');
    mkdirSync(suppressionDir, { recursive: true });
    writeFileSync(
      join(suppressionDir, 'SQFUTURE.json'),
      `${JSON.stringify({ kind: 'scip-query-suppression', schemaVersion: 3, id: 'SQFUTURE' })}\n`,
    );

    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'a.ts').write();
    writeFileSync(join(root, '.gitignore'), 'index.db\n');
    execFileSync('git', ['add', '.gitignore', '.scipquery/suppressions/SQFUTURE.json'], {
      cwd: root,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=t@t.t', 'commit', '--no-gpg-sign', '-m', 'records'],
      {
        cwd: root,
        stdio: 'ignore',
      },
    );
    const config: ScipQueryConfig = {
      projectRoot: root,
      dbPath,
      indexPath: join(root, 'index.scip'),
    };
    const db = new ScipDatabase(config);
    dbs.push(db);

    const result = diffGate(db);
    expect(result.changedFiles).toEqual([]);
    expect(result.recordCompatibility?.suppressions).toMatchObject({
      complete: false,
      total: 1,
      accepted: 0,
      unsupportedFuture: 1,
      omitted: 1,
      issues: [
        {
          path: '.scipquery/suppressions/SQFUTURE.json',
          state: 'unsupported-future',
          reason: 'unsupported schemaVersion 3',
        },
      ],
    });
  });
});
