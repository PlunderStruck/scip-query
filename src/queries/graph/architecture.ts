import { matchesGlob } from '../../analysis/glob-match.js';
import { stronglyConnectedComponents } from '../../analysis/strongly-connected-components.js';
import type { ArchitectureConfig } from '../../domain/config-types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';

export type ArchitecturePolicyStatus = 'allowed' | 'forbidden' | 'undeclared';

export interface ArchitectureFileEdge {
  fromFile: string;
  toFile: string;
}

export interface ArchitectureBoundaryEdge {
  from: string;
  to: string;
  policyStatus: ArchitecturePolicyStatus;
  fileEdgeCount: number;
  importerCount: number;
  importedFileCount: number;
  examples: ArchitectureFileEdge[];
}

export interface ArchitectureBoundarySummary {
  name: string;
  paths: string[];
  fileCount: number;
  dependencyPolicyDeclared: boolean;
}

export interface ArchitectureAmbiguousFile {
  file: string;
  boundaries: string[];
}

export interface ArchitectureReciprocalPair {
  boundaries: [string, string];
  forward: ArchitectureBoundaryEdge;
  reverse: ArchitectureBoundaryEdge;
}

export interface ArchitectureCycle {
  boundaries: string[];
  internalEdges: ArchitectureBoundaryEdge[];
  /** Least-broad internal edge(s), useful as inspection points rather than automatic repairs. */
  narrowestEdges: ArchitectureBoundaryEdge[];
  violatesPolicy: boolean;
}

export interface ArchitectureCoverage {
  totalFiles: number;
  mappedFiles: number;
  unmappedFiles: string[];
  ambiguousFiles: ArchitectureAmbiguousFile[];
}

export interface ArchitecturePolicyCoverage {
  declaredRows: number;
  totalBoundaries: number;
  missingRows: string[];
  requiresCompletePolicy: boolean;
}

export interface ArchitectureReport {
  configured: boolean;
  boundaries: ArchitectureBoundarySummary[];
  edges: ArchitectureBoundaryEdge[];
  forbiddenEdges: ArchitectureBoundaryEdge[];
  reciprocalPairs: ArchitectureReciprocalPair[];
  cycles: ArchitectureCycle[];
  coverage: ArchitectureCoverage;
  policyCoverage: ArchitecturePolicyCoverage;
}

export const ARCHITECTURE_BASELINE_PREFIX = 'architecture:';

interface MutableBoundaryEdge {
  from: string;
  to: string;
  fileEdges: ArchitectureFileEdge[];
  importers: Set<string>;
  importedFiles: Set<string>;
}

/**
 * Evaluate a file dependency graph against project-owned architectural
 * boundaries. This pure seam deliberately separates graph facts from the
 * repository-specific judgment recorded in ArchitectureConfig.
 */
export function analyzeArchitectureGraph(
  fileGraph: ReadonlyMap<string, ReadonlySet<string>>,
  indexedFiles: readonly string[],
  config?: ArchitectureConfig,
): ArchitectureReport {
  const allFiles = allGraphFiles(fileGraph, indexedFiles);
  if (!config || config.boundaries.length === 0) {
    return {
      configured: false,
      boundaries: [],
      edges: [],
      forbiddenEdges: [],
      reciprocalPairs: [],
      cycles: [],
      coverage: {
        totalFiles: allFiles.length,
        mappedFiles: 0,
        unmappedFiles: [],
        ambiguousFiles: [],
      },
      policyCoverage: {
        declaredRows: 0,
        totalBoundaries: 0,
        missingRows: [],
        requiresCompletePolicy: false,
      },
    };
  }

  const resolved = new Map<string, string>();
  const filesByBoundary = new Map(config.boundaries.map((boundary) => [boundary.name, new Set<string>()] as const));
  const unmappedFiles: string[] = [];
  const ambiguousFiles: ArchitectureAmbiguousFile[] = [];

  for (const file of allFiles) {
    const matches = config.boundaries
      .filter((boundary) => boundary.paths.some((pattern) => matchesGlob(pattern, file)))
      .map((boundary) => boundary.name)
      .sort();
    if (matches.length === 0) {
      unmappedFiles.push(file);
    } else if (matches.length > 1) {
      ambiguousFiles.push({ file, boundaries: matches });
    } else {
      const boundary = matches[0]!;
      resolved.set(file, boundary);
      filesByBoundary.get(boundary)!.add(file);
    }
  }

  const mutableEdges = new Map<string, MutableBoundaryEdge>();
  for (const [fromFile, dependencies] of fileGraph) {
    const from = resolved.get(fromFile);
    if (!from) continue;
    for (const toFile of dependencies) {
      const to = resolved.get(toFile);
      if (!to || from === to) continue;
      const key = boundaryEdgeKey(from, to);
      let edge = mutableEdges.get(key);
      if (!edge) {
        edge = { from, to, fileEdges: [], importers: new Set(), importedFiles: new Set() };
        mutableEdges.set(key, edge);
      }
      edge.fileEdges.push({ fromFile, toFile });
      edge.importers.add(fromFile);
      edge.importedFiles.add(toFile);
    }
  }

  const edges = [...mutableEdges.values()]
    .map((edge) => materializeBoundaryEdge(edge, config))
    .sort(compareBoundaryEdges);
  const edgeByKey = new Map(edges.map((edge) => [boundaryEdgeKey(edge.from, edge.to), edge]));
  const boundaryGraph = new Map(config.boundaries.map((boundary) => [boundary.name, new Set<string>()] as const));
  for (const edge of edges) boundaryGraph.get(edge.from)!.add(edge.to);

  const reciprocalPairs: ArchitectureReciprocalPair[] = [];
  for (const edge of edges) {
    if (edge.from >= edge.to) continue;
    const reverse = edgeByKey.get(boundaryEdgeKey(edge.to, edge.from));
    if (reverse) {
      reciprocalPairs.push({
        boundaries: [edge.from, edge.to],
        forward: edge,
        reverse,
      });
    }
  }

  const { components } = stronglyConnectedComponents(boundaryGraph);
  const cycles = components
    .filter((component) => component.length > 1)
    .map((component) => architectureCycle(component, edges, config.requireAcyclic === true))
    .sort(
      (a, b) =>
        b.boundaries.length - a.boundaries.length || a.boundaries.join('/').localeCompare(b.boundaries.join('/')),
    );

  const allowedDependencies = config.allowedDependencies ?? {};
  const missingRows = config.boundaries
    .map((boundary) => boundary.name)
    .filter((boundary) => !Object.hasOwn(allowedDependencies, boundary))
    .sort();
  return {
    configured: true,
    boundaries: config.boundaries
      .map((boundary) => ({
        name: boundary.name,
        paths: [...boundary.paths],
        fileCount: filesByBoundary.get(boundary.name)!.size,
        dependencyPolicyDeclared: Object.hasOwn(allowedDependencies, boundary.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    edges,
    forbiddenEdges: edges.filter((edge) => edge.policyStatus === 'forbidden'),
    reciprocalPairs,
    cycles,
    coverage: {
      totalFiles: allFiles.length,
      mappedFiles: resolved.size,
      unmappedFiles,
      ambiguousFiles,
    },
    policyCoverage: {
      declaredRows: config.boundaries.length - missingRows.length,
      totalBoundaries: config.boundaries.length,
      missingRows,
      requiresCompletePolicy: config.requireCompletePolicy === true,
    },
  };
}

/** Build and analyze the current project's import dependency graph. */
export function architecture(db: ScipDatabase, opts: { scope?: string } = {}): ArchitectureReport {
  const graph = buildFileDepGraph(db, opts.scope, {
    scipEdges: 'imports-only',
    sourceEdges: 'imports-and-reexports',
  });
  const files = indexedDocumentPaths(db, { includeIgnored: false }).filter(
    (file) => !opts.scope || file.includes(opts.scope),
  );
  return analyzeArchitectureGraph(graph, files, db.config.architecture);
}

/**
 * Produce responsibility-level identities for explicit architecture failures.
 * File examples are intentionally excluded so ordinary refactors do not churn
 * the ratchet while the same boundary relationship remains.
 */
export function architectureFindingIdentities(report: ArchitectureReport): string[] {
  const identities = report.forbiddenEdges.map(
    (edge) =>
      `${ARCHITECTURE_BASELINE_PREFIX}forbidden-edge:${encodeURIComponent(edge.from)}:${encodeURIComponent(edge.to)}`,
  );
  if (report.policyCoverage.requiresCompletePolicy) {
    for (const boundary of report.policyCoverage.missingRows) {
      identities.push(`${ARCHITECTURE_BASELINE_PREFIX}missing-policy-row:${encodeURIComponent(boundary)}`);
    }
  }
  for (const cycle of report.cycles) {
    if (!cycle.violatesPolicy) continue;
    identities.push(
      `${ARCHITECTURE_BASELINE_PREFIX}cycle:${cycle.boundaries
        .map((boundary) => encodeURIComponent(boundary))
        .sort()
        .join('|')}`,
    );
  }
  return [...new Set(identities)].sort();
}

/** True when configuration contains at least one closed rule worth enforcing. */
export function hasEnforceableArchitecturePolicy(config?: ArchitectureConfig): boolean {
  return (
    !!config &&
    (Object.keys(config.allowedDependencies ?? {}).length > 0 ||
      config.requireCompletePolicy === true ||
      config.requireAcyclic === true)
  );
}

function allGraphFiles(graph: ReadonlyMap<string, ReadonlySet<string>>, indexedFiles: readonly string[]): string[] {
  const files = new Set(indexedFiles);
  for (const [fromFile, dependencies] of graph) {
    files.add(fromFile);
    for (const toFile of dependencies) files.add(toFile);
  }
  return [...files].sort();
}

function materializeBoundaryEdge(edge: MutableBoundaryEdge, config: ArchitectureConfig): ArchitectureBoundaryEdge {
  const fileEdges = [...edge.fileEdges].sort(
    (a, b) => a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile),
  );
  return {
    from: edge.from,
    to: edge.to,
    policyStatus: edgePolicyStatus(config, edge.from, edge.to),
    fileEdgeCount: fileEdges.length,
    importerCount: edge.importers.size,
    importedFileCount: edge.importedFiles.size,
    examples: fileEdges.slice(0, 5),
  };
}

function edgePolicyStatus(
  config: ArchitectureConfig,
  fromBoundary: string,
  toBoundary: string,
): ArchitecturePolicyStatus {
  if (!config.allowedDependencies || !Object.hasOwn(config.allowedDependencies, fromBoundary)) {
    return 'undeclared';
  }
  return config.allowedDependencies[fromBoundary]!.includes(toBoundary) ? 'allowed' : 'forbidden';
}

function architectureCycle(
  component: readonly string[],
  edges: readonly ArchitectureBoundaryEdge[],
  requireAcyclic: boolean,
): ArchitectureCycle {
  const boundaries = [...component].sort();
  const members = new Set(boundaries);
  const internalEdges = edges.filter((edge) => members.has(edge.from) && members.has(edge.to));
  const minimumBreadth = Math.min(...internalEdges.map((edge) => edge.fileEdgeCount));
  return {
    boundaries,
    internalEdges,
    narrowestEdges: internalEdges.filter((edge) => edge.fileEdgeCount === minimumBreadth),
    violatesPolicy: requireAcyclic,
  };
}

function boundaryEdgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

function compareBoundaryEdges(a: ArchitectureBoundaryEdge, b: ArchitectureBoundaryEdge): number {
  return a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
}
