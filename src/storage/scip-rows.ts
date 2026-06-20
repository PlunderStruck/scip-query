/**
 * Tiny shared module for the raw SCIP-row shape and the signature-string
 * helpers that operate on its `documentation` field.
 *
 * Lives in its own module so `definition-catalog.ts` and `symbol-lookup.ts`
 * can both depend on it without depending on each other. `hydrateSymbolMatch`
 * (which IS catalog work) lives in `definition-catalog.ts`; the row shape
 * and string-massage helpers live here.
 */
import type { ScipDatabase } from './db.js';

/**
 * The minimum set of columns every "look up a definition / mention" query
 * returns. Both `defn_enclosing_ranges` (the primary, AST-corrected
 * ranges) and the `mentions`-derived fallback shape land in this same row
 * shape.
 */
export interface SymbolQueryRow {
  id: number;
  symbol: string;
  document_id: number;
  start_line: number;
  end_line: number;
  relative_path: string;
  display_name?: string | null;
  kind?: number | null;
  documentation?: string | null;
  enclosing_symbol?: string | null;
}

export interface SymbolRowQuery {
  where: string;
  params?: readonly unknown[];
  orderBy?: string;
  limit?: number;
}

// scip-query: ignore-wrapper — storage primitive paired with
// definitionMentionRows; symbol-lookup owns ranking, this owns the primary
// definition-row SQL shape.
export function definitionRangeRows(db: ScipDatabase, query: SymbolRowQuery): SymbolQueryRow[] {
  return db.all<SymbolQueryRow>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path, gs.display_name, gs.documentation
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     JOIN documents d ON der.document_id = d.id
     WHERE ${query.where}
       ${db.pathExclusionsFor('d')}
     ${orderByClause(query.orderBy)}
     ${limitClause(query.limit)}`,
    ...(query.params ?? []),
  );
}

export function definitionMentionRows(db: ScipDatabase, query: SymbolRowQuery): SymbolQueryRow[] {
  return db.all<SymbolQueryRow>(
    `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      MAX(c.end_line) AS end_line,
      d.relative_path,
      gs.display_name,
      gs.documentation
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.role = 1
       AND ${query.where}
       ${db.pathExclusionsFor('d')}
     GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path, gs.display_name, gs.documentation
     ${orderByClause(query.orderBy)}
     ${limitClause(query.limit)}`,
    ...(query.params ?? []),
  );
}

function orderByClause(orderBy: string | undefined): string {
  return orderBy ? `ORDER BY ${orderBy}` : '';
}

function limitClause(limit: number | undefined): string {
  return typeof limit === 'number' ? `LIMIT ${limit}` : '';
}

/**
 * Clean up the raw doc/signature string from the SCIP index. Strips fenced
 * code-block markers and the parenthesized kind prefixes (`(method)`,
 * `(property)`, etc.) that some SCIP indexers prepend.
 */
export function cleanSignature(sig: string | null): string | null {
  if (!sig || !sig.trim()) return null;
  return (
    sig
      .replace(/^```\w*\s*/, '')
      .replace(/\s*```$/, '')
      .replace(/^\(method\)\s*/, '')
      .replace(/^\(property\)\s*/, '')
      .replace(/^\(function\)\s*/, '')
      .replace(/^\(class\)\s*/, '')
      .replace(/^\(interface\)\s*/, '')
      .replace(/^\(enum\)\s*/, '')
      .replace(/^\(type alias\)\s*/, '')
      .replace(/^\(const\)\s*/, '')
      .replace(/^\(var\)\s*/, '')
      .trim() || null
  );
}

/**
 * SCIP indexers store `documentation` as "docstring|signature" (pipe-delimited).
 * `extractSignature` pulls the signature half; newlines are flattened to spaces
 * so downstream one-liner rendering works. If the pipe is absent the whole
 * `documentation` string is treated as signature.
 */
export function extractSignature(doc: string | null): string | null {
  if (!doc) return null;
  const fenced = extractFirstFencedBlock(doc);
  if (fenced) return fenced.replace(/\n/g, ' ');
  const pipeIdx = doc.indexOf('|');
  if (pipeIdx === -1) return doc.replace(/\n/g, ' ');
  const signatureHalf = doc.slice(pipeIdx + 1);
  return (extractFirstFencedBlock(signatureHalf) ?? signatureHalf).replace(/\n/g, ' ');
}

function extractFirstFencedBlock(doc: string): string | null {
  const match = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```/.exec(doc.trimStart());
  return match?.[1]?.trim() || null;
}
