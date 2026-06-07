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
import type { ScipDatabase } from '../storage/db.js';
import { isCallableSymbol, isFunctionLikeSymbol, isModuleLikeSymbol, leafName, shortenSymbol } from './symbol-parser.js';
import { hydrateSymbolMatch, parentTypeName } from './definition-catalog.js';
import { definitionMentionRows, definitionRangeRows, type SymbolQueryRow } from '../storage/scip-rows.js';
import type { SymbolLocation, SymbolMatch } from '../domain/types.js';
import { mergeMixedSymbolQueryRows } from './symbol-row-policy.js';

// `cleanSignature`, `extractSignature`, and `SymbolQueryRow` live in
// `scip-rows.ts` so both this module and `definition-catalog.ts` can use
// them without forming a cycle. Re-exported here for callers that already
// import them from this module.
export { cleanSignature, extractSignature, type SymbolQueryRow } from '../storage/scip-rows.js';

export function findFirstSymbolMatch(
  db: ScipDatabase,
  symbolPattern: string,
): SymbolMatch | null {
  const exact = findExactSymbolMatch(db, symbolPattern.trim());
  if (exact) {
    return exact;
  }

  const fileLine = findFileLineSymbolMatch(db, symbolPattern);
  if (fileLine) {
    return fileLine;
  }

  const pathQualified = findPathQualifiedSymbolMatch(db, symbolPattern);
  if (pathQualified) {
    return pathQualified;
  }

  return findBestFuzzySymbolMatch(db, symbolPattern);
}

function findPathQualifiedSymbolMatch(db: ScipDatabase, symbolPattern: string): SymbolMatch | null {
  const cleaned = normalizeLookupPattern(symbolPattern);
  const pathLeaf = pathQualifiedLookup(cleaned);
  if (!pathLeaf) return null;

  const pathLike = `%${pathLeaf.path}%`;
  const leaf = pathLeaf.leaf;
  const candidates = pathQualifiedCandidates(db, pathLike, leaf, cleaned);
  const best = candidates[0];
  return best ? hydrateSymbolMatch(db, best) : null;
}

function pathQualifiedCandidates(
  db: ScipDatabase,
  pathLike: string,
  leaf: string,
  cleanedPattern: string,
): SymbolQueryRow[] {
  const candidates = mergeMixedSymbolQueryRows([], [
    ...pathQualifiedPrimaryRows(db, pathLike, leaf),
    ...pathQualifiedFallbackRows(db, pathLike, leaf),
  ])
    .filter((row) => !db.isIgnored(row.relative_path))
    .filter((row) => pathQualifiedDirectScore(row, cleanedPattern) > 1);

  candidates.sort((left, right) =>
    pathQualifiedDirectScore(right, cleanedPattern) - pathQualifiedDirectScore(left, cleanedPattern)
    || (left.end_line - left.start_line) - (right.end_line - right.start_line)
    || left.start_line - right.start_line
    || left.symbol.localeCompare(right.symbol),
  );
  return candidates;
}

function pathQualifiedPrimaryRows(
  db: ScipDatabase,
  pathLike: string,
  leaf: string,
): SymbolQueryRow[] {
  return definitionRangeRows(db, {
    where: 'd.relative_path LIKE ? AND (gs.display_name = ? OR gs.symbol LIKE ?)',
    params: [pathLike, leaf, `%/${leaf}.%`],
  });
}

function pathQualifiedFallbackRows(
  db: ScipDatabase,
  pathLike: string,
  leaf: string,
): SymbolQueryRow[] {
  return definitionMentionRows(db, {
    where: 'd.relative_path LIKE ? AND (gs.display_name = ? OR gs.symbol LIKE ?)',
    params: [pathLike, leaf, `%/${leaf}.%`],
  });
}

// scip-query: ignore-extract — this is the fuzzy symbol lookup policy:
// direct lookup, token scoring, ignore filtering, and deterministic tie-breaks
// are one ranked search operation.
function findBestFuzzySymbolMatch(db: ScipDatabase, symbolPattern: string): SymbolMatch | null {
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

function findFileLineSymbolMatch(db: ScipDatabase, symbolPattern: string): SymbolMatch | null {
  const fileLineMatch = symbolPattern.match(/^(.+):(\d+)-(\d+)$/);
  if (!fileLineMatch) {
    return null;
  }

  const [, filePath, startStr, endStr] = fileLineMatch;
  const userStart0 = Math.max(0, parseInt(startStr!, 10) - 1);
  const userEnd0 = Math.max(userStart0, parseInt(endStr!, 10) - 1);
  const row = findDefinitionRangeRow(db, filePath!, userStart0, userEnd0)
    ?? findDefinitionChunkRow(db, filePath!, userStart0, userEnd0);
  return row && !db.isIgnored(row.relative_path) ? hydrateSymbolMatch(db, row) : null;
}

function findDefinitionRangeRow(
  db: ScipDatabase,
  filePath: string,
  startLine: number,
  endLine: number,
): SymbolQueryRow | undefined {
  return definitionRangeRows(db, {
    where: 'd.relative_path LIKE ? AND der.start_line <= ? AND der.end_line >= ?',
    params: [`%${filePath}%`, startLine, endLine],
    orderBy: '(der.end_line - der.start_line) ASC',
    limit: 1,
  })[0];
}

function findDefinitionChunkRow(
  db: ScipDatabase,
  filePath: string,
  startLine: number,
  endLine: number,
): SymbolQueryRow | undefined {
  return definitionMentionRows(db, {
    where: 'd.relative_path LIKE ? AND c.start_line <= ? AND c.end_line >= ?',
    params: [`%${filePath}%`, startLine, endLine],
    orderBy: '(MAX(c.end_line) - MIN(c.start_line)) ASC',
    limit: 1,
  })[0];
}

export function findExactSymbolMatch(
  db: ScipDatabase,
  symbol: string,
): SymbolMatch | null {
  const primary = definitionRangeRows(db, {
    where: 'gs.symbol = ?',
    params: [symbol],
    orderBy: 'd.relative_path, der.start_line',
    limit: 1,
  })[0];

  const row = primary ?? definitionMentionRows(db, {
    where: 'gs.symbol = ?',
    params: [symbol],
    orderBy: 'd.relative_path, start_line',
    limit: 1,
  })[0];

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
  const primary = definitionRangeRows(db, {
    where: 'gs.id = ?',
    params: [symbolId],
    orderBy: 'der.start_line, der.end_line',
  });
  const fallback = definitionMentionRows(db, {
    where: 'gs.id = ?',
    params: [symbolId],
    orderBy: 'start_line, end_line',
  });
  return mergeMixedSymbolQueryRows(primary, fallback);
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

  const where = tokenClauses.join('\n       AND ');
  const primary = definitionRangeRows(db, { where, params, limit: 200 });
  const fallback = definitionMentionRows(db, { where, params, limit: 200 });
  return mergeMixedSymbolQueryRows(primary, fallback);
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
  const pathLeaf = pathQualifiedLookup(cleanedPattern);
  const requestedLeaf = pathLeaf?.leaf.toLowerCase();

  let score = 0;

  if (rawCase === originalCase || rawCase === cleanedCase) score += 1150;
  if (shortCase === originalCase || shortCase === cleanedCase) score += 1100;
  if (displayCase === noParensCase) score += 1180;
  if (leafCase === noParensCase) score += 1160;
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

  if (pathLeaf && path.includes(pathLeaf.path.toLowerCase())) {
    score += 360;
    if (requestedLeaf && (leaf === requestedLeaf
      || `${leaf}()` === requestedLeaf
      || `${leaf}()` === `${requestedLeaf}()`)) {
      score += 700;
    }
    if (isCallableSymbol(row.symbol)) score += 180;
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

function pathQualifiedLookup(pattern: string): { path: string; leaf: string } | null {
  const normalized = pattern.trim().replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  if (slash <= 0 || slash === normalized.length - 1) return null;
  const leaf = normalized.slice(slash + 1).replace(/\(\)$/, '');
  if (!leaf || leaf.includes('.')) return null;
  return {
    path: normalized.slice(0, slash),
    leaf,
  };
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
      || pathQualifiedDirectScore(row, cleanedPattern) > 1
      || row.relative_path === trimmed;
  });

  if (directMatches.length === 0) {
    return null;
  }

  directMatches.sort((left, right) =>
    pathQualifiedDirectScore(right, cleanedPattern) - pathQualifiedDirectScore(left, cleanedPattern)
    || (left.end_line - left.start_line) - (right.end_line - right.start_line)
    || left.relative_path.localeCompare(right.relative_path)
    || left.symbol.localeCompare(right.symbol),
  );
  return directMatches[0] ?? null;
}

function pathQualifiedDirectScore(row: SymbolQueryRow, cleanedPattern: string): number {
  const pathLeaf = pathQualifiedLookup(cleanedPattern);
  if (!pathLeaf) return 0;
  const path = row.relative_path.toLowerCase();
  const leaf = leafName(row.symbol).toLowerCase();
  const requestedPath = pathLeaf.path.toLowerCase();
  const requestedLeaf = pathLeaf.leaf.toLowerCase();
  if (!path.includes(requestedPath)) return 0;
  if (leaf !== requestedLeaf) return 1;
  if (isCallableSymbol(row.symbol)) return parentTypeName(row.symbol) === null ? 5 : 4;
  return parentTypeName(row.symbol) === null ? 3 : 2;
}

// `hydrateSymbolMatch` lives in definition-catalog.ts (it's catalog work
// — projecting raw rows through the AST-corrected per-file range table).
// Re-exported above via the scip-rows barrel, but the function itself is
// imported directly from definition-catalog.
