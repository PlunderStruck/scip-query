import type { ScipDatabase } from '../../storage/db.js';
import { TARGET_COUPLING_SQL } from '../internal/target-coupling.js';
import { resolveIndexedFile } from '../internal/file-resolution.js';

export interface CouplingResult {
  file1: string;
  file2: string;
  sharedSymbols: number;
  actionTier: 'signal';
  couplingKind: 'shared-symbol-coupling';
  evidenceReasons: string[];
  recommendation: string;
}

/**
 * Measure coupling between two files: how many symbols do they share
 * (symbols defined in one and referenced in the other, or vice versa).
 */
export function coupling(db: ScipDatabase, file1: string, file2: string): CouplingResult {
  const resolvedFile1 = resolveIndexedFile(db, file1) ?? file1;
  const resolvedFile2 = resolveIndexedFile(db, file2) ?? file2;

  const row = db.get<{ shared: number }>(
    TARGET_COUPLING_SQL,
    resolvedFile1,
    resolvedFile2,
    resolvedFile2,
    resolvedFile1,
  );

  return {
    ...couplingResult(resolvedFile1, resolvedFile2, row?.shared ?? 0),
  };
}

/**
 * Find the most coupled file pairs in the codebase.
 */
// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
export function topCoupling(db: ScipDatabase, opts: { limit?: number; scope?: string } = {}): CouplingResult[] {
  const { limit = 20, scope } = opts;
  const scopeFilter = scope ? `AND def_d.relative_path LIKE ? AND ref_d.relative_path LIKE ?` : '';
  const scopeParams = scope ? [`%${scope}%`, `%${scope}%`] : [];

  // Find file pairs that share the most symbols (one defines, other references)
  const rows = db.all<{
    file1: string;
    file2: string;
    shared: number;
  }>(
    `SELECT
      def_d.relative_path AS file1,
      ref_d.relative_path AS file2,
      COUNT(DISTINCT gs.id) AS shared
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents ref_d ON c.document_id = ref_d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents def_d ON sym_def.document_id = def_d.id
    WHERE m.role != 1
      AND def_d.id != ref_d.id
      ${db.pathExclusionsFor('def_d', 'ref_d')}
      ${scopeFilter}
    GROUP BY def_d.id, ref_d.id
    ORDER BY shared DESC
    LIMIT ?`,
    ...scopeParams,
    limit,
  );

  return rows
    .filter((r) => !db.isIgnored(r.file1) && !db.isIgnored(r.file2))
    .map((r) => couplingResult(r.file1, r.file2, r.shared));
}

function couplingResult(file1: string, file2: string, sharedSymbols: number): CouplingResult {
  return {
    file1,
    file2,
    sharedSymbols,
    actionTier: 'signal',
    couplingKind: 'shared-symbol-coupling',
    evidenceReasons: [`${sharedSymbols} symbol(s) are defined in one file and referenced by the other`],
    recommendation:
      'Review whether the shared symbol surface is an intentional boundary or hidden coordination pressure before moving code.',
  };
}
