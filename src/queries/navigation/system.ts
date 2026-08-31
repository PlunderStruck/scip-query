import type { ScipDatabase } from '../../storage/db.js';
import { loadFileSymbols } from '../../symbols/definition-catalog.js';
import { fileDependencyPaths } from '../../symbols/graph/file-dep-graph.js';
import { resolveIndexedPaths } from '../internal/file-resolution.js';
import type { SymbolResult } from './symbols.js';

export interface SystemResult {
  files: string[];
  symbols: SymbolResult[];
  dependsOn: string[];
  dependedOnBy: string[];
}

/** Full system map for a module path: files, symbols, deps in/out.
 *
 * Exported-symbol ranges come from getDefinitionsForFile so they are
 * source-corrected and match `scip symbols` output.
 */
export function system(db: ScipDatabase, modulePattern: string): SystemResult {
  const matchedPaths = resolveIndexedPaths(db, modulePattern);
  if (matchedPaths.length === 0) {
    return { files: [], symbols: [], dependsOn: [], dependedOnBy: [] };
  }

  const placeholders = matchedPaths.map(() => '?').join(', ');
  const fileRows = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE relative_path IN (${placeholders})
     ORDER BY relative_path`,
    ...matchedPaths,
  );
  const files = fileRows.map((r) => r.relative_path).filter((p) => !db.isIgnored(p));

  // Exported symbols: corrected ranges + documentation filter.
  const symbols: SymbolResult[] = loadFileSymbols(db, files, { onlyDocumented: true, sort: true }).map(
    ({ relativePath: _r, ...rest }) => rest,
  );

  const dependsOn = fileDependencyPaths(db, 'forward', matchedPaths).filter((path) => !db.isIgnored(path));
  const dependedOnBy = fileDependencyPaths(db, 'reverse', matchedPaths).filter((path) => !db.isIgnored(path));

  return { files, symbols, dependsOn, dependedOnBy };
}

/** One-hop module summary; this does not infer a repository subsystem boundary. */
// scip-query: ignore-passthrough — public name preserves the one-hop module-map contract over the legacy system query.
export function moduleMap(db: ScipDatabase, modulePattern: string): SystemResult {
  return system(db, modulePattern);
}
