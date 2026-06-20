import type { ScipDatabase } from '../../storage/db.js';
import { buildFileDepGraph } from '../../symbols/file-dep-graph.js';
import { classifyFile, isBarrel as isBarrelFile } from '../../analysis/file-classifier.js';

export interface CycleResult {
  /** Files forming a cycle, in order */
  path: string[];
  /**
   * Classification of the cycle:
   *   - 'real':            architectural cycle worth fixing
   *   - 'module-hierarchy': barrel-file pattern (mod.rs / index.ts /
   *                        __init__.py declaring children that re-import
   *                        parent re-exports). Standard module structure,
   *                        not actionable.
   */
  kind: 'real' | 'module-hierarchy';
}

/**
 * Detect circular dependency chains between files.
 * A cycle exists when file A depends on B, B depends on C, and C depends on A.
 *
 * Uses the same dependency edges as the `deps` command (symbol definitions
 * referenced across files), then runs DFS cycle detection.
 */
export function cycles(
  db: ScipDatabase,
  opts: { scope?: string; maxDepth?: number } = {},
): CycleResult[] {
  const { scope, maxDepth = 10 } = opts;
  const graph = buildFileDepGraph(db, scope);

  // DFS cycle detection
  const allCycles: CycleResult[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string, depth: number): void {
    if (depth > maxDepth) return;
    if (inStack.has(node)) {
      // Found a cycle — extract it from the stack
      const cycleStart = stack.indexOf(node);
      if (cycleStart !== -1) {
        const cyclePath = stack.slice(cycleStart).concat(node);
        // Normalize: start from the lexicographically smallest file
        const minIdx = cyclePath.indexOf(
          cyclePath.reduce((a, b) => (a < b ? a : b)),
        );
        const normalized = [
          ...cyclePath.slice(minIdx, -1),
          ...cyclePath.slice(0, minIdx),
          cyclePath[minIdx]!,
        ];
        // Deduplicate
        const key = normalized.join(' -> ');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          allCycles.push({ path: normalized, kind: classifyCycle(normalized) });
        }
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = graph.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        dfs(neighbor, depth + 1);
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  const seenCycles = new Set<string>();
  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, 0);
    }
  }

  // Sort: real cycles first (more actionable), then by length.
  allCycles.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'real' ? -1 : 1;
    return a.path.length - b.path.length;
  });

  return allCycles;
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
  if (!/\.rs$/.test(child) || !/\.rs$/.test(parent)) return false;
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
  if (!/\.rs$/.test(tests) || !/\.rs$/.test(parent)) return false;
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
