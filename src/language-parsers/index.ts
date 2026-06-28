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
import { importResolutionFingerprint, normalizePath } from '../resolution/import-path-resolver.js';
import { fileContentHash, readCachedFileEvidence, writeCachedFileEvidence } from '../storage/evidence-cache.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import type { ParsedReExport, ParsedSourceExport, ParsedSourceImport } from '../domain/types.js';
import { getSourceText } from '../source/source-text.js';
import { getParserForPath } from './registry.js';

const PARSER_CACHE_GROUPS = { clearGroups: ['whole-project', 'source-file'] } as const;
const SOURCE_IMPORT_CACHE = createPerDbCache<string, ParsedSourceImport[]>('source-imports', PARSER_CACHE_GROUPS);
const SOURCE_EXPORT_CACHE = createPerDbCache<string, ParsedSourceExport[]>('source-exports', PARSER_CACHE_GROUPS);
const SOURCE_REEXPORT_CACHE = createPerDbCache<string, ParsedReExport[]>('source-reexports', PARSER_CACHE_GROUPS);

interface SerializedSourceImports {
  resolutionFingerprint: string;
  imports: ParsedSourceImport[];
}

export function getReExports(db: ScipDatabase, relativePath: string): ParsedReExport[] {
  const normalized = normalizePath(relativePath);
  return SOURCE_REEXPORT_CACHE.get(db, normalized, () => {
    const parser = getParserForPath(normalized);
    if (!parser?.parseReExports) return [];
    const source = getSourceText(db, normalized);
    if (!source) return [];
    return parser.parseReExports(db, normalized, source);
  });
}

export function getSourceImports(db: ScipDatabase, relativePath: string): ParsedSourceImport[] {
  const normalized = normalizePath(relativePath);
  return SOURCE_IMPORT_CACHE.get(db, normalized, () => {
    const parser = getParserForPath(normalized);
    if (!parser) return [];
    const source = getSourceText(db, normalized);
    if (!source) return [];
    const contentHash = fileContentHash(db, normalized, source);
    const resolutionFingerprint = importResolutionFingerprint(db);
    const cached = readCachedFileEvidence(db, 'source-imports', normalized, contentHash);
    if (cached !== null) {
      try {
        const payload = JSON.parse(cached) as SerializedSourceImports;
        if (payload.resolutionFingerprint === resolutionFingerprint && Array.isArray(payload.imports)) {
          return payload.imports;
        }
      } catch {
        // corrupt payload — fall through and rebuild
      }
    }
    const imports = parser.parseImports(db, normalized, source);
    writeCachedFileEvidence(
      db,
      'source-imports',
      normalized,
      contentHash,
      JSON.stringify({ resolutionFingerprint, imports } satisfies SerializedSourceImports),
    );
    return imports;
  });
}

export function getSourceExports(db: ScipDatabase, relativePath: string): ParsedSourceExport[] {
  const normalized = normalizePath(relativePath);
  return SOURCE_EXPORT_CACHE.get(db, normalized, () => {
    const parser = getParserForPath(normalized);
    if (!parser?.parseExports) return [];
    const source = getSourceText(db, normalized);
    if (!source) return [];
    return parser.parseExports(db, normalized, source);
  });
}
