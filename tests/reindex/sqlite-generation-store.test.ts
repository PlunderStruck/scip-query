import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import {
  promoteReindexArtifacts,
  readSqliteGenerationState,
  sqliteGenerationRoot,
} from '../../src/reindex/sqlite-generation-store.js';

describe('SQLite generation handoff', () => {
  test.each([
    ['after-recovery-retained', 'old'],
    ['after-scip-handoff', 'old'],
    ['after-database-handoff', 'new'],
    ['after-metadata-handoff', 'new'],
  ] as const)('keeps a complete stable and recovery database at %s', (failureStage, stableValue) => {
    const fixture = createFixture();

    expect(() =>
      promoteReindexArtifacts({
        ...fixture.paths,
        onStage: (stage) => {
          if (stage === failureStage) throw new Error(`failure at ${stage}`);
        },
      }),
    ).toThrow(`failure at ${failureStage}`);

    expect(readValue(fixture.paths.outputDb)).toBe(stableValue);
    expect(readValue(recoveryDatabasePath(fixture.paths.outputDb))).toBe('old');
  });

  test('keeps an old reader on the old inode while new readers open the new generation', () => {
    const fixture = createFixture();
    const oldReader = new Database(fixture.paths.outputDb, { readonly: true });

    const result = promoteReindexArtifacts({
      ...fixture.paths,
      now: () => new Date('2026-07-10T09:00:00.000Z'),
    });
    const newReader = new Database(fixture.paths.outputDb, { readonly: true });
    try {
      expect(readValueFromDatabase(oldReader)).toBe('old');
      expect(readValueFromDatabase(newReader)).toBe('new');
    } finally {
      oldReader.close();
      newReader.close();
    }

    expect(readValue(join(dirname(fixture.paths.outputDb), result.previousGeneration!.databasePath))).toBe('old');
    expect(readSqliteGenerationState(fixture.paths.outputDb)).toEqual(
      expect.objectContaining({
        version: 1,
        currentGeneration: result.currentGeneration,
        previousGeneration: result.previousGeneration,
        publishedAt: '2026-07-10T09:00:00.000Z',
      }),
    );
  });

  test('retains only the immediately preceding successful generation', () => {
    const fixture = createFixture();
    promoteReindexArtifacts({ ...fixture.paths });

    const second = createCandidateArtifacts(fixture.root, 'next', 'next-scip', 'next-meta');
    const result = promoteReindexArtifacts({
      tempOutputScip: second.scip,
      tempOutputDb: second.db,
      tempMetaPath: second.meta,
      outputScip: fixture.paths.outputScip,
      outputDb: fixture.paths.outputDb,
      metaPath: fixture.paths.metaPath,
    });

    expect(generationDirectories(fixture.paths.outputDb)).toHaveLength(1);
    expect(readValue(join(dirname(fixture.paths.outputDb), result.previousGeneration!.databasePath))).toBe('new');
    expect(readValue(fixture.paths.outputDb)).toBe('next');
  });

  test('retains a legacy database even when it has no metadata companion', () => {
    const fixture = createFixture({ legacyWithoutMeta: true });

    const result = promoteReindexArtifacts({ ...fixture.paths });

    expect(result.previousGeneration?.metadataPath).toBeUndefined();
    expect(readValue(join(dirname(fixture.paths.outputDb), result.previousGeneration!.databasePath))).toBe('old');
    expect(readFileSync(fixture.paths.metaPath, 'utf8')).toBe('new-meta');
  });
});

function createFixture(opts: { legacyWithoutMeta?: boolean } = {}): {
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

function createCandidateArtifacts(
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

function writeDatabase(path: string, value: string): void {
  const db = new Database(path);
  db.exec('CREATE TABLE generation_value (value TEXT NOT NULL)');
  db.prepare('INSERT INTO generation_value(value) VALUES (?)').run(value);
  db.close();
}

function readValue(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return readValueFromDatabase(db);
  } finally {
    db.close();
  }
}

function readValueFromDatabase(db: Database.Database): string {
  return db.prepare('SELECT value FROM generation_value').pluck().get() as string;
}

function recoveryDatabasePath(outputDb: string): string {
  const generation = generationDirectories(outputDb)[0];
  if (!generation) throw new Error('recovery generation was not retained');
  return join(sqliteGenerationRoot(outputDb), generation, 'index.db');
}

function generationDirectories(outputDb: string): string[] {
  return readdirSync(sqliteGenerationRoot(outputDb), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
