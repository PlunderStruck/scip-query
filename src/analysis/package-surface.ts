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
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMissingProjectFileError, readProjectFileText } from '../source/primitives/project-file-boundary.js';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbValue } from '../storage/per-db-cache.js';

export interface PackageSurface {
  /** Exact relative paths (posix-normalized) that are externally importable. */
  files: Set<string>;
  /** Relative path prefixes from wildcard exports (e.g. `./dist/queries/*`). */
  pathPrefixes: string[];
}

export interface PackageOperationalSurface {
  /** Source candidates launched as package binaries or script processes. */
  reasonsByFile: Map<string, string[]>;
}

const EMPTY_SURFACE: PackageSurface = { files: new Set(), pathPrefixes: [] };
const EMPTY_OPERATIONAL_SURFACE: PackageOperationalSurface = { reasonsByFile: new Map() };

/** Build-output directories commonly mapped from a `src/` tree. */
const BUILD_DIR_PATTERN = /^(?:dist|build|lib|out|output|esm|cjs|umd)\//;

const TARGET_EXTENSION_PATTERN = /\.(?:d\.ts|d\.mts|d\.cts|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

const PACKAGE_MANIFEST_SCAN_EXCLUSIONS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

const MAX_PACKAGE_MANIFEST_DEPTH = 4;

// Derives from package.json on disk, which can change in watch mode.
const packageSurfaceCache = createPerDbValue<PackageSurface>('package-surface', {
  clearGroups: ['whole-project'],
});
const packageOperationalSurfaceCache = createPerDbValue<PackageOperationalSurface>('package-operational-surface', {
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

/**
 * True when a manifest target names this file exactly. Unlike a wildcard
 * surface, an explicit surface identifies one deliberate package doorway;
 * both are externally reachable, but the exact doorway is stronger evidence
 * when choosing an explanatory ownership path.
 */
export function isExplicitPackageSurfaceFile(db: ScipDatabase, normalizedRelativePath: string): boolean {
  return getPackageSurface(db).files.has(normalizedRelativePath);
}

export function getPackageOperationalSurface(db: ScipDatabase): PackageOperationalSurface {
  return packageOperationalSurfaceCache.get(db, () => derivePackageOperationalSurface(db.config.projectRoot));
}

export function packageOperationalRootReasons(db: ScipDatabase, normalizedRelativePath: string): string[] {
  return getPackageOperationalSurface(db).reasonsByFile.get(normalizedRelativePath) ?? [];
}

export function derivePackageSurface(projectRoot: string): PackageSurface {
  const files = new Set<string>();
  const pathPrefixes: string[] = [];
  for (const { manifest, packageRoot } of readPackageManifests(projectRoot)) {
    for (const target of collectExportTargets(manifest)) {
      expandTarget(projectRoot, packageRoot, target, files, pathPrefixes);
    }
  }
  if (files.size === 0 && pathPrefixes.length === 0) return EMPTY_SURFACE;
  return { files, pathPrefixes };
}

export function derivePackageOperationalSurface(projectRoot: string): PackageOperationalSurface {
  const reasonsByFile = new Map<string, string[]>();
  for (const { manifest, packageRoot } of readPackageManifests(projectRoot)) {
    const binTargets = collectBinTargets(manifest);
    for (const target of binTargets) {
      addOperationalTarget(projectRoot, packageRoot, target, 'package binary', reasonsByFile);
    }
    const scripts = manifest['scripts'];
    if (!scripts || typeof scripts !== 'object') continue;
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== 'string') continue;
      for (const target of executableScriptTargets(command)) {
        addOperationalTarget(projectRoot, packageRoot, target, `package script "${name}"`, reasonsByFile);
      }
    }
  }
  return reasonsByFile.size === 0 ? EMPTY_OPERATIONAL_SURFACE : { reasonsByFile };
}

interface PackageManifestEntry {
  manifest: Record<string, unknown>;
  packageRoot: string;
}

function readPackageManifests(projectRoot: string): PackageManifestEntry[] {
  const entries: PackageManifestEntry[] = [];
  const rootManifest = readManifestAt(projectRoot, '');
  if (rootManifest) entries.push({ manifest: rootManifest, packageRoot: '' });
  collectNestedPackageManifests(projectRoot, '', entries, 0);
  return entries;
}

function collectNestedPackageManifests(
  projectRoot: string,
  relativeDirectory: string,
  entries: PackageManifestEntry[],
  depth: number,
): void {
  if (depth >= MAX_PACKAGE_MANIFEST_DEPTH) return;
  const absoluteDirectory = join(projectRoot, relativeDirectory);
  if (!existsSync(absoluteDirectory)) return;

  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (PACKAGE_MANIFEST_SCAN_EXCLUSIONS.has(entry.name)) continue;

    const childRelative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const manifest = readManifestAt(projectRoot, childRelative);
    if (manifest) entries.push({ manifest, packageRoot: childRelative });
    collectNestedPackageManifests(projectRoot, childRelative, entries, depth + 1);
  }
}

function readManifestAt(projectRoot: string, packageRoot: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readProjectFileText(projectRoot, join(packageRoot, 'package.json'), {
      maxBytes: 8 * 1024 * 1024,
      inputKind: 'package manifest',
    });
  } catch (error) {
    if (!isMissingProjectFileError(error)) throw error;
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
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

function collectBinTargets(manifest: Record<string, unknown>): string[] {
  const bin = manifest['bin'];
  if (typeof bin === 'string') return [bin];
  if (!bin || typeof bin !== 'object') return [];
  return Object.values(bin).filter((value): value is string => typeof value === 'string');
}

function executableScriptTargets(command: string): string[] {
  const targets: string[] = [];
  const launcher =
    /(?:^|&&|\|\||;)\s*(?:(?:cross-env|env)(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+)?(?:node|bun|tsx|ts-node|vite-node|python3?|deno\s+run)\s+(?:(?:--?[A-Za-z0-9-]+(?:=\S+)?)\s+)*["']?([^"'`\s]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py))["']?/g;
  for (const match of command.matchAll(launcher)) {
    const target = match[1];
    if (target && !target.startsWith('node_modules/') && !target.startsWith('./node_modules/')) targets.push(target);
  }
  return targets;
}

function addOperationalTarget(
  projectRoot: string,
  packageRoot: string,
  target: string,
  reason: string,
  reasonsByFile: Map<string, string[]>,
): void {
  const candidates = new Set<string>();
  expandTarget(projectRoot, packageRoot, target, candidates, []);
  for (const candidate of candidates) {
    const reasons = reasonsByFile.get(candidate) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    reasonsByFile.set(candidate, reasons);
  }
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
function expandTarget(
  projectRoot: string,
  packageRoot: string,
  target: string,
  files: Set<string>,
  pathPrefixes: string[],
): void {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '' || normalized.startsWith('..')) return;

  const wildcard = normalized.indexOf('*');
  if (wildcard >= 0) {
    const prefix = normalized.slice(0, wildcard);
    for (const variant of pathVariants(prefix)) {
      if (variant !== '') pathPrefixes.push(packagePath(packageRoot, variant));
    }
    return;
  }

  const base = normalized.replace(TARGET_EXTENSION_PATTERN, '');
  for (const variant of pathVariants(base)) {
    if (variant === base && variant === normalized) files.add(packagePath(packageRoot, normalized));
    for (const extension of SOURCE_EXTENSIONS) {
      addSourceCandidate(projectRoot, files, packageRoot, variant + extension);
    }
  }
  // Keep the literal target too — source-published packages export real files.
  files.add(packagePath(packageRoot, normalized));
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

function addSourceCandidate(projectRoot: string, files: Set<string>, packageRoot: string, candidate: string): void {
  const projectRelativeCandidate = packagePath(packageRoot, candidate);
  files.add(projectRelativeCandidate);
  if (!candidate.startsWith('src/') || existsSync(join(projectRoot, projectRelativeCandidate))) return;

  const extension = SOURCE_EXTENSIONS.find((entry) => candidate.endsWith(entry));
  if (!extension) return;

  const withoutExtension = candidate.slice(0, -extension.length);
  addDirectoryIndexCandidate(projectRoot, files, packageRoot, withoutExtension, extension);

  const slash = withoutExtension.lastIndexOf('/');
  if (slash <= 'src/'.length) return;

  const directory = withoutExtension.slice(0, slash);
  const basename = withoutExtension.slice(slash + 1);
  for (const match of nestedSourceCandidates(projectRoot, packageRoot, directory, `${basename}${extension}`)) {
    files.add(match);
  }
}

function addDirectoryIndexCandidate(
  projectRoot: string,
  files: Set<string>,
  packageRoot: string,
  withoutExtension: string,
  extension: (typeof SOURCE_EXTENSIONS)[number],
): void {
  const indexCandidate = packagePath(packageRoot, `${withoutExtension}/index${extension}`);
  if (existsSync(join(projectRoot, indexCandidate))) files.add(indexCandidate);
}

function nestedSourceCandidates(
  projectRoot: string,
  packageRoot: string,
  relativeDirectory: string,
  filename: string,
): string[] {
  const absoluteDirectory = join(projectRoot, packageRoot, relativeDirectory);
  if (!existsSync(absoluteDirectory)) return [];

  const matches: string[] = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      matches.push(...nestedSourceCandidates(projectRoot, packageRoot, relativePath, filename));
    } else if (entry.isFile() && entry.name === filename) {
      matches.push(packagePath(packageRoot, relativePath));
    }
  }
  return matches;
}

export function packagePath(packageRoot: string, relativePath: string): string {
  return packageRoot ? `${packageRoot}/${relativePath}` : relativePath;
}
