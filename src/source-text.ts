/**
 * Source-file reader with a per-database cache.
 *
 * Lives in its own module (not in source-analysis.ts) so ast.ts can read
 * source files for tree-sitter parsing without pulling in all of
 * source-analysis — that import would create a cycle since source-analysis
 * needs ast.ts to dispatch parsing for AST languages.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from './db.js';
import { createPerDbCache } from './per-db-cache.js';

const SOURCE_TEXT_CACHE = createPerDbCache<string, string>('source-text');

export function getSourceText(
  db: ScipDatabase,
  relativePath: string,
): string {
  const normalized = relativePath.replace(/\\/g, '/');
  return SOURCE_TEXT_CACHE.get(db, normalized, () => {
    const fullPath = join(db.config.projectRoot, normalized);
    if (!existsSync(fullPath)) return '';
    return readFileSync(fullPath, 'utf-8');
  });
}
