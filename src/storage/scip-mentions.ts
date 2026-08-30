import type { ScipDatabase } from './db.js';

export const SQLITE_PARAM_BATCH_SIZE = 750;

export interface MentionReferenceCountRow {
  symbol_id: number;
  relative_path: string;
  ref_count: number;
}

export interface MentionReferenceSymbolRow {
  symbol_id: number;
  relative_path: string;
}

export interface MentionReferenceSymbolIdRow {
  symbol_id: number;
}

export interface MentionReferenceChunkRow {
  symbol_id: number;
  relative_path: string;
  document_id: number;
  chunk_start: number;
  chunk_end: number;
}

export function mentionReferenceCountRows(db: ScipDatabase, symbolIds?: readonly number[]): MentionReferenceCountRow[] {
  return batchedMentionRows(db, symbolIds, (ids) => {
    const symbolFilter = ids ? `AND m.symbol_id IN (${ids.map(() => '?').join(',')})` : '';
    return db.all<MentionReferenceCountRow>(
      `SELECT
        m.symbol_id,
        d.relative_path,
        COUNT(*) AS ref_count
       FROM mentions m
       JOIN chunks c ON m.chunk_id = c.id
       JOIN documents d ON c.document_id = d.id
       WHERE m.role != 1
         ${symbolFilter}
         ${db.pathExclusionsFor('d')}
       GROUP BY m.symbol_id, d.relative_path`,
      ...(ids ?? []),
    );
  });
}

export function mentionedReferenceSymbolRows(
  db: ScipDatabase,
  symbolIds?: readonly number[],
): MentionReferenceSymbolRow[] {
  return batchedMentionRows(db, symbolIds, (ids) => {
    const symbolFilter = ids ? `AND m.symbol_id IN (${ids.map(() => '?').join(',')})` : '';
    return db.all<MentionReferenceSymbolRow>(
      `SELECT DISTINCT m.symbol_id, d.relative_path
       FROM mentions m
       JOIN chunks c ON m.chunk_id = c.id
       JOIN documents d ON c.document_id = d.id
       WHERE m.role != 1
         ${symbolFilter}
         ${db.pathExclusionsFor('d')}`,
      ...(ids ?? []),
    );
  }).filter((row) => row.symbol_id !== null);
}

export function mentionedReferenceSymbolIdRows(
  db: ScipDatabase,
  symbolIds?: readonly number[],
): MentionReferenceSymbolIdRow[] {
  return batchedMentionRows(db, symbolIds, (ids) => {
    const symbolFilter = ids ? `AND m.symbol_id IN (${ids.map(() => '?').join(',')})` : '';
    return db.all<MentionReferenceSymbolIdRow>(
      `SELECT DISTINCT m.symbol_id
       FROM mentions m
       WHERE m.role != 1
         ${symbolFilter}`,
      ...(ids ?? []),
    );
  }).filter((row) => row.symbol_id !== null);
}

export function mentionReferenceChunkRows(db: ScipDatabase, symbolIds?: readonly number[]): MentionReferenceChunkRow[] {
  const rows = batchedMentionRows(db, symbolIds, (ids) => {
    const symbolFilter = ids ? `AND m.symbol_id IN (${ids.map(() => '?').join(',')})` : '';
    return db.all<MentionReferenceChunkRow>(
      `SELECT m.symbol_id, d.relative_path, c.document_id,
              c.start_line AS chunk_start, c.end_line AS chunk_end
       FROM mentions m
       JOIN chunks c ON m.chunk_id = c.id
       JOIN documents d ON c.document_id = d.id
       WHERE m.role != 1
         ${symbolFilter}
         ${db.pathExclusionsFor('d')}`,
      ...(ids ?? []),
    );
  });
  const uniqueRows = new Map<string, MentionReferenceChunkRow>();
  for (const row of rows) {
    const key = `${row.symbol_id}\0${row.document_id}\0${row.chunk_start}\0${row.chunk_end}`;
    uniqueRows.set(key, row);
  }
  const symbolOrder = symbolIds ? new Map(symbolIds.map((symbolId, index) => [symbolId, index] as const)) : null;
  return [...uniqueRows.values()].sort(
    (left, right) =>
      (symbolOrder ? (symbolOrder.get(left.symbol_id) ?? 0) - (symbolOrder.get(right.symbol_id) ?? 0) : 0) ||
      left.relative_path.localeCompare(right.relative_path) ||
      left.chunk_start - right.chunk_start ||
      left.chunk_end - right.chunk_end ||
      left.symbol_id - right.symbol_id,
  );
}

function batchedMentionRows<Row>(
  db: ScipDatabase,
  symbolIds: readonly number[] | undefined,
  load: (symbolIds?: readonly number[]) => Row[],
): Row[] {
  if (!symbolIds) return load();
  if (symbolIds.length === 0) return [];

  const rows: Row[] = [];
  for (let offset = 0; offset < symbolIds.length; offset += SQLITE_PARAM_BATCH_SIZE) {
    rows.push(...load(symbolIds.slice(offset, offset + SQLITE_PARAM_BATCH_SIZE)));
  }
  return rows;
}
