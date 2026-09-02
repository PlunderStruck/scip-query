/**
 * UI-kit surface — the directories that hold vendored or generated design
 * system primitives (shadcn/ui, radix wrappers) rather than product code.
 *
 * Structural similarity between two primitives in that directory is a
 * property of the kit (`PopoverContent` and `HoverCardContent` are generated
 * from the same template), not duplication the project authored. Detectors
 * that report duplicated frontend structure therefore treat a pair whose
 * members both live on this surface as expected, and disclose the exclusion
 * instead of counting it.
 *
 * Sources, strongest first:
 *   1. shadcn `components.json` — its `aliases.ui` entry names the kit
 *      directory (through a tsconfig path alias such as `@/components/ui`).
 *   2. the `components/ui` directory convention the same ecosystem uses when
 *      no manifest is committed.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePathSeparators as normalizePath } from '../domain/path-normalization.js';
import { resolveTsconfigAliasPath } from '../source/primitives/import-path-resolver.js';
import { isMissingProjectFileError, readProjectFileText } from '../source/primitives/project-file-boundary.js';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbValue } from '../storage/per-db-cache.js';

export type UiKitSurfaceSource = 'shadcn-components-manifest' | 'ui-directory-convention';

export interface UiKitDirectory {
  /** Project-relative posix directory path without a trailing slash. */
  directory: string;
  source: UiKitSurfaceSource;
  /** The manifest that declared the directory, when one did. */
  manifest?: string;
}

export interface UiKitSurface {
  directories: UiKitDirectory[];
}

const SHADCN_MANIFEST_NAME = 'components.json';
const MANIFEST_SCAN_EXCLUSIONS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);
const MAX_MANIFEST_SCAN_DEPTH = 3;
const UI_DIRECTORY_CONVENTION = /(?:^|\/)components\/ui$/i;

// Derives from manifests on disk, which can change in watch mode.
const uiKitSurfaceCache = createPerDbValue<UiKitSurface>('ui-kit-surface', {
  clearGroups: ['whole-project'],
});

export function uiKitSurface(db: ScipDatabase): UiKitSurface {
  return uiKitSurfaceCache.get(db, () => discoverUiKitSurface(db));
}

/** The kit directory that contains `file`, when the file is a kit primitive. */
export function uiKitDirectoryFor(db: ScipDatabase, file: string): UiKitDirectory | null {
  const normalized = normalizePath(file);
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return null;
  const directory = normalized.slice(0, slash);
  for (const entry of uiKitSurface(db).directories) {
    if (directory === entry.directory) return entry;
  }
  if (UI_DIRECTORY_CONVENTION.test(directory)) {
    return { directory, source: 'ui-directory-convention' };
  }
  return null;
}

export function isUiKitFile(db: ScipDatabase, file: string): boolean {
  return uiKitDirectoryFor(db, file) !== null;
}

function discoverUiKitSurface(db: ScipDatabase): UiKitSurface {
  const directories = new Map<string, UiKitDirectory>();
  for (const manifest of findShadcnManifests(db.config.projectRoot)) {
    const directory = shadcnUiDirectory(db, manifest);
    if (directory && !directories.has(directory)) {
      directories.set(directory, { directory, source: 'shadcn-components-manifest', manifest });
    }
  }
  return {
    directories: [...directories.values()].sort((left, right) => left.directory.localeCompare(right.directory)),
  };
}

function findShadcnManifests(projectRoot: string): string[] {
  const manifests: string[] = [];
  const visit = (relativeDir: string, depth: number): void => {
    const absolute = relativeDir ? join(projectRoot, relativeDir) : projectRoot;
    const manifest = relativeDir ? `${relativeDir}/${SHADCN_MANIFEST_NAME}` : SHADCN_MANIFEST_NAME;
    if (existsSync(join(projectRoot, manifest))) manifests.push(manifest);
    if (depth >= MAX_MANIFEST_SCAN_DEPTH) return;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || MANIFEST_SCAN_EXCLUSIONS.has(entry.name) || entry.name.startsWith('.')) continue;
      visit(relativeDir ? `${relativeDir}/${entry.name}` : entry.name, depth + 1);
    }
  };
  visit('', 0);
  return manifests;
}

function shadcnUiDirectory(db: ScipDatabase, manifest: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readProjectFileText(db.config.projectRoot, manifest, { inputKind: 'components manifest' }));
  } catch (error) {
    if (error instanceof Error && isMissingProjectFileError(error)) return null;
    return null;
  }
  if (!isRecord(parsed)) return null;
  const aliases = parsed['aliases'];
  if (!isRecord(aliases)) return null;
  const uiAlias = typeof aliases['ui'] === 'string' ? aliases['ui'] : null;
  const componentsAlias = typeof aliases['components'] === 'string' ? aliases['components'] : null;
  const specifier = uiAlias ?? (componentsAlias ? `${componentsAlias}/ui` : null);
  if (!specifier) return null;
  return resolveManifestDirectory(db, manifest, specifier);
}

function resolveManifestDirectory(db: ScipDatabase, manifest: string, specifier: string): string | null {
  const manifestDir = manifest.includes('/') ? manifest.slice(0, manifest.lastIndexOf('/')) : '';
  const candidates: string[] = [];
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
    candidates.push(normalizePath(join(manifestDir, specifier)));
  } else {
    const aliased = resolveTsconfigAliasPath(db, manifest, specifier);
    if (aliased) candidates.push(aliased);
    // Common alias roots when no tsconfig answers (`@/x`, `~/x`, `src/x`).
    const bare = specifier.replace(/^[@~]\//, '');
    candidates.push(normalizePath(join(manifestDir, 'src', bare)), normalizePath(join(manifestDir, bare)));
  }
  for (const candidate of candidates) {
    const absolute = join(db.config.projectRoot, candidate);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) return candidate.replace(/\/+$/, '');
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
