import type { ScipDatabase } from '../storage/db.js';
import type { SymbolResult } from '../domain/types.js';
import { loadFileSymbols } from '../symbols/definition-catalog.js';
import { resolveIndexedPaths } from '../resolution/path-resolver.js';

export function symbols(db: ScipDatabase, filePattern: string): SymbolResult[] {
  const paths = resolveIndexedPaths(db, filePattern);
  return loadFileSymbols(db, paths).map(({ relativePath: _r, ...rest }) => rest);
}
