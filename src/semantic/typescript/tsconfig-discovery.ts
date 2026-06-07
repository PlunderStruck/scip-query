import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';

const TSCONFIG_CANDIDATES = [
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'tsconfig.base.json',
];

export function findNearestTsconfig(projectRoot: string, relativePath?: string): string | null {
  const startDir = relativePath
    ? path.dirname(path.join(projectRoot, relativePath))
    : projectRoot;
  let current = startDir;
  const root = path.resolve(projectRoot);

  while (current.startsWith(root)) {
    for (const name of TSCONFIG_CANDIDATES) {
      const candidate = path.join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  for (const name of TSCONFIG_CANDIDATES) {
    const candidate = path.join(projectRoot, name);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function discoverTypeScriptTsconfigs(db: ScipDatabase): string[] {
  const projectRoot = db.config.projectRoot;
  const found = new Set(discoverTypeScriptTsconfigsForProject(
    projectRoot,
    db.config.semantic?.typescript?.tsconfigs,
  ));

  const documents = indexedDocumentPaths(db, {
    includeIgnored: false,
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  });
  for (const document of documents) {
    const nearest = findNearestTsconfig(projectRoot, document);
    if (nearest) found.add(path.resolve(nearest));
  }

  if (found.size === 0) {
    const root = findNearestTsconfig(projectRoot);
    if (root) found.add(path.resolve(root));
  }

  return [...found]
    .filter((tsconfigPath) => !isIgnoredTsconfig(projectRoot, tsconfigPath))
    .sort((left, right) => left.localeCompare(right));
}

export function discoverTypeScriptTsconfigsForProject(
  projectRoot: string,
  configuredTsconfigs: readonly string[] = [],
): string[] {
  const found = new Set<string>();

  for (const configured of configuredTsconfigs) {
    const absolute = path.isAbsolute(configured) ? configured : path.join(projectRoot, configured);
    if (existsSync(absolute)) found.add(path.resolve(absolute));
  }

  for (const workspaceDir of discoverWorkspaceDirs(projectRoot)) {
    for (const name of TSCONFIG_CANDIDATES) {
      const candidate = path.join(workspaceDir, name);
      if (existsSync(candidate)) found.add(path.resolve(candidate));
    }
  }

  if (found.size === 0) {
    const root = findNearestTsconfig(projectRoot);
    if (root) found.add(path.resolve(root));
  }

  return [...found]
    .filter((tsconfigPath) => !isIgnoredTsconfig(projectRoot, tsconfigPath))
    .sort((left, right) => left.localeCompare(right));
}

function discoverWorkspaceDirs(projectRoot: string): string[] {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return [];

  let parsed: { workspaces?: string[] | { packages?: string[] } };
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as typeof parsed;
  } catch {
    return [];
  }

  const patterns = Array.isArray(parsed.workspaces)
    ? parsed.workspaces
    : parsed.workspaces?.packages ?? [];

  return patterns.flatMap((pattern) => expandWorkspacePattern(projectRoot, pattern));
}

function expandWorkspacePattern(projectRoot: string, pattern: string): string[] {
  if (!pattern || pattern.startsWith('!') || pattern.includes('node_modules')) return [];
  if (!pattern.includes('*')) {
    const candidate = path.join(projectRoot, pattern);
    return isDirectory(candidate) ? [candidate] : [];
  }

  const starIndex = pattern.indexOf('*');
  const basePrefix = pattern.slice(0, starIndex).replace(/\/$/, '');
  const suffix = pattern.slice(starIndex + 1).replace(/^\//, '');
  const baseDir = path.join(projectRoot, basePrefix || '.');
  if (!isDirectory(baseDir)) return [];

  return readdirSync(baseDir)
    .map((entry) => path.join(baseDir, entry, suffix))
    .filter(isDirectory);
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isIgnoredTsconfig(projectRoot: string, tsconfigPath: string): boolean {
  const relative = path.relative(projectRoot, tsconfigPath).replace(/\\/g, '/');
  return relative.startsWith('..')
    || relative.includes('/node_modules/')
    || relative.startsWith('node_modules/')
    || relative.includes('/dist/')
    || relative.startsWith('dist/');
}
