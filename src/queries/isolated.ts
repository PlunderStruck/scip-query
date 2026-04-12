import type { ScipDatabase } from '../db.js';
import { isEntrySurface } from '../entry-surfaces.js';
import {
  getAllDefinitions,
  getCallerRowsForSymbol,
  getCalleeRowsForSymbol,
} from '../query-support.js';
import type { IsolatedResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find isolated callables: defined locally, referenced by nothing,
 * and calling nothing else. These are truly disconnected leaves.
 */
export function isolated(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number } = {},
): IsolatedResult[] {
  const { scope, minLoc = 3 } = opts;

  return getAllDefinitions(db, { scope })
    .filter((definition) => !db.isIgnored(definition.relativePath))
    .filter((definition) => !isEntrySurface(db, definition.relativePath))
    .filter((definition) => definition.isFunctionLike)
    .map((definition) => ({
      definition,
      loc: definition.endLine - definition.startLine + 1,
    }))
    .filter((entry) => entry.loc >= minLoc)
    .filter((entry) => getCallerRowsForSymbol(db, entry.definition, { limit: 1 }).length === 0)
    .filter((entry) => getCalleeRowsForSymbol(db, entry.definition, { limit: 1 }).length === 0)
    .sort((left, right) =>
      right.loc - left.loc
      || left.definition.relativePath.localeCompare(right.definition.relativePath)
      || left.definition.startLine - right.definition.startLine,
    )
    .map((entry) => ({
      symbol: entry.definition.symbol,
      shortName: shortenSymbol(entry.definition.symbol),
      relativePath: entry.definition.relativePath,
      startLine: entry.definition.startLine,
      endLine: entry.definition.endLine,
      loc: entry.loc,
    }));
}
