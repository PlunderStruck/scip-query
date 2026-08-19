import type { ScipDatabase } from '../../storage/db.js';
import { fileDependencyPaths } from '../../symbols/graph/file-dep-graph.js';
import { resolveIndexedFile } from '../internal/file-resolution.js';

export interface DepResult {
  relativePath: string;
  edgeBasis?: 'symbol-references';
  evidence?: 'cross-file SCIP references plus resolved source imports';
}

/** What internal files does this file depend on? (forward dependencies) */
export function deps(db: ScipDatabase, filePattern: string): DepResult[] {
  const resolvedFile = resolveIndexedFile(db, filePattern);
  if (!resolvedFile) {
    return [];
  }

  const rows = fileDependencyPaths(db, 'forward', [resolvedFile]);

  return rows
    .filter((relativePath) => !db.isIgnored(relativePath))
    .map((relativePath) => ({
      relativePath,
      edgeBasis: 'symbol-references' as const,
      evidence: 'cross-file SCIP references plus resolved source imports' as const,
    }));
}

/** What files depend on this file/module? (reverse dependencies) */
export function rdeps(db: ScipDatabase, filePattern: string): DepResult[] {
  const resolvedFile = resolveIndexedFile(db, filePattern);
  if (!resolvedFile) {
    return [];
  }

  const rows = fileDependencyPaths(db, 'reverse', [resolvedFile]);

  return rows
    .filter((relativePath) => !db.isIgnored(relativePath))
    .map((relativePath) => ({
      relativePath,
      edgeBasis: 'symbol-references' as const,
      evidence: 'cross-file SCIP references plus resolved source imports' as const,
    }));
}
