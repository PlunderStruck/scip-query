import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../internal/project-index.js';
import { getReExports, getSourceExports, getSourceImports } from '../../language-parsers/index.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { isPackageSurfaceFile } from '../../analysis/package-surface.js';

export type RedundantReexportActionTier = 'direct' | 'signal';

export interface RedundantReexport {
  barrelFile: string;
  symbol: string;
  shortName: string;
  originalFile: string;
  /** Number of observed source files importing or re-exporting the barrel */
  barrelConsumers: number;
  /** Number of observed source files importing or re-exporting the original file */
  directConsumers: number;
  actionTier: RedundantReexportActionTier;
  surfaceEvidence: string[];
  recommendation: string;
}

/** Re-export declarations with no observed incoming source import or re-export.
 * This is a local cleanup candidate, not proof that an external API is unused.
 */
export function redundantReexports(
  db: ScipDatabase,
  opts: { scope?: string; limit?: number } = {},
): RedundantReexport[] {
  const { scope, limit } = opts;
  const index = new ProjectIndex(db);
  const results = dedupeReexports(findSourceRedundantReexports(db, index, scope));
  sortReexports(results);

  return limit ? results.slice(0, limit) : results;
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
    actionTier: 'signal',
    surfaceEvidence: [],
    recommendation:
      'Review this re-export: no local source importer or re-exporter was resolved. Confirm external consumers and module initialization effects before removal.',
  };
}

type DirectImportersByTarget = ReadonlyMap<string, ReadonlySet<string>>;

function directImportersByTarget(db: ScipDatabase): DirectImportersByTarget {
  const importersByTarget = new Map<string, Set<string>>();
  for (const relativePath of indexedDocumentPaths(db, { includeIgnored: false })) {
    for (const imported of [
      ...getSourceImports(db, relativePath),
      ...getSourceExports(db, relativePath),
      ...getReExports(db, relativePath),
    ]) {
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
