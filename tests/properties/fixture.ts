import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../src/storage/db.js';
import { execFileSync } from 'node:child_process';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

export function withSourceDb<T>(files: Record<string, string>, run: (db: ScipDatabase, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-property-source-'));
  try {
    writeFixtureFiles(root, files);
    const dbPath = join(root, 'index.db');
    const fixture = evidenceFixtureDb(dbPath);
    Object.keys(files).forEach((file, n) => fixture.document(n + 1, 'typescript', file));
    fixture.write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      return run(db, root);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function withGitProject<T>(files: Record<string, string>, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-property-project-'));
  try {
    writeFixtureFiles(root, files);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
