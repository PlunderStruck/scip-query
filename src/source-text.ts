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

const SOURCE_TEXT_CACHE = new WeakMap<ScipDatabase, Map<string, string>>();

export function getSourceText(
  db: ScipDatabase,
  relativePath: string,
): string {
  let cache = SOURCE_TEXT_CACHE.get(db);
  if (!cache) {
    cache = new Map();
    SOURCE_TEXT_CACHE.set(db, cache);
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const cached = cache.get(normalized);
  if (typeof cached === 'string') return cached;

  const fullPath = join(db.config.projectRoot, normalized);
  if (!existsSync(fullPath)) {
    cache.set(normalized, '');
    return '';
  }
  const source = readFileSync(fullPath, 'utf-8');
  cache.set(normalized, source);
  return source;
}
