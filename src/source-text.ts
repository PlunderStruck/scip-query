/**
 * Source-file reader with a per-database cache. Tiny module, but the cache
 * itself is hot — every per-language parser, every source-text-driven
 * query (refs/dataflow/trace), and the AST runtime all read source
 * through here so we pay the disk cost once per file per process.
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
