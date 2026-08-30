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
import { isMissingProjectFileError, readProjectFileText } from '../platform/project-files.js';
import { importResolutionFingerprint, normalizePath } from '../source/primitives/import-path-resolver.js';
import { fileContentHash } from '../storage/evidence-cache.js';
import { isRecord } from '../storage/evidence-payload.js';
import { createFileEvidenceProduct, evidenceProductInvalidation } from '../storage/evidence-products.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import type { ParsedReExport, ParsedSourceExport, ParsedSourceImport } from '../domain/types.js';
import { getSourceText } from '../source/primitives/source-text.js';
import { getParserForPath } from './registry.js';

const PARSER_CACHE_GROUPS = { clearGroups: ['whole-project', 'source-file'] } as const;
const SOURCE_IMPORT_CACHE = createPerDbCache<string, ParsedSourceImport[]>('source-imports', PARSER_CACHE_GROUPS);
const SOURCE_EXPORT_CACHE = createPerDbCache<string, ParsedSourceExport[]>('source-exports', PARSER_CACHE_GROUPS);
const SOURCE_REEXPORT_CACHE = createPerDbCache<string, ParsedReExport[]>('source-reexports', PARSER_CACHE_GROUPS);

interface SerializedSourceImports {
  parserVersion: 2;
  resolutionFingerprint: string;
  imports: ParsedSourceImport[];
}

interface SerializedReExports {
  resolutionFingerprint: string;
  reExports: ParsedReExport[];
}

const SOURCE_IMPORTS_PRODUCT = createFileEvidenceProduct<SerializedSourceImports>({
  kind: 'source-imports',
  invalidation: evidenceProductInvalidation('source-imports'),
  serialize: serializeSourceImports,
  deserialize: deserializeSourceImports,
});
const SOURCE_REEXPORTS_PRODUCT = createFileEvidenceProduct<SerializedReExports>({
  kind: 'source-reexports',
  invalidation: evidenceProductInvalidation('source-reexports'),
  serialize: serializeReExports,
  deserialize: deserializeReExports,
});

export function getReExports(db: ScipDatabase, relativePath: string): ParsedReExport[] {
  const normalized = normalizePath(relativePath);
  return SOURCE_REEXPORT_CACHE.get(db, normalized, () => {
    const parser = getParserForPath(normalized);
    if (!parser?.parseReExports) return [];
    const source = getSourceText(db, normalized);
    if (!source) return [];
    const contentHash = fileContentHash(db, normalized, source);
    const resolutionFingerprint = importResolutionFingerprint(db);
    const cached = SOURCE_REEXPORTS_PRODUCT.read(db, normalized, contentHash);
    if (cached?.resolutionFingerprint === resolutionFingerprint) {
      return cached.reExports;
    }
    const reExports = parser.parseReExports(db, normalized, source);
    SOURCE_REEXPORTS_PRODUCT.write(db, normalized, contentHash, { resolutionFingerprint, reExports });
    return reExports;
  });
}

// scip-query: ignore-similar - imports and re-exports share parser/cache plumbing but produce different source facts.
export function getSourceImports(db: ScipDatabase, relativePath: string): ParsedSourceImport[] {
  const normalized = normalizePath(relativePath);
  return SOURCE_IMPORT_CACHE.get(db, normalized, () => {
    const parser = getParserForPath(normalized);
    if (!parser) return [];
    const source = getSourceText(db, normalized);
    if (!source) return [];
    return loadSourceImports(db, normalized, source, parser);
  });
}

/**
 * Reads one import list without retaining the file text or parsed result in the
 * process-wide per-database caches. Whole-project graph construction uses this
 * streaming form so its memory is proportional to the graph, not repository size.
 */
export function readSourceImportsUncached(db: ScipDatabase, relativePath: string): ParsedSourceImport[] {
  const normalized = normalizePath(relativePath);
  const parser = getParserForPath(normalized);
  if (!parser) return [];
  let source: string;
  try {
    source = readProjectFileText(db.config.projectRoot, normalized, { inputKind: 'indexed source file' });
  } catch (error) {
    if (isMissingProjectFileError(error)) return [];
    throw error;
  }
  return loadSourceImports(db, normalized, source, parser);
}

function loadSourceImports(
  db: ScipDatabase,
  normalized: string,
  source: string,
  parser: NonNullable<ReturnType<typeof getParserForPath>>,
): ParsedSourceImport[] {
  const contentHash = fileContentHash(db, normalized, source);
  const resolutionFingerprint = importResolutionFingerprint(db);
  const cached = SOURCE_IMPORTS_PRODUCT.read(db, normalized, contentHash);
  if (cached?.resolutionFingerprint === resolutionFingerprint) return cached.imports;
  const imports = parser.parseImports(db, normalized, source);
  SOURCE_IMPORTS_PRODUCT.write(db, normalized, contentHash, { parserVersion: 2, resolutionFingerprint, imports });
  return imports;
}

/**
 * Returns the one runtime named-import binding for a local identifier.
 * A binding connects the name written at a callsite to the exported name and
 * resolved project file that actually own the callable. Ambiguous, type-only,
 * and unresolved imports fail closed because none can establish runtime identity.
 */
export function findNamedSourceImportBinding(
  db: ScipDatabase,
  relativePath: string,
  localName: string,
): ParsedSourceImport | null {
  const matches = getSourceImports(db, relativePath).filter(
    (entry) =>
      entry.kind === 'named' && entry.isTypeOnly !== true && entry.localName === localName && entry.sourcePath !== null,
  );
  return matches.length === 1 ? matches[0]! : null;
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

function serializeSourceImports(payload: SerializedSourceImports): string {
  return JSON.stringify(payload);
}

function deserializeSourceImports(payload: string): SerializedSourceImports | null {
  try {
    const raw = JSON.parse(payload) as unknown;
    if (
      !isRecord(raw) ||
      raw.parserVersion !== 2 ||
      typeof raw.resolutionFingerprint !== 'string' ||
      !Array.isArray(raw.imports)
    ) {
      return null;
    }
    return {
      parserVersion: 2,
      resolutionFingerprint: raw.resolutionFingerprint,
      imports: raw.imports as ParsedSourceImport[],
    };
  } catch {
    return null;
  }
}

function serializeReExports(payload: SerializedReExports): string {
  return JSON.stringify(payload);
}

function deserializeReExports(payload: string): SerializedReExports | null {
  try {
    const raw = JSON.parse(payload) as unknown;
    if (!isRecord(raw) || typeof raw.resolutionFingerprint !== 'string' || !Array.isArray(raw.reExports)) {
      return null;
    }
    return { resolutionFingerprint: raw.resolutionFingerprint, reExports: raw.reExports as ParsedReExport[] };
  } catch {
    return null;
  }
}
