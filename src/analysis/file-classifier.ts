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
import { compileBoundedRegExp } from '../domain/bounded-regexp.js';
import { buildFileDepGraph } from '../symbols/graph/file-dep-graph.js';
import { createPerDbValue } from '../storage/per-db-cache.js';
import { sourceEvidence } from '../language-parsers/source-evidence.js';
import { indexedDocumentPaths } from '../storage/scip-documents.js';
import { normalizePathSeparators as normalizePath } from '../domain/path-normalization.js';
import { leafName } from '../symbols/symbol-parser.js';
import { getReExports } from '../language-parsers/index.js';
import { isExplicitPackageSurfaceFile, isPackageSurfaceFile } from './package-surface.js';
import { isRustPublicLibrarySymbol } from './rust-package-surface.js';
import { classifyFile } from '../source/primitives/file-kind.js';
import { isFrameworkTaskFile } from './framework-task-surface.js';

export { classifyFile, fileKindRank, type FileKind } from '../source/primitives/file-kind.js';

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
  return (
    kind === 'entry' ||
    kind === 'worker' ||
    isFrameworkEntrypointPath(normalized) ||
    isFrameworkTaskFile(db, normalized) ||
    isLiveBarrel(db, normalized)
  );
}

/**
 * True when the symbol is externally live — reachable by consumers the index
 * cannot see. Two sources, merged: the package surface derived from
 * package.json (exports/main/bin), and explicit `entryRoots` config.
 */
export type RootedSymbolEvidence =
  | 'package-surface-file'
  | 'transitive-package-surface'
  | 'rust-public-library'
  | 'framework-entrypoint'
  | 'configured-file'
  | 'configured-path-prefix'
  | 'configured-qualified-var'
  | 'configured-symbol-pattern';

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function rootedSymbolEvidence(db: ScipDatabase, symbol: string, file: string): RootedSymbolEvidence[] {
  const normalized = normalizePath(file);
  const evidence: RootedSymbolEvidence[] = [];
  if (isPackageSurfaceFile(db, normalized)) evidence.push('package-surface-file');
  if (isTransitivelyPackageSurfaceSymbol(db, symbol, normalized)) evidence.push('transitive-package-surface');
  if (isRustPublicLibrarySymbol(db, symbol, normalized)) evidence.push('rust-public-library');
  if (isFrameworkDiscoveredEntrypointSymbol(symbol, normalized)) evidence.push('framework-entrypoint');
  const roots = db.config.entryRoots;
  if (!roots) return evidence;
  if (roots.files?.some((candidate) => normalizePath(candidate) === normalized)) evidence.push('configured-file');
  if (roots.pathPrefixes?.some((prefix) => normalized.startsWith(normalizePath(prefix)))) {
    evidence.push('configured-path-prefix');
  }
  if (roots.qualifiedVars?.some((qualified) => symbolMatchesQualifiedVar(symbol, qualified))) {
    evidence.push('configured-qualified-var');
  }
  if (
    roots.symbolPatterns?.some((pattern) => {
      try {
        return compileBoundedRegExp(pattern, 'entryRoots.symbolPatterns entry').test(symbol);
      } catch {
        return false;
      }
    })
  )
    evidence.push('configured-symbol-pattern');
  return evidence;
}

export function isRootedSymbol(db: ScipDatabase, symbol: string, file: string): boolean {
  return rootedSymbolEvidence(db, symbol, file).length > 0;
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
const explicitPackageSurfaceReachabilityCache = createPerDbValue<Map<string, PackageSurfaceVisibility>>(
  'explicit-package-surface-reachability',
  { clearGroups: ['whole-project'] },
);

function isTransitivelyPackageSurfaceSymbol(db: ScipDatabase, symbol: string, file: string): boolean {
  const visibility = packageSurfaceReachability(db).get(file);
  if (visibility === undefined) return false;
  return visibility === null || visibility.has(leafName(symbol));
}

/**
 * True when a symbol is published from an exact manifest target, either in
 * that file or through its re-export closure. This is the stronger subset of
 * package reachability; wildcard targets remain valid public reachability but
 * do not identify an intentional ownership doorway as precisely.
 */
export function isExplicitPackageSurfaceSymbol(db: ScipDatabase, symbol: string, file: string): boolean {
  const visibility = explicitPackageSurfaceReachability(db).get(file);
  if (visibility === undefined) return false;
  return visibility === null || visibility.has(leafName(symbol));
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function packageSurfaceReachability(db: ScipDatabase): Map<string, PackageSurfaceVisibility> {
  return packageSurfaceReachabilityCache.get(db, () => {
    return computePackageSurfaceReachability(db, (path) => isPackageSurfaceFile(db, path));
  });
}

function explicitPackageSurfaceReachability(db: ScipDatabase): Map<string, PackageSurfaceVisibility> {
  return explicitPackageSurfaceReachabilityCache.get(db, () => {
    return computePackageSurfaceReachability(db, (path) => isExplicitPackageSurfaceFile(db, path));
  });
}

function computePackageSurfaceReachability(
  db: ScipDatabase,
  isSurfaceFile: (path: string) => boolean,
): Map<string, PackageSurfaceVisibility> {
  const visibility = new Map<string, PackageSurfaceVisibility>();
  const queue: string[] = [];

  for (const path of indexedDocumentPaths(db, { includeIgnored: false })) {
    if (!isSurfaceFile(path)) continue;
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
}

function propagatedReexportVisibility(
  current: PackageSurfaceVisibility,
  reexport: ReturnType<typeof getReExports>[number],
): PackageSurfaceVisibility | undefined {
  if (current === null) {
    return reexport.kind === 'named' ? new Set(reexport.names) : null;
  }
  if (reexport.kind === 'star') return new Set(current);
  if (reexport.kind === 'star-as') {
    return reexport.names.some((name) => current.has(name)) ? null : undefined;
  }
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
const NEXT_MIDDLEWARE_EXPORTS = new Set(['default', 'middleware', 'config']);
const NEXT_INSTRUMENTATION_EXPORTS = new Set(['register', 'onRequestError']);
const NEXT_INSTRUMENTATION_CLIENT_EXPORTS = new Set(['onRouterTransitionStart']);
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
  if (isNextMiddlewarePath(normalized)) return NEXT_MIDDLEWARE_EXPORTS.has(name);
  if (isNextInstrumentationPath(normalized)) return NEXT_INSTRUMENTATION_EXPORTS.has(name);
  if (isNextInstrumentationClientPath(normalized)) return NEXT_INSTRUMENTATION_CLIENT_EXPORTS.has(name);
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
    isNextInstrumentationPath(normalized) ||
    isNextInstrumentationClientPath(normalized) ||
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
  return matchesNextRootConvention(normalized, '(?:middleware|proxy)\\.(?:ts|js|mts|mjs)');
}

function isNextInstrumentationPath(normalized: string): boolean {
  return matchesNextRootConvention(normalized, 'instrumentation\\.(?:ts|js|mts|mjs)');
}

function isNextInstrumentationClientPath(normalized: string): boolean {
  return matchesNextRootConvention(normalized, 'instrumentation-client\\.(?:ts|js|mts|mjs)');
}

function matchesNextRootConvention(normalized: string, basename: string): boolean {
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
