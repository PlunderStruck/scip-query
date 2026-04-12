import type { ScipDatabase } from '../db.js';
import { getInactiveBarrelPaths, isEntrySurface } from '../entry-surfaces.js';
import { getAllDefinitions, TEST_FILE_PATTERNS, TEST_SUPPORT_PATH_PATTERNS } from '../query-support.js';
import type { DeadOptions, DeadSymbolResult, DeadSummary } from '../types.js';
import { isFunctionLikeSymbol, isModuleLikeSymbol, shortenSymbol } from '../symbol-parser.js';

/**
 * Find dead exports: symbols defined locally with no cross-file references.
 * Language-agnostic — works with any SCIP index.
 */
export function dead(db: ScipDatabase, opts: DeadOptions = {}): DeadSummary {
  const {
    scope,
    minLoc = 1,
    includeTests = false,
    skipBarrels = false,
    includeMembers = false,
  } = opts;

  const inactiveBarrelPaths = skipBarrels ? new Set(getInactiveBarrelPaths(db)) : new Set<string>();
  const referenceRows = db.all<{
    symbol_id: number;
    relative_path: string;
    ref_count: number;
  }>(
    `SELECT
      m.symbol_id,
      d.relative_path,
      COUNT(*) AS ref_count
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.role != 1
       ${db.pathExclusionsFor('d')}
     GROUP BY m.symbol_id, d.relative_path`,
  );

  const referencesBySymbol = new Map<number, Map<string, number>>();
  for (const row of referenceRows) {
    if (db.isIgnored(row.relative_path)) continue;
    if (inactiveBarrelPaths.has(row.relative_path)) continue;

    let refsForSymbol = referencesBySymbol.get(row.symbol_id);
    if (!refsForSymbol) {
      refsForSymbol = new Map<string, number>();
      referencesBySymbol.set(row.symbol_id, refsForSymbol);
    }
    refsForSymbol.set(row.relative_path, row.ref_count);
  }

  const definitions = getAllDefinitions(db, { scope })
    .filter((definition) => !db.isIgnored(definition.relativePath))
    .filter((definition) => !isModuleLikeSymbol(definition.symbol))
    .filter((definition) => looksValueLikeDefinition(definition.symbol))
    .filter((definition) => (
      definition.isFunctionLike
      || !definition.enclosingSymbol
      || !looksValueLikeDefinition(definition.enclosingSymbol)
    ))
    .filter((definition) => includeTests || passesTestFileFilter(definition.relativePath))
    .filter((definition) => includeMembers || looksValueLikeDefinition(definition.symbol))
    .filter((definition) => (definition.endLine - definition.startLine + 1) >= minLoc);

  const rows = definitions
    .map((definition) => {
      const refMap = referencesBySymbol.get(definition.symbolId) ?? new Map<string, number>();
      const sameFileRefs = refMap.get(definition.relativePath) ?? 0;
      let crossFileRefs = 0;
      for (const [relativePath, count] of refMap) {
        if (relativePath === definition.relativePath) continue;
        crossFileRefs += count;
      }

      return {
        relative_path: definition.relativePath,
        start_line: definition.startLine,
        end_line: definition.endLine,
        loc: definition.endLine - definition.startLine + 1,
        symbol: definition.symbol,
        same_file_refs: sameFileRefs,
        cross_file_refs: crossFileRefs,
      };
    })
    .filter((row) => row.cross_file_refs === 0)
    .sort((a, b) => b.loc - a.loc || a.relative_path.localeCompare(b.relative_path) || a.start_line - b.start_line);

  let deadCodeCount = 0;
  let fileInternalCount = 0;
  let totalLoc = 0;

  const symbols: DeadSymbolResult[] = rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .filter((r) => !isEntrySurface(db, r.relative_path))
    .map((r) => {
      // dead-code: zero references anywhere (not even in same file) — safe to delete
      // file-internal: referenced within same file but never cross-file —
      //   may be a private helper (fine) or a forgotten export (needs review)
      const kind = r.same_file_refs === 0 ? 'dead-code' : 'file-internal';
      if (kind === 'dead-code') deadCodeCount++;
      else fileInternalCount++;
      totalLoc += r.loc;

      return {
        relativePath: r.relative_path,
        startLine: r.start_line,
        endLine: r.end_line,
        loc: r.loc,
        symbol: r.symbol,
        shortName: shortenSymbol(r.symbol),
        sameFileRefs: r.same_file_refs,
        kind,
      };
    });

  return {
    symbols,
    totalCount: symbols.length,
    deadCodeCount,
    fileInternalCount,
    totalLoc,
  };
}

function passesTestFileFilter(relativePath: string): boolean {
  const patterns = [...new Set([...TEST_FILE_PATTERNS, ...TEST_SUPPORT_PATH_PATTERNS])];
  return patterns.every((pattern) => !likeMatches(relativePath, pattern));
}

function likeMatches(value: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.')}$`);
  return regex.test(value);
}

function looksValueLikeDefinition(rawSymbol: string): boolean {
  return isFunctionLikeSymbol(rawSymbol) || rawSymbol.endsWith('().') || rawSymbol.endsWith('.');
}
