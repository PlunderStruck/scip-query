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
import { buildFileDepGraph } from '../symbols/graph/file-dep-graph.js';
import { createPerDbValue } from '../storage/per-db-cache.js';
import { sourceEvidence } from '../source/source-evidence.js';
import { indexedDocumentPaths } from '../storage/scip-documents.js';
import { normalizePathSeparators as normalizePath } from '../domain/path-normalization.js';
import { leafName } from '../symbols/symbol-parser.js';
import { getReExports } from '../language-parsers/index.js';
import { isPackageSurfaceFile } from './package-surface.js';
import { isRustPublicLibrarySymbol } from './rust-package-surface.js';

export type FileKind =
  | 'entry' // CLI/server bootstraps, main.rs, top-level index.ts, src/bin/*, scripts
  | 'barrel' // re-export-only modules: index.ts/js, mod.rs, __init__.py
  | 'worker' // background workers, child-process entry points (foo.worker.ts, etc.)
  | 'test' // matches a test file pattern
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

export function isBarrel(file: string): boolean {
  return classifyFile(file) === 'barrel';
}

// ── Live-barrel transitive closure (DB-dependent) ────────────────

/**
 * The set of barrel files reachable from any entry/worker file via the
 * project's dependency graph. A barrel is "live" when something actually
 * imports it; otherwise it's just dead re-export glue.
 */
export function getLiveBarrelPaths(db: ScipDatabase): Set<string> {
  return liveBarrelCache.get(db, () => {
    const sourcePaths = indexedDocumentPaths(db, { includeIgnored: false });
    const queue = sourcePaths.filter((path) => {
      const kind = classifyFile(path);
      return kind === 'entry' || kind === 'worker';
    });
    if (queue.length === 0) return new Set<string>();

    const graph = buildFileDepGraph(db);
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

// Derives from the dep graph + source files, so it must drop when they do.
const liveBarrelCache = createPerDbValue<Set<string>>('live-barrels', {
  clearGroups: ['whole-project'],
});

export function isLiveBarrel(db: ScipDatabase, file: string): boolean {
  return getLiveBarrelPaths(db).has(normalizePath(file));
}

/**
 * Barrel files that exist in the index but no entry/worker reaches.
 * Useful for dead-code skip-barrels: refs from these don't count
 * because the barrels themselves aren't really used.
 *
 * A file that DEFINES functions is not re-export glue, whatever its name —
 * server entrypoints are routinely called `backend/src/index.ts`, nothing
 * imports them, and discarding their outgoing references made everything
 * they exclusively use look dead (caught live by cleanup-plan --verify).
 */
// scip-query: ignore-wrapper — skip-barrels policy stays in the classifier so
// dead.ts does not duplicate live-barrel and function-entry rules.
export function getInactiveBarrelPaths(db: ScipDatabase): string[] {
  const live = getLiveBarrelPaths(db);
  return indexedDocumentPaths(db, { includeIgnored: false }).filter(
    (path) => isBarrel(path) && !live.has(path) && !definesFunctions(db, path),
  );
}

function definesFunctions(db: ScipDatabase, relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  // AST callables catch arrow functions whose SCIP symbols carry no
  // function marker (`const shutdown = async () => {...}`).
  const callables = sourceEvidence(db).forFile(normalized, { facts: true }).facts?.callables;
  if (callables && callables.length > 0) return true;
  // Fallback without an AST: any multi-line definition is real code,
  // not a re-export line.
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM defn_enclosing_ranges der
     JOIN documents d ON d.id = der.document_id
     WHERE d.relative_path = ?
       AND der.end_line - der.start_line >= 2`,
    normalized,
  );
  return (row?.n ?? 0) > 0;
}

/**
 * `isEntrySurface` covers anything that "looks like" a real entry into the
 * codebase from outside: a structural entry (CLI/main), a worker, or a
 * live barrel. dead-code and health both filter out symbols defined in
 * entry-surface files because the framework dispatches them, not the
 * static graph.
 */
export function isEntrySurface(db: ScipDatabase, file: string): boolean {
  const normalized = normalizePath(file);
  const kind = classifyFile(file);
  return kind === 'entry' || kind === 'worker' || isFrameworkEntrypointPath(normalized) || isLiveBarrel(db, normalized);
}

/**
 * True when the symbol is externally live — reachable by consumers the index
 * cannot see. Two sources, merged: the package surface derived from
 * package.json (exports/main/bin), and explicit `entryRoots` config.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function isRootedSymbol(db: ScipDatabase, symbol: string, file: string): boolean {
  const normalized = normalizePath(file);
  if (isPackageSurfaceFile(db, normalized)) return true;
  if (isTransitivelyPackageSurfaceSymbol(db, symbol, normalized)) return true;
  if (isRustPublicLibrarySymbol(db, symbol, normalized)) return true;
  if (isFrameworkDiscoveredEntrypointSymbol(symbol, normalized)) return true;
  const roots = db.config.entryRoots;
  if (!roots) return false;
  if (roots.files?.some((candidate) => normalizePath(candidate) === normalized)) return true;
  if (roots.pathPrefixes?.some((prefix) => normalized.startsWith(normalizePath(prefix)))) return true;
  if (roots.qualifiedVars?.some((qualified) => symbolMatchesQualifiedVar(symbol, qualified))) return true;
  if (
    roots.symbolPatterns?.some((pattern) => {
      try {
        return new RegExp(pattern).test(symbol);
      } catch {
        return false;
      }
    })
  )
    return true;
  return false;
}

type PackageSurfaceVisibility = Set<string> | null;

// `null` means every export from the file is externally visible. A Set means
// only those names were propagated through a named re-export. This closure is
// deliberately based on re-export edges, not ordinary imports: a public entry
// file may depend on private implementation modules without publishing them.
const packageSurfaceReachabilityCache = createPerDbValue<Map<string, PackageSurfaceVisibility>>(
  'package-surface-reachability',
  { clearGroups: ['whole-project'] },
);

function isTransitivelyPackageSurfaceSymbol(db: ScipDatabase, symbol: string, file: string): boolean {
  const visibility = packageSurfaceReachability(db).get(file);
  if (visibility === undefined) return false;
  return visibility === null || visibility.has(leafName(symbol));
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function packageSurfaceReachability(db: ScipDatabase): Map<string, PackageSurfaceVisibility> {
  return packageSurfaceReachabilityCache.get(db, () => {
    const visibility = new Map<string, PackageSurfaceVisibility>();
    const queue: string[] = [];

    for (const path of indexedDocumentPaths(db, { includeIgnored: false })) {
      if (!isPackageSurfaceFile(db, path)) continue;
      visibility.set(path, null);
      queue.push(path);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentVisibility = visibility.get(current);
      if (currentVisibility === undefined) continue;

      for (const reexport of getReExports(db, current)) {
        if (!reexport.sourcePath || db.isIgnored(reexport.sourcePath)) continue;
        const propagated = propagatedReexportVisibility(currentVisibility, reexport);
        if (propagated === undefined) continue;
        if (mergePackageVisibility(visibility, reexport.sourcePath, propagated)) queue.push(reexport.sourcePath);
      }
    }

    return visibility;
  });
}

function propagatedReexportVisibility(
  current: PackageSurfaceVisibility,
  reexport: ReturnType<typeof getReExports>[number],
): PackageSurfaceVisibility | undefined {
  if (current === null) {
    return reexport.kind === 'named' ? new Set(reexport.names) : null;
  }
  if (reexport.kind === 'star') return new Set(current);
  if (reexport.kind === 'star-as') return undefined;
  const names = reexport.names.filter((name) => current.has(name));
  return names.length > 0 ? new Set(names) : undefined;
}

function mergePackageVisibility(
  visibility: Map<string, PackageSurfaceVisibility>,
  file: string,
  incoming: PackageSurfaceVisibility,
): boolean {
  if (!visibility.has(file)) {
    visibility.set(file, incoming);
    return true;
  }
  const existing = visibility.get(file);
  if (existing === undefined) return false;
  if (existing === null || incoming === null) {
    if (existing === null) return false;
    visibility.set(file, null);
    return true;
  }
  let changed = false;
  for (const name of incoming) {
    if (existing.has(name)) continue;
    existing.add(name);
    changed = true;
  }
  return changed;
}

// ── Pattern internals ────────────────────────────────────────────

const HTTP_METHOD_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const NEXT_APP_PAGE_EXPORTS = new Set(['default', 'generateMetadata', 'generateStaticParams']);
const NEXT_PAGES_EXPORTS = new Set(['default', 'getStaticProps', 'getServerSideProps', 'getStaticPaths', 'config']);
const REMIX_ROUTE_EXPORTS = new Set([
  'default',
  'loader',
  'action',
  'clientLoader',
  'clientAction',
  'headers',
  'links',
  'meta',
  'shouldRevalidate',
  'ErrorBoundary',
  'HydrateFallback',
]);
const SVELTEKIT_ROUTE_EXPORTS = new Set(['load', 'actions', 'entries', ...HTTP_METHOD_EXPORTS]);
const VITE_ROUTE_EXPORTS = new Set(['default']);

// scip-query: ignore-similar — symbol and path entrypoint policies intentionally recognize different cases.
function isFrameworkDiscoveredEntrypointSymbol(symbol: string, normalized: string): boolean {
  const name = leafName(symbol);
  if (name === '') return false;
  if (isNextAppRoutePath(normalized)) return HTTP_METHOD_EXPORTS.has(name);
  if (isNextAppPagePath(normalized)) return NEXT_APP_PAGE_EXPORTS.has(name);
  if (isNextPagesPath(normalized)) return NEXT_PAGES_EXPORTS.has(name);
  if (isRemixRoutePath(normalized)) return REMIX_ROUTE_EXPORTS.has(name);
  if (isSvelteKitRoutePath(normalized)) return SVELTEKIT_ROUTE_EXPORTS.has(name);
  if (isViteRoutePath(normalized)) return VITE_ROUTE_EXPORTS.has(name);
  return false;
}

/**
 * Files whose framework discovers them by path rather than an ordinary
 * import. The whole file is an external entry boundary: static references
 * cannot prove its exported handler/component dead, and suppressing private
 * helpers here is the conservative tradeoff required for deletion advice.
 */
export function isFrameworkEntrypointPath(normalized: string): boolean {
  return (
    isNextAppRoutePath(normalized) ||
    isNextAppPagePath(normalized) ||
    isNextPagesPath(normalized) ||
    isNextMiddlewarePath(normalized) ||
    isRemixRoutePath(normalized) ||
    isSvelteKitRoutePath(normalized)
  );
}

function isNextAppRoutePath(normalized: string): boolean {
  return /(?:^|\/)app(?:\/[^/]+)*\/route\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalized);
}

function isNextAppPagePath(normalized: string): boolean {
  return /(?:^|\/)app(?:\/[^/]+)*\/(?:page|layout|template|loading|error|not-found|global-error|head|default)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(
    normalized,
  );
}

function isNextPagesPath(normalized: string): boolean {
  return /(?:^|\/)pages\/.+\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalized);
}

function isNextMiddlewarePath(normalized: string): boolean {
  const basename = '(?:middleware|proxy|instrumentation)\\.(?:ts|js|mts|mjs)';
  return (
    new RegExp(`^(?:src/)?${basename}$`).test(normalized) ||
    new RegExp(`(?:^|/)src/${basename}$`).test(normalized) ||
    new RegExp(`(?:^|/)(?:apps|services|packages)/[^/]+/(?:src/)?${basename}$`).test(normalized)
  );
}

function isRemixRoutePath(normalized: string): boolean {
  return /(?:^|\/)app\/routes\/.+\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalized);
}

function isSvelteKitRoutePath(normalized: string): boolean {
  return /(?:^|\/)src\/routes\/(?:.*\/)?\+(?:page|page\.server|layout|layout\.server|server)\.(?:ts|js)$/.test(
    normalized,
  );
}

function isViteRoutePath(normalized: string): boolean {
  return /(?:^|\/)src\/(?:pages|views|routes)\/.+\.(?:ts|tsx|js|jsx|vue)$/.test(normalized);
}

function matchesTestPattern(normalized: string): boolean {
  // Direct test files
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(normalized)) return true;
  if (/(?:^|\/)(?:_)?test_[^/]+$/i.test(normalized)) return true;
  if (/(?:^|\/)spec_[^/]+$/i.test(normalized)) return true;
  if (/(?:^|\/)[^/]+_test\.[a-z0-9]+$/i.test(normalized)) return true;
  if (/(?:^|\/)[^/]+_tests\.rs$/i.test(normalized)) return true; // Rust convention for inline-tests modules
  if (/(?:^|\/)tests\.rs$/i.test(normalized)) return true; // Rust `mod tests;` body file
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
    basename === 'cli.ts' ||
    basename === 'cli.js' ||
    basename === 'postinstall.ts' ||
    basename === 'postinstall.js' ||
    basename === 'main.ts' ||
    basename === 'main.js' ||
    basename === 'main.rs' ||
    basename === 'main.go' ||
    basename === 'main.py' ||
    basename === 'build.rs' ||
    basename === 'lib.rs'
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
  return (
    normalized === 'index.ts' ||
    normalized === 'index.js' ||
    normalized.endsWith('/index.ts') ||
    normalized.endsWith('/index.js') ||
    normalized.endsWith('/mod.rs') ||
    normalized.endsWith('/__init__.py')
  );
}

function symbolMatchesQualifiedVar(symbol: string, qualified: string): boolean {
  const slash = qualified.lastIndexOf('/');
  if (slash < 0) return false;
  const ns = qualified.slice(0, slash);
  const name = qualified.slice(slash + 1);
  return symbol.includes(formatScipName(ns) + '/') && symbol.includes(formatScipName(name) + '.');
}

function formatScipName(value: string): string {
  return /^[A-Za-z0-9_$+-]+$/.test(value) ? value : '`' + value.replace(/`/g, '``') + '`';
}
