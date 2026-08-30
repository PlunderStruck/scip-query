import type { ScipDatabase } from '../../storage/db.js';
import { getReExports, getSourceImports } from '../../language-parsers/index.js';
import { projectEvidenceFingerprint, sha256Hex } from '../../storage/evidence-cache.js';
import { createProjectEvidenceProduct, evidenceProductInvalidation } from '../../storage/evidence-products.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { profileSpan } from '../../instrumentation/profile.js';

interface FileDependencyGraphPayload {
  version: 2;
  construction: 'full' | 'carried';
  sourceDependencyFingerprint: string | null;
  sourceFileCount: number;
  sourceEdgeCount: number | null;
  scipEdgeCount: number | null;
  edgeCount: number;
  graph: Array<[string, string[]]>;
}

export interface FileDependencyGraphSnapshot {
  cacheKey: string;
  graph: Map<string, Set<string>>;
}

interface SourceDependencyEdge {
  fromFile: string;
  toFile: string;
}

interface SourceDependencyEdgeSet {
  files: string[];
  edges: SourceDependencyEdge[];
  fingerprint: string;
}

export type SourceDependencyEdgeMode = 'imports-only' | 'imports-and-reexports';
/** The public relation selected by file dependency analyses. */
export type FileDependencyEdgeBasis = 'symbol-references' | 'imports';
export type FileDependencyDirection = 'forward' | 'reverse';

const FILE_DEPENDENCY_GRAPH_PRODUCT = createProjectEvidenceProduct<FileDependencyGraphPayload>({
  kind: 'file-dependency-graph',
  invalidation: evidenceProductInvalidation('file-dependency-graph'),
  serialize: (value) => JSON.stringify(value),
  deserialize: deserializeFileDependencyGraphPayload,
});

// Keyed by scope (not path) — only whole-project clears apply; mixes SCIP
// edges with source-import evidence, so it must drop when sources change.
const FILE_DEP_GRAPH_CACHE = createPerDbCache<string, Map<string, Set<string>>>('file-dep-graph', {
  clearGroups: ['whole-project'],
});

/** Returns the files directly related to the selected paths in one graph direction. */
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

// scip-query: ignore-extract — this builds the file dependency graph from
// SCIP edges plus source-import fallback edges; the two sources intentionally
// share one normalization path.
export function buildFileDepGraph(
  db: ScipDatabase,
  scope?: string,
  opts: {
    scipEdges?: 'all-references' | 'imports-only';
    sourceEdges?: SourceDependencyEdgeMode;
  } = {},
): Map<string, Set<string>> {
  const scipEdges = opts.scipEdges ?? 'all-references';
  const sourceEdges = opts.sourceEdges ?? 'imports-only';
  const cacheKey = fileDependencyGraphCacheKey(scope, scipEdges, sourceEdges);
  return FILE_DEP_GRAPH_CACHE.get(db, cacheKey, () => {
    const indexedFiles = new Set(indexedDocumentPaths(db, { includeIgnored: false }));
    const projectFingerprint = projectEvidenceFingerprint(db);
    let sourceFileCount = 0;
    let sourceEdgeCount: number | null = 0;
    let sourceDependencyFingerprintValue: string | null = null;
    let hit = false;
    let scipEdgeCount: number | null = 0;
    let graphFileCount = 0;
    let construction: FileDependencyGraphPayload['construction'] | null = null;

    return profileSpan(
      'file-dep-graph.product',
      () => {
        if (projectFingerprint) {
          const cached = FILE_DEPENDENCY_GRAPH_PRODUCT.read(db, cacheKey, projectFingerprint);
          if (cached) {
            hit = true;
            construction = cached.construction;
            const graph = graphFromPayload(cached);
            sourceFileCount = cached.sourceFileCount;
            sourceEdgeCount = cached.sourceEdgeCount;
            scipEdgeCount = cached.scipEdgeCount;
            graphFileCount = graph.size;
            sourceDependencyFingerprintValue = cached.sourceDependencyFingerprint;
            return graph;
          }
        }

        const sourceDependencies = profileSpan(
          'file-dep-graph.source-imports',
          () => {
            const collected = collectSourceDependencyEdges(db, indexedFiles, scope, sourceEdges);
            sourceFileCount = collected.files.length;
            sourceEdgeCount = collected.edges.length;
            sourceDependencyFingerprintValue = collected.fingerprint;
            return collected;
          },
          () => ({ scope: scope ?? null, sourceEdges, files: sourceFileCount, edges: sourceEdgeCount }),
        );

        const graph = new Map<string, Set<string>>();
        const addEdge = (fromFile: string, toFile: string): void =>
          addFileDepEdge(db, graph, indexedFiles, fromFile, toFile);

        profileSpan(
          'file-dep-graph.scip-edges',
          () => {
            for (const edge of scipFileDepEdges(db, scope, scipEdges)) {
              scipEdgeCount = (scipEdgeCount ?? 0) + 1;
              addEdge(edge.from_file, edge.to_file);
            }
          },
          () => ({ scope: scope ?? null, edges: scipEdgeCount }),
        );

        for (const edge of sourceDependencies.edges) addEdge(edge.fromFile, edge.toFile);
        graphFileCount = graph.size;

        if (projectFingerprint) {
          construction = 'full';
          FILE_DEPENDENCY_GRAPH_PRODUCT.write(db, cacheKey, projectFingerprint, {
            version: 2,
            construction: 'full',
            sourceDependencyFingerprint: sourceDependencies.fingerprint,
            sourceFileCount: sourceDependencies.files.length,
            sourceEdgeCount: sourceDependencies.edges.length,
            scipEdgeCount,
            edgeCount: graphEdgeCount(graph),
            graph: graphPayloadFromGraph(graph),
          });
        }

        return graph;
      },
      () => ({
        scope: scope ?? null,
        available: projectFingerprint !== null,
        hit,
        construction,
        files: sourceFileCount,
        sourceEdges: sourceEdgeCount,
        sourceEdgeMode: sourceEdges,
        scipEdges: scipEdgeCount,
        graphFiles: graphFileCount,
        sourceDependencyFingerprint: sourceDependencyFingerprintValue,
      }),
    );
  });
}

/**
 * Captures one complete dependency product so a later immutable generation can
 * replace only the outgoing edges of documents it re-emitted.
 */
export function captureFileDependencyGraph(db: ScipDatabase): FileDependencyGraphSnapshot {
  const cacheKey = fileDependencyGraphCacheKey(undefined, 'all-references', 'imports-only');
  const graph = buildFileDepGraph(db);
  return { cacheKey, graph: cloneGraph(graph) };
}

/**
 * A carried dependency graph is the next generation's complete graph produced
 * by retaining untouched outgoing edges and rereading the re-emitted documents
 * from the accepted candidate database.
 */
export function carryFileDependencyGraph(
  db: ScipDatabase,
  previous: FileDependencyGraphSnapshot,
  replacedPaths: readonly string[],
): boolean {
  const projectFingerprint = projectEvidenceFingerprint(db);
  if (!projectFingerprint) return false;
  const graph = materializeCarriedFileDependencyGraph(db, previous, replacedPaths);
  if (!graph) return false;

  const indexedFiles = new Set(indexedDocumentPaths(db, { includeIgnored: false }));
  const expectedCacheKey = fileDependencyGraphCacheKey(undefined, 'all-references', 'imports-only');

  FILE_DEPENDENCY_GRAPH_PRODUCT.write(db, expectedCacheKey, projectFingerprint, {
    version: 2,
    construction: 'carried',
    sourceDependencyFingerprint: null,
    sourceFileCount: indexedFiles.size,
    sourceEdgeCount: null,
    scipEdgeCount: null,
    edgeCount: graphEdgeCount(graph),
    graph: graphPayloadFromGraph(graph),
  });
  return true;
}

/** Builds the next exact graph in memory before candidate metadata is available. */
export function materializeCarriedFileDependencyGraph(
  db: ScipDatabase,
  previous: FileDependencyGraphSnapshot,
  replacedPaths: readonly string[],
): Map<string, Set<string>> | null {
  const expectedCacheKey = fileDependencyGraphCacheKey(undefined, 'all-references', 'imports-only');
  if (previous.cacheKey !== expectedCacheKey) return null;

  const indexedFiles = new Set(indexedDocumentPaths(db, { includeIgnored: false }));
  const replaced = new Set(replacedPaths);
  const graph = new Map<string, Set<string>>();
  for (const [fromFile, dependencies] of previous.graph) {
    if (replaced.has(fromFile) || !indexedFiles.has(fromFile)) continue;
    for (const toFile of dependencies) addFileDepEdge(db, graph, indexedFiles, fromFile, toFile);
  }
  for (const edge of scipFileDepEdgesForFiles(db, replaced, 'all-references')) {
    addFileDepEdge(db, graph, indexedFiles, edge.from_file, edge.to_file);
  }
  for (const fromFile of replaced) {
    if (!indexedFiles.has(fromFile)) continue;
    for (const entry of getSourceImports(db, fromFile)) {
      if (entry.sourcePath) addFileDepEdge(db, graph, indexedFiles, fromFile, entry.sourcePath);
    }
  }
  return graph;
}

function collectSourceDependencyEdges(
  db: ScipDatabase,
  indexedFiles: ReadonlySet<string>,
  scope: string | undefined,
  mode: SourceDependencyEdgeMode,
): SourceDependencyEdgeSet {
  const files: string[] = [];
  const edges: SourceDependencyEdge[] = [];
  for (const relativePath of indexedFiles) {
    if (scope && !relativePath.includes(scope)) continue;
    files.push(relativePath);
    for (const entry of getSourceImports(db, relativePath)) {
      if (!entry.sourcePath) continue;
      edges.push({ fromFile: relativePath, toFile: entry.sourcePath });
    }
    if (mode === 'imports-and-reexports') {
      for (const entry of getReExports(db, relativePath)) {
        if (!entry.sourcePath) continue;
        edges.push({ fromFile: relativePath, toFile: entry.sourcePath });
      }
    }
  }

  return {
    files,
    edges,
    fingerprint: sourceDependencyFingerprint(files, edges),
  };
}

function sourceDependencyFingerprint(files: readonly string[], edges: readonly SourceDependencyEdge[]): string {
  const sortedEdges = edges.map((edge) => `${edge.fromFile}\0${edge.toFile}`).sort();
  return sha256Hex(JSON.stringify({ files, edges: sortedEdges }));
}

function fileDependencyGraphCacheKey(
  scope: string | undefined,
  scipEdges: 'all-references' | 'imports-only',
  sourceEdges: SourceDependencyEdgeMode,
): string {
  // v4 separates the carried-forward payload schema from earlier full-build
  // products while retaining the source-edge-mode separation introduced in v3.
  return `edge-mode-v4:${scipEdges}:${sourceEdges}:${scope ?? '<all>'}`;
}

function graphPayloadFromGraph(graph: Map<string, Set<string>>): Array<[string, string[]]> {
  return [...graph]
    .map(([file, deps]): [string, string[]] => [file, [...deps].sort()])
    .sort(([left], [right]) => left.localeCompare(right));
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
    candidate.version === 2 &&
    (candidate.construction === 'full' || candidate.construction === 'carried') &&
    (candidate.sourceDependencyFingerprint === null || typeof candidate.sourceDependencyFingerprint === 'string') &&
    typeof candidate.sourceFileCount === 'number' &&
    (candidate.sourceEdgeCount === null || typeof candidate.sourceEdgeCount === 'number') &&
    (candidate.scipEdgeCount === null || typeof candidate.scipEdgeCount === 'number') &&
    typeof candidate.edgeCount === 'number' &&
    Array.isArray(candidate.graph) &&
    candidate.graph.every(isGraphPayloadEntry)
  );
}

function cloneGraph(graph: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
  return new Map([...graph].map(([file, dependencies]) => [file, new Set(dependencies)]));
}

function graphEdgeCount(graph: ReadonlyMap<string, ReadonlySet<string>>): number {
  let count = 0;
  for (const dependencies of graph.values()) count += dependencies.size;
  return count;
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

function scipFileDepEdges(
  db: ScipDatabase,
  scope: string | undefined,
  edgeMode: 'all-references' | 'imports-only',
): Array<{ from_file: string; to_file: string }> {
  const scopeFilter = scope ? `AND d1.relative_path LIKE ?` : '';
  const scopeParams = scope ? [`%${scope}%`] : [];
  const roleFilter = edgeMode === 'imports-only' ? 'AND m.role = 2' : 'AND m.role != 1';
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
	      ${roleFilter}
	      ${db.pathExclusionsFor('d1', 'd2')}
	      ${scopeFilter}`,
    ...scopeParams,
  );
}

function scipFileDepEdgesForFiles(
  db: ScipDatabase,
  relativePaths: ReadonlySet<string>,
  edgeMode: 'all-references' | 'imports-only',
): Array<{ from_file: string; to_file: string }> {
  const paths = [...relativePaths].sort();
  if (paths.length === 0) return [];
  const roleFilter = edgeMode === 'imports-only' ? 'AND m.role = 2' : 'AND m.role != 1';
  const result: Array<{ from_file: string; to_file: string }> = [];
  for (let offset = 0; offset < paths.length; offset += 500) {
    const batch = paths.slice(offset, offset + 500);
    const placeholders = batch.map(() => '?').join(', ');
    result.push(
      ...db.all<{ from_file: string; to_file: string }>(
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
          ${roleFilter}
          ${db.pathExclusionsFor('d1', 'd2')}
          AND d1.relative_path IN (${placeholders})`,
        ...batch,
      ),
    );
  }
  return result;
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
