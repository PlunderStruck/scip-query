import type { ScipDatabase } from '../db.js';
import type { SymbolResult } from '../types.js';
import { loadFileSymbols } from '../definition-catalog.js';

export function symbols(db: ScipDatabase, filePattern: string): SymbolResult[] {
  return loadFileSymbols(db, filePattern).map(({ relativePath: _r, ...rest }) => rest);
}
