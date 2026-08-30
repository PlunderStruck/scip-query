import { createRequire } from 'node:module';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type * as TsMorphCommon from '@ts-morph/common';
import { isPathInsideProject as isInsideProject } from '../domain/path-normalization.js';
import { readSmallArtifactText } from './bounded-file.js';
import { projectSnapshotFile, projectSnapshotPaths, projectSnapshotPathState } from './project-snapshot-context.js';

const require = createRequire(import.meta.url);
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
 * Discover the compiler project roots that scip-typescript indexes. Explicit
 * configuration is authoritative; otherwise nested tsconfigs are discovered
 * and a root project is retained only when its include contract covers source.
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

export function activeTypeScriptProjectConfigPaths(projectRoots: readonly string[]): ReadonlySet<string> {
  return new Set(
    projectRoots.map((project) => (project === '.' ? 'tsconfig.json' : `${project.replace(/\/$/u, '')}/tsconfig.json`)),
  );
}

export function isTypeScriptProjectConfigPath(relativePath: string): boolean {
  const name = relativePath.split('/').at(-1)?.toLowerCase();
  return name?.startsWith('tsconfig') === true && name.endsWith('.json');
}

/**
 * Return source paths selected by the same TypeScript compiler config files
 * that define the index. `null` means compiler configuration could not be
 * loaded, so callers must keep their conservative broad fingerprint.
 */
export function typeScriptProjectInputPaths(
  projectRoot: string,
  projectMode: 'single' | 'workspace' | undefined,
  configuredProjects: readonly string[] = [],
): ReadonlySet<string> | null {
  let ts: typeof TsMorphCommon.ts;
  try {
    ts = require('@ts-morph/common/dist/typescript.js') as typeof TsMorphCommon.ts;
  } catch {
    return null;
  }

  const root = path.resolve(projectRoot);
  const projects = projectMode === 'workspace' ? discoverTypeScriptProjectRoots(root, configuredProjects) : ['.'];
  const sourcePaths = new Set<string>();
  for (const project of projects) {
    const projectDirectory = project === '.' ? root : path.join(root, project);
    const tsconfigPath = path.join(projectDirectory, 'tsconfig.json');
    const host = compilerConfigHost(ts, root);
    if (!host.fileExists(tsconfigPath)) return null;
    const read = ts.readConfigFile(tsconfigPath, host.readFile);
    if (read.error) return null;
    const parsed = ts.parseJsonConfigFileContent(read.config as object, host, projectDirectory);
    if (parsed.errors.length > 0) return null;
    for (const fileName of parsed.fileNames) {
      const absolute = path.resolve(fileName);
      if (!isInsideProject(root, absolute)) continue;
      sourcePaths.add(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  return sourcePaths;
}

/**
 * A tree-owned project selection is one whose source membership can change
 * only when the clean Git tree changes. Config symlinks, ignored configs, and
 * `extends` chains stay on the full compiler path because their effective
 * bytes can change without changing the repository tree object.
 */
export function typeScriptProjectSelectionIsTreeOwned(
  projectRoot: string,
  projectMode: 'single' | 'workspace' | undefined,
  configuredProjects: readonly string[],
  trackedPaths: readonly string[],
): boolean {
  const root = path.resolve(projectRoot);
  const tracked = new Set(trackedPaths);
  for (const configured of configuredProjects) {
    const absolute = path.resolve(root, configured);
    if (!isInsideProject(root, absolute)) continue;
    try {
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) return false;
      if (stats.isFile() && !tracked.has(relativeProjectPath(root, absolute))) return false;
    } catch {
      // Missing configured entries normalize away during ordinary discovery.
    }
  }

  const projects = projectMode === 'workspace' ? discoverTypeScriptProjectRoots(root, configuredProjects) : ['.'];
  for (const project of projects) {
    const projectDirectory = project === '.' ? root : path.join(root, project);
    const tsconfigPath = path.join(projectDirectory, 'tsconfig.json');
    if (!projectFileExists(root, tsconfigPath)) continue;
    const relativePath = relativeProjectPath(root, tsconfigPath);
    if (!tracked.has(relativePath)) return false;
    try {
      if (lstatSync(tsconfigPath).isSymbolicLink()) return false;
      const source = readProjectConfigText(root, tsconfigPath);
      if (source.includes('extends') || source.includes('\\')) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function sortRelativeProjectPaths(root: string, projects: readonly string[]): string[] {
  return [...new Set(projects.map((project) => relativeProjectPath(root, project)))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function discoverTsconfigProjectDirs(projectRoot: string): string[] {
  const snapshotPaths = projectSnapshotPaths(projectRoot);
  if (snapshotPaths) {
    return snapshotPaths.flatMap((relativePath) => {
      if (relativePath.split('/').some((part) => SKIP_DIR_NAMES.has(part))) return [];
      const fullPath = path.join(projectRoot, ...relativePath.split('/'));
      return isIndexableTsconfig(projectRoot, fullPath) ? [path.dirname(fullPath)] : [];
    });
  }

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
        if (!SKIP_DIR_NAMES.has(entry.name) && !entry.name.startsWith('.')) stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isIndexableTsconfig(projectRoot, fullPath)) projects.push(path.dirname(fullPath));
    }
  }

  return projects;
}

function normalizeConfiguredProject(projectRoot: string, configured: string): string[] {
  const trimmed = configured.trim();
  if (!trimmed) return [];
  const absolute = path.resolve(projectRoot, trimmed);
  if (!isInsideProject(projectRoot, absolute)) return [];

  const snapshotPaths = projectSnapshotPaths(projectRoot);
  if (snapshotPaths) {
    const relativePath = relativeProjectPath(projectRoot, absolute);
    if (snapshotPaths.includes(relativePath) && isTsconfigName(path.basename(absolute))) {
      return [path.dirname(absolute)];
    }
    const directoryPrefix = relativePath === '.' ? '' : `${relativePath}/`;
    return snapshotPaths.some((candidate) => candidate.startsWith(directoryPrefix)) ? [absolute] : [];
  }

  try {
    const stat = statSync(absolute);
    if (stat.isDirectory()) return [absolute];
    if (stat.isFile() && isTsconfigName(path.basename(absolute))) return [path.dirname(absolute)];
  } catch {
    return [];
  }
  return [];
}

function isIndexableTsconfig(projectRoot: string, tsconfigPath: string): boolean {
  if (!isTsconfigName(path.basename(tsconfigPath))) return false;
  const data = readJsonObject(projectRoot, tsconfigPath);
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
  return projectFileExists(projectRoot, rootTsconfig) && tsconfigCoversSubdirectories(projectRoot, rootTsconfig);
}

function tsconfigCoversSubdirectories(projectRoot: string, tsconfigPath: string): boolean {
  const data = readJsonObject(projectRoot, tsconfigPath);
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

function readJsonObject(projectRoot: string, filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readProjectConfigText(projectRoot, filePath)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function projectFileExists(projectRoot: string, filePath: string): boolean {
  const relativePath = relativeProjectPath(projectRoot, filePath);
  const snapshotState = projectSnapshotPathState(projectRoot, relativePath);
  return snapshotState ? snapshotState === 'present' : existsSync(filePath);
}

function readProjectConfigText(projectRoot: string, filePath: string): string {
  const relativePath = relativeProjectPath(projectRoot, filePath);
  const snapshotPaths = projectSnapshotPaths(projectRoot);
  if (snapshotPaths) {
    const file = projectSnapshotFile(projectRoot, relativePath);
    if (!file) throw Object.assign(new Error(`Snapshot file ${relativePath} is missing.`), { code: 'ENOENT' });
    return file.content.toString('utf8');
  }
  return readSmallArtifactText(filePath, 'TypeScript project config');
}

interface CompilerConfigHost {
  useCaseSensitiveFileNames: boolean;
  readDirectory(
    rootDir: string,
    extensions: readonly string[],
    excludes: readonly string[] | undefined,
    includes: readonly string[],
    depth?: number,
  ): string[];
  fileExists(filePath: string): boolean;
  readFile(filePath: string): string | undefined;
}

type TypeScriptRuntime = typeof TsMorphCommon.ts & {
  matchFiles(
    rootDir: string,
    extensions: readonly string[],
    excludes: readonly string[] | undefined,
    includes: readonly string[],
    useCaseSensitiveFileNames: boolean,
    currentDirectory: string,
    depth: number | undefined,
    getFileSystemEntries: (directory: string) => { files: string[]; directories: string[] },
    realpath: (input: string) => string,
  ): string[];
};

function compilerConfigHost(ts: typeof TsMorphCommon.ts, projectRoot: string): CompilerConfigHost {
  const snapshotPaths = projectSnapshotPaths(projectRoot);
  if (!snapshotPaths) return ts.sys;

  const root = path.resolve(projectRoot);
  const pathSet = new Set(snapshotPaths);
  const entries = snapshotDirectoryEntries(root, snapshotPaths);
  const runtime = ts as TypeScriptRuntime;
  const relativeSnapshotPath = (filePath: string): string | null => {
    const absolute = path.resolve(filePath);
    if (!isInsideProject(root, absolute)) return null;
    return relativeProjectPath(root, absolute);
  };

  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists(filePath) {
      const relativePath = relativeSnapshotPath(filePath);
      return relativePath === null ? ts.sys.fileExists(filePath) : pathSet.has(relativePath);
    },
    readFile(filePath) {
      const relativePath = relativeSnapshotPath(filePath);
      if (relativePath === null) return ts.sys.readFile(filePath);
      return projectSnapshotFile(root, relativePath)?.content.toString('utf8');
    },
    readDirectory(rootDir, extensions, excludes, includes, depth) {
      const absolute = path.resolve(rootDir);
      if (!isInsideProject(root, absolute)) return ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth);
      return runtime.matchFiles(
        absolute,
        extensions,
        excludes,
        includes,
        ts.sys.useCaseSensitiveFileNames,
        root,
        depth,
        (directory) => entries.get(path.resolve(directory)) ?? { files: [], directories: [] },
        (input) => input,
      );
    },
  };
}

function snapshotDirectoryEntries(
  projectRoot: string,
  snapshotPaths: readonly string[],
): ReadonlyMap<string, { files: string[]; directories: string[] }> {
  const filesByDirectory = new Map<string, Set<string>>();
  const directoriesByDirectory = new Map<string, Set<string>>();
  const ensure = (directory: string): void => {
    if (!filesByDirectory.has(directory)) filesByDirectory.set(directory, new Set());
    if (!directoriesByDirectory.has(directory)) directoriesByDirectory.set(directory, new Set());
  };
  ensure(projectRoot);

  for (const relativePath of snapshotPaths) {
    const parts = relativePath.split('/');
    let directory = projectRoot;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const child = parts[index]!;
      ensure(directory);
      directoriesByDirectory.get(directory)!.add(child);
      directory = path.join(directory, child);
      ensure(directory);
    }
    filesByDirectory.get(directory)!.add(parts.at(-1)!);
  }

  return new Map(
    [...filesByDirectory].map(([directory, files]) => [
      directory,
      {
        files: [...files].sort(),
        directories: [...(directoriesByDirectory.get(directory) ?? [])].sort(),
      },
    ]),
  );
}

function relativeProjectPath(projectRoot: string, projectDir: string): string {
  const relative = path.relative(projectRoot, projectDir);
  return relative ? relative.split(path.sep).join('/') : '.';
}

function isAncestor(candidate: string, other: string): boolean {
  const relative = path.relative(candidate, other);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
