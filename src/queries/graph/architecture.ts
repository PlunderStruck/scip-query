import { classifyFile } from '../../analysis/file-classifier.js';
import { matchesGlob } from '../../analysis/glob-match.js';
import { stronglyConnectedComponents } from '../../analysis/strongly-connected-components.js';
import type { ArchitectureConfig } from '../../domain/config-types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { testBoundaryViolations, type TestBoundaryViolation } from './test-boundary-policy.js';
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
  /**
   * True when the entire boundary dependency rests on a single import. Not a
   * violation — a signal that the edge is incidental rather than load-bearing,
   * and therefore cheap to remove if it was never intended.
   */
  fragile: boolean;
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
  requiresMinimalPolicy: boolean;
}

/** A declared allowance that no observed edge uses. */
export interface ArchitectureStaleAllowance {
  from: string;
  to: string;
}

/** A boundary exceeding a configured size or connectivity limit. */
export interface ArchitectureBoundaryLimit {
  boundary: string;
  kind: 'fan-out' | 'files';
  observed: number;
  limit: number;
}

/** One directed dependency between two sub-units inside a single boundary. */
export interface ArchitectureSubUnitEdge {
  from: string;
  to: string;
  fileEdgeCount: number;
  examples: ArchitectureFileEdge[];
}

/**
 * A boundary whose own members form a dependency cycle.
 *
 * `requireAcyclic` quotients the file graph by boundary and discards every
 * intra-boundary edge, so a cycle wholly inside one boundary is reported as
 * absent. Such a boundary is "too coarse to check": its clean status carries
 * no information about the code it contains.
 */
export interface ArchitectureCoarseBoundary {
  boundary: string;
  violatesPolicy: boolean;
  subUnits: string[];
  internalEdges: ArchitectureSubUnitEdge[];
  /** Least-broad internal edge(s) — the cheapest inspection points. */
  narrowestEdges: ArchitectureSubUnitEdge[];
}

export interface ArchitectureReport {
  configured: boolean;
  boundaries: ArchitectureBoundarySummary[];
  edges: ArchitectureBoundaryEdge[];
  forbiddenEdges: ArchitectureBoundaryEdge[];
  reciprocalPairs: ArchitectureReciprocalPair[];
  cycles: ArchitectureCycle[];
  /** Boundaries hiding an internal cycle that the boundary graph cannot express. */
  coarseBoundaries: ArchitectureCoarseBoundary[];
  /** Declared allowances with no observed edge — policy wider than reality. */
  staleAllowances: ArchitectureStaleAllowance[];
  /** Boundaries over a configured fan-out or file-count limit. */
  boundaryLimits: ArchitectureBoundaryLimit[];
  /** Report-only: boundary edges resting on exactly one import. */
  fragileEdges: ArchitectureBoundaryEdge[];
  /** Test files importing beyond what their subject's boundary may reach. */
  testBoundaryViolations: TestBoundaryViolation[];
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
// scip-query: ignore-extract — reviewed E2 cohesive algorithm; mapping, edge policy, SCCs, and coverage define one report.
export function analyzeArchitectureGraph(
  fileGraph: ReadonlyMap<string, ReadonlySet<string>>,
  indexedFiles: readonly string[],
  config?: ArchitectureConfig,
  opts: {
    isModuleHierarchyFile?: (file: string) => boolean;
    testBoundaryViolations?: TestBoundaryViolation[];
  } = {},
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
      coarseBoundaries: [],
      staleAllowances: [],
      boundaryLimits: [],
      fragileEdges: [],
      testBoundaryViolations: [],
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
        requiresMinimalPolicy: false,
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
  const enforcedEdges = edges;
  const edgeByKey = new Map(enforcedEdges.map((edge) => [boundaryEdgeKey(edge.from, edge.to), edge]));
  const boundaryGraph = new Map(config.boundaries.map((boundary) => [boundary.name, new Set<string>()] as const));
  for (const edge of enforcedEdges) boundaryGraph.get(edge.from)!.add(edge.to);

  const reciprocalPairs: ArchitectureReciprocalPair[] = [];
  for (const edge of enforcedEdges) {
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
    .map((component) => architectureCycle(component, enforcedEdges, config.requireAcyclic === true))
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
    forbiddenEdges: enforcedEdges.filter((edge) => edge.policyStatus === 'forbidden'),
    reciprocalPairs,
    cycles,
    staleAllowances: staleAllowances(config, enforcedEdges),
    boundaryLimits: boundaryLimits(config, enforcedEdges, filesByBoundary),
    fragileEdges: enforcedEdges.filter((edge) => edge.fragile),
    testBoundaryViolations: opts.testBoundaryViolations ?? [],
    coarseBoundaries: detectCoarseBoundaries(
      fileGraph,
      filesByBoundary,
      opts.isModuleHierarchyFile,
      config.requireResolvedBoundaries === true,
      (name) => config.boundaries.find((boundary) => boundary.name === name)?.subUnits ?? 'directory',
    ),
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
      requiresMinimalPolicy: config.requireMinimalPolicy === true,
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
  // Hoisted: this is consulted once per import of every test file, so building
  // it per lookup turns the test-boundary pass into an O(files x imports) scan.
  const sourceFiles = new Set(files);
  return analyzeArchitectureGraph(graph, files, db.config.architecture, {
    isModuleHierarchyFile: (file) => isModuleHierarchyFile(db, file),
    testBoundaryViolations: testBoundaryViolations(
      db,
      db.config.architecture,
      (file) => boundaryForFile(db.config.architecture, file),
      (file) => sourceFiles.has(file),
    ),
  });
}

/** Resolve a file to its single owning boundary, or null when ambiguous/unmapped. */
function boundaryForFile(config: ArchitectureConfig | undefined, file: string): string | null {
  const matches = (config?.boundaries ?? []).filter((boundary) =>
    boundary.paths.some((pattern) => matchesGlob(pattern, file)),
  );
  return matches.length === 1 ? matches[0]!.name : null;
}

/**
 * True when a file exists to wire modules together rather than to hold logic:
 * a test, a structural entry point, or a barrel that only re-exports.
 *
 * The barrel test is deliberately content-aware. `classifyFile` decides
 * "barrel" from the path alone, which labels any `index.ts` a barrel — including
 * modules like `src/language-parsers/index.ts` that carry real caching logic.
 * Excluding those by name hides genuine cycles, so a barrel only counts as
 * bookkeeping when the index records no definitions of its own inside it.
 */
function isModuleHierarchyFile(db: ScipDatabase, file: string): boolean {
  const kind = classifyFile(file);
  if (kind === 'test' || kind === 'entry') return true;
  if (kind !== 'barrel') return false;
  return getDefinitionsForFile(db, file).length === 0;
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
  if (report.policyCoverage.requiresMinimalPolicy) {
    for (const allowance of report.staleAllowances) {
      identities.push(
        `${ARCHITECTURE_BASELINE_PREFIX}stale-allowance:${encodeURIComponent(allowance.from)}:${encodeURIComponent(allowance.to)}`,
      );
    }
  }
  for (const violation of report.testBoundaryViolations) {
    identities.push(
      `${ARCHITECTURE_BASELINE_PREFIX}test-boundary:${encodeURIComponent(violation.testFile)}:${encodeURIComponent(violation.importedBoundary)}`,
    );
  }
  for (const limit of report.boundaryLimits) {
    identities.push(
      `${ARCHITECTURE_BASELINE_PREFIX}boundary-limit:${limit.kind}:${encodeURIComponent(limit.boundary)}`,
    );
  }
  for (const finding of report.coarseBoundaries) {
    if (!finding.violatesPolicy) continue;
    // Keyed by boundary alone. Sub-unit membership shifts as files move, and
    // this string is the persistent baseline comparison key -- including the
    // members would turn one continuing problem into an apparent fix plus a
    // new finding on every reorganization.
    identities.push(`${ARCHITECTURE_BASELINE_PREFIX}coarse-boundary:${encodeURIComponent(finding.boundary)}`);
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
      config.requireAcyclic === true ||
      config.requireResolvedBoundaries === true ||
      config.requireMinimalPolicy === true ||
      config.maxBoundaryFanOut !== undefined ||
      config.maxBoundaryFiles !== undefined ||
      (config.testPaths?.length ?? 0) > 0)
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
    fragile: fileEdges.length === 1,
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

/**
 * Find boundaries whose members form a cycle the boundary graph cannot show.
 *
 * Works on the *quotient by sub-unit* (a file's containing directory), not the
 * file graph: `cycles` reports no file-level loop in this repository's large
 * boundaries even though several of them are internally cyclic, because a
 * quotient can be cyclic while the graph it quotients is acyclic.
 *
 * `isModuleHierarchyFile` removes re-export bookkeeping (barrels, entries,
 * tests) so normal parent/child module structure is not reported as debt.
 * Rust `mod.rs` and `index.ts` module declarations fall out through that rule
 * because a pure re-export file defines nothing of its own.
 *
 * Directory nesting alone is deliberately *not* a suppression signal: a
 * boundary's root files and one of its sub-directories depending on each other
 * is the most common real cycle, not module bookkeeping.
 */
export function detectCoarseBoundaries(
  fileGraph: ReadonlyMap<string, ReadonlySet<string>>,
  filesByBoundary: ReadonlyMap<string, ReadonlySet<string>>,
  isModuleHierarchyFile: (file: string) => boolean = pathModuleHierarchyFile,
  violatesPolicy = false,
  granularityFor: (boundary: string) => 'directory' | 'file' = () => 'directory',
): ArchitectureCoarseBoundary[] {
  const findings: ArchitectureCoarseBoundary[] = [];

  for (const [boundary, members] of filesByBoundary) {
    const subUnitOf = granularityFor(boundary) === 'file' ? (file: string) => file : directoryOf;
    const considered = [...members].filter((file) => !isModuleHierarchyFile(file));
    if (considered.length < 2) continue;
    const inBoundary = new Set(considered);

    const edges = new Map<string, { from: string; to: string; fileEdges: ArchitectureFileEdge[] }>();
    const subGraph = new Map<string, Set<string>>();
    for (const file of considered) subGraph.set(subUnitOf(file), new Set());

    for (const fromFile of considered) {
      for (const toFile of fileGraph.get(fromFile) ?? []) {
        if (!inBoundary.has(toFile)) continue;
        const from = subUnitOf(fromFile);
        const to = subUnitOf(toFile);
        if (from === to) continue;
        const key = boundaryEdgeKey(from, to);
        let edge = edges.get(key);
        if (!edge) {
          edge = { from, to, fileEdges: [] };
          edges.set(key, edge);
        }
        edge.fileEdges.push({ fromFile, toFile });
        subGraph.get(from)!.add(to);
      }
    }

    const { components } = stronglyConnectedComponents(subGraph);
    for (const component of components) {
      if (component.length < 2) continue;
      const members = new Set(component);
      const internalEdges = [...edges.values()]
        .filter((edge) => members.has(edge.from) && members.has(edge.to))
        .map((edge) => ({
          from: edge.from,
          to: edge.to,
          fileEdgeCount: edge.fileEdges.length,
          examples: edge.fileEdges.slice(0, 5),
        }))
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
      const minimum = Math.min(...internalEdges.map((edge) => edge.fileEdgeCount));
      findings.push({
        boundary,
        violatesPolicy,
        subUnits: [...component].sort(),
        internalEdges,
        narrowestEdges: internalEdges.filter((edge) => edge.fileEdgeCount === minimum),
      });
    }
  }

  return findings.sort((a, b) => b.subUnits.length - a.subUnits.length || a.boundary.localeCompare(b.boundary));
}

/**
 * Declared allowances with no observed edge.
 *
 * These are how a reviewed policy silently widens: the import that justified a
 * row is deleted, the row survives, and the boundary keeps permission nobody
 * re-examined. Only boundaries that actually have a row are considered — a
 * missing row makes no claim and cannot be stale.
 */
function staleAllowances(
  config: ArchitectureConfig,
  edges: readonly ArchitectureBoundaryEdge[],
): ArchitectureStaleAllowance[] {
  const observed = new Set(edges.map((edge) => boundaryEdgeKey(edge.from, edge.to)));
  const declared = config.allowedDependencies ?? {};
  const boundaryNames = new Set(config.boundaries.map((boundary) => boundary.name));
  const stale: ArchitectureStaleAllowance[] = [];
  for (const [from, targets] of Object.entries(declared)) {
    if (!boundaryNames.has(from)) continue;
    for (const to of targets) {
      if (!boundaryNames.has(to) || observed.has(boundaryEdgeKey(from, to))) continue;
      stale.push({ from, to });
    }
  }
  return stale.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** Boundaries over a configured connectivity or size limit. */
function boundaryLimits(
  config: ArchitectureConfig,
  edges: readonly ArchitectureBoundaryEdge[],
  filesByBoundary: ReadonlyMap<string, ReadonlySet<string>>,
): ArchitectureBoundaryLimit[] {
  const limits: ArchitectureBoundaryLimit[] = [];
  const fanOut = new Map<string, number>();
  for (const edge of edges) fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);

  for (const boundary of config.boundaries) {
    if (config.maxBoundaryFanOut !== undefined) {
      const observed = fanOut.get(boundary.name) ?? 0;
      if (observed > config.maxBoundaryFanOut) {
        limits.push({ boundary: boundary.name, kind: 'fan-out', observed, limit: config.maxBoundaryFanOut });
      }
    }
    if (config.maxBoundaryFiles !== undefined) {
      const observed = filesByBoundary.get(boundary.name)?.size ?? 0;
      if (observed > config.maxBoundaryFiles) {
        limits.push({ boundary: boundary.name, kind: 'files', observed, limit: config.maxBoundaryFiles });
      }
    }
  }
  return limits.sort((a, b) => a.boundary.localeCompare(b.boundary) || a.kind.localeCompare(b.kind));
}

/**
 * Path-only module-hierarchy test, used when a caller supplies no classifier.
 *
 * Conservative by construction: it treats every `index.ts`/`mod.rs` as a
 * barrel, so a direct caller gets fewer findings rather than bookkeeping noise.
 * `architecture(db)` overrides it with a content-aware version, because the
 * path rule also hides real cycles whose back edge targets a logic-bearing
 * module that merely happens to be named `index.ts`.
 */
function pathModuleHierarchyFile(file: string): boolean {
  const kind = classifyFile(file);
  return kind === 'test' || kind === 'entry' || kind === 'barrel';
}

/** A file's default sub-unit is its containing directory. */
function directoryOf(file: string): string {
  const cut = file.lastIndexOf('/');
  return cut === -1 ? '.' : file.slice(0, cut);
}

function boundaryEdgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

function compareBoundaryEdges(a: ArchitectureBoundaryEdge, b: ArchitectureBoundaryEdge): number {
  return a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
}
