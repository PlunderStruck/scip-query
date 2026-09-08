import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';

const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

export function createFixture(opts: { legacyWithoutMeta?: boolean } = {}): {
  root: string;
  paths: {
    tempOutputScip: string;
    tempOutputDb: string;
    tempMetaPath: string;
    outputScip: string;
    outputDb: string;
    metaPath: string;
  };
} {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-sqlite-generation-'));
  roots.add(root);
  const stableDir = join(root, 'cache');
  mkdirSync(stableDir, { recursive: true });
  const outputScip = join(stableDir, 'index.scip');
  const outputDb = join(stableDir, 'index.db');
  const metaPath = join(stableDir, 'meta.json');
  writeFileSync(outputScip, 'old-scip');
  writeDatabase(outputDb, 'old');
  if (!opts.legacyWithoutMeta) writeFileSync(metaPath, 'old-meta');
  const candidate = createCandidateArtifacts(root, 'new', 'new-scip', 'new-meta');
  return {
    root,
    paths: {
      tempOutputScip: candidate.scip,
      tempOutputDb: candidate.db,
      tempMetaPath: candidate.meta,
      outputScip,
      outputDb,
      metaPath,
    },
  };
}

export function createCandidateArtifacts(
  root: string,
  value: string,
  scip: string,
  meta: string,
): { scip: string; db: string; meta: string } {
  const runDir = join(root, `run-${value}`);
  mkdirSync(runDir, { recursive: true });
  const paths = {
    scip: join(runDir, 'index.scip'),
    db: join(runDir, 'index.db'),
    meta: join(runDir, 'meta.json'),
  };
  writeFileSync(paths.scip, scip);
  writeDatabase(paths.db, value);
  writeFileSync(paths.meta, meta);
  return paths;
}

export function writeDatabase(path: string, value: string): void {
  const db = new Database(path);
  db.exec('CREATE TABLE generation_value (value TEXT NOT NULL)');
  db.prepare('INSERT INTO generation_value(value) VALUES (?)').run(value);
  db.close();
}

export function readValueFromDatabase(db: Database.Database): string {
  return db.prepare('SELECT value FROM generation_value').pluck().get() as string;
}

export function openFixtureDatabase(fixture: ReturnType<typeof createFixture>): ScipDatabase {
  return new ScipDatabase({
    projectRoot: fixture.root,
    dbPath: fixture.paths.outputDb,
    indexPath: fixture.paths.outputScip,
  });
}
