import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, resolveIndexedFile } from '../query-support.js';
import { getSourceImports } from '../source-analysis.js';
import type { ImportResult, UnusedImportResult } from '../types.js';
import { isModuleLikeSymbol, leafName, shortenSymbol } from '../symbol-parser.js';

/**
 * What symbols does this file import?
 * Uses role=2 (import) from the SCIP mentions table.
 */
export function imports(db: ScipDatabase, filePattern: string): ImportResult[] {
  const importer = resolveIndexedFile(db, filePattern);
  if (!importer) return [];

  const rows = db.all<{
    symbol: string;
    from_file: string;
    importer: string;
  }>(
    `SELECT DISTINCT gs.symbol, def_d.relative_path AS from_file, imp_d.relative_path AS importer
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents imp_d ON c.document_id = imp_d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    LEFT JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    LEFT JOIN documents def_d ON der.document_id = def_d.id
    WHERE imp_d.relative_path = ?
      AND m.role = 2
    ORDER BY def_d.relative_path, gs.symbol`,
    importer,
  );

  const indexedResults = rows
    .filter((row) => !db.isIgnored(row.importer))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      fromFile: r.from_file ?? '(external)',
    }));

  if (indexedResults.length > 0) {
    return indexedResults;
  }

  return getSourceImports(db, importer)
    .map((entry) => ({
      symbol: renderImportSymbol(entry.importedName, entry.localName, entry.kind),
      shortName: renderImportSymbol(entry.importedName, entry.localName, entry.kind),
      fromFile: entry.sourcePath ?? '(external)',
    }));
}

/**
 * Which files import this symbol?
 */
export function importedBy(db: ScipDatabase, symbolPattern: string): ImportResult[] {
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

  const indexedResults = rows
    .filter((r) => !db.isIgnored(r.importer))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      fromFile: r.importer,
    }));

  if (indexedResults.length > 0) {
    return indexedResults;
  }

  const target = findFirstSymbolMatch(db, symbolPattern);
  const targetFile = target?.relativePath ?? null;
  const targetLeaf = target ? leafName(target.symbol) : symbolPattern.replace(/\(\)$/, '');
  const targetIsModule = target ? isModuleLikeSymbol(target.symbol) : false;

  const files = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
     ORDER BY relative_path`,
  );

  const importers = new Set<string>();
  for (const row of files) {
    if (db.isIgnored(row.relative_path)) continue;

    for (const entry of getSourceImports(db, row.relative_path)) {
      if (!entry.sourcePath) continue;

      if (targetFile && normalizePath(entry.sourcePath) !== normalizePath(targetFile)) {
        continue;
      }

      if (entry.kind === 'side-effect') {
        importers.add(row.relative_path);
        continue;
      }

      if (targetFile && isCLikeImporter(row.relative_path)) {
        importers.add(row.relative_path);
        continue;
      }

      if (targetIsModule) {
        importers.add(row.relative_path);
        continue;
      }

      if (entry.kind === 'named' && entry.importedName === targetLeaf) {
        importers.add(row.relative_path);
        continue;
      }

      if (entry.kind === 'namespace' && entry.usedMembers.includes(targetLeaf)) {
        importers.add(row.relative_path);
      }
    }
  }

  return [...importers].sort().map((importer) => ({
    symbol: target?.symbol ?? targetLeaf,
    shortName: target ? shortenSymbol(target.symbol) : targetLeaf,
    fromFile: importer,
  }));
}

/**
 * Find imports in a file that are never referenced (role=0) in the same file.
 * These are likely unused imports.
 */
export function unusedImports(db: ScipDatabase, filePattern: string): UnusedImportResult[] {
  const importer = resolveIndexedFile(db, filePattern);
  if (!importer) return [];

  const rows = db.all<{
    symbol: string;
    imported_in: string;
    importer: string;
  }>(
    `SELECT gs.symbol, d.relative_path AS imported_in, d.relative_path AS importer
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    WHERE d.relative_path = ?
      AND m.role = 2
      AND NOT EXISTS (
        SELECT 1
        FROM mentions ref_m
        JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
        WHERE ref_m.symbol_id = gs.id
          AND ref_m.role != 1
          AND ref_c.document_id = d.id
      )
    ORDER BY d.relative_path, gs.symbol`,
    importer,
  );

  const indexedResults = rows
    .filter((row) => !db.isIgnored(row.importer))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      importedIn: r.imported_in,
    }));

  if (indexedResults.length > 0) {
    return indexedResults;
  }

  return getSourceImports(db, importer)
    .filter((entry) => entry.kind !== 'side-effect' && !entry.used)
    .map((entry) => ({
      symbol: renderImportSymbol(entry.importedName, entry.localName, entry.kind),
      shortName: renderImportSymbol(entry.importedName, entry.localName, entry.kind),
      importedIn: importer,
    }));
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

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isCLikeImporter(relativePath: string): boolean {
  return /\.(?:c|h|cc|cpp|cxx|hpp|hh|hxx)$/i.test(relativePath);
}
