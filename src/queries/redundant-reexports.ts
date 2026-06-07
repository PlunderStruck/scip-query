import type { ScipDatabase } from '../storage/db.js';
import { ProjectIndex } from '../core/project-index.js';
import { isLiveBarrel } from '../analysis/file-classifier.js';
import { getSourceExports, getSourceImports } from '../language-parsers/index.js';
import type { IndexedDefinition } from '../domain/types.js';
import { leafSuffix, shortenSymbol } from '../symbols/symbol-parser.js';
import { indexedDocumentPaths } from '../storage/scip-documents.js';

export interface RedundantReexport {
  barrelFile: string;
  symbol: string;
  shortName: string;
  originalFile: string;
  /** How many consumers import through the barrel */
  barrelConsumers: number;
  /** How many consumers import directly from the source */
  directConsumers: number;
}

interface ScipReexportRow {
  barrel_doc_id: number;
  barrel_path: string;
  symbol_id: number;
  symbol: string;
  original_doc_id: number;
  original_path: string;
}

interface ReexportConsumerCounts {
  barrel_consumers: number;
  direct_consumers: number;
}

/**
 * Find barrel re-exports that no consumer actually imports through.
 *
 * If `queries/index.ts` re-exports `byKind` from `by-kind.ts`, but every
 * consumer of `byKind` imports it directly from `by-kind.ts` (not through
 * `index.ts`), the re-export in the barrel is dead weight.
 *
 * Algorithm:
 * 1. Find all barrel files (index.ts / index.js)
 * 2. For each barrel, find symbols it re-exports (defined elsewhere, referenced in barrel with role=0)
 * 3. For each re-exported symbol, count consumers through the barrel vs direct from the source
 * 4. If zero consumers go through the barrel, the re-export is redundant
 */
export function redundantReexports(
  db: ScipDatabase,
  opts: { scope?: string; limit?: number } = {},
): RedundantReexport[] {
  const { scope, limit } = opts;
  const index = new ProjectIndex(db);
  const withDartFallback = dedupeReexports([
    ...findScipRedundantReexports(db, scope),
    ...findSourceRedundantReexports(db, index, scope),
  ]);
  sortReexports(withDartFallback);

  return limit ? withDartFallback.slice(0, limit) : withDartFallback;
}

// scip-query: ignore-extract — this is the SCIP-backed redundant re-export
// decision: barrel/source rows, live-barrel guard, and conservative consumer
// counts must be evaluated together.
function findScipRedundantReexports(
  db: ScipDatabase,
  scope?: string,
): RedundantReexport[] {
  const results: RedundantReexport[] = [];
  for (const row of loadScipReexportRows(db, scope)) {
    if (db.isIgnored(row.barrel_path) || db.isIgnored(row.original_path)) continue;
    if (isLiveBarrel(db, row.barrel_path)) continue;

    const consumerCounts = countReexportConsumers(db, row);
    const barrelConsumers = consumerCounts?.barrel_consumers ?? 0;
    const directConsumers = consumerCounts?.direct_consumers ?? 0;

    // In TypeScript, `import * as X from './barrel'` resolves all references
    // directly to the source file — the barrel is transparent to SCIP.
    // This means barrelConsumers is always 0 for namespace imports.
    //
    // We can only confidently report symbols with 0 consumers EVERYWHERE
    // (both barrel and direct). These are truly dead re-exports.
    //
    // Symbols with directConsumers > 0 but barrelConsumers === 0 might still be
    // consumed through a namespace import — we can't tell, so we skip them.
    if (barrelConsumers !== 0 || directConsumers !== 0) continue;

    results.push({
      barrelFile: row.barrel_path,
      symbol: row.symbol,
      shortName: shortenSymbol(row.symbol),
      originalFile: row.original_path,
      barrelConsumers,
      directConsumers,
    });
  }
  return results;
}

function loadScipReexportRows(
  db: ScipDatabase,
  scope?: string,
): ScipReexportRow[] {
  const scopeFilter = scope ? `AND barrel_d.relative_path LIKE '%${scope}%'` : '';

  // Step 1 + 2: Find all barrel files and symbols they re-export.
  // A re-export is a symbol that:
  //   - is mentioned in a barrel file with role=0 (reference/import)
  //   - has its definition (defn_enclosing_ranges) in a DIFFERENT file
  return db.all<ScipReexportRow>(
    `SELECT DISTINCT
      barrel_d.id AS barrel_doc_id,
      barrel_d.relative_path AS barrel_path,
      gs.id AS symbol_id,
      gs.symbol AS symbol,
      orig_d.id AS original_doc_id,
      orig_d.relative_path AS original_path
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents barrel_d ON c.document_id = barrel_d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents orig_d ON sym_def.document_id = orig_d.id
    WHERE m.role != 1
      AND (barrel_d.relative_path LIKE '%/index.ts'
        OR barrel_d.relative_path LIKE '%/index.js'
        OR barrel_d.relative_path = 'index.ts'
        OR barrel_d.relative_path = 'index.js')
      AND orig_d.id != barrel_d.id
      ${db.pathExclusionsFor('barrel_d', 'orig_d')}
      ${db.symbolNoiseFor('gs')}
      -- Only function-level symbols (ending with ().), not module-level
      AND gs.symbol LIKE '%().'
      ${scopeFilter}
    ORDER BY barrel_d.relative_path, gs.symbol`,
  );
}

function countReexportConsumers(
  db: ScipDatabase,
  row: ScipReexportRow,
): ReexportConsumerCounts | undefined {
  // A consumer "goes through the barrel" if it has any role=0 mention pointing
  // to a symbol that appears in the barrel file. SCIP does not preserve the
  // literal import path for transparent re-exports, so this is conservative.
  return db.get<ReexportConsumerCounts>(
    `SELECT
      SUM(CASE WHEN uses_barrel = 1 THEN 1 ELSE 0 END) AS barrel_consumers,
      SUM(CASE WHEN uses_barrel = 0 THEN 1 ELSE 0 END) AS direct_consumers
    FROM (
      SELECT
        consumer_d.id AS consumer_doc_id,
        MAX(CASE WHEN EXISTS (
          SELECT 1
          FROM mentions barrel_m
          JOIN chunks barrel_c ON barrel_m.chunk_id = barrel_c.id
          WHERE barrel_c.document_id = consumer_d.id
            AND barrel_m.role != 1
            AND barrel_m.symbol_id IN (
              SELECT m2.symbol_id
              FROM mentions m2
              JOIN chunks c2 ON m2.chunk_id = c2.id
              WHERE c2.document_id = ?
                AND m2.role != 1
            )
        ) THEN 1 ELSE 0 END) AS uses_barrel
      FROM mentions ref_m
      JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
      JOIN documents consumer_d ON ref_c.document_id = consumer_d.id
      WHERE ref_m.symbol_id = ?
        AND ref_m.role != 1
        AND consumer_d.id != ?
        AND consumer_d.id != ?
        ${db.pathExclusionsFor('consumer_d')}
      GROUP BY consumer_d.id
    )`,
    row.barrel_doc_id,
    row.symbol_id,
    row.barrel_doc_id,
    row.original_doc_id,
  );
}

function findSourceRedundantReexports(
  db: ScipDatabase,
  index: ProjectIndex,
  scope?: string,
): RedundantReexport[] {
  const results: RedundantReexport[] = [];
  for (const barrelPath of sourceBarrelCandidates(db, scope)) {
    const barrelConsumers = countDirectImporters(db, barrelPath, barrelPath);
    if (barrelConsumers > 0) continue;
    results.push(...sourceRedundantReexportsForBarrel(db, index, barrelPath));
  }
  return results;
}

function sourceBarrelCandidates(db: ScipDatabase, scope?: string): string[] {
  return indexedDocumentPaths(db, { scope, includeIgnored: false })
    .filter((relativePath) => getSourceExports(db, relativePath).length > 0);
}

function sourceRedundantReexportsForBarrel(
  db: ScipDatabase,
  index: ProjectIndex,
  barrelPath: string,
): RedundantReexport[] {
  return getSourceExports(db, barrelPath)
    .filter((entry) => entry.sourcePath && !db.isIgnored(entry.sourcePath))
    .flatMap((entry) => sourceRedundantReexportForExport(db, index, barrelPath, entry.sourcePath!));
}

function sourceRedundantReexportForExport(
  db: ScipDatabase,
  index: ProjectIndex,
  barrelPath: string,
  sourcePath: string,
): RedundantReexport[] {
  const representative = representativeExportSymbol(index, sourcePath);
  if (!representative) return [];
  return [{
    barrelFile: barrelPath,
    symbol: representative.symbol,
    shortName: shortenSymbol(representative.symbol),
    originalFile: sourcePath,
    barrelConsumers: 0,
    directConsumers: countDirectImporters(db, sourcePath, barrelPath),
  }];
}

function countDirectImporters(
  db: ScipDatabase,
  targetPath: string,
  excludedPath: string,
): number {
  const importers = new Set<string>();
  for (const relativePath of indexedDocumentPaths(db, { includeIgnored: false })) {
    if (relativePath === excludedPath) continue;
    for (const imported of getSourceImports(db, relativePath)) {
      if (imported.sourcePath === targetPath) {
        importers.add(relativePath);
      }
    }
  }

  return importers.size;
}

function representativeExportSymbol(
  index: ProjectIndex,
  sourcePath: string,
): IndexedDefinition | null {
  const definitions = index.definitionsForFile(sourcePath);
  return definitions.find((definition) => leafSuffix(definition.symbol) === 'method')
    ?? definitions[0]
    ?? null;
}

function dedupeReexports(
  rows: RedundantReexport[],
): RedundantReexport[] {
  const seen = new Set<string>();
  const unique: RedundantReexport[] = [];
  for (const row of rows) {
    const key = `${row.barrelFile}|${row.symbol}|${row.originalFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function sortReexports(results: RedundantReexport[]): void {
  results.sort((a, b) =>
    b.directConsumers - a.directConsumers
    || a.barrelFile.localeCompare(b.barrelFile)
    || a.shortName.localeCompare(b.shortName),
  );
}
