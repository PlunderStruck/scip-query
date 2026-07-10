import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  affectedSetShadowPaths,
  collectAffectedSetShadowRecord,
  compareDocumentFactDigests,
  digestDocumentFacts,
  evaluateAffectedSetShadow,
  formatAffectedSetShadowStatus,
  GLOBAL_FACTS_UNIT,
  readAffectedSetShadowStatus,
  readDocumentFactDigests,
  writeAffectedSetShadowRecord,
  type AffectedShadowDatabase,
  type AffectedSetShadowRecord,
  type AffectedSetShadowRuntime,
  type DocumentFactRecord,
  type EvaluatedAffectedSetShadowRecord,
} from '../../src/reindex/affected-shadow.js';
import type { AffectedSetFallbackReason, ProjectInputSnapshot } from '../../src/reindex/affected-set.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { createEvidenceSchema } from '../fixtures/evidence-fixture.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createDatabase(
  name: string,
  options: {
    bText?: string;
    bOccurrences?: Buffer;
    bKind?: number;
    bSignature?: Buffer;
    aMentionSymbolId?: 1 | 2;
    orphanSymbol?: string;
  } = {},
): ScipDatabase {
  const projectRoot = mkdtempSync(join(tmpdir(), `scip-query-shadow-${name}-`));
  tempDirs.push(projectRoot);
  const dbPath = join(projectRoot, 'index.db');
  const sqlite = new Database(dbPath);
  try {
    createEvidenceSchema(sqlite);
    sqlite
      .prepare('INSERT INTO documents (id, language, relative_path, position_encoding, text) VALUES (?, ?, ?, ?, ?)')
      .run(1, 'typescript', 'src/a.ts', 'utf-8', 'export const a = 1;');
    sqlite
      .prepare('INSERT INTO documents (id, language, relative_path, position_encoding, text) VALUES (?, ?, ?, ?, ?)')
      .run(2, 'typescript', 'src/b.ts', 'utf-8', options.bText ?? 'export const b = 1;');
    sqlite
      .prepare(
        `INSERT INTO global_symbols
         (id, symbol, display_name, kind, documentation, signature, enclosing_symbol, relationships)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 'scip . . . a.', 'a', 17, 'a docs', Buffer.from([1]), null, Buffer.from([2]));
    sqlite
      .prepare(
        `INSERT INTO global_symbols
         (id, symbol, display_name, kind, documentation, signature, enclosing_symbol, relationships)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        2,
        'scip . . . b.',
        'b',
        options.bKind ?? 17,
        'b docs',
        options.bSignature ?? Buffer.from([3]),
        null,
        Buffer.from([4]),
      );
    sqlite
      .prepare(
        `INSERT INTO defn_enclosing_ranges
         (id, document_id, symbol_id, start_line, start_char, end_line, end_char)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 1, 1, 0, 0, 0, 10);
    sqlite
      .prepare(
        `INSERT INTO defn_enclosing_ranges
         (id, document_id, symbol_id, start_line, start_char, end_line, end_char)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(2, 2, 2, 0, 0, 0, 10);
    sqlite
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 1, 0, 0, 1, Buffer.from([5]));
    sqlite
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(2, 2, 0, 0, 1, options.bOccurrences ?? Buffer.from([6]));
    sqlite
      .prepare('INSERT INTO mentions (chunk_id, symbol_id, role) VALUES (?, ?, ?)')
      .run(1, options.aMentionSymbolId ?? 1, 1);
    sqlite.prepare('INSERT INTO mentions (chunk_id, symbol_id, role) VALUES (?, ?, ?)').run(2, 2, 1);
    if (options.orphanSymbol) {
      sqlite
        .prepare('INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES (?, ?, ?, ?)')
        .run(3, options.orphanSymbol, 'orphan', 17);
    }
  } finally {
    sqlite.close();
  }
  return new ScipDatabase({ projectRoot, dbPath });
}

function snapshot(hash: string): ProjectInputSnapshot {
  return {
    version: 2,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'single',
    typescriptProjects: [],
    files: [
      { path: 'src/a.ts', hash, size: 1 },
      { path: 'src/b.ts', hash: 'same', size: 4 },
    ],
  };
}

describe('affected-set document fact oracle', () => {
  it('normalizes record ordering while preserving fact differences', () => {
    const facts: DocumentFactRecord[] = [
      { relativePath: 'src/a.ts', kind: 'chunk', values: [0, 'AA'] },
      { relativePath: 'src/a.ts', kind: 'document', values: ['typescript', null, 'text'] },
    ];
    const reversed = [...facts].reverse();
    expect(digestDocumentFacts(facts)).toEqual(digestDocumentFacts(reversed));

    reversed[0] = { relativePath: 'src/a.ts', kind: 'document', values: ['typescript', null, 'changed'] };
    expect(digestDocumentFacts(facts).get('src/a.ts')).not.toBe(digestDocumentFacts(reversed).get('src/a.ts'));
  });

  it('detects document text, binary occurrence, and symbol fact changes in the owning file', () => {
    const before = createDatabase('before');
    const after = createDatabase('after', {
      bText: 'export const b = 2;',
      bOccurrences: Buffer.from([9]),
      bKind: 61,
    });
    try {
      const comparison = compareDocumentFactDigests(readDocumentFactDigests(before), readDocumentFactDigests(after));
      expect(comparison).toEqual({
        addedFiles: [],
        modifiedFiles: ['src/b.ts'],
        deletedFiles: [],
        changedFiles: ['src/b.ts'],
        unchangedFiles: ['src/a.ts'],
      });
    } finally {
      before.close();
      after.close();
    }
  });

  it('tracks unowned global symbols in an explicit global fact unit', () => {
    const before = createDatabase('global-before');
    const after = createDatabase('global-after', { orphanSymbol: 'scip . . . orphan.' });
    try {
      expect(
        compareDocumentFactDigests(readDocumentFactDigests(before), readDocumentFactDigests(after)).addedFiles,
      ).toEqual([GLOBAL_FACTS_UNIT]);
    } finally {
      before.close();
      after.close();
    }
  });

  it('marks a consumer when metadata for its mentioned symbol changes', () => {
    const before = createDatabase('consumer-before', { aMentionSymbolId: 2 });
    const after = createDatabase('consumer-after', { aMentionSymbolId: 2, bSignature: Buffer.from([99]) });
    try {
      expect(
        compareDocumentFactDigests(readDocumentFactDigests(before), readDocumentFactDigests(after)).modifiedFiles,
      ).toEqual(['src/a.ts', 'src/b.ts']);
    } finally {
      before.close();
      after.close();
    }
  });

  it('classifies added, modified, deleted, and unchanged digest units', () => {
    expect(
      compareDocumentFactDigests(
        new Map([
          ['deleted.ts', 'old'],
          ['modified.ts', 'old'],
          ['same.ts', 'same'],
        ]),
        new Map([
          ['added.ts', 'new'],
          ['modified.ts', 'new'],
          ['same.ts', 'same'],
        ]),
      ),
    ).toEqual({
      addedFiles: ['added.ts'],
      modifiedFiles: ['modified.ts'],
      deletedFiles: ['deleted.ts'],
      changedFiles: ['added.ts', 'deleted.ts', 'modified.ts'],
      unchangedFiles: ['same.ts'],
    });
  });

  it('fails recall when the prediction omits a changed document', () => {
    const comparison = {
      addedFiles: [],
      modifiedFiles: ['src/a.ts', 'src/b.ts'],
      deletedFiles: [],
      changedFiles: ['src/a.ts', 'src/b.ts'],
      unchangedFiles: ['src/c.ts'],
    };
    expect(evaluateAffectedSetShadow({ mode: 'closure', affectedFiles: ['src/a.ts'] }, comparison, 4)).toMatchObject({
      passed: false,
      recall: 0.5,
      affectedRatio: 0.25,
      missingFiles: ['src/b.ts'],
      extraFiles: [],
    });
  });

  it('treats full-project work as covering global facts and reports over-invalidation', () => {
    const comparison = {
      addedFiles: [GLOBAL_FACTS_UNIT],
      modifiedFiles: ['src/a.ts'],
      deletedFiles: [],
      changedFiles: [GLOBAL_FACTS_UNIT, 'src/a.ts'],
      unchangedFiles: ['src/b.ts'],
    };
    expect(
      evaluateAffectedSetShadow({ mode: 'full-project', affectedFiles: ['src/a.ts', 'src/b.ts'] }, comparison, 2),
    ).toEqual({
      passed: true,
      recall: 1,
      affectedRatio: 1,
      predictedFiles: ['src/a.ts', 'src/b.ts'],
      actualFiles: [GLOBAL_FACTS_UNIT, 'src/a.ts'],
      missingFiles: [],
      extraFiles: ['src/b.ts'],
    });
  });

  it('treats a full-project fallback as covering newly observed document units', () => {
    const comparison = {
      addedFiles: ['src/new.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      changedFiles: ['src/new.ts'],
      unchangedFiles: ['src/a.ts'],
    };
    expect(
      evaluateAffectedSetShadow({ mode: 'full-project', affectedFiles: ['src/a.ts'] }, comparison, 1),
    ).toMatchObject({
      passed: true,
      recall: 1,
      missingFiles: [],
    });
  });

  it('collects a closed, deterministic record from injected old/new database evidence', () => {
    const closed: string[] = [];
    const before = fakeDatabase('before', closed);
    const after = fakeDatabase('after', closed);
    const times = [1_000, 1_012];
    const runtime: AffectedSetShadowRuntime = {
      now: () => times.shift() ?? 1_012,
      databaseExists: () => true,
      openDatabase: (_projectRoot, dbPath) => (dbPath === 'before.db' ? before : after),
      indexedPaths: () => ['src/a.ts', 'src/b.ts'],
      dependencyGraph: () => new Map([['src/b.ts', new Set(['src/a.ts'])]]),
      factDigests: (db) =>
        db === before
          ? new Map([
              ['src/a.ts', 'old'],
              ['src/b.ts', 'old'],
            ])
          : new Map([
              ['src/a.ts', 'new'],
              ['src/b.ts', 'new'],
            ]),
    };

    expect(
      collectAffectedSetShadowRecord(
        {
          projectRoot: '/project',
          previousDbPath: 'before.db',
          previousIndexPath: 'before.scip',
          candidateDbPath: 'after.db',
          candidateIndexPath: 'after.scip',
          previousSnapshot: snapshot('old'),
          currentSnapshot: snapshot('new'),
          refreshResult: 'rebuilt',
        },
        runtime,
      ),
    ).toMatchObject({
      version: 1,
      status: 'evaluated',
      refreshResult: 'rebuilt',
      durationMs: 12,
      plan: { mode: 'closure', affectedFiles: ['src/a.ts', 'src/b.ts'] },
      comparison: { changedFiles: ['src/a.ts', 'src/b.ts'] },
      evaluation: { passed: true, recall: 1, missingFiles: [] },
    });
    expect(closed.sort()).toEqual(['after', 'before']);
  });

  it('records unavailable evidence without trying to open a missing prior database', () => {
    const openDatabase = vi.fn();
    const runtime: AffectedSetShadowRuntime = {
      now: () => 1_000,
      databaseExists: (path) => path !== 'before.db',
      openDatabase,
      indexedPaths: () => [],
      dependencyGraph: () => new Map(),
      factDigests: () => new Map(),
    };
    expect(
      collectAffectedSetShadowRecord(
        {
          projectRoot: '/project',
          previousDbPath: 'before.db',
          previousIndexPath: 'before.scip',
          candidateDbPath: 'after.db',
          candidateIndexPath: 'after.scip',
          previousSnapshot: null,
          currentSnapshot: snapshot('new'),
          refreshResult: 'rebuilt',
        },
        runtime,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'prior-index-unavailable' });
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('skips dependency-graph work when the manifest already requires a full-project fallback', () => {
    const before = fakeDatabase('before', []);
    const after = fakeDatabase('after', []);
    const dependencyGraph = vi.fn(() => new Map());
    const runtime: AffectedSetShadowRuntime = {
      now: () => 1_000,
      databaseExists: () => true,
      openDatabase: (_projectRoot, dbPath) => (dbPath === 'before.db' ? before : after),
      indexedPaths: () => ['src/a.ts', 'src/b.ts'],
      dependencyGraph,
      factDigests: () => new Map(),
    };

    expect(
      collectAffectedSetShadowRecord(
        {
          projectRoot: '/project',
          previousDbPath: 'before.db',
          previousIndexPath: 'before.scip',
          candidateDbPath: 'after.db',
          candidateIndexPath: 'after.scip',
          previousSnapshot: null,
          currentSnapshot: snapshot('new'),
          refreshResult: 'rebuilt',
        },
        runtime,
      ),
    ).toMatchObject({ status: 'evaluated', plan: { mode: 'full-project' } });
    expect(dependencyGraph).not.toHaveBeenCalled();
  });

  it('appends history before atomically replacing the latest record', () => {
    const calls: string[] = [];
    const record: AffectedSetShadowRecord = {
      version: 1,
      status: 'unavailable',
      refreshResult: 'rebuilt',
      recordedAt: '1970-01-01T00:00:01.000Z',
      durationMs: 0,
      reason: 'prior-index-unavailable',
    };
    const paths = writeAffectedSetShadowRecord('/cache/index.db', record, {
      appendHistory: (path) => calls.push(`history:${path}`),
      writeLatest: (path) => calls.push(`latest:${path}`),
    });
    expect(paths).toEqual(affectedSetShadowPaths('/cache/index.db'));
    expect(calls).toEqual(['history:/cache/affected-shadow.jsonl', 'latest:/cache/affected-shadow-latest.json']);
  });

  it('reads and formats a passing status summary', () => {
    const status = readAffectedSetShadowStatus('/cache/index.db', () => JSON.stringify(evaluatedRecord()));
    expect(status).toMatchObject({
      state: 'passing',
      mode: 'closure',
      recall: 1,
      affectedRatio: 0.25,
      predictedFiles: ['src/a.ts'],
      actualFiles: ['src/a.ts'],
      missingFiles: [],
      fallbackReasons: [],
      latestPath: '/cache/affected-shadow-latest.json',
    });
    expect(formatAffectedSetShadowStatus(status)).toBe(
      'passing, 100.0% recall, 1 predicted / 1 changed, 25.0% of project',
    );
  });

  it('surfaces a failing recall record and exact miss count', () => {
    const status = readAffectedSetShadowStatus('/cache/index.db', () =>
      JSON.stringify(
        evaluatedRecord({
          passed: false,
          recall: 0.5,
          actualFiles: ['src/a.ts', 'src/b.ts'],
          missingFiles: ['src/b.ts'],
        }),
      ),
    );
    expect(status).toMatchObject({ state: 'failing', recall: 0.5, missingFiles: ['src/b.ts'] });
    expect(formatAffectedSetShadowStatus(status)).toContain('failing, 50.0% recall, 1 predicted / 2 changed');
    expect(formatAffectedSetShadowStatus(status)).toContain('1 missed');
  });

  it('reports a conservative fallback without calling it a recall failure', () => {
    const status = readAffectedSetShadowStatus('/cache/index.db', () =>
      JSON.stringify(
        evaluatedRecord({
          mode: 'full-project',
          predictedFiles: ['src/a.ts', 'src/b.ts'],
          affectedRatio: 1,
          fallbackReasons: ['file-added'],
        }),
      ),
    );
    expect(status).toMatchObject({
      state: 'passing',
      mode: 'full-project',
      fallbackReasons: ['file-added'],
    });
    expect(formatAffectedSetShadowStatus(status)).toContain('fallback: file-added');
  });

  it('preserves an oracle-unavailable record as unavailable status', () => {
    const record: AffectedSetShadowRecord = {
      version: 1,
      status: 'unavailable',
      refreshResult: 'reused',
      recordedAt: '2026-07-10T00:00:00.000Z',
      durationMs: 4,
      reason: 'oracle-error',
      error: 'database is malformed',
    };
    const status = readAffectedSetShadowStatus('/cache/index.db', () => JSON.stringify(record));
    expect(status).toMatchObject({
      state: 'unavailable',
      reason: 'oracle-error',
      refreshResult: 'reused',
      error: 'database is malformed',
    });
  });

  it('distinguishes missing, malformed, unreadable, and unsupported telemetry', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const unreadable = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(
      readAffectedSetShadowStatus('/cache/index.db', () => {
        throw missing;
      }),
    ).toMatchObject({ state: 'unavailable', reason: 'telemetry-missing' });
    expect(readAffectedSetShadowStatus('/cache/index.db', () => '{')).toMatchObject({
      state: 'unavailable',
      reason: 'telemetry-malformed',
    });
    expect(
      readAffectedSetShadowStatus('/cache/index.db', () => {
        throw unreadable;
      }),
    ).toMatchObject({ state: 'unavailable', reason: 'telemetry-unreadable', error: 'permission denied' });
    expect(readAffectedSetShadowStatus('/cache/index.db', () => JSON.stringify({ version: 2 }))).toMatchObject({
      state: 'unavailable',
      reason: 'unsupported-record-version',
    });
    expect(
      readAffectedSetShadowStatus('/cache/index.db', () =>
        JSON.stringify(evaluatedRecord({ missingFiles: ['src/not-actual.ts'] })),
      ),
    ).toMatchObject({ state: 'unavailable', reason: 'telemetry-malformed' });
  });
});

function fakeDatabase(label: string, closed: string[]): AffectedShadowDatabase {
  return {
    all: () => [],
    close: () => closed.push(label),
  };
}

function evaluatedRecord(
  options: {
    passed?: boolean;
    recall?: number;
    affectedRatio?: number;
    mode?: 'none' | 'closure' | 'full-project';
    predictedFiles?: string[];
    actualFiles?: string[];
    missingFiles?: string[];
    fallbackReasons?: AffectedSetFallbackReason[];
  } = {},
): EvaluatedAffectedSetShadowRecord {
  const predictedFiles = options.predictedFiles ?? ['src/a.ts'];
  const actualFiles = options.actualFiles ?? ['src/a.ts'];
  const missingFiles = options.missingFiles ?? [];
  return {
    version: 1,
    status: 'evaluated',
    refreshResult: 'rebuilt',
    recordedAt: '2026-07-10T00:00:00.000Z',
    durationMs: 12,
    manifest: { version: 1, changes: [], projectIdentityChanged: false, uncertainty: [] },
    plan: {
      mode: options.mode ?? 'closure',
      changedFiles: ['src/a.ts'],
      affectedFiles: predictedFiles,
      reasons: options.fallbackReasons ?? [],
    },
    comparison: {
      addedFiles: [],
      modifiedFiles: actualFiles,
      deletedFiles: [],
      changedFiles: actualFiles,
      unchangedFiles: [],
    },
    evaluation: {
      passed: options.passed ?? true,
      recall: options.recall ?? 1,
      affectedRatio: options.affectedRatio ?? 0.25,
      predictedFiles,
      actualFiles,
      missingFiles,
      extraFiles: [],
    },
  };
}
