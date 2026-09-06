/**
 * Shared raw SCIP rows, occurrence ranges and signature-string decoding.
 *
 * Lives in its own module so `definition-catalog.ts` and `symbol-lookup.ts`
 * can both depend on it without depending on each other. `hydrateSymbolMatch`
 * lives in `definition-catalog.ts`; raw index decoding lives here.
 */
import type { ScipDatabase } from './db.js';
import { fromBinary } from '@bufbuild/protobuf';
import { DocumentSchema, SymbolRole } from '@c4312/scip';
import { zstdDecompressSync } from 'node:zlib';
import { createPerDbCache } from './per-db-cache.js';

type DefinitionOccurrenceRange = Pick<SymbolQueryRow, 'start_line' | 'start_char' | 'end_line' | 'end_char'>;
const DEFINITION_OCCURRENCE_RANGES = createPerDbCache<string, Map<string, DefinitionOccurrenceRange>>(
  'definition-occurrence-ranges',
  {
    clearGroups: ['whole-project', 'definition-catalog'],
    maxEntries: 64,
  },
);

/** Identifier ranges directly recorded by the indexer, including fields without enclosing ranges. */
export function definitionOccurrenceRanges(db: ScipDatabase, file: string): Map<string, DefinitionOccurrenceRange> {
  return DEFINITION_OCCURRENCE_RANGES.get(db, file, () => {
    const ranges = new Map<string, DefinitionOccurrenceRange>();
    for (const row of db.all<{ occurrences: Uint8Array }>(
      'SELECT c.occurrences FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.relative_path = ? ORDER BY c.chunk_index',
      file,
    )) {
      for (const [symbol, range] of chunkDefinitionRanges(row.occurrences)) {
        if (!ranges.has(symbol)) ranges.set(symbol, range);
      }
    }
    return ranges;
  });
}

function chunkDefinitionRanges(blob: Uint8Array): Map<string, DefinitionOccurrenceRange> {
  const ranges = new Map<string, DefinitionOccurrenceRange>();
  if (!blob || blob.length <= 1) return ranges;
  try {
    for (const occurrence of fromBinary(DocumentSchema, zstdDecompressSync(blob)).occurrences) {
      const range = occurrenceDefinitionRange(occurrence);
      if (range && occurrence.symbol && !ranges.has(occurrence.symbol)) ranges.set(occurrence.symbol, range);
    }
  } catch {
    // Missing/corrupt occurrence data establishes no additional range.
  }
  return ranges;
}

function occurrenceDefinitionRange(occurrence: {
  symbolRoles: number;
  range: number[];
}): DefinitionOccurrenceRange | undefined {
  const range = occurrence.range;
  if (!(occurrence.symbolRoles & SymbolRole.Definition) || range.length < 3) return undefined;
  return {
    start_line: range[0]!,
    start_char: range[1]!,
    end_line: range.length === 4 ? range[2]! : range[0]!,
    end_char: range.length === 4 ? range[3]! : range[2]!,
  };
}

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
  start_char?: number;
  end_line: number;
  end_char?: number;
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
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.start_char, der.end_line, der.end_char, d.relative_path, gs.display_name, gs.documentation
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
  return db
    .all<SymbolQueryRow>(
      `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      0 AS start_char,
      MAX(c.end_line) AS end_line,
      0 AS end_char,
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
    )
    .map((row) => ({ ...row, ...definitionOccurrenceRanges(db, row.relative_path).get(row.symbol) }));
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

const REFERENCE_OCCURRENCE_LINES = createPerDbCache<string, Map<string, number[]> | null>(
  'reference-occurrence-lines',
  { clearGroups: ['whole-project', 'source-file'], maxEntries: 64 },
);

/** Index-generation reference lines bound to one exact symbol; null means the occurrence provider is unavailable. */
export function referenceOccurrenceLines(db: ScipDatabase, file: string, symbol: string): number[] | null {
  const bySymbol = REFERENCE_OCCURRENCE_LINES.get(db, file, () => {
    const rows = db.all<{ occurrences: Uint8Array | null }>(
      'SELECT c.occurrences FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.relative_path = ? ORDER BY c.chunk_index',
      file,
    );
    if (rows.length === 0) return null;
    const lines = new Map<string, Set<number>>();
    try {
      for (const row of rows) {
        if (!row.occurrences || row.occurrences.length <= 1) return null;
        const { occurrences } = fromBinary(DocumentSchema, zstdDecompressSync(row.occurrences));
        addReferenceOccurrenceLines(occurrences, lines);
      }
    } catch {
      return null;
    }
    return new Map([...lines].map(([identity, values]) => [identity, [...values].sort((a, b) => a - b)]));
  });
  return bySymbol === null ? null : (bySymbol.get(symbol) ?? []);
}

function addReferenceOccurrenceLines(
  occurrences: readonly { symbol: string; symbolRoles: number; range: number[] }[],
  lines: Map<string, Set<number>>,
): void {
  for (const occurrence of occurrences) {
    if (!occurrence.symbol || (occurrence.symbolRoles & SymbolRole.Definition) !== 0) continue;
    const line = occurrence.range[0];
    if (line === undefined || !Number.isSafeInteger(line) || line < 0) continue;
    const bucket = lines.get(occurrence.symbol) ?? new Set<number>();
    bucket.add(line);
    lines.set(occurrence.symbol, bucket);
  }
}
