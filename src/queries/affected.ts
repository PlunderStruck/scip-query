import type { ScipDatabase } from '../db.js';
import {
  findExactSymbolMatch,
  findFirstSymbolMatch,
  getCallerRowsForSymbol,
} from '../query-support.js';
import type { SymbolMatch } from '../query-support.js';
import type { AffectedResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Full transitive closure of symbols that could break if a given symbol changes.
 * BFS from the target through the mention graph: depth 1 = direct consumers,
 * depth 2 = consumers of consumers, etc.
 */
export function affected(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { maxDepth?: number; scope?: string } = {},
): AffectedResult[] {
  const { maxDepth = 5, scope } = opts;

  const target = findFirstSymbolMatch(db, symbolPattern);
  if (!target) return [];

  const results: AffectedResult[] = [];
  const visited = new Set<number>([target.symbolId]);
  const seenResults = new Set<string>();
  let frontier = [target];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;

    const nextFrontier: typeof frontier = [];

    for (const current of frontier) {
      for (const row of getDirectAffectedRows(db, current, scope)) {
        const resultKey = `${row.file}|${row.shortName}`;
        if (row.symbolId !== null) {
          if (visited.has(row.symbolId)) continue;
          visited.add(row.symbolId);
        } else if (seenResults.has(resultKey)) {
          continue;
        }

        seenResults.add(resultKey);
        results.push({
          symbol: row.symbol,
          shortName: row.shortName,
          file: row.file,
          depth,
        });

        if (row.symbolId !== null && row.symbolMatch) {
          nextFrontier.push(row.symbolMatch);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Sort by depth then file path
  results.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  return results;
}

function getDirectAffectedRows(
  db: ScipDatabase,
  target: SymbolMatch,
  scope?: string,
): Array<{
  symbolId: number | null;
  symbol: string;
  shortName: string;
  file: string;
  symbolMatch: SymbolMatch | null;
}> {
  const callerRows = getCallerRowsForSymbol(db, target, { limit: 500 })
    .filter((row) => !db.isIgnored(row.file))
    .filter((row) => !scope || row.file.includes(scope));

  const results: Array<{
    symbolId: number | null;
    symbol: string;
    shortName: string;
    file: string;
    symbolMatch: SymbolMatch | null;
  }> = [];
  const seen = new Set<string>();

  for (const row of callerRows) {
    const match = findExactSymbolMatch(db, row.symbol);
    if (!match) {
      const key = `${row.file}|${row.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        symbolId: null,
        symbol: row.symbol,
        shortName: shortenSymbol(row.symbol),
        file: row.file,
        symbolMatch: null,
      });
      continue;
    }

    if (match.symbolId === target.symbolId || db.isIgnored(match.relativePath)) {
      continue;
    }

    const key = `${match.symbolId}|${match.relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      symbolId: match.symbolId,
      symbol: match.symbol,
      shortName: shortenSymbol(match.symbol),
      file: match.relativePath,
      symbolMatch: match,
    });
  }

  return results;
}
