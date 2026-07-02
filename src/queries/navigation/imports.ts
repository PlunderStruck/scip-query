import type { ScipDatabase } from '../../storage/db.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { resolveIndexedFile } from '../../resolution/path-resolver.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { semanticImportUsage } from '../../semantic/shared-primitives.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import { isModuleLikeSymbol, leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import { detectAstLanguage } from '../../source/ast.js';
import { normalizePathSeparators as normalizePath } from '../../source/path-normalization.js';

export interface ImportResult {
  symbol: string;
  shortName: string;
  fromFile: string;
}

export interface UnusedImportResult {
  symbol: string;
  shortName: string;
  importedIn: string;
}

/**
 * What symbols does this file import?
 * Uses role=2 (import) from the SCIP mentions table.
 */
export function imports(db: ScipDatabase, filePattern: string, opts: { semantic?: boolean } = {}): ImportResult[] {
  return (
    loadFileImportEntries(db, filePattern, opts)?.map((entry) => ({
      symbol: entry.symbol,
      shortName: entry.shortName,
      fromFile: entry.fromFile,
    })) ?? []
  );
}

/**
 * Which files import this symbol?
 */
export function importedBy(db: ScipDatabase, symbolPattern: string): ImportResult[] {
  const target = findFirstSymbolMatch(db, symbolPattern);
  const indexedResults = indexedImporters(db, symbolPattern);
  if (indexedResults.length > 0 && !isClojureTarget(target)) return indexedResults;
  const sourceResults = sourceImportersForSymbol(db, symbolPattern, target);
  if (looksLikeNamespacePattern(symbolPattern) && sourceResults.length > 0) return sourceResults;
  return dedupeImportResults([...indexedResults, ...sourceResults]);
}

/**
 * Find imports in a file that are never referenced (role=0) in the same file.
 * These are likely unused imports.
 */
export function unusedImports(
  db: ScipDatabase,
  filePattern: string,
  opts: { semantic?: boolean } = {},
): UnusedImportResult[] {
  return (
    loadFileImportEntries(db, filePattern, opts)
      ?.filter((entry) => !entry.used)
      .map((entry) => ({
        symbol: entry.symbol,
        shortName: entry.shortName,
        importedIn: entry.importer,
      })) ?? []
  );
}

interface ImportEntry {
  symbol: string;
  shortName: string;
  fromFile: string;
  importer: string;
  used: boolean;
}

function indexedImporters(db: ScipDatabase, symbolPattern: string): ImportResult[] {
  const rows = db.all<{
    symbol: string;
    importer: string;
  }>(
    `SELECT DISTINCT gs.symbol, d.relative_path AS importer
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    WHERE gs.symbol LIKE ?
      AND m.role = 2
    ORDER BY d.relative_path`,
    `%${symbolPattern}%`,
  );

  return rows
    .filter((r) => !db.isIgnored(r.importer))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      fromFile: r.importer,
    }));
}

// scip-query: ignore-extract — this is the source-parser fallback importer
// scan; document loading, ignore filtering, and import-target matching form one
// conservative evidence path.
function sourceImportersForSymbol(
  db: ScipDatabase,
  symbolPattern: string,
  target: ReturnType<typeof findFirstSymbolMatch> = findFirstSymbolMatch(db, symbolPattern),
): ImportResult[] {
  const targetFile = target?.relativePath ?? null;
  const targetLeaf = target ? leafName(target.symbol) : symbolPattern.replace(/\(\)$/, '');
  const targetIsModule = target ? isModuleLikeSymbol(target.symbol) : false;

  const importers = new Set<string>();
  for (const relativePath of indexedDocumentPaths(db, { includeIgnored: false })) {
    for (const entry of getSourceImports(db, relativePath)) {
      if (
        sourceImportMatchesTarget(entry, relativePath, {
          targetFile,
          targetLeaf,
          targetIsModule,
          targetPattern: symbolPattern,
        })
      ) {
        importers.add(relativePath);
      }
    }
  }

  const namespacePattern = looksLikeNamespacePattern(symbolPattern) ? symbolPattern.trim() : null;
  return [...importers].sort().map((importer) => ({
    symbol: namespacePattern ?? target?.symbol ?? targetLeaf,
    shortName: namespacePattern ?? (target ? shortenSymbol(target.symbol) : targetLeaf),
    fromFile: importer,
  }));
}

function isClojureTarget(target: ReturnType<typeof findFirstSymbolMatch>): boolean {
  return Boolean(
    target && (target.symbol.startsWith('scip-clojure ') || detectAstLanguage(target.relativePath) === 'clojure'),
  );
}

function dedupeImportResults(results: ImportResult[]): ImportResult[] {
  const seen = new Set<string>();
  const deduped: ImportResult[] = [];
  for (const result of results) {
    const key = `${result.symbol}|${result.fromFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped.sort((a, b) => a.fromFile.localeCompare(b.fromFile) || a.shortName.localeCompare(b.shortName));
}

function sourceImportMatchesTarget(
  entry: ParsedSourceImport,
  importerPath: string,
  target: { targetFile: string | null; targetLeaf: string; targetIsModule: boolean; targetPattern: string },
): boolean {
  if (!entry.sourcePath) return false;
  if (target.targetFile && normalizePath(entry.sourcePath) !== normalizePath(target.targetFile)) {
    return false;
  }
  if (entry.kind === 'side-effect') return true;
  if (target.targetFile && isCLikeImporter(importerPath)) return true;
  if (entry.kind === 'namespace' && namespaceImportMatchesPattern(entry, target.targetPattern)) return true;
  if (target.targetIsModule) return true;
  if (entry.kind === 'named' && entry.importedName === target.targetLeaf) return true;
  return entry.kind === 'namespace' && entry.usedMembers.includes(target.targetLeaf);
}

function namespaceImportMatchesPattern(entry: ParsedSourceImport, targetPattern: string): boolean {
  const normalized = targetPattern.trim().replace(/\(\)$/, '');
  if (!looksLikeNamespacePattern(normalized)) return false;
  return entry.importedName === normalized || entry.localName === normalized;
}

function looksLikeNamespacePattern(pattern: string): boolean {
  const normalized = pattern.trim().replace(/\(\)$/, '');
  return normalized.includes('.') && !normalized.includes('/') && !normalized.includes(':');
}

function loadFileImportEntries(
  db: ScipDatabase,
  filePattern: string,
  opts: { semantic?: boolean } = {},
): ImportEntry[] | null {
  const importer = resolveIndexedFile(db, filePattern);
  if (!importer) return null;

  return (
    indexedFileImportEntries(db, importer, opts) ??
    (opts.semantic === false ? null : semanticFileImportEntries(db, importer)) ??
    sourceFileImportEntries(db, importer)
  );
}

function indexedFileImportEntries(
  db: ScipDatabase,
  importer: string,
  opts: { semantic?: boolean },
): ImportEntry[] | null {
  const rows = db.all<{
    symbol: string;
    from_file: string | null;
    importer: string;
    used: number;
  }>(
    `SELECT DISTINCT
       gs.symbol,
       def_d.relative_path AS from_file,
       imp_d.relative_path AS importer,
       EXISTS (
         SELECT 1
         FROM mentions ref_m
         JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
         WHERE ref_m.symbol_id = gs.id
           AND ref_m.role != 1
           AND ref_c.document_id = imp_d.id
       ) AS used
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents imp_d ON c.document_id = imp_d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    LEFT JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    LEFT JOIN documents def_d ON sym_def.document_id = def_d.id
    WHERE imp_d.relative_path = ?
      AND m.role = 2
    ORDER BY def_d.relative_path, gs.symbol`,
    importer,
  );

  const indexed = rows.filter((row) => !db.isIgnored(row.importer));
  if (indexed.length > 0) {
    const semantic = opts.semantic === false ? [] : semanticImportUsage(db, importer);
    return indexed.map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      fromFile: r.from_file ?? '(external)',
      importer: r.importer,
      used: r.used !== 0 || semantic.some((entry) => entry.isUsed && entry.sourcePath === r.from_file),
    }));
  }

  return null;
}

function semanticFileImportEntries(db: ScipDatabase, importer: string): ImportEntry[] | null {
  const semantic = semanticImportUsage(db, importer);
  if (semantic.length > 0) {
    return semantic.map((entry) => {
      const rendered = renderImportSymbol(entry.importedName, entry.localName, entry.kind);
      return {
        symbol: rendered,
        shortName: rendered,
        fromFile: entry.sourcePath ?? '(external)',
        importer,
        used: entry.kind === 'side-effect' ? true : entry.isUsed,
      };
    });
  }
  return null;
}

function sourceFileImportEntries(db: ScipDatabase, importer: string): ImportEntry[] {
  return getSourceImports(db, importer).map((entry) => {
    const rendered = renderImportSymbol(entry.importedName, entry.localName, entry.kind);
    // Side-effect imports never reference a named symbol, so they're never
    // "unused" in the sense unused-imports flags. Mark them used to preserve
    // the original `kind !== 'side-effect' && !entry.used` filter behavior.
    const used = entry.kind === 'side-effect' ? true : entry.used;
    return {
      symbol: rendered,
      shortName: rendered,
      fromFile: entry.sourcePath ?? '(external)',
      importer,
      used,
    };
  });
}

function renderImportSymbol(
  importedName: string,
  localName: string | null,
  kind: 'named' | 'default' | 'namespace' | 'side-effect',
): string {
  if (kind === 'namespace' && importedName === '*' && localName) {
    return `* as ${localName}`;
  }

  if (kind === 'default' && localName) {
    return `default as ${localName}`;
  }

  if (kind === 'side-effect') {
    return '(side effect import)';
  }

  if (localName && localName !== importedName) {
    return `${importedName} as ${localName}`;
  }

  return importedName;
}

function isCLikeImporter(relativePath: string): boolean {
  return /\.(?:c|h|cc|cpp|cxx|hpp|hh|hxx)$/i.test(relativePath);
}
