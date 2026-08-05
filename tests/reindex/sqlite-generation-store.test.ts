import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import {
  decodeResultCursor,
  encodeResultCursor,
  indexGenerationIdentity,
} from '../../src/runtime/result-pagination.js';
import { ScipDatabase } from '../../src/storage/db.js';
import {
  SQLITE_GENERATION_MANIFEST,
  SQLITE_GENERATION_READERS_DIRECTORY,
} from '../../src/storage/sqlite-generation.js';
import {
  collectLocalSqliteGenerations,
  ensureImmutableSqliteGeneration,
  inspectSqliteGeneration,
  inspectLocalSqliteGenerationRetention,
  promoteReindexArtifacts,
  readSqliteGenerationState,
  refreshSqliteGenerationMetadata,
  sqliteGenerationRoot,
} from '../../src/reindex/sqlite-generation-store.js';

describe('SQLite generation handoff', () => {
  test.each([
    ['after-recovery-retained', 'old'],
    ['after-pointer-handoff', 'old'],
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
    expect(readValue(publishedDatabasePath(fixture.paths.outputDb))).toBe('old');
  });

  test.each([
    'after-recovery-retained',
    'after-pointer-handoff',
    'after-scip-handoff',
    'after-database-handoff',
    'after-metadata-handoff',
  ] as const)('keeps new database handles on one complete generation at %s', (failureStage) => {
    const fixture = createFixture();
    let observed:
      | { value: string; identity: string; metadata: string | undefined; scip: string | undefined }
      | undefined;

    expect(() =>
      promoteReindexArtifacts({
        ...fixture.paths,
        onStage: (stage) => {
          if (stage !== failureStage) return;
          const db = openFixtureDatabase(fixture);
          try {
            observed = {
              value: readValueFromDatabase(db.db),
              identity: indexGenerationIdentity(db),
              metadata: db.generation.metadataRaw,
              scip: db.generation.indexPath ? readFileSync(db.generation.indexPath, 'utf8') : undefined,
            };
          } finally {
            db.close();
          }
          throw new Error(`failure at ${stage}`);
        },
      }),
    ).toThrow(`failure at ${failureStage}`);

    const pointerSwitched = failureStage !== 'after-recovery-retained';
    expect(observed).toEqual({
      value: pointerSwitched ? 'new' : 'old',
      identity: readSqliteGenerationState(fixture.paths.outputDb)!.currentGeneration,
      metadata: pointerSwitched ? 'new-meta' : 'old-meta',
      scip: pointerSwitched ? 'new-scip' : 'old-scip',
    });
  });

  test('keeps an old reader on the old inode while new readers open the new generation', () => {
    const fixture = createFixture();
    const oldReader = new Database(fixture.paths.outputDb, { readonly: true });

    const result = promoteReindexArtifacts({
      ...fixture.paths,
      publication: {
        mode: 'incremental',
        validation: 'passed',
        converterDurationMs: 12,
        affectedDocumentCount: 1,
        changedDocumentCount: 1,
        producerDurationMs: 7,
        patchDurationMs: 4,
      },
      now: () => new Date('2026-07-10T09:00:00.000Z'),
    });
    expect(result).toEqual(
      expect.objectContaining({
        achievedDurability: 'directory-durable',
        directorySync: 'synced',
      }),
    );
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
        publication: expect.objectContaining({ mode: 'incremental', patchDurationMs: 4 }),
        publishedAt: '2026-07-10T09:00:00.000Z',
      }),
    );
    expect(inspectSqliteGeneration(fixture.paths.outputDb, fixture.paths.metaPath)).toEqual(
      expect.objectContaining({ state: 'current', currentMatches: true, recoveryExists: true }),
    );
  });

  test('retains immutable generations so existing readers never lose their companions', () => {
    const fixture = createFixture();
    promoteReindexArtifacts({ ...fixture.paths });
    const retainedReader = openFixtureDatabase(fixture);
    const retainedIdentity = retainedReader.generation.identity;

    const second = createCandidateArtifacts(fixture.root, 'next', 'next-scip', 'next-meta');
    const result = promoteReindexArtifacts({
      tempOutputScip: second.scip,
      tempOutputDb: second.db,
      tempMetaPath: second.meta,
      outputScip: fixture.paths.outputScip,
      outputDb: fixture.paths.outputDb,
      metaPath: fixture.paths.metaPath,
    });

    const currentReader = openFixtureDatabase(fixture);
    try {
      expect(generationDirectories(fixture.paths.outputDb)).toHaveLength(2);
      expect(readValue(join(dirname(fixture.paths.outputDb), result.previousGeneration!.databasePath))).toBe('new');
      expect(readValueFromDatabase(retainedReader.db)).toBe('new');
      expect(retainedReader.generation.metadataRaw).toBe('new-meta');
      expect(readFileSync(retainedReader.generation.indexPath!, 'utf8')).toBe('new-scip');
      expect(indexGenerationIdentity(retainedReader)).toBe(retainedIdentity);
      expect(readValueFromDatabase(currentReader.db)).toBe('next');
      expect(currentReader.generation.metadataRaw).toBe('next-meta');
      expect(currentReader.generation.identity).not.toBe(retainedIdentity);
      expect(readValue(fixture.paths.outputDb)).toBe('next');
    } finally {
      retainedReader.close();
      currentReader.close();
    }
  });

  test('rejects a continuation cursor before applying an old offset to a new result set', () => {
    const fixture = createFixture();
    promoteReindexArtifacts({ ...fixture.paths });
    const firstPageReader = openFixtureDatabase(fixture);
    const cursor = encodeResultCursor({
      command: 'refs',
      target: 'value',
      offset: 1,
      indexGeneration: indexGenerationIdentity(firstPageReader),
    });

    const changed = createCandidateArtifacts(fixture.root, 'changed-order', 'changed-scip', 'changed-meta');
    promoteReindexArtifacts({
      tempOutputScip: changed.scip,
      tempOutputDb: changed.db,
      tempMetaPath: changed.meta,
      outputScip: fixture.paths.outputScip,
      outputDb: fixture.paths.outputDb,
      metaPath: fixture.paths.metaPath,
    });
    const continuationReader = openFixtureDatabase(fixture);
    try {
      expect(
        decodeResultCursor(cursor, {
          command: 'refs',
          target: 'value',
          indexGeneration: indexGenerationIdentity(firstPageReader),
        }).offset,
      ).toBe(1);
      expect(() =>
        decodeResultCursor(cursor, {
          command: 'refs',
          target: 'value',
          indexGeneration: indexGenerationIdentity(continuationReader),
        }),
      ).toThrow('index changed');
    } finally {
      firstPageReader.close();
      continuationReader.close();
    }
  });

  test('can publish a database generation while retaining a deferred SCIP companion', () => {
    const fixture = createFixture();
    const result = promoteReindexArtifacts({
      ...fixture.paths,
      preserveOutputScip: true,
      publication: {
        mode: 'incremental',
        validation: 'passed',
        converterDurationMs: 2,
        scipCompanion: 'deferred',
        typescriptOverlayGeneration: 'typescript-generation-2',
      },
    });

    expect(readFileSync(fixture.paths.outputScip, 'utf8')).toBe('old-scip');
    expect(readValue(fixture.paths.outputDb)).toBe('new');
    expect(readSqliteGenerationState(fixture.paths.outputDb)).toEqual(
      expect.objectContaining({
        currentGeneration: result.currentGeneration,
        publication: expect.objectContaining({ scipCompanion: 'deferred' }),
      }),
    );
  });

  test('retains a legacy database even when it has no metadata companion', () => {
    const fixture = createFixture({ legacyWithoutMeta: true });

    const result = promoteReindexArtifacts({ ...fixture.paths });

    expect(result.previousGeneration?.metadataPath).toBeUndefined();
    expect(readValue(join(dirname(fixture.paths.outputDb), result.previousGeneration!.databasePath))).toBe('old');
    expect(readFileSync(fixture.paths.metaPath, 'utf8')).toBe('new-meta');
  });

  test('ignores last-refresh-only metadata changes but detects generation and recovery drift', () => {
    const fixture = createFixture();
    const metadata = {
      version: 3,
      status: 'complete',
      updatedAt: '2026-07-10T09:00:00.000Z',
      fingerprint: { version: 2, files: [] },
      indexedLanguages: ['typescript'],
    };
    writeFileSync(fixture.paths.tempMetaPath, JSON.stringify(metadata));
    const result = promoteReindexArtifacts({ ...fixture.paths });

    writeFileSync(
      fixture.paths.metaPath,
      JSON.stringify({ ...metadata, lastRefresh: { result: 'reused', durationMs: 3 } }),
    );
    expect(inspectSqliteGeneration(fixture.paths.outputDb, fixture.paths.metaPath).state).toBe('current');

    writeFileSync(fixture.paths.metaPath, JSON.stringify({ ...metadata, updatedAt: '2026-07-10T09:01:00.000Z' }));
    expect(inspectSqliteGeneration(fixture.paths.outputDb, fixture.paths.metaPath)).toEqual(
      expect.objectContaining({ state: 'drifted', currentMatches: false }),
    );

    writeFileSync(fixture.paths.metaPath, JSON.stringify(metadata));
    rmSync(join(dirname(fixture.paths.outputDb), result.previousGeneration!.databasePath));
    expect(inspectSqliteGeneration(fixture.paths.outputDb, fixture.paths.metaPath)).toEqual(
      expect.objectContaining({ state: 'drifted', recoveryExists: false }),
    );
  });

  test('classifies a malformed generation state without throwing', () => {
    const fixture = createFixture();
    promoteReindexArtifacts({ ...fixture.paths });
    writeFileSync(join(sqliteGenerationRoot(fixture.paths.outputDb), 'state.json'), '{');

    expect(inspectSqliteGeneration(fixture.paths.outputDb, fixture.paths.metaPath)).toEqual(
      expect.objectContaining({ state: 'invalid', reason: 'generation state is malformed' }),
    );
  });

  test('refreshes generation identity after a metadata-only publication', () => {
    const fixture = createFixture();
    promoteReindexArtifacts({ ...fixture.paths });
    const prior = openFixtureDatabase(fixture);
    writeFileSync(fixture.paths.metaPath, 'metadata-only-update');
    expect(inspectSqliteGeneration(fixture.paths.outputDb, fixture.paths.metaPath).state).toBe('drifted');

    refreshSqliteGenerationMetadata(
      fixture.paths.outputDb,
      fixture.paths.metaPath,
      () => new Date('2026-07-10T10:30:00.000Z'),
    );

    const current = openFixtureDatabase(fixture);
    try {
      expect(inspectSqliteGeneration(fixture.paths.outputDb, fixture.paths.metaPath)).toEqual(
        expect.objectContaining({ state: 'current', currentMatches: true }),
      );
      expect(readSqliteGenerationState(fixture.paths.outputDb)?.publishedAt).toBe('2026-07-10T10:30:00.000Z');
      expect(prior.generation.metadataRaw).toBe('new-meta');
      expect(current.generation.metadataRaw).toBe('metadata-only-update');
      expect(current.generation.identity).not.toBe(prior.generation.identity);
      expect(readValueFromDatabase(current.db)).toBe('new');
    } finally {
      prior.close();
      current.close();
    }
  });

  test('fails closed when an immutable generation named by the pointer is missing', () => {
    const fixture = createFixture();
    const result = promoteReindexArtifacts({ ...fixture.paths });
    rmSync(join(sqliteGenerationRoot(fixture.paths.outputDb), result.currentGeneration, SQLITE_GENERATION_MANIFEST));

    expect(() => openFixtureDatabase(fixture)).toThrow(
      `Published SQLite generation ${result.currentGeneration} is missing or invalid.`,
    );
  });

  test.each(['database', 'index', 'metadata'] as const)(
    'rejects same-size %s corruption after a prior successful validation',
    (artifactKind) => {
      const fixture = createFixture();
      const result = promoteReindexArtifacts({ ...fixture.paths });
      const first = openFixtureDatabase(fixture);
      first.close();
      const generationDirectory = join(sqliteGenerationRoot(fixture.paths.outputDb), result.currentGeneration);
      const artifactPath =
        artifactKind === 'database'
          ? join(generationDirectory, 'index.db')
          : artifactKind === 'index'
            ? join(generationDirectory, 'index.scip')
            : join(generationDirectory, 'meta.json');
      const bytes = readFileSync(artifactPath);
      const corrupt = Buffer.from(bytes);
      corrupt[Math.max(0, corrupt.length - 1)] ^= 0xff;
      chmodSync(artifactPath, 0o644);
      writeFileSync(artifactPath, corrupt);
      expect(statSync(artifactPath).size).toBe(bytes.length);

      expect(() => openFixtureDatabase(fixture)).toThrow(
        `Published SQLite generation ${result.currentGeneration} is missing or invalid.`,
      );
    },
  );

  test('fails closed on a corrupt current generation instead of silently selecting a valid previous generation', () => {
    const fixture = createFixture();
    const result = promoteReindexArtifacts({ ...fixture.paths });
    expect(result.previousGeneration).toBeDefined();
    const currentScip = join(sqliteGenerationRoot(fixture.paths.outputDb), result.currentGeneration, 'index.scip');
    chmodSync(currentScip, 0o644);
    writeFileSync(currentScip, 'bad-scip');

    expect(() => openFixtureDatabase(fixture)).toThrow(
      `Published SQLite generation ${result.currentGeneration} is missing or invalid.`,
    );
  });

  test('publishes immutable generation artifacts with read-only mode on POSIX', () => {
    const fixture = createFixture();
    const result = promoteReindexArtifacts({ ...fixture.paths });
    if (process.platform === 'win32') return;
    const generationDirectory = join(sqliteGenerationRoot(fixture.paths.outputDb), result.currentGeneration);

    for (const name of ['index.db', 'index.scip', 'meta.json']) {
      expect(statSync(join(generationDirectory, name)).mode & 0o777).toBe(0o444);
    }
  });

  test('does not open replaceable legacy paths while an older publisher owns the reindex lock', () => {
    const fixture = createFixture();
    const lockPath = join(dirname(fixture.paths.outputDb), 'index.lock');
    writeFileSync(lockPath, '{}');

    expect(() => openFixtureDatabase(fixture)).toThrow('Legacy SQLite publication is in progress');
    const upgraded = ensureImmutableSqliteGeneration(
      fixture.paths.outputDb,
      fixture.paths.outputScip,
      fixture.paths.metaPath,
    );
    const db = openFixtureDatabase(fixture);
    try {
      expect(readValueFromDatabase(db.db)).toBe('old');
      expect(db.generation.source).toBe('immutable');
      expect(db.generation.identity).toBe(upgraded?.currentGeneration);
    } finally {
      db.close();
      rmSync(lockPath);
    }
  });

  test('keeps current, previous, and live-reader generations while enforcing retention after close', () => {
    const fixture = createFixture();
    promoteReindexArtifacts({ ...fixture.paths });
    const reader = openFixtureDatabase(fixture);
    const readerIdentity = reader.generation.identity;

    for (const value of ['next', 'latest']) {
      const candidate = createCandidateArtifacts(fixture.root, value, `${value}-scip`, `${value}-meta`);
      promoteReindexArtifacts({
        tempOutputScip: candidate.scip,
        tempOutputDb: candidate.db,
        tempMetaPath: candidate.meta,
        outputScip: fixture.paths.outputScip,
        outputDb: fixture.paths.outputDb,
        metaPath: fixture.paths.metaPath,
      });
    }

    const protectedResult = collectLocalSqliteGenerations(fixture.paths.outputDb, {
      limits: { maxGenerations: 2 },
    });
    expect(protectedResult).toEqual(
      expect.objectContaining({
        state: 'protected',
        generationCount: 3,
        activeReaderLeases: 1,
      }),
    );
    expect(generationDirectories(fixture.paths.outputDb)).toContain(readerIdentity);
    expect(readValueFromDatabase(reader.db)).toBe('new');

    reader.close();
    const collected = collectLocalSqliteGenerations(fixture.paths.outputDb, {
      limits: { maxGenerations: 2 },
    });
    expect(collected).toEqual(
      expect.objectContaining({
        state: 'collected',
        generationCount: 2,
        activeReaderLeases: 0,
        removedGenerations: 1,
      }),
    );
    expect(generationDirectories(fixture.paths.outputDb)).not.toContain(readerIdentity);
    expect(inspectLocalSqliteGenerationRetention(fixture.paths.outputDb)).toEqual(
      expect.objectContaining({
        state: 'managed',
        generationCount: 2,
        activeReaderLeases: 0,
        limits: expect.objectContaining({ maxGenerations: 2 }),
        lastCollection: expect.objectContaining({ state: 'collected' }),
      }),
    );
  });

  test('reclaims dead reader leases but fails closed on malformed ownership evidence', () => {
    const fixture = createFixture();
    promoteReindexArtifacts({ ...fixture.paths });
    const readersDirectory = join(sqliteGenerationRoot(fixture.paths.outputDb), SQLITE_GENERATION_READERS_DIRECTORY);
    mkdirSync(readersDirectory, { recursive: true });
    const state = readSqliteGenerationState(fixture.paths.outputDb)!;
    writeFileSync(
      join(readersDirectory, 'dead.json'),
      JSON.stringify({
        version: 1,
        token: 'dead',
        generationIdentity: state.currentGeneration,
        pid: 99_999_999,
        acquiredAt: new Date().toISOString(),
      }),
    );
    const dead = collectLocalSqliteGenerations(fixture.paths.outputDb, {
      isProcessAlive: () => false,
    });
    expect(dead.staleReaderLeasesRemoved).toBe(1);
    expect(readdirSync(readersDirectory)).toHaveLength(0);

    writeFileSync(join(readersDirectory, 'malformed.json'), '{');
    const malformed = collectLocalSqliteGenerations(fixture.paths.outputDb, {
      limits: { maxGenerations: 2, maxLogicalBytes: 1 },
    });
    expect(malformed).toEqual(
      expect.objectContaining({
        state: 'protected',
        malformedReaderLeases: 1,
        reason: 'malformed reader ownership evidence fails closed',
      }),
    );
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

function publishedDatabasePath(outputDb: string): string {
  const state = readSqliteGenerationState(outputDb);
  const generation = state?.previousGeneration?.generationIdentity ?? state?.currentGeneration;
  if (!generation) throw new Error('published generation was not retained');
  return join(sqliteGenerationRoot(outputDb), generation, 'index.db');
}

function generationDirectories(outputDb: string): string[] {
  return readdirSync(sqliteGenerationRoot(outputDb), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => entry.name);
}

function openFixtureDatabase(fixture: ReturnType<typeof createFixture>): ScipDatabase {
  return new ScipDatabase({
    projectRoot: fixture.root,
    dbPath: fixture.paths.outputDb,
    indexPath: fixture.paths.outputScip,
  });
}
