import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getSourceReferenceSites } from '../query-support.js';
import type { TraceResult } from '../types.js';
import { cleanSignature } from './clean-signature.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../symbol-parser.js';

export function trace(db: ScipDatabase, symbolPattern: string): TraceResult {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) {
    return { definitions: [], referencedBy: [] };
  }

  // Definitions
  const defRows = db.all<{
    relative_path: string;
    start_line: number;
    end_line: number;
    sig: string | null;
    display_name: string | null;
  }>(
    `SELECT d.relative_path, der.start_line, der.end_line,
      gs.display_name,
      REPLACE(SUBSTR(gs.documentation, INSTR(gs.documentation, '|') + 1), char(10), ' ') AS sig
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE gs.id = ?
    ORDER BY d.relative_path, der.start_line
    LIMIT 10`,
    match.symbolId,
  );

  const definitions = defRows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      relativePath: r.relative_path,
      startLine: r.start_line,
      endLine: r.end_line,
      signature: buildTraceSignature(r.sig, r.display_name, match.symbol),
    }));

  // References
  const sourceSites = getSourceReferenceSites(db, match);
  const referencedBy = sourceSites.length > 0
    ? sourceSites
      .filter((site) => !db.isIgnored(site.file))
      .map((site) => ({
        relativePath: site.file,
        line: site.line,
        enclosingSymbol: site.enclosingSymbol,
        enclosingShort: site.enclosingSymbol ? shortenSymbol(site.enclosingSymbol) : '(top-level)',
      }))
    : db.all<{
      relative_path: string;
      line: number;
      enclosing_symbol: string | null;
    }>(
      `SELECT DISTINCT d.relative_path, c.start_line AS line,
        (SELECT enc_gs.symbol
         FROM defn_enclosing_ranges enc_der
         JOIN global_symbols enc_gs ON enc_der.symbol_id = enc_gs.id
         WHERE enc_der.document_id = d.id
           AND enc_der.start_line <= c.start_line
           AND enc_der.end_line >= c.end_line
         ORDER BY (enc_der.end_line - enc_der.start_line) ASC
         LIMIT 1
        ) AS enclosing_symbol
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      JOIN documents d ON c.document_id = d.id
      WHERE m.symbol_id = ?
        AND m.role != 1
      ORDER BY d.relative_path, c.start_line`,
      match.symbolId,
    )
      .filter((r) => !db.isIgnored(r.relative_path))
      .map((r) => ({
        relativePath: r.relative_path,
        line: r.line,
        enclosingSymbol: r.enclosing_symbol,
        enclosingShort: r.enclosing_symbol ? shortenSymbol(r.enclosing_symbol) : '(top-level)',
      }));

  return { definitions, referencedBy };
}

function buildTraceSignature(
  signature: string | null,
  displayName: string | null,
  rawSymbol: string,
): string | null {
  const cleaned = cleanSignature(signature);
  if (cleaned && !looksBogusSignature(cleaned)) {
    return cleaned;
  }

  const fallback = (displayName ?? '').trim();
  if (fallback) {
    return isFunctionLikeSymbol(rawSymbol) && !fallback.endsWith('()')
      ? `${fallback}()`
      : fallback;
  }

  return shortenSymbol(rawSymbol);
}

function looksBogusSignature(signature: string): boolean {
  return signature.startsWith('undefined') || signature.includes('|') || signature.includes('```');
}
