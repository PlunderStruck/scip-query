/**
 * File classifier — one place to decide what role a source file plays.
 *
 * Multiple queries (dead, health, cycles, drift) all need to ask
 * questions like "is this a test file?", "is this an entry point?",
 * "is this a barrel?" Pre-this-module each query had its own answer
 * with subtle divergences. classifyFile gives every query one
 * consistent verdict.
 *
 * `FileKind` is closed — when a future contributor adds a kind they
 * edit the type, and the compiler forces every consumer's switch to
 * handle it.
 */
import type { ScipDatabase } from '../storage/db.js';
import { buildFileDepGraph } from '../symbols/file-dep-graph.js';
import { createPerDbValue } from '../storage/per-db-cache.js';
import { getSourceFiles } from '../source/source-fileset.js';

export type FileKind =
  | 'entry'   // CLI/server bootstraps, main.rs, top-level index.ts, src/bin/*, scripts
  | 'barrel'  // re-export-only modules: index.ts/js, mod.rs, __init__.py
  | 'worker'  // background workers, child-process entry points (foo.worker.ts, etc.)
  | 'test'    // matches a test file pattern
  | 'source'; // everything else — regular code

/**
 * Classify a file by role. Pure pattern matching — doesn't need a DB.
 * For "is this barrel reachable?" use `isLiveBarrel(db, file)` instead.
 */
export function classifyFile(file: string): FileKind {
  const normalized = normalizePath(file);
  if (matchesTestPattern(normalized)) return 'test';
  if (isWorkerPath(normalized)) return 'worker';
  if (isStructuralEntryPath(normalized)) return 'entry';
  if (isBarrelPath(normalized)) return 'barrel';
  return 'source';
}

// ── Convenience predicates ───────────────────────────────────────

export function isBarrel(file: string): boolean { return classifyFile(file) === 'barrel'; }

// ── Live-barrel transitive closure (DB-dependent) ────────────────

/**
 * The set of barrel files reachable from any entry/worker file via the
 * project's dependency graph. A barrel is "live" when something actually
 * imports it; otherwise it's just dead re-export glue.
 */
export function getLiveBarrelPaths(db: ScipDatabase): Set<string> {
  return liveBarrelCache.get(db, () => {
    const graph = buildFileDepGraph(db);
    const queue = getSourceFiles(db).filter((path) => {
      const kind = classifyFile(path);
      return kind === 'entry' || kind === 'worker';
    });
    const visited = new Set<string>();
    const liveBarrels = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (classifyFile(current) === 'barrel') liveBarrels.add(current);
      for (const dep of graph.get(current) ?? []) {
        if (!visited.has(dep)) queue.push(dep);
      }
    }
    return liveBarrels;
  });
}

const liveBarrelCache = createPerDbValue<Set<string>>('live-barrels');

export function isLiveBarrel(db: ScipDatabase, file: string): boolean {
  return getLiveBarrelPaths(db).has(normalizePath(file));
}

/**
 * Barrel files that exist in the index but no entry/worker reaches.
 * Useful for dead-code skip-barrels: refs from these don't count
 * because the barrels themselves aren't really used.
 */
export function getInactiveBarrelPaths(db: ScipDatabase): string[] {
  const live = getLiveBarrelPaths(db);
  return getSourceFiles(db).filter((path) => isBarrel(path) && !live.has(path));
}

/**
 * `isEntrySurface` covers anything that "looks like" a real entry into the
 * codebase from outside: a structural entry (CLI/main), a worker, or a
 * live barrel. dead-code and health both filter out symbols defined in
 * entry-surface files because the framework dispatches them, not the
 * static graph.
 */
export function isEntrySurface(db: ScipDatabase, file: string): boolean {
  const kind = classifyFile(file);
  return kind === 'entry' || kind === 'worker' || isLiveBarrel(db, file);
}

export function isRootedSymbol(db: ScipDatabase, symbol: string, file: string): boolean {
  const roots = db.config.entryRoots;
  if (!roots) return false;
  const normalized = normalizePath(file);
  if (roots.files?.some((candidate) => normalizePath(candidate) === normalized)) return true;
  if (roots.pathPrefixes?.some((prefix) => normalized.startsWith(normalizePath(prefix)))) return true;
  if (roots.qualifiedVars?.some((qualified) => symbolMatchesQualifiedVar(symbol, qualified))) return true;
  if (roots.symbolPatterns?.some((pattern) => {
    try {
      return new RegExp(pattern).test(symbol);
    } catch {
      return false;
    }
  })) return true;
  return false;
}

// ── Pattern internals ────────────────────────────────────────────

/**
 * SQL LIKE patterns matching common test-file conventions across
 * languages. Used by query-support's TEST_FILE_PATTERNS exports too.
 */
export const TEST_FILE_PATTERNS = [
  '%/__tests__/%',
  '%.test.%',
  '%.spec.%',
  '%/test/%',
  '%/tests/%',
  '%_test.%',
  '%_spec.%',
  '%/test_%.%',
  '%/spec_%.%',
] as const;

/**
 * Path patterns matching test-support files (helpers, utilities) that
 * ride alongside tests.
 */
export const TEST_SUPPORT_PATH_PATTERNS = [
  '%/test-utils/%',
] as const;

function matchesTestPattern(normalized: string): boolean {
  // Direct test files
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(normalized)) return true;
  if (/(?:^|\/)(?:_)?test_[^/]+$/i.test(normalized)) return true;
  if (/(?:^|\/)spec_[^/]+$/i.test(normalized)) return true;
  if (/(?:^|\/)[^/]+_test\.[a-z0-9]+$/i.test(normalized)) return true;
  if (/(?:^|\/)[^/]+_tests\.rs$/i.test(normalized)) return true; // Rust convention for inline-tests modules
  if (/(?:^|\/)tests\.rs$/i.test(normalized)) return true;       // Rust `mod tests;` body file
  if (/(?:^|\/)[^/]+_spec\.[a-z0-9]+$/i.test(normalized)) return true;
  // Test directories (only when path actually traverses them; not bare basenames)
  if (/(?:^|\/)__tests__\//i.test(normalized)) return true;
  if (/(?:^|\/)test\//i.test(normalized)) return true;
  if (/(?:^|\/)tests\//i.test(normalized)) return true;
  if (/(?:^|\/)__fixtures__\//i.test(normalized)) return true;
  if (/(?:^|\/)__mocks__\//i.test(normalized)) return true;
  if (/(?:^|\/)test-support\//i.test(normalized)) return true;
  if (/(?:^|\/)test-utils\//i.test(normalized)) return true;
  if (/(?:^|\/)testing\//i.test(normalized)) return true;
  return false;
}

function isWorkerPath(normalized: string): boolean {
  return /(?:^|\/)[^/]*worker\.(?:ts|tsx|js|mjs|cjs|rs|py|go)$/.test(normalized);
}

function isStructuralEntryPath(normalized: string): boolean {
  const segments = normalized.split('/');
  const basename = segments[segments.length - 1] ?? normalized;

  if (
    basename === 'cli.ts'
    || basename === 'cli.js'
    || basename === 'postinstall.ts'
    || basename === 'postinstall.js'
    || basename === 'main.ts'
    || basename === 'main.js'
    || basename === 'main.rs'
    || basename === 'main.go'
    || basename === 'main.py'
    || basename === 'build.rs'
    || basename === 'lib.rs'
  ) {
    return true;
  }

  // Cargo binary targets: every .rs in src/bin/ or examples/ is an entry
  // point with its own main(). Same for tests/ and benches/.
  if (/\bsrc\/bin\/[^/]+\.rs$/.test(normalized)) return true;
  if (/(?:^|\/)examples\/[^/]+\.rs$/.test(normalized)) return true;
  if (/(?:^|\/)tests\/[^/]+\.rs$/.test(normalized)) return true;
  if (/(?:^|\/)benches\/[^/]+\.rs$/.test(normalized)) return true;

  // Top-level index files only — nested barrels need a live dependency
  // path through these roots before counting as entry surfaces.
  if (basename === 'index.ts' || basename === 'index.js') {
    if (/(?:^|\/)(?:apps|services)\/[^/]+\/src\/index\.(?:ts|js)$/.test(normalized)) return true;
    return segments.length <= 2;
  }

  return false;
}

function isBarrelPath(normalized: string): boolean {
  return normalized === 'index.ts'
    || normalized === 'index.js'
    || normalized.endsWith('/index.ts')
    || normalized.endsWith('/index.js')
    || normalized.endsWith('/mod.rs')
    || normalized.endsWith('/__init__.py');
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function symbolMatchesQualifiedVar(symbol: string, qualified: string): boolean {
  const slash = qualified.lastIndexOf('/');
  if (slash < 0) return false;
  const ns = qualified.slice(0, slash);
  const name = qualified.slice(slash + 1);
  return symbol.includes(formatScipName(ns) + '/')
    && symbol.includes(formatScipName(name) + '.');
}

function formatScipName(value: string): string {
  return /^[A-Za-z0-9_$+-]+$/.test(value)
    ? value
    : '`' + value.replace(/`/g, '``') + '`';
}
