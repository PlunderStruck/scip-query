import type { ScipDatabase } from '../db.js';
import type { SymbolResult } from '../types.js';
import { getDefinitionsForFile, resolveIndexedPaths } from '../query-support.js';
import { shortenSymbol } from '../symbol-parser.js';
import { cleanSignature } from './clean-signature.js';

export function symbols(db: ScipDatabase, filePattern: string): SymbolResult[] {
  const resolvedPaths = resolveIndexedPaths(db, filePattern);
  if (resolvedPaths.length === 0) {
    return [];
  }

  return resolvedPaths
    .flatMap((relativePath) => getDefinitionsForFile(db, relativePath))
    .filter((row) => !db.isIgnored(row.relativePath))
    .map((row) => {
      const docRow = db.get<{ sig: string | null }>(
        `SELECT REPLACE(SUBSTR(documentation, INSTR(documentation, '|') + 1), char(10), ' ') AS sig
         FROM global_symbols
         WHERE id = ?`,
        row.symbolId,
      );

      return {
        startLine: row.startLine,
        endLine: row.endLine,
        symbol: row.symbol,
        shortName: shortenSymbol(row.symbol),
        signature: cleanSignature(docRow?.sig ?? null),
      };
    });
}
