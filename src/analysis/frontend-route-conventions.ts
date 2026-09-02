/**
 * Frontend route conventions — path-only facts about files a framework
 * router discovers by convention (Next.js app router pages, layouts,
 * intercepting routes).
 *
 * Two route entry files share structure because the framework dictates it
 * (auth check, query hydration, render the client) — that is scaffolding,
 * not duplication a reviewer can consolidate without changing the routing
 * contract. An intercepting route and the route it intercepts are supposed
 * to render one view; when both bodies match, the missing shared component
 * is the finding, and the recommendation must say so rather than propose a
 * hook.
 */
import { normalizePathSeparators as normalizePath } from '../domain/path-normalization.js';

const ROUTE_ENTRY_BASENAMES = new Set([
  'page',
  'layout',
  'template',
  'loading',
  'error',
  'not-found',
  'global-error',
  'default',
  'route',
]);
const ROUTE_FILE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const INTERCEPT_MARKER = /^\((\.{1,3})\)(.*)$/;
const DOUBLE_INTERCEPT_MARKER = /^\(\.\.\)\(\.\.\)(.*)$/;

export interface NextRouteIdentity {
  /** Route segments with groups, slots, and intercept markers resolved. */
  route: string[];
  /** The convention file name without extension (`page`, `layout`, ...). */
  entry: string;
  /** True when one segment carried an intercepting-route marker. */
  intercepting: boolean;
}

/** True for Next.js app-router files the framework discovers by file name. */
export function isNextRouteEntryFile(file: string): boolean {
  return nextRouteIdentity(file) !== null;
}

/**
 * Resolve a Next.js app-router file to its effective route. Route groups
 * `(marketing)` are transparent, parallel slots `@modal` are transparent,
 * and intercept markers rewrite the segment they prefix: `(.)photo` stays at
 * the current level, `(..)photo` climbs one route level, `(..)(..)photo`
 * climbs two, and `(...)photo` restarts at the app root.
 */
// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the segment rewrite rules are one routing convention.
export function nextRouteIdentity(file: string): NextRouteIdentity | null {
  const normalized = normalizePath(file);
  if (!ROUTE_FILE_EXTENSIONS.test(normalized)) return null;
  const segments = normalized.split('/');
  const basename = segments[segments.length - 1]!.replace(ROUTE_FILE_EXTENSIONS, '');
  if (!ROUTE_ENTRY_BASENAMES.has(basename)) return null;
  const appIndex = segments.findIndex((segment, index) => segment === 'app' && index < segments.length - 1);
  if (appIndex < 0) return null;

  const route: string[] = [];
  let intercepting = false;
  for (const segment of segments.slice(appIndex + 1, -1)) {
    if (segment.startsWith('@')) continue;
    const doubleIntercept = DOUBLE_INTERCEPT_MARKER.exec(segment);
    if (doubleIntercept) {
      intercepting = true;
      route.splice(Math.max(0, route.length - 2));
      route.push(doubleIntercept[1]!);
      continue;
    }
    const intercept = INTERCEPT_MARKER.exec(segment);
    if (intercept) {
      intercepting = true;
      const marker = intercept[1]!;
      if (marker === '..') route.splice(Math.max(0, route.length - 1));
      else if (marker === '...') route.splice(0);
      route.push(intercept[2]!);
      continue;
    }
    if (segment.startsWith('(') && segment.endsWith(')')) continue;
    route.push(segment);
  }
  return { route, entry: basename, intercepting };
}

/**
 * True when one file is a Next.js intercepting route and the other is the
 * route it intercepts (or both intercept the same target). Such pairs are
 * meant to render the same view; their shared structure is the routing
 * contract, and the actionable finding is a missing shared component.
 */
export function isInterceptingRoutePair(fileA: string, fileB: string): boolean {
  const left = nextRouteIdentity(fileA);
  const right = nextRouteIdentity(fileB);
  if (!left || !right) return false;
  if (!left.intercepting && !right.intercepting) return false;
  if (left.entry !== right.entry) return false;
  return left.route.join('/') === right.route.join('/');
}
