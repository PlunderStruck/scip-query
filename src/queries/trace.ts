import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getSourceReferenceSites } from '../query-support.js';
import { getSourceText } from '../source-analysis.js';
import type { TraceResult } from '../types.js';
import { cleanSignature } from './clean-signature.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../symbol-parser.js';

export function trace(db: ScipDatabase, symbolPattern: string): TraceResult {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) {
    return { definitions: [], referencedBy: [] };
  }

  const definitionMeta = db.get<{
    sig: string | null;
    display_name: string | null;
  }>(
    `SELECT
      gs.display_name,
      REPLACE(SUBSTR(gs.documentation, INSTR(gs.documentation, '|') + 1), char(10), ' ') AS sig
    FROM global_symbols gs
    WHERE gs.id = ?
    LIMIT 10`,
    match.symbolId,
  );

  const definitions = db.isIgnored(match.relativePath)
    ? []
    : [{
      relativePath: match.relativePath,
      startLine: match.startLine,
      endLine: match.endLine,
      signature: buildTraceSignature(definitionMeta?.sig ?? null, definitionMeta?.display_name ?? null, match.symbol),
      source: definitionSource(db, match.relativePath, match.startLine, match.endLine),
    }];

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

function definitionSource(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): string | null {
  const source = getSourceText(db, relativePath);
  if (!source) {
    return null;
  }

  const lines = source.split('\n');
  const slice = lines.slice(startLine, endLine + 1).join('\n').trimEnd();
  return slice.length > 0 ? slice : null;
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
