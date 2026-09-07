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
import { createPerDbCache } from '../storage/per-db-cache.js';
import {
  isCallableSymbol,
  isFunctionLikeSymbol,
  isModuleLikeSymbol,
  leafName,
  shortenSymbol,
} from './symbol-parser.js';
import { hydrateSymbolMatch, parentTypeName } from './definition-catalog.js';
import { definitionMentionRows, definitionRangeRows, type SymbolQueryRow } from '../storage/scip-rows.js';
import { resolveIndexedDocumentCandidates } from '../storage/scip-documents.js';
import type { SymbolLocation, SymbolMatch, SymbolResolution, SymbolResolutionCandidate } from '../domain/types.js';
import { mergeMixedSymbolQueryRows } from './symbol-row-policy.js';

// `cleanSignature`, `extractSignature`, and `SymbolQueryRow` live in
// `scip-rows.ts` so both this module and `definition-catalog.ts` can use
// them without forming a cycle. Re-exported here for callers that already
// import them from this module.
export { cleanSignature, extractSignature, type SymbolQueryRow } from '../storage/scip-rows.js';

const SYMBOL_RESOLUTION_CACHE = createPerDbCache<string, SymbolResolution>('symbol-resolution', { clearGroups: [] });

export function findFirstSymbolMatch(db: ScipDatabase, symbolPattern: string): SymbolMatch | null {
  return resolveSymbol(db, symbolPattern).match;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function resolveSymbol(db: ScipDatabase, symbolPattern: string): SymbolResolution {
  return SYMBOL_RESOLUTION_CACHE.get(db, symbolPattern, () => {
    const exactRows = exactSymbolRows(db, symbolPattern.trim()).filter((row) => !db.isIgnored(row.relative_path));
    if (exactRows.length > 0) {
      return resolutionFromRows(db, exactRows);
    }

    const fileLineRow = findFileLineSymbolRow(db, symbolPattern);
    if (fileLineRow && !db.isIgnored(fileLineRow.relative_path)) {
      return resolutionFromRows(db, [fileLineRow]);
    }

    const compactQualifiedRows = compactQualifiedSymbolRows(db, symbolPattern);
    if (compactQualifiedRows.length > 0) {
      return resolutionFromRows(db, compactQualifiedRows);
    }

    const pathQualifiedRows = pathQualifiedSymbolRows(db, symbolPattern);
    if (pathQualifiedRows.length > 0) {
      return resolutionFromRows(db, pathQualifiedRows);
    }

    return fuzzySymbolResolution(db, symbolPattern);
  });
}

function compactQualifiedSymbolRows(db: ScipDatabase, symbolPattern: string): SymbolQueryRow[] {
  const compact = symbolPattern.trim().replace(/\(\)$/u, '');
  const separator = compact.lastIndexOf(':');
  if (separator <= 0 || separator === compact.length - 1 || compact.startsWith('local:')) return [];
  const leaf = compact.slice(separator + 1);
  if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(leaf)) return [];
  const descriptorNeedles = [`/${leaf}().`, `/${leaf}.`, `/${leaf}#`, `#${leaf}().`, `#${leaf}.`, `/${leaf}/`];
  const where = `gs.display_name = ? OR ${descriptorNeedles.map(() => 'instr(gs.symbol, ?) > 0').join(' OR ')}`;
  const params = [leaf, ...descriptorNeedles];

  const primary = definitionRangeRows(db, {
    where,
    params,
    orderBy: 'd.relative_path, der.start_line',
    limit: 200,
  });
  const fallback =
    primary.length > 0
      ? []
      : definitionMentionRows(db, {
          where,
          params,
          orderBy: 'd.relative_path, start_line',
          limit: 200,
        });
  const exactRows = mergeMixedSymbolQueryRows(primary, fallback)
    .filter((row) => !db.isIgnored(row.relative_path))
    .filter((row) => shortenSymbol(row.symbol).replace(/\(\)$/u, '') === compact);
  return [...new Map(exactRows.map((row) => [`${row.symbol}\0${row.relative_path}`, row] as const)).values()];
}

function pathQualifiedSymbolRows(db: ScipDatabase, symbolPattern: string): SymbolQueryRow[] {
  const cleaned = normalizeLookupPattern(symbolPattern);
  const pathLeaf = pathQualifiedLookup(cleaned);
  if (!pathLeaf) return [];

  const pathLike = `%${pathLeaf.path}%`;
  const leaf = pathLeaf.leaf;
  return pathQualifiedCandidates(db, pathLike, leaf, cleaned);
}

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
function pathQualifiedCandidates(
  db: ScipDatabase,
  pathLike: string,
  leaf: string,
  cleanedPattern: string,
): SymbolQueryRow[] {
  const candidates = mergeMixedSymbolQueryRows(
    [],
    [...pathQualifiedPrimaryRows(db, pathLike, leaf), ...pathQualifiedFallbackRows(db, pathLike, leaf)],
  )
    .filter((row) => !db.isIgnored(row.relative_path))
    .filter((row) => pathQualifiedDirectScore(row, cleanedPattern) > 1);

  candidates.sort(
    (left, right) =>
      pathQualifiedDirectScore(right, cleanedPattern) - pathQualifiedDirectScore(left, cleanedPattern) ||
      left.end_line - left.start_line - (right.end_line - right.start_line) ||
      left.start_line - right.start_line ||
      left.symbol.localeCompare(right.symbol),
  );
  return candidates;
}

function pathQualifiedPrimaryRows(db: ScipDatabase, pathLike: string, leaf: string): SymbolQueryRow[] {
  return definitionRangeRows(db, {
    where: 'd.relative_path LIKE ? AND (gs.display_name = ? OR gs.symbol LIKE ?)',
    params: [pathLike, leaf, `%/${leaf}.%`],
  });
}

function pathQualifiedFallbackRows(db: ScipDatabase, pathLike: string, leaf: string): SymbolQueryRow[] {
  return definitionMentionRows(db, {
    where: 'd.relative_path LIKE ? AND (gs.display_name = ? OR gs.symbol LIKE ?)',
    params: [pathLike, leaf, `%/${leaf}.%`],
  });
}

// scip-query: ignore-extract — reviewed E3 feature-local pipeline; the helper cluster has no separate owner or consumer.
function fuzzySymbolResolution(db: ScipDatabase, symbolPattern: string): SymbolResolution {
  const cleaned = normalizeLookupPattern(symbolPattern);
  const tokens = lookupTokens(symbolPattern);
  const candidates = getSymbolLookupCandidates(db, tokens);
  const directRows = findDirectSymbolCandidates(candidates, symbolPattern, cleaned).filter(
    (row) => !db.isIgnored(row.relative_path),
  );
  if (directRows.length > 0) {
    return resolutionFromRows(db, directRows);
  }

  const scored: Array<{
    row: SymbolQueryRow;
    score: number;
  }> = [];

  for (const row of candidates) {
    if (db.isIgnored(row.relative_path)) continue;

    const score = scoreSymbolCandidate(row, symbolPattern, cleaned, tokens);
    if (score <= 0) continue;
    scored.push({ row, score });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.row.end_line - left.row.start_line - (right.row.end_line - right.row.start_line) ||
      left.row.relative_path.localeCompare(right.row.relative_path) ||
      left.row.symbol.localeCompare(right.row.symbol),
  );

  return resolutionFromRows(
    db,
    scored.map((entry) => entry.row),
  );
}

function resolutionFromRows(db: ScipDatabase, rows: SymbolQueryRow[]): SymbolResolution {
  const hydrated = rows.map((row) => hydrateSymbolMatch(db, row));
  const match = hydrated[0] ?? null;
  return {
    match,
    candidates: match ? alternateCandidates(hydrated, match) : [],
    total: hydrated.length,
  };
}

function alternateCandidates(hydrated: SymbolMatch[], match: SymbolMatch): SymbolResolutionCandidate[] {
  const seen = new Set<string>([`${match.symbolId}:${match.relativePath}:${match.startLine}`]);
  const candidates: SymbolResolutionCandidate[] = [];
  for (const candidate of hydrated) {
    const key = `${candidate.symbolId}:${candidate.relativePath}:${candidate.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      symbol: candidate.symbol,
      shortName: shortenSymbol(candidate.symbol),
      relativePath: candidate.relativePath,
      startLine: candidate.startLine,
    });
    if (candidates.length >= 5) break;
  }
  return candidates;
}

function findFileLineSymbolRow(db: ScipDatabase, symbolPattern: string): SymbolQueryRow | undefined {
  const fileLineMatch = symbolPattern.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (!fileLineMatch) {
    return undefined;
  }

  const [, filePath, startStr, endStr] = fileLineMatch;
  const relativePath = resolveIndexedDocumentCandidates(db, filePath!, {
    allowMultiple: false,
    requirePathMatch: true,
  })[0]?.relativePath;
  if (!relativePath) return undefined;
  const userStart0 = Math.max(0, parseInt(startStr!, 10) - 1);
  const userEnd0 = endStr ? Math.max(userStart0, parseInt(endStr, 10) - 1) : userStart0;
  return (
    findDefinitionRangeRow(db, relativePath, userStart0, userEnd0) ??
    findDefinitionChunkRow(db, relativePath, userStart0, userEnd0)
  );
}

function findDefinitionRangeRow(
  db: ScipDatabase,
  filePath: string,
  startLine: number,
  endLine: number,
): SymbolQueryRow | undefined {
  return definitionRangeRows(db, {
    where: 'd.relative_path = ? AND der.start_line <= ? AND der.end_line >= ?',
    params: [filePath, startLine, endLine],
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
    where: 'd.relative_path = ? AND c.start_line <= ? AND c.end_line >= ?',
    params: [filePath, startLine, endLine],
    orderBy: '(MAX(c.end_line) - MIN(c.start_line)) ASC',
    limit: 1,
  })[0];
}

export function findExactSymbolMatch(db: ScipDatabase, symbol: string): SymbolMatch | null {
  const row = exactSymbolRows(db, symbol).find((candidate) => !db.isIgnored(candidate.relative_path));

  return row ? hydrateSymbolMatch(db, row) : null;
}

function exactSymbolRows(db: ScipDatabase, symbol: string): SymbolQueryRow[] {
  const primary = definitionRangeRows(db, {
    where: 'gs.symbol = ?',
    params: [symbol],
    orderBy: 'd.relative_path, der.start_line',
  });

  const fallback =
    primary.length > 0
      ? []
      : definitionMentionRows(db, {
          where: 'gs.symbol = ?',
          params: [symbol],
          orderBy: 'd.relative_path, start_line',
        });
  return mergeMixedSymbolQueryRows(primary, fallback);
}

export function getFullSymbolMatch(db: ScipDatabase, symbol: SymbolLocation): SymbolMatch | null {
  if ('symbol' in symbol && 'relativePath' in symbol) {
    return symbol as SymbolMatch;
  }

  const row = getDefinitionRowsForSymbolId(db, symbol.symbolId)[0];

  if (!row) {
    return null;
  }

  return hydrateSymbolMatch(db, row);
}

export function getDefinitionRowsForSymbolId(db: ScipDatabase, symbolId: number): SymbolQueryRow[] {
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

export function getSymbolLookupCandidates(db: ScipDatabase, tokens: string[]): SymbolQueryRow[] {
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

interface SymbolCandidateNames {
  raw: string;
  short: string;
  leaf: string;
  display: string;
  path: string;
}

function scoreEqualMatches(rules: readonly (readonly [string, readonly string[], number])[]): number {
  return rules.reduce((score, [value, alternatives, weight]) => score + (alternatives.includes(value) ? weight : 0), 0);
}

function scoreCaseSensitiveNames(names: SymbolCandidateNames, original: string, cleaned: string): number {
  const noParens = cleaned.replace(/\(\)$/, '');
  return scoreEqualMatches([
    [names.raw, [original, cleaned], 1150],
    [names.short, [original, cleaned], 1100],
    [names.display, [noParens], 1180],
    [names.leaf, [noParens], 1160],
    [`${names.leaf}()`, [original, cleaned], 955],
  ]);
}

function scoreNormalizedNames(names: SymbolCandidateNames, original: string, cleaned: string): number {
  const noParens = cleaned.replace(/\(\)$/, '');
  const exact = scoreEqualMatches([
    [names.raw, [original, cleaned], 1000],
    [names.short, [original, cleaned], 950],
    [names.path, [original, cleaned], 925],
    [names.display, [noParens], 850],
    [names.leaf, [noParens], 825],
    [`${names.leaf}()`, [original, cleaned], 820],
  ]);
  const pathSuffix = [cleaned, original].some((pattern) => names.path.endsWith(`/${pattern}`));
  const qualifiedSuffix = [cleaned, noParens, `${noParens}()`].some((pattern) => names.short.endsWith(`:${pattern}`));
  return exact + (pathSuffix ? 875 : 0) + (qualifiedSuffix ? 800 : 0);
}

function scorePartialNames(names: SymbolCandidateNames, cleaned: string, tokens: string[]): number {
  const contains: readonly (readonly [string, number])[] = [
    [names.raw, 120],
    [names.short, 140],
    [names.path, 140],
    [names.display, 110],
  ];
  const partial = contains.reduce((score, [value, weight]) => score + (value.includes(cleaned) ? weight : 0), 0);
  const allTokensMatch = tokens.every((token) => contains.some(([value]) => value.includes(token.toLowerCase())));
  return partial + (allTokensMatch ? 100 + tokens.length * 15 : 0);
}

function scorePathQualifiedName(names: SymbolCandidateNames, symbol: string, pattern: string): number {
  const pathLeaf = pathQualifiedLookup(pattern);
  if (!pathLeaf || !names.path.includes(pathLeaf.path.toLowerCase())) return 0;
  const requestedLeaf = pathLeaf.leaf.toLowerCase();
  const matchesLeaf =
    requestedLeaf &&
    (names.leaf === requestedLeaf || `${names.leaf}()` === requestedLeaf || `${names.leaf}()` === `${requestedLeaf}()`);
  return 360 + (matchesLeaf ? 700 : 0) + (isCallableSymbol(symbol) ? 180 : 0);
}

export function scoreSymbolCandidate(
  row: SymbolQueryRow,
  originalPattern: string,
  cleanedPattern: string,
  tokens: string[],
): number {
  const names = {
    raw: row.symbol,
    short: shortenSymbol(row.symbol),
    leaf: leafName(row.symbol),
    display: row.display_name ?? '',
    path: row.relative_path,
  };
  const normalized = {
    raw: names.raw.toLowerCase(),
    short: names.short.toLowerCase(),
    leaf: names.leaf.toLowerCase(),
    display: names.display.toLowerCase(),
    path: names.path.toLowerCase(),
  };
  const cleaned = cleanedPattern.toLowerCase();
  let score =
    scoreCaseSensitiveNames(names, originalPattern.trim(), cleanedPattern) +
    scoreNormalizedNames(normalized, originalPattern.toLowerCase(), cleaned) +
    scorePartialNames(normalized, cleaned, tokens) +
    scorePathQualifiedName(normalized, row.symbol, cleanedPattern);
  if (isFunctionLikeSymbol(row.symbol) && normalized.leaf === cleaned.replace(/\(\)$/, '')) score += 60;
  if (!/[/:.]/.test(cleanedPattern) && isModuleLikeSymbol(row.symbol)) score -= 160;
  // Prefer narrower matches when everything else is close.
  return score - Math.min(50, Math.max(0, row.end_line - row.start_line));
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

function findDirectSymbolCandidates(
  candidates: SymbolQueryRow[],
  symbolPattern: string,
  cleanedPattern: string,
): SymbolQueryRow[] {
  const trimmed = symbolPattern.trim();
  const directMatches = candidates.filter((row) => {
    const short = shortenSymbol(row.symbol);
    const leaf = leafName(row.symbol);
    const display = (row.display_name ?? '').trim();
    return (
      row.symbol === trimmed ||
      short === trimmed ||
      short === cleanedPattern ||
      leaf === trimmed ||
      leaf === cleanedPattern ||
      `${leaf}()` === trimmed ||
      display === trimmed ||
      display === cleanedPattern ||
      `${display}()` === trimmed ||
      pathQualifiedDirectScore(row, cleanedPattern) > 1 ||
      row.relative_path === trimmed
    );
  });

  if (directMatches.length === 0) {
    return [];
  }

  // A plain leaf such as `systemMap` must not remain ambiguous merely because
  // same-prefix declarations such as `SystemMapOptions` also matched the
  // lookup prefilter. Preserve real ambiguity between exact leaves, and when
  // a language permits a type/value name collision prefer the callable value
  // for an unadorned callable query.
  const requestedLeaf = cleanedPattern.replace(/\(\)$/u, '');
  const exactLeafMatches = directMatches.filter((row) => leafName(row.symbol) === requestedLeaf);
  if (exactLeafMatches.length > 0) {
    exactLeafMatches.sort((left, right) => compareDirectCandidates(left, right, cleanedPattern));
    const exactCallableLeaves = exactLeafMatches.filter((row) => isFunctionLikeSymbol(row.symbol));
    return exactCallableLeaves.length > 0 ? exactCallableLeaves : exactLeafMatches;
  }

  directMatches.sort((left, right) => compareDirectCandidates(left, right, cleanedPattern));
  return directMatches;
}

function compareDirectCandidates(left: SymbolQueryRow, right: SymbolQueryRow, cleanedPattern: string): number {
  return (
    pathQualifiedDirectScore(right, cleanedPattern) - pathQualifiedDirectScore(left, cleanedPattern) ||
    left.end_line - left.start_line - (right.end_line - right.start_line) ||
    left.relative_path.localeCompare(right.relative_path) ||
    left.symbol.localeCompare(right.symbol)
  );
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function nearestSymbolNames(db: ScipDatabase, symbolPattern: string, limit = 5): string[] {
  const normalized = normalizeNameForDistance(symbolPattern);
  if (!normalized) return [];

  const rows = definitionRangeRows(db, {
    where: '1 = 1',
    orderBy: 'd.relative_path, der.start_line',
    limit: 5000,
  });

  const byName = new Map<string, { shortName: string; distance: number }>();
  for (const row of rows) {
    if (db.isIgnored(row.relative_path)) continue;
    const shortName = shortenSymbol(row.symbol);
    const leaf = leafName(row.symbol);
    const display = row.display_name ?? leaf;
    const candidateNames = [shortName, leaf, display].filter((value) => value.trim().length > 0);
    const distance = Math.min(...candidateNames.map((name) => levenshtein(normalizeNameForDistance(name), normalized)));
    const existing = byName.get(shortName);
    if (!existing || distance < existing.distance) {
      byName.set(shortName, { shortName, distance });
    }
  }

  return [...byName.values()]
    .sort((left, right) => left.distance - right.distance || left.shortName.localeCompare(right.shortName))
    .slice(0, limit)
    .map((entry) => entry.shortName);
}

function normalizeNameForDistance(value: string): string {
  return normalizeLookupPattern(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '');
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min(current[j]! + 1, previous[j + 1]! + 1, previous[j]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

// `hydrateSymbolMatch` lives in definition-catalog.ts (it's catalog work
// — projecting raw rows through the AST-corrected per-file range table).
// Re-exported above via the scip-rows barrel, but the function itself is
// imported directly from definition-catalog.
