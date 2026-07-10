import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareDocumentFactDigests,
  digestDocumentFacts,
  evaluateAffectedSetShadow,
  GLOBAL_FACTS_UNIT,
  readDocumentFactDigests,
  type DocumentFactRecord,
} from '../../src/reindex/affected-shadow.js';
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
});
