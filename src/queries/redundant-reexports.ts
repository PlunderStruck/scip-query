import type { ScipDatabase } from '../db.js';
import { isLiveBarrel } from '../entry-surfaces.js';
import { getDefinitionsForFile } from '../query-support.js';
import { getSourceExports, getSourceImports } from '../source-analysis.js';
import type { RedundantReexport } from '../types.js';
import { leafSuffix, shortenSymbol } from '../symbol-parser.js';

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

  const scopeFilter = scope ? `AND barrel_d.relative_path LIKE '%${scope}%'` : '';

  // Step 1 + 2: Find all barrel files and symbols they re-export.
  // A re-export is a symbol that:
  //   - is mentioned in a barrel file with role=0 (reference/import)
  //   - has its definition (defn_enclosing_ranges) in a DIFFERENT file
  const reexportRows = db.all<{
    barrel_doc_id: number;
    barrel_path: string;
    symbol_id: number;
    symbol: string;
    original_doc_id: number;
    original_path: string;
  }>(
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

  const results: RedundantReexport[] = [];

    for (const row of reexportRows) {
      if (db.isIgnored(row.barrel_path) || db.isIgnored(row.original_path)) continue;
      if (isLiveBarrel(db, row.barrel_path)) continue;

      // Step 3: Count consumers that reference this symbol through the barrel
    // A "barrel consumer" is a file (other than the barrel itself and the original file)
    // that mentions this symbol AND also mentions something from the barrel document.
    // More precisely: count distinct files that reference this symbol AND whose
    // chunk is in a document that also has a role=0 mention pointing to the barrel file's symbols.
    //
    // Simpler approach: count distinct documents that reference this symbol (role=0)
    // grouped by whether the reference chunk is in a file that imports from the barrel
    // or from the original.
    //
    // Actually, the most reliable approach with SCIP data: count how many distinct
    // consumer documents reference this symbol_id with role=0, excluding the barrel
    // and the original file themselves. Then check if those consumers also reference
    // ANY symbol through a mention in the barrel doc vs the original doc.
    //
    // Simplest correct approach: In SCIP, when file A does `import { foo } from './bar/index'`,
    // the mention of `foo` in file A points to the same global symbol regardless of import path.
    // SCIP doesn't track import provenance. BUT the barrel file itself contains mentions
    // (role=0 references) of the re-exported symbols. So we can check:
    // - barrelConsumers: files that mention both this symbol AND any symbol whose definition
    //   is in the barrel (i.e., they import the barrel)
    // - directConsumers: files that mention this symbol but don't import the barrel
    //
    // Even simpler: check if the barrel document is in the deps of the consumer.
    // A consumer "goes through the barrel" if it has ANY role=0 mention pointing to a
    // chunk in the barrel file. Otherwise it goes direct.

    const consumerCounts = db.get<{
      barrel_consumers: number;
      direct_consumers: number;
    }>(
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
      row.barrel_doc_id,  // for the inner subquery checking barrel mentions
      row.symbol_id,      // the re-exported symbol
      row.barrel_doc_id,  // exclude the barrel itself
      row.original_doc_id, // exclude the original file
    );

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
      if (barrelConsumers === 0 && directConsumers === 0) {
        results.push({
        barrelFile: row.barrel_path,
        symbol: row.symbol,
        shortName: shortenSymbol(row.symbol),
        originalFile: row.original_path,
        barrelConsumers,
        directConsumers,
      });
    }
  }

  // Sort: symbols with the most direct consumers first (biggest cleanup wins),
  // then by barrel file path for stable output
  results.sort((a, b) =>
    b.directConsumers - a.directConsumers
    || a.barrelFile.localeCompare(b.barrelFile)
    || a.shortName.localeCompare(b.shortName),
  );

  const withDartFallback = dedupeReexports([
    ...results,
    ...findSourceRedundantReexports(db, scope),
  ]);
  withDartFallback.sort((a, b) =>
    b.directConsumers - a.directConsumers
    || a.barrelFile.localeCompare(b.barrelFile)
    || a.shortName.localeCompare(b.shortName),
  );

  return limit ? withDartFallback.slice(0, limit) : withDartFallback;
}

function findSourceRedundantReexports(
  db: ScipDatabase,
  scope?: string,
): RedundantReexport[] {
  const files = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${scope ? 'AND relative_path LIKE ?' : ''}
       ${db.pathExclusionsFor('documents')}
     ORDER BY relative_path`,
    ...(scope ? [`%${scope}%`] : []),
  );

  const candidates = files
    .map((row) => row.relative_path)
    .filter((relativePath) => !db.isIgnored(relativePath))
    .filter((relativePath) => getSourceExports(db, relativePath).length > 0);

  const results: RedundantReexport[] = [];

  for (const barrelPath of candidates) {
    const exports = getSourceExports(db, barrelPath).filter((entry) => entry.sourcePath && !db.isIgnored(entry.sourcePath));
    if (exports.length === 0) continue;

    const barrelConsumers = countDirectImporters(db, barrelPath, barrelPath);
    if (barrelConsumers > 0) continue;

    for (const exported of exports) {
      const sourcePath = exported.sourcePath!;
      const representative = representativeExportSymbol(db, sourcePath);
      if (!representative) continue;

      results.push({
        barrelFile: barrelPath,
        symbol: representative.symbol,
        shortName: shortenSymbol(representative.symbol),
        originalFile: sourcePath,
        barrelConsumers: 0,
        directConsumers: countDirectImporters(db, sourcePath, barrelPath),
      });
    }
  }

  return results;
}

function countDirectImporters(
  db: ScipDatabase,
  targetPath: string,
  excludedPath: string,
): number {
  const files = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
     ORDER BY relative_path`,
  );

  const importers = new Set<string>();
  for (const row of files) {
    if (db.isIgnored(row.relative_path) || row.relative_path === excludedPath) continue;
    for (const imported of getSourceImports(db, row.relative_path)) {
      if (imported.sourcePath === targetPath) {
        importers.add(row.relative_path);
      }
    }
  }

  return importers.size;
}

function representativeExportSymbol(
  db: ScipDatabase,
  sourcePath: string,
): ReturnType<typeof getDefinitionsForFile>[number] | null {
  const definitions = getDefinitionsForFile(db, sourcePath);
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
