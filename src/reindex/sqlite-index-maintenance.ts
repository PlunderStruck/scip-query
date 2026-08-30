import Database from 'better-sqlite3';

export { CURRENT_SQLITE_QUERY_LAYOUT_VERSION } from '../domain/sqlite-query-layout.js';

const DEFINITION_INDEX = 'idx_mentions_definitions';
const DEFINITION_INDEX_COLUMNS = ['symbol_id', 'chunk_id'] as const;

export interface SqliteQueryLayoutMaintenanceResult {
  added: string[];
  removed: string[];
  retained: string[];
  analyzed: boolean;
  skippedReason?: 'not-a-sqlite-database';
}

export interface SqliteQueryLayoutMaintenanceOptions {
  /** Recompute whole-database planner statistics after a material change. */
  analyze?: boolean;
}

/**
 * Establishes the post-conversion SQLite layout expected by query code.
 *
 * The definition-only index covers exact symbol-to-definition joins while
 * remaining small enough for whole-definition scans. Redundant indexes are
 * removed only when schema inspection proves a retained equivalent, then
 * ANALYZE records statistics for the final augmented database.
 */
export function optimizeSqliteQueryLayout(
  databasePath: string,
  options: SqliteQueryLayoutMaintenanceOptions = {},
): SqliteQueryLayoutMaintenanceResult {
  const db = new Database(databasePath);
  const added: string[] = [];
  const removed: string[] = [];
  const retained: string[] = [];
  try {
    db.transaction(() => {
      ensureDefinitionIndex(db, added);

      if (
        namedIndexColumns(db, 'idx_global_symbols_symbol')?.join('\0') === 'symbol' &&
        tableIndexes(db, 'global_symbols').some(
          (index) =>
            index.name !== 'idx_global_symbols_symbol' && index.unique && index.columns.join('\0') === 'symbol',
        )
      ) {
        db.exec('DROP INDEX "idx_global_symbols_symbol"');
        removed.push('idx_global_symbols_symbol');
      } else if (namedIndexColumns(db, 'idx_global_symbols_symbol')) {
        retained.push('idx_global_symbols_symbol');
      }

      const chunkPrefix = namedIndexColumns(db, 'idx_chunks_doc_id');
      const widerChunkIndex = tableIndexes(db, 'chunks').some(
        (index) => index.name !== 'idx_chunks_doc_id' && index.columns.length > 1 && index.columns[0] === 'document_id',
      );
      if (chunkPrefix?.join('\0') === 'document_id' && widerChunkIndex) {
        db.exec('DROP INDEX "idx_chunks_doc_id"');
        removed.push('idx_chunks_doc_id');
      } else if (chunkPrefix) {
        retained.push('idx_chunks_doc_id');
      }

      if (options.analyze !== false) db.exec('ANALYZE');
    })();
    return { added, removed, retained, analyzed: options.analyze !== false };
  } catch (error) {
    if ((error as { code?: unknown }).code === 'SQLITE_NOTADB') {
      return {
        added: [],
        removed: [],
        retained: [],
        analyzed: false,
        skippedReason: 'not-a-sqlite-database',
      };
    }
    throw error;
  } finally {
    db.close();
  }
}

function ensureDefinitionIndex(db: Database.Database, added: string[]): void {
  const existing = namedIndexDefinition(db, DEFINITION_INDEX);
  if (existing) {
    const correctColumns = existing.columns.join('\0') === DEFINITION_INDEX_COLUMNS.join('\0');
    const correctPredicate = /\bWHERE\s+role\s*=\s*1\b/iu.test(existing.sql ?? '');
    if (!correctColumns || !correctPredicate || existing.table !== 'mentions') {
      throw new Error(`${DEFINITION_INDEX} exists with an incompatible definition`);
    }
    return;
  }

  db.exec(`CREATE INDEX "${DEFINITION_INDEX}" ON mentions(symbol_id, chunk_id) WHERE role = 1`);
  added.push(DEFINITION_INDEX);
}

function tableIndexes(
  db: Database.Database,
  table: string,
): Array<{ name: string; unique: boolean; columns: string[] }> {
  return (
    db.prepare(`PRAGMA index_list('${table.replaceAll("'", "''")}')`).all() as Array<{
      name: string;
      unique: number;
    }>
  ).map((index) => ({
    name: index.name,
    unique: index.unique === 1,
    columns: namedIndexColumns(db, index.name) ?? [],
  }));
}

function namedIndexColumns(db: Database.Database, name: string): string[] | null {
  return namedIndexDefinition(db, name)?.columns ?? null;
}

function namedIndexDefinition(
  db: Database.Database,
  name: string,
): { table: string; sql: string | null; columns: string[] } | null {
  const row = db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as
    | { tbl_name: string; sql: string | null }
    | undefined;
  if (!row) return null;
  const columns = (
    db.prepare(`PRAGMA index_info('${name.replaceAll("'", "''")}')`).all() as Array<{ name: string }>
  ).map((column) => column.name);
  return { table: row.tbl_name, sql: row.sql, columns };
}
