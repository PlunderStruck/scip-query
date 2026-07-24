import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isPathInsideProject as isInsideProject } from '../domain/path-normalization.js';

const SKIP_DIR_NAMES = new Set([
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.nx',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
  'vendor',
]);

/**
 * Discovers the tsconfig project roots to index for a repo.
 *
 * Contract: explicit config is authoritative. When `configuredProjects` normalizes to a
 * non-empty list (after dropping entries that don't exist or fall outside the project root),
 * that set is returned exactly as configured — deduped and sorted, with no discovery walk and
 * no re-adding the repo root alongside the configured projects. Discovery (plus the
 * root-alongside heuristic) only runs when no usable configured projects remain.
 */
export function discoverTypeScriptProjectRoots(
  projectRoot: string,
  configuredProjects: readonly string[] = [],
): string[] {
  const root = path.resolve(projectRoot);
  const configured = configuredProjects.flatMap((project) => normalizeConfiguredProject(root, project));

  if (configured.length > 0) {
    return sortRelativeProjectPaths(root, dedupeNestedProjects(configured));
  }

  const discovered = discoverTsconfigProjectDirs(root);
  const deduped = dedupeNestedProjects(discovered);
  const withRoot = shouldIndexRootAlongsideProjects(root, deduped) ? [root, ...deduped] : deduped;
  const projects = withRoot.length > 0 ? withRoot : [root];

  return sortRelativeProjectPaths(root, projects);
}

function sortRelativeProjectPaths(root: string, projects: readonly string[]): string[] {
  return [...new Set(projects.map((project) => relativeProjectPath(root, project)))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function discoverTsconfigProjectDirs(projectRoot: string): string[] {
  const projects: string[] = [];
  const stack = [projectRoot];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name) && !entry.name.startsWith('.')) {
          stack.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && isIndexableTsconfig(fullPath)) {
        projects.push(path.dirname(fullPath));
      }
    }
  }

  return projects;
}

function normalizeConfiguredProject(projectRoot: string, configured: string): string[] {
  const trimmed = configured.trim();
  if (!trimmed) return [];

  const absolute = path.resolve(projectRoot, trimmed);
  if (!isInsideProject(projectRoot, absolute)) return [];

  try {
    const stat = statSync(absolute);
    if (stat.isDirectory()) return [absolute];
    if (stat.isFile() && isTsconfigName(path.basename(absolute))) return [path.dirname(absolute)];
  } catch {
    return [];
  }

  return [];
}

function isIndexableTsconfig(tsconfigPath: string): boolean {
  if (!isTsconfigName(path.basename(tsconfigPath))) return false;
  const data = readJsonObject(tsconfigPath);
  if (!data) return false;
  const name = path.basename(tsconfigPath);
  return name === 'tsconfig.json' || 'include' in data || 'files' in data || 'references' in data;
}

function isTsconfigName(name: string): boolean {
  return name.startsWith('tsconfig') && name.endsWith('.json');
}

function dedupeNestedProjects(projects: readonly string[]): string[] {
  const unique = [...new Set(projects.map((project) => path.resolve(project)))].sort((left, right) =>
    left.localeCompare(right),
  );
  if (unique.length <= 1) return unique;

  return unique.filter((candidate) => !unique.some((other) => other !== candidate && isAncestor(candidate, other)));
}

function shouldIndexRootAlongsideProjects(projectRoot: string, projects: readonly string[]): boolean {
  if (projects.length === 0 || projects.some((project) => path.resolve(project) === projectRoot)) return false;
  const rootTsconfig = path.join(projectRoot, 'tsconfig.json');
  return existsSync(rootTsconfig) && tsconfigCoversSubdirectories(rootTsconfig);
}

function tsconfigCoversSubdirectories(tsconfigPath: string): boolean {
  const data = readJsonObject(tsconfigPath);
  const include = data?.['include'];
  if (!Array.isArray(include)) return false;
  return include.some(
    (pattern) =>
      typeof pattern === 'string' &&
      pattern.trim() !== '' &&
      !pattern.startsWith('!') &&
      (pattern.includes('/') || pattern.includes('**') || !path.extname(pattern)),
  );
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function relativeProjectPath(projectRoot: string, projectDir: string): string {
  const relative = path.relative(projectRoot, projectDir);
  return relative ? relative.split(path.sep).join('/') : '.';
}

function isAncestor(candidate: string, other: string): boolean {
  const relative = path.relative(candidate, other);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
