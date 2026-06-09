/**
 * Package surface — the published API surface of a JS/TS package, derived
 * from package.json (`exports`, `main`, `module`, `types`, `browser`, `bin`).
 *
 * Files on this surface are externally live: consumers outside the index can
 * import them, so detectors must not treat their exports as unconsumed.
 * Previously this knowledge was caller folklore — each project had to
 * hand-configure `entryRoots` or detectors would flag published contract
 * types as stale. Deriving it from package.json names the policy once.
 *
 * Build-output targets (dist/, build/, lib/, ...) are mapped back to
 * plausible source paths. Candidates that don't correspond to real indexed
 * files simply never match, so over-generation is harmless.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbValue } from '../storage/per-db-cache.js';

export interface PackageSurface {
  /** Exact relative paths (posix-normalized) that are externally importable. */
  files: Set<string>;
  /** Relative path prefixes from wildcard exports (e.g. `./dist/queries/*`). */
  pathPrefixes: string[];
}

const EMPTY_SURFACE: PackageSurface = { files: new Set(), pathPrefixes: [] };

/** Build-output directories commonly mapped from a `src/` tree. */
const BUILD_DIR_PATTERN = /^(?:dist|build|lib|out|output|esm|cjs|umd)\//;

const TARGET_EXTENSION_PATTERN = /\.(?:d\.ts|d\.mts|d\.cts|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

// Derives from package.json on disk, which can change in watch mode.
const packageSurfaceCache = createPerDbValue<PackageSurface>('package-surface', {
  clearGroups: ['whole-project'],
});

export function getPackageSurface(db: ScipDatabase): PackageSurface {
  return packageSurfaceCache.get(db, () => derivePackageSurface(db.config.projectRoot));
}

// scip-query: ignore-wrapper — surface-membership semantics (exact files +
// wildcard prefixes) stay beside the data structure that defines them.
export function isPackageSurfaceFile(db: ScipDatabase, normalizedRelativePath: string): boolean {
  const surface = getPackageSurface(db);
  if (surface.files.has(normalizedRelativePath)) return true;
  return surface.pathPrefixes.some((prefix) => normalizedRelativePath.startsWith(prefix));
}

export function derivePackageSurface(projectRoot: string): PackageSurface {
  const manifest = readManifest(projectRoot);
  if (!manifest) return EMPTY_SURFACE;

  const files = new Set<string>();
  const pathPrefixes: string[] = [];
  for (const target of collectExportTargets(manifest)) {
    expandTarget(target, files, pathPrefixes);
  }
  return { files, pathPrefixes };
}

function readManifest(projectRoot: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(join(projectRoot, 'package.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Collect every path string the manifest declares as externally reachable:
 * top-level entry fields, every leaf of the (possibly nested, conditional)
 * `exports` map, and `bin` scripts.
 */
function collectExportTargets(manifest: Record<string, unknown>): string[] {
  const targets: string[] = [];
  for (const field of ['main', 'module', 'types', 'browser'] as const) {
    if (typeof manifest[field] === 'string') targets.push(manifest[field]);
  }
  const bin = manifest['bin'];
  if (typeof bin === 'string') targets.push(bin);
  else if (bin && typeof bin === 'object') {
    for (const value of Object.values(bin)) {
      if (typeof value === 'string') targets.push(value);
    }
  }
  collectExportsLeaves(manifest['exports'], targets);
  return targets;
}

function collectExportsLeaves(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const value of Object.values(node)) {
    collectExportsLeaves(value, out);
  }
}

/**
 * Expand one export target into the source paths it plausibly corresponds
 * to: the target itself (source-published packages) plus the same path with
 * the build directory swapped for `src/` or stripped, across common source
 * extensions.
 */
function expandTarget(target: string, files: Set<string>, pathPrefixes: string[]): void {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '' || normalized.startsWith('..')) return;

  const wildcard = normalized.indexOf('*');
  if (wildcard >= 0) {
    const prefix = normalized.slice(0, wildcard);
    for (const variant of pathVariants(prefix)) {
      if (variant !== '') pathPrefixes.push(variant);
    }
    return;
  }

  const base = normalized.replace(TARGET_EXTENSION_PATTERN, '');
  for (const variant of pathVariants(base)) {
    if (variant === base && variant === normalized) files.add(normalized);
    for (const extension of SOURCE_EXTENSIONS) {
      files.add(variant + extension);
    }
  }
  // Keep the literal target too — source-published packages export real files.
  files.add(normalized);
}

/** The path as written, with its build dir swapped for `src/`, and stripped. */
function pathVariants(path: string): string[] {
  const variants = [path];
  if (BUILD_DIR_PATTERN.test(path)) {
    variants.push(path.replace(BUILD_DIR_PATTERN, 'src/'));
    variants.push(path.replace(BUILD_DIR_PATTERN, ''));
  }
  return variants;
}
