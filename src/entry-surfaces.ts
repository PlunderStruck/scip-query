import type { ScipDatabase } from './db.js';
import { buildFileDepGraph } from './query-support.js';

const liveBarrelCache = new WeakMap<ScipDatabase, Set<string>>();

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function isBarrelFile(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === 'index.ts'
    || normalized === 'index.js'
    || normalized.endsWith('/index.ts')
    || normalized.endsWith('/index.js')
    || normalized.endsWith('/mod.rs')
    || normalized.endsWith('/__init__.py');
}

export function isWorkerEntrySurface(path: string): boolean {
  const normalized = normalizePath(path);
  return /(^|\/)[^/]*worker\.(ts|js|mjs|cjs|rs|py|go)$/.test(normalized);
}

export function isStructuralEntrySurface(path: string): boolean {
  const normalized = normalizePath(path);
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
  ) {
    return true;
  }

  if (basename === 'index.ts' || basename === 'index.js') {
    // Treat only top-level index files as structural entry surfaces.
    // Nested barrels need a live dependency path from one of these roots.
    return segments.length <= 2;
  }

  return normalized.endsWith('/mod.rs') || normalized.endsWith('/__init__.py');
}

function getIndexedPaths(db: ScipDatabase): string[] {
  return db.all<{ relative_path: string }>(
    `SELECT d.relative_path
     FROM documents d
     WHERE 1 = 1
       ${db.pathExclusionsFor('d')}
     ORDER BY d.relative_path`,
  )
    .map((row) => row.relative_path)
    .filter((path) => !db.isIgnored(path));
}

export function getLiveBarrelPaths(db: ScipDatabase): Set<string> {
  const cached = liveBarrelCache.get(db);
  if (cached) {
    return cached;
  }

  const graph = buildFileDepGraph(db);
  const queue = getIndexedPaths(db).filter((path) =>
    isStructuralEntrySurface(path) || isWorkerEntrySurface(path),
  );
  const visited = new Set<string>();
  const liveBarrels = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    if (isBarrelFile(current)) {
      liveBarrels.add(current);
    }

    for (const dep of graph.get(current) ?? []) {
      if (!visited.has(dep)) {
        queue.push(dep);
      }
    }
  }

  liveBarrelCache.set(db, liveBarrels);
  return liveBarrels;
}

export function isLiveBarrel(db: ScipDatabase, path: string): boolean {
  return getLiveBarrelPaths(db).has(normalizePath(path));
}

export function isEntrySurface(db: ScipDatabase, path: string): boolean {
  return isStructuralEntrySurface(path)
    || isWorkerEntrySurface(path)
    || isLiveBarrel(db, path);
}

export function getInactiveBarrelPaths(db: ScipDatabase): string[] {
  const liveBarrels = getLiveBarrelPaths(db);
  return getIndexedPaths(db)
    .filter((path) => isBarrelFile(path))
    .filter((path) => !liveBarrels.has(path));
}
