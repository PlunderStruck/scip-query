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
import type { ScipDatabase } from '../storage/db.js';
import { normalizePath } from '../resolution/import-path-resolver.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import type { ParsedReExport, ParsedSourceExport, ParsedSourceImport } from '../domain/types.js';
import { parseReExports } from './javascript.js';
import { getParserForPath } from './registry.js';

/**
 * Parse `export … from '…'` statements in a JS/TS source and resolve the
 * target paths. Public entry point of the language-parsers barrel so callers
 * don't reach into the JS-specific implementation file.
 */
// scip-query: ignore-wrapper — barrel-layer entry point that hides the
// per-language adapter. Inlining would reintroduce a queries → JS-impl
// layer dependency that drift correctly flags.
export function getReExports(
  db: ScipDatabase,
  relativePath: string,
): ParsedReExport[] {
  return parseReExports(db, relativePath);
}

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
