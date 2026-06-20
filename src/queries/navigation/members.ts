import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../../core/project-index.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { isDirectChildSymbol, leafSuffix, shortenSymbol } from '../../symbols/symbol-parser.js';

export interface MemberResult {
  symbol: string;
  shortName: string;
  startLine: number;
  endLine: number;
  kind: string;
}

/**
 * Find all direct children of a symbol (methods, fields, nested types).
 * Uses descriptor-chain fallback when enclosing_symbol is not populated.
 *
 * Ranges come from getDefinitionsForFile so they are source-corrected
 * and match `scip symbols` output.
 */
export function members(db: ScipDatabase, symbolPattern: string): MemberResult[] {
  const parent = findFirstSymbolMatch(db, symbolPattern);
  if (!parent) return [];

  const index = new ProjectIndex(db);
  return index.definitionsForFile(parent.relativePath)
    .filter((definition) => definition.symbol !== parent.symbol)
    .filter((definition) => isDirectChildSymbol(parent.symbol, definition.symbol))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
    .map((definition) => ({
      symbol: definition.symbol,
      shortName: shortenSymbol(definition.symbol),
      startLine: definition.startLine,
      endLine: definition.endLine,
      kind: leafSuffix(definition.symbol) ?? 'unknown',
    }));
}
