import { lstatSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { TYPESCRIPT_FRAGMENT_STORE_DIRECTORY } from './typescript-fragment-store.js';
import { TYPESCRIPT_OVERLAY_STORE_DIRECTORY } from './typescript-overlay-store.js';

export const INDEX_ARTIFACT_CATALOG_VERSION = 1;
export const LANGUAGE_INDEX_DIRECTORY = 'language-indexes';

const REQUIRED_ARTIFACTS = ['index.db', 'index.scip', 'meta.json'] as const;
const SHAREABLE_DIRECTORIES = [
  LANGUAGE_INDEX_DIRECTORY,
  TYPESCRIPT_FRAGMENT_STORE_DIRECTORY,
  TYPESCRIPT_OVERLAY_STORE_DIRECTORY,
] as const;

export interface IndexArtifactSet {
  version: typeof INDEX_ARTIFACT_CATALOG_VERSION;
  files: string[];
}

export function describeIndexArtifactSet(cacheDir: string): IndexArtifactSet {
  const files: string[] = [];
  for (const relativePath of REQUIRED_ARTIFACTS) {
    assertRegularArtifact(cacheDir, relativePath);
    files.push(relativePath);
  }
  for (const directory of SHAREABLE_DIRECTORIES) {
    collectRegularFiles(cacheDir, directory, files);
  }
  return { version: INDEX_ARTIFACT_CATALOG_VERSION, files: files.sort() };
}

export function validateIndexArtifactRelativePath(relativePath: string): string {
  if (!relativePath || relativePath.includes('\0') || relativePath.startsWith('/') || relativePath.includes('\\')) {
    throw new Error(`invalid index artifact path: ${relativePath || '<empty>'}`);
  }
  const normalized = relativePath.split('/');
  if (normalized.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid index artifact path: ${relativePath}`);
  }
  const root = normalized[0]!;
  if (
    !REQUIRED_ARTIFACTS.includes(relativePath as (typeof REQUIRED_ARTIFACTS)[number]) &&
    !SHAREABLE_DIRECTORIES.includes(root as (typeof SHAREABLE_DIRECTORIES)[number])
  ) {
    throw new Error(`index artifact path is not shareable: ${relativePath}`);
  }
  return relativePath;
}

export function indexArtifactPath(cacheDir: string, relativePath: string): string {
  const validated = validateIndexArtifactRelativePath(relativePath);
  const root = resolve(cacheDir);
  const path = resolve(root, ...validated.split('/'));
  if (path !== root && !path.startsWith(`${root}${sep}`))
    throw new Error(`index artifact escapes cache: ${relativePath}`);
  return path;
}

function collectRegularFiles(cacheDir: string, relativeDirectory: string, output: string[]): void {
  const path = join(cacheDir, relativeDirectory);
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(path, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`index artifact cannot be a symlink: ${relativePath}`);
    if (entry.isDirectory()) collectRegularFiles(cacheDir, relativePath, output);
    else if (entry.isFile()) output.push(validateIndexArtifactRelativePath(relativePath));
  }
}

function assertRegularArtifact(cacheDir: string, relativePath: string): void {
  const path = indexArtifactPath(cacheDir, relativePath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`required index artifact is missing: ${relativePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`required index artifact is not a regular file: ${relativePath}`);
  const actualRelative = relative(resolve(cacheDir), path);
  if (actualRelative.startsWith('..')) throw new Error(`index artifact escapes cache: ${relativePath}`);
}
