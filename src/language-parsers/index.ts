/**
 * Public entry-point of the language-parsers directory. Hides the
 * registry, the per-language adapters, and the per-(db, file) source
 * caches. Callers see source-fact functions: imports, exports, and
 * JavaScript-style re-exports.
 *
 * The cache layer here matters: every query that walks the import graph
 * calls `getSourceImports` for many files in a tight loop. Without
 * caching, each call would re-read the file off disk and re-walk the
 * AST. The cache makes repeat queries on the same file effectively free.
 */
import type { ScipDatabase } from '../storage/db.js';
import { normalizePath } from '../resolution/import-path-resolver.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import type { ParsedReExport, ParsedSourceExport, ParsedSourceImport } from '../domain/types.js';
import { getSourceText } from '../source/source-text.js';
import { getParserForPath } from './registry.js';

const SOURCE_IMPORT_CACHE = createPerDbCache<string, ParsedSourceImport[]>('source-imports');
const SOURCE_EXPORT_CACHE = createPerDbCache<string, ParsedSourceExport[]>('source-exports');
const SOURCE_REEXPORT_CACHE = createPerDbCache<string, ParsedReExport[]>('source-reexports');

export function getReExports(
  db: ScipDatabase,
  relativePath: string,
): ParsedReExport[] {
  const normalized = normalizePath(relativePath);
  return SOURCE_REEXPORT_CACHE.get(db, normalized, () => {
    const parser = getParserForPath(normalized);
    if (!parser?.parseReExports) return [];
    const source = getSourceText(db, normalized);
    if (!source) return [];
    return parser.parseReExports(db, normalized, source);
  });
}

export function getSourceImports(
  db: ScipDatabase,
  relativePath: string,
): ParsedSourceImport[] {
  const normalized = normalizePath(relativePath);
  return SOURCE_IMPORT_CACHE.get(db, normalized, () => {
    const parser = getParserForPath(normalized);
    if (!parser) return [];
    const source = getSourceText(db, normalized);
    if (!source) return [];
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
    const source = getSourceText(db, normalized);
    if (!source) return [];
    return parser.parseExports(db, normalized, source);
  });
}

export function clearLanguageParserCaches(db: ScipDatabase): void {
  SOURCE_IMPORT_CACHE.invalidateAll(db);
  SOURCE_EXPORT_CACHE.invalidateAll(db);
  SOURCE_REEXPORT_CACHE.invalidateAll(db);
}

export function clearLanguageParserCachesForFile(db: ScipDatabase, relativePath: string): void {
  const normalized = normalizePath(relativePath);
  SOURCE_IMPORT_CACHE.invalidate(db, normalized);
  SOURCE_EXPORT_CACHE.invalidate(db, normalized);
  SOURCE_REEXPORT_CACHE.invalidate(db, normalized);
}
