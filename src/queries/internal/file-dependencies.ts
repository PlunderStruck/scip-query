import type { ScipDatabase } from '../../storage/db.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';

export type FileDependencyDirection = 'forward' | 'reverse';

/**
 * Returns compiler-resolved file relationships by entering through the exact
 * selected documents. Project-wide graph builders intentionally use their own
 * complete queries; this helper is only for target-bounded commands.
 */
export function fileDependencyPaths(
  db: ScipDatabase,
  direction: FileDependencyDirection,
  selectedPaths: readonly string[],
): string[] {
  if (selectedPaths.length === 0) return [];
  const selected = new Set(selectedPaths);
  const graph = buildFileDepGraph(db);
  const related = new Set<string>();

  if (direction === 'forward') {
    for (const path of selected) {
      for (const dependency of graph.get(path) ?? []) {
        if (!selected.has(dependency)) related.add(dependency);
      }
    }
  } else {
    for (const [source, dependencies] of graph) {
      if (selected.has(source)) continue;
      for (const target of selected) {
        if (dependencies.has(target)) related.add(source);
      }
    }
  }

  return [...related].sort();
}

/**
 * Legacy SQL projection retained for callers that inspect the raw SCIP
 * reference relation. Runtime dependency commands use `fileDependencyPaths`
 * so source-import fallback and graph analyses observe the same edge set.
 */
export function fileDependencySql(
  db: ScipDatabase,
  direction: FileDependencyDirection,
  selectedPathCount: number,
): string {
  if (!Number.isSafeInteger(selectedPathCount) || selectedPathCount <= 0) {
    throw new Error('file dependency SQL requires at least one selected path');
  }
  const selectedValues = Array.from({ length: selectedPathCount }, () => '(?)').join(', ');
  return direction === 'forward' ? forwardDependencySql(db, selectedValues) : reverseDependencySql(db, selectedValues);
}

function forwardDependencySql(db: ScipDatabase, selectedValues: string): string {
  return `WITH selected(relative_path) AS (VALUES ${selectedValues}),
    source_symbols(symbol_id) AS MATERIALIZED (
      SELECT DISTINCT source_m.symbol_id
      FROM selected
      JOIN documents source_d ON source_d.relative_path = selected.relative_path
      JOIN chunks source_c ON source_c.document_id = source_d.id
      JOIN mentions source_m ON source_m.chunk_id = source_c.id
      JOIN global_symbols gs ON gs.id = source_m.symbol_id
      WHERE ${db.localSymbolPredicate}
    )
    SELECT DISTINCT target_d.relative_path
    FROM source_symbols
    JOIN mentions definition_m ON definition_m.symbol_id = source_symbols.symbol_id
      AND definition_m.role = 1
    JOIN chunks definition_c ON definition_c.id = definition_m.chunk_id
    JOIN documents target_d ON target_d.id = definition_c.document_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM selected target_selected
      WHERE target_selected.relative_path = target_d.relative_path
    )
    ORDER BY target_d.relative_path`;
}

function reverseDependencySql(db: ScipDatabase, selectedValues: string): string {
  return `WITH selected(relative_path) AS (VALUES ${selectedValues}),
    target_symbols(symbol_id) AS MATERIALIZED (
      SELECT DISTINCT definition_m.symbol_id
      FROM selected
      JOIN documents target_d ON target_d.relative_path = selected.relative_path
      JOIN chunks definition_c ON definition_c.document_id = target_d.id
      JOIN mentions definition_m ON definition_m.chunk_id = definition_c.id
        AND definition_m.role = 1
    )
    SELECT DISTINCT source_d.relative_path
    FROM target_symbols
    JOIN mentions source_m ON source_m.symbol_id = target_symbols.symbol_id
    JOIN chunks source_c ON source_c.id = source_m.chunk_id
    JOIN documents source_d ON source_d.id = source_c.document_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM selected source_selected
      WHERE source_selected.relative_path = source_d.relative_path
    )
    ORDER BY source_d.relative_path`;
}
