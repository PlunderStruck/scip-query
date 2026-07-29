import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { monotonicNowMs } from '../domain/time.js';
import { cloneFileWithFallback, recordFileClone, type ReindexWriteTelemetry } from '../platform/file-clone.js';

export type IncrementalSqlitePatchStage =
  | 'after-delete'
  | 'after-symbol-reconciliation'
  | 'after-insert'
  | 'before-commit';

export interface PatchIncrementalSqliteGenerationInput {
  previousDbPath: string;
  miniDbPath: string;
  candidateDbPath: string;
  affectedFiles: readonly string[];
  writeTelemetry?: ReindexWriteTelemetry;
  onStage?: (stage: IncrementalSqlitePatchStage) => void;
}

export interface IncrementalSqlitePatchResult {
  candidateDbPath: string;
  affectedDocumentCount: number;
  changedDocumentPaths: string[];
  durationMs: number;
}

interface TableColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface IndexContract {
  table: string;
  columns: readonly string[];
}

const TABLE_CONTRACTS = {
  documents: [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'language', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'relative_path', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'position_encoding', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'text', type: 'TEXT', notnull: 0, pk: 0 },
  ],
  chunks: [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'document_id', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'chunk_index', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'start_line', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'end_line', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'occurrences', type: 'BLOB', notnull: 1, pk: 0 },
  ],
  global_symbols: [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'symbol', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'display_name', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'kind', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'documentation', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'signature', type: 'BLOB', notnull: 0, pk: 0 },
    { name: 'enclosing_symbol', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'relationships', type: 'BLOB', notnull: 0, pk: 0 },
  ],
  mentions: [
    { name: 'chunk_id', type: 'INTEGER', notnull: 1, pk: 1 },
    { name: 'symbol_id', type: 'INTEGER', notnull: 1, pk: 2 },
    { name: 'role', type: 'INTEGER', notnull: 1, pk: 3 },
  ],
  defn_enclosing_ranges: [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'document_id', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'symbol_id', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'start_line', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'start_char', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'end_line', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'end_char', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
} as const satisfies Record<string, readonly TableColumn[]>;

const INDEX_CONTRACTS = {
  idx_chunks_line_range: { table: 'chunks', columns: ['document_id', 'start_line', 'end_line'] },
  idx_defn_enclosing_ranges_document: {
    table: 'defn_enclosing_ranges',
    columns: ['document_id', 'start_line', 'end_line'],
  },
  idx_defn_enclosing_ranges_symbol_id: { table: 'defn_enclosing_ranges', columns: ['symbol_id'] },
  idx_mentions_symbol_id_role: { table: 'mentions', columns: ['symbol_id', 'role'] },
} as const satisfies Record<string, IndexContract>;

type DatabaseSchema = 'main' | 'incremental';

/**
 * Produces a private complete database generation by replacing the affected
 * documents with rows from an official `scip expt-convert` mini database.
 * The accepted database is opened read-only and is never modified.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; generation validation, patching, and publication are one transaction.
export function patchIncrementalSqliteGeneration(
  input: PatchIncrementalSqliteGenerationInput,
): IncrementalSqlitePatchResult {
  const startedAt = monotonicNowMs();
  const affectedFiles = validateAffectedFiles(input.affectedFiles);
  assertDistinctPaths(input.previousDbPath, input.miniDbPath, input.candidateDbPath);
  rmSync(input.candidateDbPath, { force: true });
  if (!existsSync(input.previousDbPath)) throw new Error('previous SQLite generation is unavailable');
  if (!existsSync(input.miniDbPath)) throw new Error('incremental SQLite mini database is unavailable');

  // The stable prior generation already passed publication integrity checks;
  // validate its schema here and run the full checks on the copied candidate.
  validateStandaloneDatabase(input.previousDbPath, 'previous SQLite generation', false);
  validateStandaloneDatabase(input.miniDbPath, 'incremental SQLite mini database');

  const clone = cloneFileWithFallback(input.previousDbPath, input.candidateDbPath);
  if (input.writeTelemetry) recordFileClone(input.writeTelemetry, clone);

  let db: Database.Database | null = null;
  try {
    db = new Database(input.candidateDbPath, { fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.prepare('ATTACH DATABASE ? AS incremental').run(input.miniDbPath);
    validateSchema(db, 'main', 'candidate SQLite generation');
    validateSchema(db, 'incremental', 'incremental SQLite mini database');
    prepareAffectedPaths(db, affectedFiles);
    validateDocumentSets(db, affectedFiles.length);
    const previousFactDigests = readAffectedFactDigests(db, 'main', true);

    const originalDocumentCount = scalarNumber(db, 'SELECT COUNT(*) AS value FROM main.documents');
    const transaction = db.transaction(() => {
      prepareSymbolOwnership(db!);
      rejectSharedDefinitions(db!);
      deleteAffectedDocumentRows(db!);
      input.onStage?.('after-delete');
      reconcileGlobalSymbols(db!);
      input.onStage?.('after-symbol-reconciliation');
      insertAffectedDocumentRows(db!);
      input.onStage?.('after-insert');
      pruneReconciledOrphanSymbols(db!);
      validatePatchedTransaction(db!, affectedFiles.length, originalDocumentCount);
      input.onStage?.('before-commit');
    });
    transaction.immediate();

    validateDatabaseIntegrity(db, 'main', 'candidate SQLite generation');
    const candidateFactDigests = validateAffectedFacts(db);
    const changedDocumentPaths = [...candidateFactDigests]
      .filter(([relativePath, digest]) => previousFactDigests.get(relativePath) !== digest)
      .map(([relativePath]) => relativePath)
      .sort();
    db.exec('DETACH DATABASE incremental');
    db.close();
    db = null;
    return {
      candidateDbPath: input.candidateDbPath,
      affectedDocumentCount: affectedFiles.length,
      changedDocumentPaths,
      durationMs: monotonicNowMs() - startedAt,
    };
  } catch (error) {
    try {
      db?.close();
    } finally {
      rmSync(input.candidateDbPath, { force: true });
    }
    throw new Error(
      `Incremental SQLite publication rejected: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function validateAffectedFiles(files: readonly string[]): string[] {
  if (files.length === 0) throw new Error('incremental SQLite publication requires affected documents');
  const normalized = [...files].sort();
  for (const file of normalized) {
    if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) {
      throw new Error(`invalid affected document path: ${file}`);
    }
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('incremental SQLite publication contains duplicate affected documents');
  }
  return normalized;
}

function assertDistinctPaths(previousDbPath: string, miniDbPath: string, candidateDbPath: string): void {
  const paths = [previousDbPath, miniDbPath, candidateDbPath].map((path) => resolve(path));
  if (new Set(paths).size !== paths.length) {
    throw new Error('previous, mini, and candidate SQLite paths must be distinct');
  }
}

function validateStandaloneDatabase(path: string, label: string, checkIntegrity = true): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    validateSchema(db, 'main', label);
    if (checkIntegrity) validateDatabaseIntegrity(db, 'main', label);
  } finally {
    db.close();
  }
}

function validateSchema(db: Database.Database, schema: DatabaseSchema, label: string): void {
  for (const [table, expected] of Object.entries(TABLE_CONTRACTS)) {
    const actual = db.prepare(`PRAGMA ${schema}.table_info('${table}')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const normalized = actual.map(({ name, type, notnull, pk }) => ({
      name,
      type: type.toUpperCase(),
      notnull,
      pk,
    }));
    if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
      throw new Error(`${label} schema changed for table ${table}`);
    }
  }

  for (const [name, expected] of Object.entries(INDEX_CONTRACTS)) {
    const index = db
      .prepare(`SELECT tbl_name FROM ${schema}.sqlite_master WHERE type = 'index' AND name = ?`)
      .get(name) as { tbl_name: string } | undefined;
    const columns = db
      .prepare(`PRAGMA ${schema}.index_info('${name}')`)
      .all()
      .map((row) => (row as { name: string }).name);
    if (index?.tbl_name !== expected.table || JSON.stringify(columns) !== JSON.stringify(expected.columns)) {
      throw new Error(`${label} schema changed for index ${name}`);
    }
  }
  assertUniqueIndex(db, schema, 'documents', ['relative_path'], label);
  assertUniqueIndex(db, schema, 'global_symbols', ['symbol'], label);
}

function assertUniqueIndex(
  db: Database.Database,
  schema: DatabaseSchema,
  table: string,
  expectedColumns: readonly string[],
  label: string,
): void {
  const indexes = db.prepare(`PRAGMA ${schema}.index_list('${table}')`).all() as Array<{
    name: string;
    unique: number;
  }>;
  const found = indexes.some((index) => {
    if (index.unique !== 1) return false;
    const columns = db
      .prepare(`PRAGMA ${schema}.index_info('${index.name}')`)
      .all()
      .map((row) => (row as { name: string }).name);
    return JSON.stringify(columns) === JSON.stringify(expectedColumns);
  });
  if (!found) throw new Error(`${label} lost the unique ${table}(${expectedColumns.join(', ')}) constraint`);
}

function validateDatabaseIntegrity(db: Database.Database, schema: DatabaseSchema, label: string): void {
  const integrity = db.prepare(`PRAGMA ${schema}.integrity_check`).pluck().get();
  if (integrity !== 'ok') throw new Error(`${label} failed integrity_check: ${String(integrity)}`);
  const foreignKeys = db.prepare(`PRAGMA ${schema}.foreign_key_check`).all();
  if (foreignKeys.length > 0) throw new Error(`${label} failed foreign_key_check`);
}

function prepareAffectedPaths(db: Database.Database, affectedFiles: readonly string[]): void {
  db.exec('CREATE TEMP TABLE incremental_affected_paths (relative_path TEXT PRIMARY KEY) WITHOUT ROWID');
  const insert = db.prepare('INSERT INTO temp.incremental_affected_paths(relative_path) VALUES (?)');
  const insertAll = db.transaction((files: readonly string[]) => {
    for (const file of files) insert.run(file);
  });
  insertAll(affectedFiles);
}

function validateDocumentSets(db: Database.Database, affectedCount: number): void {
  const miniCount = scalarNumber(db, 'SELECT COUNT(*) AS value FROM incremental.documents');
  const priorCount = scalarNumber(
    db,
    `SELECT COUNT(*) AS value
     FROM main.documents d
     JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path`,
  );
  const missing = db
    .prepare(
      `SELECT p.relative_path
       FROM temp.incremental_affected_paths p
       LEFT JOIN incremental.documents d ON d.relative_path = p.relative_path
       WHERE d.id IS NULL
       LIMIT 1`,
    )
    .pluck()
    .get();
  const unexpected = db
    .prepare(
      `SELECT d.relative_path
       FROM incremental.documents d
       LEFT JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path
       WHERE p.relative_path IS NULL
       LIMIT 1`,
    )
    .pluck()
    .get();
  if (
    miniCount !== affectedCount ||
    priorCount !== affectedCount ||
    missing !== undefined ||
    unexpected !== undefined
  ) {
    throw new Error('incremental SQLite mini database does not exactly match the affected document set');
  }
}

function prepareSymbolOwnership(db: Database.Database): void {
  db.exec(`
    CREATE TEMP TABLE incremental_old_defined_symbols (symbol TEXT PRIMARY KEY) WITHOUT ROWID;
    INSERT OR IGNORE INTO temp.incremental_old_defined_symbols(symbol)
    SELECT g.symbol
    FROM main.defn_enclosing_ranges r
    JOIN main.documents d ON d.id = r.document_id
    JOIN main.global_symbols g ON g.id = r.symbol_id
    JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path;
    INSERT OR IGNORE INTO temp.incremental_old_defined_symbols(symbol)
    SELECT g.symbol
    FROM main.mentions m
    JOIN main.chunks c ON c.id = m.chunk_id
    JOIN main.documents d ON d.id = c.document_id
    JOIN main.global_symbols g ON g.id = m.symbol_id
    JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path
    WHERE m.role = 1;

    CREATE TEMP TABLE incremental_new_defined_symbols (symbol TEXT PRIMARY KEY) WITHOUT ROWID;
    INSERT OR IGNORE INTO temp.incremental_new_defined_symbols(symbol)
    SELECT g.symbol
    FROM incremental.defn_enclosing_ranges r
    JOIN incremental.global_symbols g ON g.id = r.symbol_id;
    INSERT OR IGNORE INTO temp.incremental_new_defined_symbols(symbol)
    SELECT g.symbol
    FROM incremental.mentions m
    JOIN incremental.global_symbols g ON g.id = m.symbol_id
    WHERE m.role = 1;
  `);
}

function rejectSharedDefinitions(db: Database.Database): void {
  const shared = db
    .prepare(
      `WITH changed_symbols AS (
         SELECT symbol FROM temp.incremental_old_defined_symbols
         UNION
         SELECT symbol FROM temp.incremental_new_defined_symbols
       ), unaffected_definitions AS (
         SELECT g.symbol
         FROM main.defn_enclosing_ranges r
         JOIN main.documents d ON d.id = r.document_id
         JOIN main.global_symbols g ON g.id = r.symbol_id
         LEFT JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path
         WHERE p.relative_path IS NULL
         UNION
         SELECT g.symbol
         FROM main.mentions m
         JOIN main.chunks c ON c.id = m.chunk_id
         JOIN main.documents d ON d.id = c.document_id
         JOIN main.global_symbols g ON g.id = m.symbol_id
         LEFT JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path
         WHERE m.role = 1 AND p.relative_path IS NULL
       )
       SELECT u.symbol
       FROM unaffected_definitions u
       JOIN changed_symbols c ON c.symbol = u.symbol
       LIMIT 1`,
    )
    .pluck()
    .get();
  if (typeof shared === 'string') {
    throw new Error(`symbol definition is shared by affected and unaffected documents: ${shared}`);
  }
}

function deleteAffectedDocumentRows(db: Database.Database): void {
  db.exec(`
    DELETE FROM main.mentions
    WHERE chunk_id IN (
      SELECT c.id
      FROM main.chunks c
      JOIN main.documents d ON d.id = c.document_id
      JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path
    );
    DELETE FROM main.chunks
    WHERE document_id IN (
      SELECT d.id
      FROM main.documents d
      JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path
    );
    DELETE FROM main.defn_enclosing_ranges
    WHERE document_id IN (
      SELECT d.id
      FROM main.documents d
      JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path
    );
    DELETE FROM main.documents
    WHERE relative_path IN (SELECT relative_path FROM temp.incremental_affected_paths);
  `);
}

function reconcileGlobalSymbols(db: Database.Database): void {
  db.exec(`
    UPDATE main.global_symbols
    SET display_name = NULL,
        kind = NULL,
        documentation = NULL,
        signature = NULL,
        enclosing_symbol = NULL,
        relationships = NULL
    WHERE symbol IN (SELECT symbol FROM temp.incremental_old_defined_symbols);

    INSERT OR IGNORE INTO main.global_symbols(
      symbol, display_name, kind, documentation, signature, enclosing_symbol, relationships
    )
    SELECT symbol, display_name, kind, documentation, signature, enclosing_symbol, relationships
    FROM incremental.global_symbols;

    UPDATE main.global_symbols
    SET display_name = (
          SELECT source.display_name FROM incremental.global_symbols source
          WHERE source.symbol = main.global_symbols.symbol
        ),
        kind = (
          SELECT source.kind FROM incremental.global_symbols source
          WHERE source.symbol = main.global_symbols.symbol
        ),
        documentation = (
          SELECT source.documentation FROM incremental.global_symbols source
          WHERE source.symbol = main.global_symbols.symbol
        ),
        signature = (
          SELECT source.signature FROM incremental.global_symbols source
          WHERE source.symbol = main.global_symbols.symbol
        ),
        enclosing_symbol = (
          SELECT source.enclosing_symbol FROM incremental.global_symbols source
          WHERE source.symbol = main.global_symbols.symbol
        ),
        relationships = (
          SELECT source.relationships FROM incremental.global_symbols source
          WHERE source.symbol = main.global_symbols.symbol
        )
    WHERE symbol IN (SELECT symbol FROM temp.incremental_new_defined_symbols);
  `);
}

function insertAffectedDocumentRows(db: Database.Database): void {
  const documentOffset = scalarNumber(db, 'SELECT COALESCE(MAX(id), 0) AS value FROM main.documents');
  const chunkOffset = scalarNumber(db, 'SELECT COALESCE(MAX(id), 0) AS value FROM main.chunks');
  const rangeOffset = scalarNumber(db, 'SELECT COALESCE(MAX(id), 0) AS value FROM main.defn_enclosing_ranges');

  db.prepare(
    `INSERT INTO main.documents(id, language, relative_path, position_encoding, text)
     SELECT id + ?, language, relative_path, position_encoding, text
     FROM incremental.documents`,
  ).run(documentOffset);
  db.prepare(
    `INSERT INTO main.chunks(id, document_id, chunk_index, start_line, end_line, occurrences)
     SELECT id + ?, document_id + ?, chunk_index, start_line, end_line, occurrences
     FROM incremental.chunks`,
  ).run(chunkOffset, documentOffset);
  db.prepare(
    `INSERT INTO main.mentions(chunk_id, symbol_id, role)
     SELECT m.chunk_id + ?, target.id, m.role
     FROM incremental.mentions m
     JOIN incremental.global_symbols source ON source.id = m.symbol_id
     JOIN main.global_symbols target ON target.symbol = source.symbol`,
  ).run(chunkOffset);
  db.prepare(
    `INSERT INTO main.defn_enclosing_ranges(
       id, document_id, symbol_id, start_line, start_char, end_line, end_char
     )
     SELECT r.id + ?, r.document_id + ?, target.id,
            r.start_line, r.start_char, r.end_line, r.end_char
     FROM incremental.defn_enclosing_ranges r
     JOIN incremental.global_symbols source ON source.id = r.symbol_id
     JOIN main.global_symbols target ON target.symbol = source.symbol`,
  ).run(rangeOffset, documentOffset);
}

function pruneReconciledOrphanSymbols(db: Database.Database): void {
  db.exec(`
    DELETE FROM main.global_symbols
    WHERE NOT EXISTS (SELECT 1 FROM main.mentions m WHERE m.symbol_id = main.global_symbols.id)
      AND NOT EXISTS (
        SELECT 1 FROM main.defn_enclosing_ranges r WHERE r.symbol_id = main.global_symbols.id
      );
  `);
}

function validatePatchedTransaction(db: Database.Database, affectedCount: number, originalDocumentCount: number): void {
  const documentCount = scalarNumber(db, 'SELECT COUNT(*) AS value FROM main.documents');
  const affectedDocumentCount = scalarNumber(
    db,
    `SELECT COUNT(*) AS value
     FROM main.documents d
     JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path`,
  );
  if (documentCount !== originalDocumentCount || affectedDocumentCount !== affectedCount) {
    throw new Error('candidate SQLite document counts changed unexpectedly');
  }
  const duplicatePath = db
    .prepare('SELECT relative_path FROM main.documents GROUP BY relative_path HAVING COUNT(*) > 1 LIMIT 1')
    .pluck()
    .get();
  const duplicateSymbol = db
    .prepare('SELECT symbol FROM main.global_symbols GROUP BY symbol HAVING COUNT(*) > 1 LIMIT 1')
    .pluck()
    .get();
  if (duplicatePath !== undefined || duplicateSymbol !== undefined) {
    throw new Error('candidate SQLite generation contains duplicate document paths or symbols');
  }
}

function validateAffectedFacts(db: Database.Database): Map<string, string> {
  const candidateFacts = readAffectedFactDigests(db, 'main', true);
  const miniFacts = readAffectedFactDigests(db, 'incremental', false);
  if (JSON.stringify([...candidateFacts]) !== JSON.stringify([...miniFacts])) {
    throw new Error('candidate SQLite affected document facts differ from the mini database');
  }
  return candidateFacts;
}

function readAffectedFactDigests(
  db: Database.Database,
  schema: DatabaseSchema,
  filterAffected: boolean,
): Map<string, string> {
  const affectedJoin = filterAffected
    ? 'JOIN temp.incremental_affected_paths p ON p.relative_path = d.relative_path'
    : '';
  const documents = db
    .prepare(
      `SELECT d.relative_path, d.language, d.position_encoding, d.text
       FROM ${schema}.documents d
       ${affectedJoin}
       ORDER BY d.relative_path`,
    )
    .all();
  const chunks = db
    .prepare(
      `SELECT d.relative_path, c.chunk_index, c.start_line, c.end_line, hex(c.occurrences) AS occurrences
       FROM ${schema}.chunks c
       JOIN ${schema}.documents d ON d.id = c.document_id
       ${affectedJoin}
       ORDER BY d.relative_path, c.chunk_index, c.start_line, c.end_line, c.id`,
    )
    .all();
  const definitions = db
    .prepare(
      `SELECT d.relative_path, r.start_line, r.start_char, r.end_line, r.end_char,
              g.symbol, g.display_name, g.kind, g.documentation,
              CASE WHEN g.signature IS NULL THEN NULL ELSE hex(g.signature) END AS signature,
              g.enclosing_symbol,
              CASE WHEN g.relationships IS NULL THEN NULL ELSE hex(g.relationships) END AS relationships
       FROM ${schema}.defn_enclosing_ranges r
       JOIN ${schema}.documents d ON d.id = r.document_id
       JOIN ${schema}.global_symbols g ON g.id = r.symbol_id
       ${affectedJoin}
       ORDER BY d.relative_path, r.start_line, r.start_char, r.end_line, r.end_char, g.symbol`,
    )
    .all();
  const mentions = db
    .prepare(
      `SELECT d.relative_path, c.chunk_index, m.role, g.symbol
       FROM ${schema}.mentions m
       JOIN ${schema}.chunks c ON c.id = m.chunk_id
       JOIN ${schema}.documents d ON d.id = c.document_id
       JOIN ${schema}.global_symbols g ON g.id = m.symbol_id
       ${affectedJoin}
       ORDER BY d.relative_path, c.chunk_index, m.role, g.symbol`,
    )
    .all();
  const encodedByPath = new Map<string, string[]>();
  for (const [kind, rows] of Object.entries({ documents, chunks, definitions, mentions })) {
    for (const row of rows as Array<{ relative_path: string }>) {
      const encoded = JSON.stringify([kind, row]);
      const facts = encodedByPath.get(row.relative_path) ?? [];
      facts.push(encoded);
      encodedByPath.set(row.relative_path, facts);
    }
  }
  const digests = new Map<string, string>();
  for (const [relativePath, facts] of [...encodedByPath].sort(([left], [right]) => left.localeCompare(right))) {
    const hash = createHash('sha256');
    for (const fact of facts.sort()) hash.update(fact).update('\n');
    digests.set(relativePath, hash.digest('hex'));
  }
  return digests;
}

function scalarNumber(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as { value: number };
  return row.value;
}
