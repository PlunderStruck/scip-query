import type { ScipDatabase } from '../../storage/db.js';
import { loadFileSymbols } from '../../symbols/definition-catalog.js';
import { resolveIndexedPaths } from '../../resolution/path-resolver.js';

// scip-query: ignore-stale — public row contract returned by symbols() and
// reused by system() for its nested symbol list.
export interface SymbolResult {
  startLine: number;
  endLine: number;
  symbol: string;
  shortName: string;
  signature: string | null;
}

export function symbols(db: ScipDatabase, filePattern: string): SymbolResult[] {
  const paths = resolveIndexedPaths(db, filePattern);
  return loadFileSymbols(db, paths).map(({ relativePath: _r, ...rest }) => rest);
}
