import type { ScipDatabase } from '../db.js';
import type { SymbolResult } from '../types.js';
import { loadFileSymbols } from '../definition-catalog.js';
import { resolveIndexedPaths } from '../path-resolver.js';

export function symbols(db: ScipDatabase, filePattern: string): SymbolResult[] {
  const paths = resolveIndexedPaths(db, filePattern);
  return loadFileSymbols(db, paths).map(({ relativePath: _r, ...rest }) => rest);
}
