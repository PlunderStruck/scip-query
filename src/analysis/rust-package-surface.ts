/**
 * Cargo library surface — Rust source owned by a Cargo library target.
 *
 * A public item in this surface can be consumed by crates outside the indexed
 * checkout. Missing local references therefore cannot establish that the item
 * is repository-dead. Binary-only targets are deliberately absent: `pub` in a
 * binary changes in-crate visibility but does not create a downstream API.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbValue } from '../storage/per-db-cache.js';
import { getDefinitionsForFile } from '../symbols/definition-catalog.js';
import { getSourceLines } from '../source/primitives/source-text.js';
import { packagePath } from './package-surface.js';

export interface RustLibrarySurface {
  rootFiles: Set<string>;
  sourcePrefixes: string[];
}

const EMPTY_RUST_LIBRARY_SURFACE: RustLibrarySurface = { rootFiles: new Set(), sourcePrefixes: [] };
const CARGO_SCAN_EXCLUSIONS = new Set(['.git', '.scipquery', 'node_modules', 'target']);
const MAX_CARGO_MANIFEST_DEPTH = 6;

const rustLibrarySurfaceCache = createPerDbValue<RustLibrarySurface>('rust-library-surface', {
  clearGroups: ['whole-project'],
});

// scip-query: ignore-wrapper — this is the public policy boundary consumed by
// file-classifier; target ownership, definition lookup, and Rust visibility
// must agree before a symbol is treated as externally live.
export function isRustPublicLibrarySymbol(db: ScipDatabase, symbol: string, relativePath: string): boolean {
  if (!relativePath.endsWith('.rs')) return false;
  if (!isRustLibrarySourceFile(getRustLibrarySurface(db), relativePath)) return false;

  const definition = getDefinitionsForFile(db, relativePath).find((candidate) => candidate.symbol === symbol);
  if (!definition) return false;
  return isExternallyPublicRustDeclaration(getSourceLines(db, relativePath)[definition.startLine] ?? '');
}

export function getRustLibrarySurface(db: ScipDatabase): RustLibrarySurface {
  return rustLibrarySurfaceCache.get(db, () => deriveRustLibrarySurface(db.config.projectRoot));
}

export function deriveRustLibrarySurface(projectRoot: string): RustLibrarySurface {
  const rootFiles = new Set<string>();
  const sourcePrefixes = new Set<string>();

  for (const manifestRoot of findCargoManifestRoots(projectRoot)) {
    const manifestPath = join(projectRoot, manifestRoot, 'Cargo.toml');
    const manifest = readFileSync(manifestPath, 'utf8');
    const explicitPath = cargoLibPath(manifest);
    const defaultPath = packagePath(manifestRoot, 'src/lib.rs');
    const rootFile = explicitPath
      ? packagePath(manifestRoot, explicitPath)
      : !cargoAutolibDisabled(manifest) && existsSync(join(projectRoot, defaultPath))
        ? defaultPath
        : null;
    if (!rootFile) continue;

    rootFiles.add(rootFile);
    const prefix = dirname(rootFile).replaceAll('\\', '/');
    sourcePrefixes.add(prefix === '.' ? '' : `${prefix}/`);
  }

  if (rootFiles.size === 0) return EMPTY_RUST_LIBRARY_SURFACE;
  return { rootFiles, sourcePrefixes: [...sourcePrefixes].sort() };
}

export function isRustLibrarySourceFile(surface: RustLibrarySurface, relativePath: string): boolean {
  if (!relativePath.endsWith('.rs')) return false;
  if (surface.rootFiles.has(relativePath)) return true;
  if (isCargoNonLibraryTargetPath(relativePath)) return false;
  return surface.sourcePrefixes.some((prefix) => relativePath.startsWith(prefix));
}

export function isExternallyPublicRustDeclaration(sourceLine: string): boolean {
  return /^\s*pub\s+(?!\()/.test(sourceLine);
}

function findCargoManifestRoots(projectRoot: string): string[] {
  if (!existsSync(projectRoot)) return [];
  const roots: string[] = [];
  collectCargoManifestRoots(projectRoot, '', roots, 0);
  return roots;
}

function collectCargoManifestRoots(
  projectRoot: string,
  relativeDirectory: string,
  roots: string[],
  depth: number,
): void {
  const absoluteDirectory = join(projectRoot, relativeDirectory);
  if (!existsSync(absoluteDirectory)) return;
  if (existsSync(join(absoluteDirectory, 'Cargo.toml'))) roots.push(relativeDirectory);
  if (depth >= MAX_CARGO_MANIFEST_DEPTH) return;

  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || CARGO_SCAN_EXCLUSIONS.has(entry.name)) continue;
    const child = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    collectCargoManifestRoots(projectRoot, child, roots, depth + 1);
  }
}

function cargoLibPath(manifest: string): string | null {
  let inLibSection = false;
  for (const rawLine of manifest.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inLibSection = section[1] === 'lib';
      continue;
    }
    if (!inLibSection) continue;
    const path = /^path\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    if (path) return path.replaceAll('\\', '/').replace(/^\.\//, '');
  }
  return null;
}

function cargoAutolibDisabled(manifest: string): boolean {
  let inPackageSection = false;
  for (const rawLine of manifest.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inPackageSection = section[1] === 'package';
      continue;
    }
    if (inPackageSection && /^autolib\s*=\s*false\b/.test(line)) return true;
  }
  return false;
}

function isCargoNonLibraryTargetPath(relativePath: string): boolean {
  return (
    /(?:^|\/)src\/main\.rs$/.test(relativePath) ||
    /(?:^|\/)src\/bin\//.test(relativePath) ||
    /(?:^|\/)(?:examples|tests|benches)\//.test(relativePath)
  );
}
