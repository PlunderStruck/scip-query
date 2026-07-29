import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../internal/project-index.js';
import { isLiveBarrel } from '../../analysis/file-classifier.js';
import { getReExports, getSourceExports, getSourceImports } from '../../language-parsers/index.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { isPackageSurfaceFile } from '../../analysis/package-surface.js';

export type RedundantReexportActionTier = 'direct' | 'signal';

export interface RedundantReexport {
  barrelFile: string;
  symbol: string;
  shortName: string;
  originalFile: string;
  /** How many consumers import through the barrel */
  barrelConsumers: number;
  /** How many consumers import directly from the source */
  directConsumers: number;
  actionTier: RedundantReexportActionTier;
  surfaceEvidence: string[];
  recommendation: string;
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
function findScipRedundantReexports(db: ScipDatabase, scope?: string): RedundantReexport[] {
  const results: RedundantReexport[] = [];
  for (const row of loadScipReexportRows(db, scope)) {
    if (db.isIgnored(row.barrel_path) || db.isIgnored(row.original_path)) continue;
    if (isLiveBarrel(db, row.barrel_path)) continue;
    if (getSourceText(db, row.barrel_path) && getSourceExports(db, row.barrel_path).length === 0) continue;

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
      ...redundantReexportCaveat(db, row.barrel_path),
    });
  }
  return results;
}

function loadScipReexportRows(db: ScipDatabase, scope?: string): ScipReexportRow[] {
  const scopeFilter = scope ? `AND barrel_d.relative_path LIKE ?` : '';
  const scopeParams = scope ? [`%${scope}%`] : [];

  // Step 1 + 2: Find all barrel files and symbols they re-export.
  // A re-export is a symbol that:
  //   - is mentioned in a barrel file with role=0 (reference/import)
  //   - has its definition (defn_enclosing_ranges) in a DIFFERENT file
  return db.all<ScipReexportRow>(
    `WITH barrel_refs AS MATERIALIZED (
      SELECT DISTINCT
        barrel_d.id AS barrel_doc_id,
        barrel_d.relative_path AS barrel_path,
        m.symbol_id
      FROM documents barrel_d
      JOIN chunks c ON c.document_id = barrel_d.id
      JOIN mentions m ON m.chunk_id = c.id
      WHERE m.role != 1
        AND (barrel_d.relative_path LIKE '%/index.ts'
          OR barrel_d.relative_path LIKE '%/index.js'
          OR barrel_d.relative_path = 'index.ts'
          OR barrel_d.relative_path = 'index.js')
        ${db.pathExclusionsFor('barrel_d')}
        ${scopeFilter}
    ),
    sym_def AS MATERIALIZED (
      SELECT m2.symbol_id, c2.document_id
      FROM barrel_refs br
      -- Keep the bounded barrel-symbol set on the outer side. An ordinary
      -- JOIN lets SQLite scan every definition mention before applying the
      -- barrel-symbol bloom filter on large indexes.
      CROSS JOIN mentions m2 ON m2.symbol_id = br.symbol_id
        AND m2.role = 1
      JOIN chunks c2 ON m2.chunk_id = c2.id
      GROUP BY m2.symbol_id
    )
    SELECT DISTINCT
      br.barrel_doc_id,
      br.barrel_path,
      gs.id AS symbol_id,
      gs.symbol AS symbol,
      orig_d.id AS original_doc_id,
      orig_d.relative_path AS original_path
    FROM barrel_refs br
    JOIN global_symbols gs ON br.symbol_id = gs.id
    JOIN sym_def ON sym_def.symbol_id = gs.id
    JOIN documents orig_d ON sym_def.document_id = orig_d.id
    WHERE orig_d.id != br.barrel_doc_id
      ${db.pathExclusionsFor('orig_d')}
      ${db.symbolNoiseFor('gs')}
      -- Only function-level symbols (ending with ().), not module-level
      AND gs.symbol LIKE '%().'
    ORDER BY br.barrel_path, gs.symbol`,
    ...scopeParams,
  );
}

function countReexportConsumers(db: ScipDatabase, row: ScipReexportRow): ReexportConsumerCounts | undefined {
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

function findSourceRedundantReexports(db: ScipDatabase, index: ProjectIndex, scope?: string): RedundantReexport[] {
  const results: RedundantReexport[] = [];
  const importersByTarget = directImportersByTarget(db);
  for (const barrelPath of sourceBarrelCandidates(db, scope)) {
    const barrelConsumers = countDirectImporters(importersByTarget, barrelPath, barrelPath);
    if (barrelConsumers > 0) continue;
    results.push(...sourceRedundantReexportsForBarrel(db, index, barrelPath, importersByTarget));
  }
  return results;
}

function sourceBarrelCandidates(db: ScipDatabase, scope?: string): string[] {
  return indexedDocumentPaths(db, { scope, includeIgnored: false }).filter(
    (relativePath) => getSourceExports(db, relativePath).length > 0 || getReExports(db, relativePath).length > 0,
  );
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function sourceRedundantReexportsForBarrel(
  db: ScipDatabase,
  index: ProjectIndex,
  barrelPath: string,
  importersByTarget: DirectImportersByTarget,
): RedundantReexport[] {
  const sourceExportRows = getSourceExports(db, barrelPath)
    .filter((entry) => entry.sourcePath && !db.isIgnored(entry.sourcePath))
    .flatMap((entry) =>
      sourceRedundantReexportForExport(db, index, barrelPath, entry.sourcePath!, importersByTarget, [
        exportSpecifierName(entry.specifier),
      ]),
    );
  const reExportRows = getReExports(db, barrelPath)
    .filter((entry) => entry.sourcePath && !db.isIgnored(entry.sourcePath))
    .flatMap((entry) =>
      sourceRedundantReexportForExport(
        db,
        index,
        barrelPath,
        entry.sourcePath!,
        importersByTarget,
        entry.kind === 'named' && entry.names.length > 0
          ? entry.names
          : [entry.kind === 'star' ? `* from ${entry.sourcePath}` : `* namespace from ${entry.sourcePath}`],
      ),
    );
  return [...sourceExportRows, ...reExportRows];
}

function sourceRedundantReexportForExport(
  db: ScipDatabase,
  index: ProjectIndex,
  barrelPath: string,
  sourcePath: string,
  importersByTarget: DirectImportersByTarget,
  exportedNames: readonly string[],
): RedundantReexport[] {
  const definitions = index.definitionsForFile(sourcePath);
  return exportedNames.map((exportedName) => {
    const definition = definitions.find((candidate) => candidate.leaf === exportedName);
    return {
      barrelFile: barrelPath,
      symbol: definition?.symbol ?? `source-reexport:${barrelPath}:${exportedName}`,
      shortName: definition ? shortenSymbol(definition.symbol) : exportedName,
      originalFile: sourcePath,
      barrelConsumers: 0,
      directConsumers: countDirectImporters(importersByTarget, sourcePath, barrelPath),
      ...redundantReexportCaveat(db, barrelPath),
    };
  });
}

function exportSpecifierName(specifier: string): string {
  return (
    specifier
      .split('::')
      .at(-1)
      ?.split('/')
      .at(-1)
      ?.replace(/\.[^.]+$/, '') ?? specifier
  );
}

function redundantReexportCaveat(
  db: ScipDatabase,
  barrelFile: string,
): {
  actionTier: RedundantReexportActionTier;
  surfaceEvidence: string[];
  recommendation: string;
} {
  if (isPackageSurfaceFile(db, barrelFile)) {
    const surfaceEvidence = ['barrel file is declared on the package public surface'];
    return {
      actionTier: 'signal',
      surfaceEvidence,
      recommendation:
        'Review the package API before removing this re-export; local consumers are zero, but external consumers may import through the public barrel.',
    };
  }
  return {
    actionTier: 'direct',
    surfaceEvidence: [],
    recommendation: 'Remove this unused re-export when the barrel is not part of an external API surface.',
  };
}

type DirectImportersByTarget = ReadonlyMap<string, ReadonlySet<string>>;

function directImportersByTarget(db: ScipDatabase): DirectImportersByTarget {
  const importersByTarget = new Map<string, Set<string>>();
  for (const relativePath of indexedDocumentPaths(db, { includeIgnored: false })) {
    for (const imported of getSourceImports(db, relativePath)) {
      if (!imported.sourcePath) continue;
      const importers = importersByTarget.get(imported.sourcePath) ?? new Set<string>();
      importers.add(relativePath);
      importersByTarget.set(imported.sourcePath, importers);
    }
  }
  return importersByTarget;
}

function countDirectImporters(
  importersByTarget: DirectImportersByTarget,
  targetPath: string,
  excludedPath: string,
): number {
  const importers = importersByTarget.get(targetPath);
  if (!importers) return 0;
  return importers.size - (importers.has(excludedPath) ? 1 : 0);
}

function dedupeReexports(rows: RedundantReexport[]): RedundantReexport[] {
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
  results.sort(
    (a, b) =>
      b.directConsumers - a.directConsumers ||
      a.barrelFile.localeCompare(b.barrelFile) ||
      a.shortName.localeCompare(b.shortName),
  );
}
