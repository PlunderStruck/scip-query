import type { ScipDatabase } from '../../storage/db.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { projectEvidenceFingerprint, sha256Hex } from '../../storage/evidence-cache.js';
import { createProjectEvidenceProduct } from '../../storage/evidence-products.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { profileSpan } from '../../instrumentation/profile.js';

interface FileDependencyGraphPayload {
  sourceImportFingerprint: string;
  sourceFileCount: number;
  sourceEdgeCount: number;
  scipEdgeCount: number;
  graph: Array<[string, string[]]>;
}

interface SourceImportEdge {
  fromFile: string;
  toFile: string;
}

interface SourceImportEdgeSet {
  files: string[];
  edges: SourceImportEdge[];
  fingerprint: string;
}

const FILE_DEPENDENCY_GRAPH_PRODUCT = createProjectEvidenceProduct<FileDependencyGraphPayload>({
  kind: 'file-dependency-graph',
  serialize: (value) => JSON.stringify(value),
  deserialize: deserializeFileDependencyGraphPayload,
});

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
    const indexedFiles = new Set(indexedDocumentPaths(db, { includeIgnored: false }));
    let sourceFileCount = 0;
    let sourceEdgeCount = 0;
    const sourceImports = profileSpan(
      'file-dep-graph.source-imports',
      () => {
        const collected = collectSourceImportEdges(db, indexedFiles, scope);
        sourceFileCount = collected.files.length;
        sourceEdgeCount = collected.edges.length;
        return collected;
      },
      () => ({ scope: scope ?? null, files: sourceFileCount, edges: sourceEdgeCount }),
    );

    const projectFingerprint = projectEvidenceFingerprint(db);
    const graphFingerprint = projectFingerprint
      ? fileDependencyGraphFingerprint(projectFingerprint, sourceImports.fingerprint)
      : null;
    let hit = false;
    let scipEdgeCount = 0;
    let graphFileCount = 0;

    return profileSpan(
      'file-dep-graph.product',
      () => {
        const cacheKey = fileDependencyGraphCacheKey(scope);
        if (graphFingerprint) {
          const cached = FILE_DEPENDENCY_GRAPH_PRODUCT.read(db, cacheKey, graphFingerprint);
          if (cached?.sourceImportFingerprint === sourceImports.fingerprint) {
            hit = true;
            const graph = graphFromPayload(cached);
            graphFileCount = graph.size;
            return graph;
          }
        }

        const graph = new Map<string, Set<string>>();
        const addEdge = (fromFile: string, toFile: string): void =>
          addFileDepEdge(db, graph, indexedFiles, fromFile, toFile);

        profileSpan(
          'file-dep-graph.scip-edges',
          () => {
            for (const edge of scipFileDepEdges(db, scope)) {
              scipEdgeCount += 1;
              addEdge(edge.from_file, edge.to_file);
            }
          },
          () => ({ scope: scope ?? null, edges: scipEdgeCount }),
        );

        for (const edge of sourceImports.edges) addEdge(edge.fromFile, edge.toFile);
        graphFileCount = graph.size;

        if (graphFingerprint) {
          FILE_DEPENDENCY_GRAPH_PRODUCT.write(db, cacheKey, graphFingerprint, {
            sourceImportFingerprint: sourceImports.fingerprint,
            sourceFileCount: sourceImports.files.length,
            sourceEdgeCount: sourceImports.edges.length,
            scipEdgeCount,
            graph: graphPayloadFromGraph(graph),
          });
        }

        return graph;
      },
      () => ({
        scope: scope ?? null,
        available: graphFingerprint !== null,
        hit,
        files: sourceImports.files.length,
        sourceEdges: sourceImports.edges.length,
        scipEdges: scipEdgeCount,
        graphFiles: graphFileCount,
        sourceImportFingerprint: sourceImports.fingerprint,
      }),
    );
  });
}

function collectSourceImportEdges(
  db: ScipDatabase,
  indexedFiles: ReadonlySet<string>,
  scope: string | undefined,
): SourceImportEdgeSet {
  const files: string[] = [];
  const edges: SourceImportEdge[] = [];
  for (const relativePath of indexedFiles) {
    if (scope && !relativePath.includes(scope)) continue;
    files.push(relativePath);
    for (const entry of getSourceImports(db, relativePath)) {
      if (!entry.sourcePath) continue;
      edges.push({ fromFile: relativePath, toFile: entry.sourcePath });
    }
  }

  return {
    files,
    edges,
    fingerprint: sourceImportFingerprint(files, edges),
  };
}

function sourceImportFingerprint(files: readonly string[], edges: readonly SourceImportEdge[]): string {
  const sortedEdges = edges.map((edge) => `${edge.fromFile}\0${edge.toFile}`).sort();
  return sha256Hex(JSON.stringify({ files, edges: sortedEdges }));
}

function fileDependencyGraphCacheKey(scope: string | undefined): string {
  return scope ?? '<all>';
}

function fileDependencyGraphFingerprint(projectFingerprint: string, sourceImportFingerprint: string): string {
  return sha256Hex(JSON.stringify({ projectFingerprint, sourceImportFingerprint }));
}

function graphPayloadFromGraph(graph: Map<string, Set<string>>): Array<[string, string[]]> {
  return [...graph].map(([file, deps]) => [file, [...deps]]);
}

function graphFromPayload(payload: FileDependencyGraphPayload): Map<string, Set<string>> {
  return new Map(payload.graph.map(([file, deps]) => [file, new Set(deps)]));
}

function deserializeFileDependencyGraphPayload(payload: string): FileDependencyGraphPayload | null {
  const raw = JSON.parse(payload) as unknown;
  if (!isFileDependencyGraphPayload(raw)) return null;
  return raw;
}

function isFileDependencyGraphPayload(value: unknown): value is FileDependencyGraphPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FileDependencyGraphPayload>;
  return (
    typeof candidate.sourceImportFingerprint === 'string' &&
    typeof candidate.sourceFileCount === 'number' &&
    typeof candidate.sourceEdgeCount === 'number' &&
    typeof candidate.scipEdgeCount === 'number' &&
    Array.isArray(candidate.graph) &&
    candidate.graph.every(isGraphPayloadEntry)
  );
}

function isGraphPayloadEntry(value: unknown): value is [string, string[]] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    Array.isArray(value[1]) &&
    value[1].every((dep) => typeof dep === 'string')
  );
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
