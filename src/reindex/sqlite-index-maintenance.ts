import Database from 'better-sqlite3';

export interface RedundantSqliteIndexMaintenanceResult {
  removed: string[];
  retained: string[];
  skippedReason?: 'not-a-sqlite-database';
}

/**
 * Removes only indexes whose complete lookup prefix is already supplied by a
 * retained index. The unique symbol constraint is authoritative; the chunk
 * prefix is removed only when a wider document/range index is present.
 */
export function removeRedundantSqliteIndexes(databasePath: string): RedundantSqliteIndexMaintenanceResult {
  const db = new Database(databasePath);
  const removed: string[] = [];
  const retained: string[] = [];
  try {
    if (
      namedIndexColumns(db, 'idx_global_symbols_symbol')?.join('\0') === 'symbol' &&
      tableIndexes(db, 'global_symbols').some(
        (index) => index.name !== 'idx_global_symbols_symbol' && index.unique && index.columns.join('\0') === 'symbol',
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
    return { removed, retained };
  } catch (error) {
    if ((error as { code?: unknown }).code === 'SQLITE_NOTADB') {
      return { removed: [], retained: [], skippedReason: 'not-a-sqlite-database' };
    }
    throw error;
  } finally {
    db.close();
  }
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
  const present = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as
    | { present: 1 }
    | undefined;
  if (!present) return null;
  return (db.prepare(`PRAGMA index_info('${name.replaceAll("'", "''")}')`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}
