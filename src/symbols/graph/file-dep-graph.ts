import type { ScipDatabase } from '../../storage/db.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';

// Keyed by scope (not path) — only whole-project clears apply; mixes SCIP
// edges with source-import evidence, so it must drop when sources change.
const FILE_DEP_GRAPH_CACHE = createPerDbCache<string, Map<string, Set<string>>>('file-dep-graph', {
  clearGroups: ['whole-project'],
});

// scip-query: ignore-extract — this builds the file dependency graph from
// SCIP edges plus source-import fallback edges; the two sources intentionally
// share one normalization path.
export function buildFileDepGraph(db: ScipDatabase, scope?: string): Map<string, Set<string>> {
  return FILE_DEP_GRAPH_CACHE.get(db, scope ?? '', () => {
    const graph = new Map<string, Set<string>>();
    const indexedFiles = new Set(indexedDocumentPaths(db, { includeIgnored: false }));
    const addEdge = (fromFile: string, toFile: string): void =>
      addFileDepEdge(db, graph, indexedFiles, fromFile, toFile);

    for (const edge of scipFileDepEdges(db, scope)) {
      addEdge(edge.from_file, edge.to_file);
    }

    for (const relativePath of indexedFiles) {
      if (scope && !relativePath.includes(scope)) continue;
      for (const entry of getSourceImports(db, relativePath)) {
        if (!entry.sourcePath) continue;
        addEdge(relativePath, entry.sourcePath);
      }
    }

    return graph;
  });
}

function scipFileDepEdges(db: ScipDatabase, scope?: string): Array<{ from_file: string; to_file: string }> {
  const scopeFilter = scope ? `AND d1.relative_path LIKE '%${scope}%'` : '';
  return db.all<{ from_file: string; to_file: string }>(
    `SELECT DISTINCT
      d1.relative_path AS from_file,
      d2.relative_path AS to_file
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents d2 ON sym_def.document_id = d2.id
    WHERE d1.id != d2.id
      AND m.role != 1
      ${db.pathExclusionsFor('d1', 'd2')}
      ${scopeFilter}`,
  );
}

function addFileDepEdge(
  db: ScipDatabase,
  graph: Map<string, Set<string>>,
  indexedFiles: ReadonlySet<string>,
  fromFile: string,
  toFile: string,
): void {
  if (fromFile === toFile) return;
  if (db.isIgnored(fromFile) || db.isIgnored(toFile)) return;
  if (!indexedFiles.has(toFile)) return;
  let bucket = graph.get(fromFile);
  if (!bucket) {
    bucket = new Set();
    graph.set(fromFile, bucket);
  }
  bucket.add(toFile);
}
