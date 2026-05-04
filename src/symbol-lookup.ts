/**
 * symbol-lookup — symbol-pattern → SymbolMatch.
 *
 * Owns the fuzzy-match + scoring pipeline:
 *   1. Try an exact symbol match.
 *   2. If the pattern is `file:line-line`, find the smallest range
 *      containing those lines.
 *   3. Otherwise tokenise, gather candidates, and score each one
 *      against the original / cleaned / case-sensitive variants.
 *
 * Hydration goes through `hydrateSymbolMatch`, which prefers the
 * AST-corrected ranges produced by the definition catalog so callers
 * that show ranges to a user (or use them as bounds) get accurate
 * line numbers — never raw `defn_enclosing_ranges` rows.
 *
 * This module also owns two generic SCIP helpers — `cleanSignature`
 * and `extractSignature` — that are reused by every catalog API.
 *
 * Layer position: foundational, paired with path-resolver. Definition
 * catalog and reference graph build on top.
 */
import type { ScipDatabase } from './db.js';
import { isFunctionLikeSymbol, isModuleLikeSymbol, leafName, shortenSymbol } from './symbol-parser.js';
import { getDefinitionsForFile } from './definition-catalog.js';
import type { SymbolLocation, SymbolMatch } from './types.js';

/**
 * Clean up the raw doc/signature string from the SCIP index. Strips fenced
 * code-block markers and the parenthesized kind prefixes (`(method)`,
 * `(property)`, etc.) that some SCIP indexers prepend.
 */
export function cleanSignature(sig: string | null): string | null {
  if (!sig || !sig.trim()) return null;
  return sig
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
    .trim() || null;
}

/**
 * SCIP indexers store `documentation` as "docstring|signature" (pipe-delimited).
 * `extractSignature` pulls the signature half; newlines are flattened to spaces
 * so downstream one-liner rendering works. If the pipe is absent the whole
 * `documentation` string is treated as signature.
 */
export function extractSignature(doc: string | null): string | null {
  if (!doc) return null;
  const pipeIdx = doc.indexOf('|');
  if (pipeIdx === -1) return doc.replace(/\n/g, ' ');
  return doc.slice(pipeIdx + 1).replace(/\n/g, ' ');
}

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

export function findFirstSymbolMatch(
  db: ScipDatabase,
  symbolPattern: string,
): SymbolMatch | null {
  const exact = findExactSymbolMatch(db, symbolPattern.trim());
  if (exact) {
    return exact;
  }

  // Handle file:line-line syntax (e.g., "src/foo.ts:10-50").
  // User-supplied lines are editor-1-indexed; DB is 0-indexed.
  const fileLineMatch = symbolPattern.match(/^(.+):(\d+)-(\d+)$/);
  if (fileLineMatch) {
    const [, filePath, startStr, endStr] = fileLineMatch;
    const userStart0 = Math.max(0, parseInt(startStr!, 10) - 1);
    const userEnd0 = Math.max(userStart0, parseInt(endStr!, 10) - 1);
    let row = db.get<SymbolQueryRow>(
      `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path
      FROM global_symbols gs
      JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
      JOIN documents d ON der.document_id = d.id
      WHERE d.relative_path LIKE ?
        AND der.start_line <= ? AND der.end_line >= ?
        ${db.pathExclusionsFor('d')}
      ORDER BY (der.end_line - der.start_line) ASC
        LIMIT 1`,
      `%${filePath}%`, userStart0, userEnd0,
    );
    if (!row) {
      row = db.get<SymbolQueryRow>(
        `SELECT gs.id, gs.symbol, c.document_id, MIN(c.start_line) AS start_line, MAX(c.end_line) AS end_line, d.relative_path
         FROM global_symbols gs
         JOIN mentions m ON m.symbol_id = gs.id
         JOIN chunks c ON m.chunk_id = c.id
         JOIN documents d ON c.document_id = d.id
         WHERE m.role = 1
           AND d.relative_path LIKE ?
           AND c.start_line <= ? AND c.end_line >= ?
           ${db.pathExclusionsFor('d')}
         GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path
         ORDER BY (MAX(c.end_line) - MIN(c.start_line)) ASC
         LIMIT 1`,
        `%${filePath}%`, userStart0, userEnd0,
      );
    }
    if (row && !db.isIgnored(row.relative_path)) {
      return hydrateSymbolMatch(db, row);
    }
  }

  const cleaned = normalizeLookupPattern(symbolPattern);
  const tokens = lookupTokens(symbolPattern);
  const candidates = getSymbolLookupCandidates(db, tokens);
  const direct = findDirectSymbolCandidate(candidates, symbolPattern, cleaned);
  if (direct && !db.isIgnored(direct.relative_path)) {
    return hydrateSymbolMatch(db, direct);
  }

  let best: {
    row: SymbolQueryRow;
    score: number;
  } | null = null;

  for (const row of candidates) {
    if (db.isIgnored(row.relative_path)) continue;

    const score = scoreSymbolCandidate(row, symbolPattern, cleaned, tokens);
    if (score <= 0) continue;

    if (!best || score > best.score) {
      best = { row, score };
    }
  }

  if (best) {
    return hydrateSymbolMatch(db, best.row);
  }

  return null;
}

export function findExactSymbolMatch(
  db: ScipDatabase,
  symbol: string,
): SymbolMatch | null {
  const primary = db.get<SymbolQueryRow>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     JOIN documents d ON der.document_id = d.id
     WHERE gs.symbol = ?
       ${db.pathExclusionsFor('d')}
     ORDER BY d.relative_path, der.start_line
     LIMIT 1`,
    symbol,
  );

  const row = primary ?? db.get<SymbolQueryRow>(
    `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      MAX(c.end_line) AS end_line,
      d.relative_path
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE gs.symbol = ?
       AND m.role = 1
       ${db.pathExclusionsFor('d')}
     GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path
     ORDER BY d.relative_path, start_line
     LIMIT 1`,
    symbol,
  );

  if (!row || db.isIgnored(row.relative_path)) {
    return null;
  }

  return hydrateSymbolMatch(db, row);
}

export function getFullSymbolMatch(
  db: ScipDatabase,
  symbol: SymbolLocation,
): SymbolMatch | null {
  if ('symbol' in symbol && 'relativePath' in symbol) {
    return symbol as SymbolMatch;
  }

  const row = getDefinitionRowsForSymbolId(db, symbol.symbolId)[0];

  if (!row) {
    return null;
  }

  return hydrateSymbolMatch(db, row);
}

export function getDefinitionRowsForSymbolId(
  db: ScipDatabase,
  symbolId: number,
): SymbolQueryRow[] {
  const primary = db.all<SymbolQueryRow>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path, gs.display_name
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     JOIN documents d ON der.document_id = d.id
     WHERE gs.id = ?
     ORDER BY der.start_line, der.end_line`,
    symbolId,
  );
  if (primary.length > 0) {
    return primary;
  }

  return db.all<SymbolQueryRow>(
    `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      MAX(c.end_line) AS end_line,
      d.relative_path,
      gs.display_name
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE gs.id = ?
       AND m.role = 1
       ${db.pathExclusionsFor('d')}
     GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path, gs.display_name
     ORDER BY start_line, end_line`,
    symbolId,
  );
}

export function getSymbolLookupCandidates(
  db: ScipDatabase,
  tokens: string[],
): SymbolQueryRow[] {
  const tokenClauses = tokens.map(
    () => `(gs.symbol LIKE ? OR d.relative_path LIKE ? OR COALESCE(gs.display_name, '') LIKE ?)`,
  );
  const params = tokens.flatMap((token) => {
    const like = `%${token}%`;
    return [like, like, like];
  });

  const primary = db.all<SymbolQueryRow>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path, gs.display_name
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     JOIN documents d ON der.document_id = d.id
     WHERE ${tokenClauses.join('\n       AND ')}
       ${db.pathExclusionsFor('d')}
      LIMIT 200`,
      ...params,
    );
  if (primary.length > 0) {
    return primary;
  }

  return db.all<SymbolQueryRow>(
    `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      MAX(c.end_line) AS end_line,
      d.relative_path,
      gs.display_name
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.role = 1
       AND ${tokenClauses.join('\n       AND ')}
       ${db.pathExclusionsFor('d')}
     GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path, gs.display_name
     LIMIT 200`,
    ...params,
  );
}

export function scoreSymbolCandidate(
  row: SymbolQueryRow,
  originalPattern: string,
  cleanedPattern: string,
  tokens: string[],
): number {
  const originalCase = originalPattern.trim();
  const cleanedCase = cleanedPattern;
  const noParensCase = cleanedCase.replace(/\(\)$/, '');
  const original = originalPattern.toLowerCase();
  const cleaned = cleanedPattern.toLowerCase();
  const noParens = cleaned.replace(/\(\)$/, '');
  const rawCase = row.symbol;
  const shortCase = shortenSymbol(row.symbol);
  const leafCase = leafName(row.symbol);
  const displayCase = row.display_name ?? '';
  const raw = row.symbol.toLowerCase();
  const short = shortCase.toLowerCase();
  const leaf = leafCase.toLowerCase();
  const display = displayCase.toLowerCase();
  const path = row.relative_path.toLowerCase();
  const looksPathLike = /[/:.]/.test(cleanedPattern);

  let score = 0;

  if (rawCase === originalCase || rawCase === cleanedCase) score += 1150;
  if (shortCase === originalCase || shortCase === cleanedCase) score += 1100;
  if (displayCase === noParensCase) score += 980;
  if (leafCase === noParensCase) score += 960;
  if (`${leafCase}()` === originalCase || `${leafCase}()` === cleanedCase) score += 955;
  if (raw === original || raw === cleaned) score += 1000;
  if (short === original || short === cleaned) score += 950;
  if (path === original || path === cleaned) score += 925;
  if (path.endsWith(`/${cleaned}`) || path.endsWith(`/${original}`)) score += 875;
  if (display === noParens) score += 850;
  if (leaf === noParens) score += 825;
  if (`${leaf}()` === original || `${leaf}()` === cleaned) score += 820;
  if (short.endsWith(`:${cleaned}`) || short.endsWith(`:${noParens}`) || short.endsWith(`:${noParens}()`)) score += 800;

  if (raw.includes(cleaned)) score += 120;
  if (short.includes(cleaned)) score += 140;
  if (path.includes(cleaned)) score += 140;
  if (display.includes(cleaned)) score += 110;

  if (tokens.every((token) => {
    const lower = token.toLowerCase();
    return raw.includes(lower) || short.includes(lower) || path.includes(lower) || display.includes(lower);
  })) {
    score += 100 + tokens.length * 15;
  }

  if (isFunctionLikeSymbol(row.symbol) && leaf === noParens) {
    score += 60;
  }

  if (!looksPathLike && isModuleLikeSymbol(row.symbol)) {
    score -= 160;
  }

  // Prefer narrower matches when everything else is close.
  score -= Math.min(50, Math.max(0, row.end_line - row.start_line));

  return score;
}

export function normalizeLookupPattern(symbolPattern: string): string {
  return symbolPattern.trim().replace(/\(\)$/, '').replace(/\(.*$/, '');
}

export function lookupTokens(symbolPattern: string): string[] {
  const cleaned = normalizeLookupPattern(symbolPattern);
  const tokens = cleaned
    .split(/[^A-Za-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return tokens.length > 0 ? [...new Set(tokens)] : [cleaned];
}

export function findDirectSymbolCandidate(
  candidates: SymbolQueryRow[],
  symbolPattern: string,
  cleanedPattern: string,
): SymbolQueryRow | null {
  const trimmed = symbolPattern.trim();
  const directMatches = candidates.filter((row) => {
    const short = shortenSymbol(row.symbol);
    const display = (row.display_name ?? '').trim();
    return row.symbol === trimmed
      || short === trimmed
      || short === cleanedPattern
      || display === trimmed
      || display === cleanedPattern
      || `${display}()` === trimmed
      || row.relative_path === trimmed;
  });

  if (directMatches.length === 0) {
    return null;
  }

  directMatches.sort((left, right) =>
    (left.end_line - left.start_line) - (right.end_line - right.start_line)
    || left.relative_path.localeCompare(right.relative_path)
    || left.symbol.localeCompare(right.symbol),
  );
  return directMatches[0] ?? null;
}

/**
 * Project a SymbolQueryRow into a SymbolMatch, replacing the raw chunk-
 * level range with the AST-corrected per-file range from the definition
 * catalog when one is available. Callers that show ranges to a user (or
 * use them as bounds) get accurate line numbers; raw rows are only ever
 * used for tie-breaks before correction.
 */
export function hydrateSymbolMatch(
  db: ScipDatabase,
  row: SymbolQueryRow,
): SymbolMatch {
  const corrected = getDefinitionsForFile(db, row.relative_path)
    .find((definition) => definition.symbolId === row.id);

  if (corrected) {
    return {
      symbolId: corrected.symbolId,
      symbol: corrected.symbol,
      documentId: corrected.documentId,
      startLine: corrected.startLine,
      endLine: corrected.endLine,
      relativePath: corrected.relativePath,
    };
  }

  return {
    symbolId: row.id,
    symbol: row.symbol,
    documentId: row.document_id,
    startLine: row.start_line,
    endLine: row.end_line,
    relativePath: row.relative_path,
  };
}
