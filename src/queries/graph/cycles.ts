import type { ScipDatabase } from '../../storage/db.js';
import { buildFileDepGraph, type FileDependencyEdgeBasis } from '../../symbols/graph/file-dep-graph.js';
import { classifyFile, isBarrel as isBarrelFile } from '../../analysis/file-classifier.js';
import { stronglyConnectedComponents } from '../../analysis/strongly-connected-components.js';

export type { FileDependencyEdgeBasis } from '../../symbols/graph/file-dep-graph.js';

export interface CycleResult {
  /** One deterministic directed witness path; the first file is repeated at the end. */
  path: string[];
  /** Every file in the cyclic strongly connected component represented by the witness. */
  component?: string[];
  /** The file edge relation on which cyclic reachability was computed. */
  edgeBasis?: FileDependencyEdgeBasis;
  /** Distinguishes a witness from an enumeration of every simple cycle. */
  witness?: true;
  classification?: 'dependency-cycle' | 'module-structure-candidate';
  /**
   * @deprecated Compatibility field. Prefer `classification`: “real” was too
   * strong for a static dependency observation.
   *
   * Historical classification of the cycle:
   *   - 'real':            architectural cycle worth fixing
   *   - 'module-hierarchy': barrel-file pattern (mod.rs / index.ts /
   *                        __init__.py declaring children that re-import
   *                        parent re-exports). Standard module structure,
   *                        not actionable.
   */
  kind: 'real' | 'module-hierarchy';
}

export interface CycleSummary {
  cycles: CycleResult[];
  truncated: boolean;
  edgeBasis?: FileDependencyEdgeBasis;
  maxDepth: number;
}

export interface DependencyCycleOptions {
  scope?: string;
  /** @deprecated Cycle enumeration is SCC-complete; this value is reported only for legacy callers. */
  maxDepth?: number;
  edgeBasis?: FileDependencyEdgeBasis;
}

/**
 * Detect circular dependency chains between files.
 * A cycle exists when file A depends on B, B depends on C, and C depends on A.
 *
 * By default this uses the same symbol-reference plus source-import dependency
 * edges as `deps`. `edgeBasis: 'imports'` selects the narrower import graph.
 * Every cyclic strongly connected component is returned exactly once with one
 * deterministic witness path; this is not an enumeration of every simple cycle.
 */
export function cycles(db: ScipDatabase, opts: { scope?: string; maxDepth?: number } = {}): CycleResult[] {
  return cycleSummary(db, opts).cycles;
}

// scip-query: ignore-passthrough — stable public query name delegates to the explicitly named dependency-cycle calculation.
export function cycleSummary(db: ScipDatabase, opts: { scope?: string; maxDepth?: number } = {}): CycleSummary {
  return dependencyCycleSummary(db, opts);
}

/**
 * Enumerate cyclic strongly connected components in a named file-dependency
 * relation. This is the explicit replacement for selecting a different graph
 * through the legacy `cycles` API.
 */
export function dependencyCycles(db: ScipDatabase, opts: DependencyCycleOptions = {}): CycleResult[] {
  return dependencyCycleSummary(db, opts).cycles;
}

export function dependencyCycleSummary(db: ScipDatabase, opts: DependencyCycleOptions = {}): CycleSummary {
  const { scope, maxDepth = 10, edgeBasis = 'symbol-references' } = opts;
  const graph = buildFileDepGraph(
    db,
    scope,
    edgeBasis === 'imports' ? { scipEdges: 'imports-only', sourceEdges: 'imports-only' } : undefined,
  );
  const { components } = stronglyConnectedComponents(graph);
  const allCycles = components
    .filter((component) => isCyclicComponent(graph, component))
    .map((members) => {
      const component = [...members].sort();
      const path = cycleWitness(graph, component);
      const kind = classifyCycle(path);
      return {
        path,
        component,
        edgeBasis,
        witness: true as const,
        classification: kind === 'real' ? ('dependency-cycle' as const) : ('module-structure-candidate' as const),
        kind,
      };
    });

  // Sort: real cycles first (more actionable), then by length.
  allCycles.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'real' ? -1 : 1;
    return a.path.length - b.path.length;
  });

  return {
    cycles: allCycles,
    truncated: false,
    edgeBasis,
    maxDepth,
  };
}

function isCyclicComponent(graph: ReadonlyMap<string, ReadonlySet<string>>, component: readonly string[]): boolean {
  if (component.length > 1) return true;
  const only = component[0];
  return only !== undefined && graph.get(only)?.has(only) === true;
}

function cycleWitness(graph: ReadonlyMap<string, ReadonlySet<string>>, component: readonly string[]): string[] {
  const start = component[0];
  if (!start) return [];
  const members = new Set(component);
  for (const neighbor of [...(graph.get(start) ?? [])].filter((node) => members.has(node)).sort()) {
    if (neighbor === start) return [start, start];
    const returnPath = shortestPathWithinComponent(graph, neighbor, start, members);
    if (returnPath) return [start, ...returnPath];
  }
  throw new Error(`Cyclic component did not contain a witness path from ${start}.`);
}

function shortestPathWithinComponent(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  from: string,
  target: string,
  members: ReadonlySet<string>,
): string[] | null {
  const queue = [from];
  const parent = new Map<string, string | null>([[from, null]]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (current === target) {
      const reversed: string[] = [];
      for (let cursor: string | null = current; cursor !== null; cursor = parent.get(cursor) ?? null) {
        reversed.push(cursor);
      }
      return reversed.reverse();
    }
    for (const neighbor of [...(graph.get(current) ?? [])].filter((node) => members.has(node)).sort()) {
      if (parent.has(neighbor)) continue;
      parent.set(neighbor, current);
      queue.push(neighbor);
    }
  }
  return null;
}

/**
 * A cycle is "module-hierarchy" — and therefore not a real architectural
 * cycle worth fixing — when it's a 2-file loop where one file is a barrel
 * (mod.rs / index.ts / __init__.py). The barrel declares its child module
 * (Rust `pub mod x;` or TS re-export); the child accesses something the
 * barrel re-exports. That creates a graph edge each direction even though
 * there's no real cyclic coupling — it's how module hierarchies work.
 *
 * Longer cycles (3+ files) are kept as 'real' even when a barrel is
 * involved — those are usually genuine tangles.
 */
function classifyCycle(path: string[]): 'real' | 'module-hierarchy' {
  // Any cycle that passes through a test file, barrel, or entry isn't an
  // architectural one. Tests are leaves with implicit cross-traffic from
  // `mod tests;`. Barrels exist to re-export — every cycle they're in is
  // bookkeeping. Entries do bootstrap imports the rest of the crate then
  // mirrors. Apply to cycles of any length.
  for (const file of path) {
    const kind = classifyFile(file);
    if (kind === 'test' || kind === 'barrel' || kind === 'entry') return 'module-hierarchy';
  }
  // path includes the closing repeat (a → b → a), so 2 distinct files = path of length 3.
  if (path.length !== 3) return 'real';
  const [a, b] = path;
  if (!a || !b) return 'real';
  if (isBarrelFile(a) || isBarrelFile(b)) return 'module-hierarchy';
  // Rust submodule pattern: `foo.rs` declares `mod bar;` whose body lives in
  // `foo/bar.rs`. Parent and child reference each other's items — this is
  // how Rust hierarchical modules work, not an architectural cycle.
  // `_tests`-suffixed siblings and integration tests in `tests/<name>.rs`
  // alongside `src/<name>.rs` follow the same pattern.
  if (isRustSubmodulePair(a, b) || isRustSubmodulePair(b, a)) return 'module-hierarchy';
  if (isRustTestSibling(a, b) || isRustTestSibling(b, a)) return 'module-hierarchy';
  // Entry-file 2-cycles (`main.rs` ↔ a sibling): the entry file is the
  // bootstrap, the sibling is implementation; the cycle exists because the
  // entry imports the impl while the impl imports something the entry
  // re-exports. Same kind of artifact as a barrel cycle.
  if (classifyFile(a) === 'entry' || classifyFile(b) === 'entry') return 'module-hierarchy';
  return 'real';
}

// True when `child` is the body file of a submodule declared by `parent`.
// In Rust, `parent.rs` (or `parent/mod.rs`) can declare `mod child;` whose
// body is at `parent/child.rs`. The two files are guaranteed to reference
// each other — child uses items from parent's scope, parent re-exports
// items from child — and that bidirectional traffic isn't a true cycle.
function isRustSubmodulePair(child: string, parent: string): boolean {
  if (!child.endsWith('.rs') || !parent.endsWith('.rs')) return false;
  const parentDir = parent.replace(/\.rs$/, '/');
  // child must live directly under the parent's stem-named directory:
  // parent.rs ↔ parent/child.rs.
  if (!child.startsWith(parentDir)) return false;
  const remainder = child.slice(parentDir.length);
  // direct child only (no nested subdirs); rejects deeper hierarchy whose
  // cycles would represent genuine cross-layer traffic.
  return !remainder.includes('/');
}

// True when `tests` looks like the inline-test sibling of `parent`. Covers
// the two common Rust idioms: `foo_tests.rs` next to `foo.rs`, and
// `tests/foo.rs` integration test for `src/foo.rs`.
function isRustTestSibling(tests: string, parent: string): boolean {
  if (!tests.endsWith('.rs') || !parent.endsWith('.rs')) return false;
  const testBase = tests.replace(/\.rs$/, '');
  const parentBase = parent.replace(/\.rs$/, '');
  if (testBase === parentBase + '_tests') return true;
  if (testBase === parentBase + '/tests') return true;
  // Integration test pattern: `<crate>/tests/<name>.rs` ↔ `<crate>/src/<name>.rs`.
  // Both files share a basename and the test path passes through `/tests/`.
  const testParts = tests.split('/');
  const parentParts = parent.split('/');
  if (testParts.length === parentParts.length && testParts.includes('tests') && parentParts.includes('src')) {
    const testBaseName = testParts[testParts.length - 1];
    const parentBaseName = parentParts[parentParts.length - 1];
    if (testBaseName && testBaseName === parentBaseName) return true;
  }
  return false;
}
