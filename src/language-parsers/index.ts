/**
 * Public entry-point of the language-parsers directory. Hides the
 * registry, the per-language adapters, and the per-(db, file) source
 * caches. Callers see two functions: `getSourceImports` and
 * `getSourceExports`.
 *
 * The cache layer here matters: every query that walks the import graph
 * calls `getSourceImports` for many files in a tight loop. Without
 * caching, each call would re-read the file off disk and re-walk the
 * AST. The cache makes repeat queries on the same file effectively free.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../db.js';
import { normalizePath } from '../import-path-resolver.js';
import { createPerDbCache } from '../per-db-cache.js';
import type { ParsedSourceExport, ParsedSourceImport } from '../types.js';
import { getParserForPath } from './registry.js';

const SOURCE_IMPORT_CACHE = createPerDbCache<string, ParsedSourceImport[]>('source-imports');
const SOURCE_EXPORT_CACHE = createPerDbCache<string, ParsedSourceExport[]>('source-exports');

export function getSourceImports(
  db: ScipDatabase,
  relativePath: string,
): ParsedSourceImport[] {
  const normalized = normalizePath(relativePath);
  return SOURCE_IMPORT_CACHE.get(db, normalized, () => {
    const parser = getParserForPath(normalized);
    if (!parser) return [];
    const fullPath = join(db.config.projectRoot, normalized);
    if (!existsSync(fullPath)) return [];
    const source = readFileSync(fullPath, 'utf-8');
    return parser.parseImports(db, normalized, source);
  });
}

export function getSourceExports(
  db: ScipDatabase,
  relativePath: string,
): ParsedSourceExport[] {
  const normalized = normalizePath(relativePath);
  return SOURCE_EXPORT_CACHE.get(db, normalized, () => {
    const parser = getParserForPath(normalized);
    if (!parser?.parseExports) return [];
    const fullPath = join(db.config.projectRoot, normalized);
    if (!existsSync(fullPath)) return [];
    const source = readFileSync(fullPath, 'utf-8');
    return parser.parseExports(db, normalized, source);
  });
}
