import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isPathInsideProject } from '../source/path-normalization.js';
import type { ProjectFileFingerprint } from './project-files.js';

/**
 * Maps repo-wide file fingerprints (from `fingerprintProjectFiles`) onto the
 * TypeScript project dirs produced by `discoverTypeScriptProjectRoots`, and
 * derives the cross-project dependency graph used to invalidate a cached
 * project shard when a dependency (not just the project itself) changes.
 *
 * Everything here except `readProjectManifestInputs` is pure: it operates on
 * already-fingerprinted file lists and already-parsed manifest data, never
 * touching the filesystem. That keeps every invalidation decision unit
 * testable without fixtures — the one place that reads disk is isolated to a
 * thin shell function.
 */

/** Per-project split of a repo-wide file list, plus files nobody claimed. */
export interface ProjectFileAssignment {
  /** Files each project claims directly (does not include dependency files). */
  files: Record<string, ProjectFileFingerprint[]>;
  /**
   * Files claimed by no project. Populated only when no root project ('.')
   * is present to catch them; included in every project's fingerprint
   * because any of them could feed any project's compilation.
   */
  shared: ProjectFileFingerprint[];
}

/** Transitive "depends on" edges, keyed by project path. */
export type ProjectDependencyGraph = Record<string, string[]>;

/** Pre-parsed package.json + tsconfig data for one project, used to derive dependency edges. */
export interface ProjectManifestReading {
  packageName: string | undefined;
  /** Union of dependencies/devDependencies/peerDependencies keys. */
  dependencyNames: string[];
  /** tsconfig `compilerOptions.paths` targets, resolved to repo-relative POSIX paths (through the extends chain). */
  pathsTargets: string[];
  /** tsconfig `references[].path` targets, resolved to repo-relative POSIX paths. */
  referencesPaths: string[];
  /** Set when package.json or the tsconfig chain existed but could not be read/parsed — forces depend-on-all. */
  parseFailed: boolean;
}

/** Per-project manifest readings, keyed by the same project paths passed to `deriveProjectDependencies`. */
export type ProjectManifestInputs = Record<string, ProjectManifestReading>;

/**
 * Assigns each fingerprinted file to the most-specific project dir that
 * contains it. "Most specific" is the longest project path that is a `/`-
 * boundary prefix of the file's path (so `apps/web2/x.ts` never matches
 * project `apps/web`). The root project (`.`) never competes on prefix —
 * it is the fallback for files no other project claims. When `.` is not in
 * `projects`, unclaimed files go into `shared` instead, which the caller
 * folds into every project's fingerprint.
 */
export function assignFilesToProjects(
  files: readonly ProjectFileFingerprint[],
  projects: readonly string[],
): ProjectFileAssignment {
  const hasRoot = projects.includes('.');
  const result: Record<string, ProjectFileFingerprint[]> = {};
  for (const project of projects) result[project] = [];
  const shared: ProjectFileFingerprint[] = [];

  for (const file of files) {
    const owner = mostSpecificMatch(file.path, projects);
    if (owner) {
      result[owner].push(file);
    } else if (hasRoot) {
      result['.'].push(file);
    } else {
      shared.push(file);
    }
  }

  return { files: result, shared };
}

/**
 * Derives the "depends on" graph between projects and returns its transitive
 * closure. An edge `a -> b` means a's cached shard must be invalidated
 * whenever b's files change. Edges come from:
 *  - a package.json dependency name that matches another project's package name;
 *  - a tsconfig `paths`/`references` target that resolves under another project's dir.
 * Any project with `parseFailed: true` depends on every other project (fail
 * toward re-running rather than risk serving a stale shard).
 */
export function deriveProjectDependencies(
  projects: readonly string[],
  inputs: ProjectManifestInputs,
): ProjectDependencyGraph {
  const packageNameToProject = new Map<string, string>();
  for (const project of projects) {
    const name = inputs[project]?.packageName;
    if (name) packageNameToProject.set(name, project);
  }

  const directEdges = new Map<string, Set<string>>();
  for (const project of projects) directEdges.set(project, new Set());

  for (const project of projects) {
    const reading = inputs[project];
    const edges = directEdges.get(project)!;

    if (!reading || reading.parseFailed) {
      for (const other of projects) {
        if (other !== project) edges.add(other);
      }
      continue;
    }

    for (const depName of reading.dependencyNames) {
      const depProject = packageNameToProject.get(depName);
      if (depProject && depProject !== project) edges.add(depProject);
    }

    for (const target of [...reading.pathsTargets, ...reading.referencesPaths]) {
      const owner = mostSpecificMatch(target, projects);
      if (owner && owner !== project) edges.add(owner);
    }
  }

  return transitiveClosure(projects, directEdges);
}

/**
 * Per-project shard fingerprint: own assigned files, plus every transitive
 * dependency's assigned files, plus the shared bucket — sorted by path and
 * deduplicated by path. This is the exact set of files whose byte-identity
 * must hold for a cached project shard to be safely reused.
 */
export function computeProjectShardFingerprints(
  projects: readonly string[],
  assignment: ProjectFileAssignment,
  dependencies: ProjectDependencyGraph,
): Record<string, { files: ProjectFileFingerprint[] }> {
  const result: Record<string, { files: ProjectFileFingerprint[] }> = {};

  for (const project of projects) {
    const byPath = new Map<string, ProjectFileFingerprint>();
    for (const file of assignment.files[project] ?? []) byPath.set(file.path, file);
    for (const dep of dependencies[project] ?? []) {
      for (const file of assignment.files[dep] ?? []) byPath.set(file.path, file);
    }
    for (const file of assignment.shared) byPath.set(file.path, file);

    result[project] = {
      files: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  return result;
}

/**
 * Filesystem-safe, collision-resistant slug for a project's cached shard
 * file: `language-indexes/typescript-projects/<slug>.scip`. The root project
 * (`.`) gets the readable `root`; everything else is the path with `/`
 * replaced by `__`, suffixed with an 8-hex sha256 digest of the raw path so
 * two projects that only differ by a replaced separator (or a rename that
 * collides after replacement) never collide on disk.
 */
export function projectShardSlug(project: string): string {
  if (project === '.') return 'root';
  const hash = createHash('sha256').update(project).digest('hex').slice(0, 8);
  return `${project.split('/').join('__')}-${hash}`;
}

/**
 * Reads each project's package.json and tsconfig (following `extends` up to
 * depth 5) into the plain data `deriveProjectDependencies` needs. This is
 * the only function in the module that touches the filesystem — everything
 * it discovers is reduced to strings before being handed to the pure core.
 *
 * A missing package.json or tsconfig is not a failure (empty inputs); a
 * present-but-unparseable one sets `parseFailed`, which propagates to
 * depend-on-all in `deriveProjectDependencies`. An `extends` target that
 * resolves outside the repo or into `node_modules` is treated as absent
 * (external base configs are not our concern), not a failure.
 */
export function readProjectManifestInputs(projectRoot: string, projects: readonly string[]): ProjectManifestInputs {
  const root = resolve(projectRoot);
  const result: ProjectManifestInputs = {};
  for (const project of projects) {
    result[project] = readProjectManifestInput(root, project);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Longest `/`-boundary prefix match among `candidates`, excluding the root project ('.'), which never competes on prefix. */
function mostSpecificMatch(targetPath: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const candidate of candidates) {
    if (candidate === '.') continue;
    if (targetPath === candidate || targetPath.startsWith(`${candidate}/`)) {
      if (!best || candidate.length > best.length) best = candidate;
    }
  }
  return best;
}

function transitiveClosure(projects: readonly string[], directEdges: Map<string, Set<string>>): ProjectDependencyGraph {
  const result: ProjectDependencyGraph = {};

  for (const project of projects) {
    const visited = new Set<string>();
    const stack = [...(directEdges.get(project) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next === project || visited.has(next)) continue;
      visited.add(next);
      for (const transitive of directEdges.get(next) ?? []) {
        if (transitive !== project && !visited.has(transitive)) stack.push(transitive);
      }
    }
    result[project] = [...visited].sort((left, right) => left.localeCompare(right));
  }

  return result;
}

function readProjectManifestInput(root: string, project: string): ProjectManifestReading {
  const dir = project === '.' ? root : join(root, project);
  const pkg = readPackageManifest(dir);
  const tsconfigPath = findProjectTsconfigPath(dir);
  const tsconfig = tsconfigPath
    ? readTsconfigInputs(tsconfigPath, root)
    : { pathsTargets: [] as string[], referencesPaths: [] as string[], failed: false };

  return {
    packageName: pkg.name,
    dependencyNames: pkg.dependencyNames,
    pathsTargets: tsconfig.pathsTargets,
    referencesPaths: tsconfig.referencesPaths,
    parseFailed: pkg.failed || tsconfig.failed,
  };
}

function readPackageManifest(dir: string): { name: string | undefined; dependencyNames: string[]; failed: boolean } {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return { name: undefined, dependencyNames: [], failed: false };

  const parsed = readJsonc(pkgPath);
  if (!parsed.ok) return { name: undefined, dependencyNames: [], failed: true };

  const name = typeof parsed.value.name === 'string' ? parsed.value.name : undefined;
  const dependencyNames = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = parsed.value[field];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      for (const key of Object.keys(deps as Record<string, unknown>)) dependencyNames.add(key);
    }
  }

  return { name, dependencyNames: [...dependencyNames], failed: false };
}

function findProjectTsconfigPath(dir: string): string | undefined {
  const primary = join(dir, 'tsconfig.json');
  if (existsSync(primary)) return primary;

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => /^tsconfig.*\.json$/.test(name));
  } catch {
    return undefined;
  }
  entries.sort((left, right) => left.localeCompare(right));
  return entries.length > 0 ? join(dir, entries[0]) : undefined;
}

function readTsconfigInputs(
  tsconfigPath: string,
  root: string,
): { pathsTargets: string[]; referencesPaths: string[]; failed: boolean } {
  const own = readJsonc(tsconfigPath);
  if (!own.ok) return { pathsTargets: [], referencesPaths: [], failed: true };

  const referencesPaths = resolveReferences(own.value, tsconfigPath, root);
  const pathsResult = resolvePathsChain(tsconfigPath, own.value, root, 0);
  return { pathsTargets: pathsResult.pathsTargets, referencesPaths, failed: pathsResult.failed };
}

function resolveReferences(parsedValue: Record<string, unknown>, tsconfigPath: string, root: string): string[] {
  const references = parsedValue.references;
  if (!Array.isArray(references)) return [];

  const configDir = dirname(tsconfigPath);
  const resolved = new Set<string>();
  for (const ref of references) {
    if (!ref || typeof ref !== 'object') continue;
    const refPath = (ref as Record<string, unknown>).path;
    if (typeof refPath !== 'string' || refPath.trim() === '') continue;
    const target = resolveTargetToRepoRelative(refPath, configDir, root);
    if (target) resolved.add(target);
  }
  return [...resolved];
}

/** Depth-first walk of the `extends` chain (capped) looking for the nearest `compilerOptions.paths` definition — `paths` overrides rather than merges across `extends`, matching tsc's own semantics. */
function resolvePathsChain(
  configPath: string,
  parsedValue: Record<string, unknown>,
  root: string,
  depth: number,
): { pathsTargets: string[]; failed: boolean } {
  const paths = extractPaths(parsedValue);
  if (paths) {
    return { pathsTargets: resolvePathsTargets(paths, dirname(configPath), root), failed: false };
  }

  if (depth >= 5) return { pathsTargets: [], failed: false };

  const nextConfigPath = resolveExtendsTarget(parsedValue.extends, configPath, root);
  if (!nextConfigPath) return { pathsTargets: [], failed: false };

  const next = readJsonc(nextConfigPath);
  if (!next.ok) return { pathsTargets: [], failed: true };

  return resolvePathsChain(nextConfigPath, next.value, root, depth + 1);
}

function extractPaths(parsedValue: Record<string, unknown>): Record<string, unknown> | undefined {
  const compilerOptions = parsedValue.compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== 'object' || Array.isArray(compilerOptions)) return undefined;
  const paths = (compilerOptions as Record<string, unknown>).paths;
  return paths && typeof paths === 'object' && !Array.isArray(paths) ? (paths as Record<string, unknown>) : undefined;
}

function resolvePathsTargets(paths: Record<string, unknown>, configDir: string, root: string): string[] {
  const targets = new Set<string>();
  for (const value of Object.values(paths)) {
    if (!Array.isArray(value)) continue;
    for (const target of value) {
      if (typeof target !== 'string') continue;
      const resolved = resolveTargetToRepoRelative(target, configDir, root);
      if (resolved) targets.add(resolved);
    }
  }
  return [...targets];
}

/** Resolves an `extends` value (string, or last entry of an array — tsc applies later entries as the "closer" base) to an absolute config path, or undefined if it should be treated as absent. */
function resolveExtendsTarget(extendsValue: unknown, configPath: string, root: string): string | undefined {
  const raw = Array.isArray(extendsValue) ? extendsValue.at(-1) : extendsValue;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  if (!raw.startsWith('.') && !raw.startsWith('/')) return undefined; // package specifier -> node_modules

  let candidate = resolve(dirname(configPath), raw);
  if (!candidate.endsWith('.json')) candidate = `${candidate}.json`;

  if (candidate.split(sep).includes('node_modules')) return undefined;
  if (!isPathInsideProject(root, candidate)) return undefined;
  if (!existsSync(candidate)) return undefined;
  return candidate;
}

function resolveTargetToRepoRelative(target: string, baseDir: string, root: string): string | undefined {
  const stripped = target.replace(/\/?\*+$/, '');
  const abs = resolve(baseDir, stripped === '' ? '.' : stripped);
  if (!isPathInsideProject(root, abs)) return undefined;
  const rel = relative(root, abs);
  const posix = rel.split(sep).join('/');
  return posix === '' ? '.' : posix;
}

/**
 * Minimal JSONC parse: strips `//` line comments and `/* *\/` block comments
 * before `JSON.parse`, without touching `//` or `/* *\/`-looking sequences
 * inside string literals. A small state machine (in-string vs not), not a
 * regex over the whole file — a regex can't reliably tell "this slash is
 * inside a quoted string" from "this slash starts a comment".
 */
function stripJsonComments(input: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  const length = input.length;

  while (index < length) {
    const char = input[index];

    if (inString) {
      output += char;
      if (char === '\\' && index + 1 < length) {
        output += input[index + 1];
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }

    if (char === '/' && input[index + 1] === '/') {
      index += 2;
      while (index < length && input[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && input[index + 1] === '*') {
      index += 2;
      while (index < length && !(input[index] === '*' && input[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function readJsonc(filePath: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}
