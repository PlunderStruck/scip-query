/**
 * workspace-packages — discovers the packages declared by a pnpm/npm/yarn
 * workspace (`pnpm-workspace.yaml`'s `packages:` glob list, or package.json
 * `workspaces`) and each one's declared name + `package.json` `exports`
 * map. Used by import-path-resolver.ts to turn a bare workspace-package
 * specifier (`@scope/pkg`, `@scope/pkg/subpath`) into the project-relative
 * source file it names, the same way tsconfig `paths` aliases are resolved
 * for intra-package specifiers.
 *
 * Deliberately dependency-free: no YAML library. `pnpm-workspace.yaml`'s
 * `packages` field is always a flat list of glob strings under one
 * top-level key — a full YAML parser is not needed to read that one shape,
 * and this repo has no YAML dependency to reach for.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readSmallArtifactText } from './bounded-file.js';

export interface WorkspacePackage {
  /** package.json "name" field, e.g. "@vega/shared". */
  name: string;
  /** Project-root-relative directory (forward slashes), e.g. "packages/shared". */
  relativeDir: string;
  /** Raw package.json "exports" field, if declared. */
  exports: unknown;
}

export function discoverWorkspacePackages(projectRoot: string): WorkspacePackage[] {
  const patterns = pnpmWorkspacePatterns(projectRoot) ?? packageJsonWorkspacePatterns(projectRoot);
  if (!patterns || patterns.length === 0) return [];

  const packages: WorkspacePackage[] = [];
  const seenDirs = new Set<string>();
  for (const pattern of patterns) {
    for (const dir of expandWorkspacePattern(projectRoot, pattern)) {
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      const pkg = readWorkspacePackage(projectRoot, dir);
      if (pkg) packages.push(pkg);
    }
  }
  return packages;
}

function pnpmWorkspacePatterns(projectRoot: string): string[] | null {
  const yamlPath = join(projectRoot, 'pnpm-workspace.yaml');
  if (!existsSync(yamlPath)) return null;
  try {
    return parsePnpmWorkspacePackagesField(readSmallArtifactText(yamlPath, 'pnpm workspace manifest'));
  } catch {
    return null;
  }
}

/**
 * Reads the `packages:` list from a pnpm-workspace.yaml's top-level
 * mapping, e.g.:
 *   packages:
 *     - "apps/*"
 *     - "packages/*"
 */
export function parsePnpmWorkspacePackagesField(content: string): string[] {
  const patterns: string[] = [];
  let inPackagesList = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripYamlComment(rawLine);
    if (!inPackagesList) {
      if (/^packages\s*:\s*$/.test(line.trim())) inPackagesList = true;
      continue;
    }
    const listItem = /^\s+-\s*(.+)$/.exec(line);
    if (listItem) {
      const value = unquoteYamlScalar(listItem[1]!.trim());
      if (value) patterns.push(value);
      continue;
    }
    if (line.trim() === '') continue;
    break; // a non-indented, non-list line ends the `packages:` block.
  }
  return patterns;
}

function stripYamlComment(line: string): string {
  const hashIndex = line.indexOf('#');
  return hashIndex === -1 ? line : line.slice(0, hashIndex);
}

function unquoteYamlScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function packageJsonWorkspacePatterns(projectRoot: string): string[] | null {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed = JSON.parse(readSmallArtifactText(pkgPath, 'workspace package manifest')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    if (!parsed.workspaces) return null;
    return Array.isArray(parsed.workspaces) ? parsed.workspaces : (parsed.workspaces.packages ?? []);
  } catch {
    return null;
  }
}

// Exported so semantic/typescript/tsconfig-discovery.ts can reuse both
// instead of keeping its own byte-identical private copies (workspace glob
// expansion has exactly one implementation now).
export function expandWorkspacePattern(projectRoot: string, pattern: string): string[] {
  if (!pattern || pattern.startsWith('!') || pattern.includes('node_modules')) return [];
  if (!pattern.includes('*')) {
    const candidate = join(projectRoot, pattern);
    return isDirectory(candidate) ? [candidate] : [];
  }

  const starIndex = pattern.indexOf('*');
  const basePrefix = pattern.slice(0, starIndex).replace(/\/$/, '');
  const suffix = pattern.slice(starIndex + 1).replace(/^\//, '');
  const baseDir = join(projectRoot, basePrefix || '.');
  if (!isDirectory(baseDir)) return [];

  return readdirSync(baseDir)
    .map((entry) => join(baseDir, entry, suffix))
    .filter(isDirectory);
}

export function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readWorkspacePackage(projectRoot: string, dir: string): WorkspacePackage | null {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed = JSON.parse(readSmallArtifactText(pkgPath, 'workspace package manifest')) as {
      name?: string;
      exports?: unknown;
    };
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) return null;
    return {
      name: parsed.name,
      relativeDir: relative(projectRoot, dir).replace(/\\/g, '/'),
      exports: parsed.exports,
    };
  } catch {
    return null;
  }
}
