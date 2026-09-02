/**
 * Framework task surface — directories whose exported tasks a job framework
 * registers by scanning them, so nothing in the repository imports the task
 * symbol even though the platform invokes it.
 *
 * Trigger.dev (`trigger.config.*`, `dirs: ["./src/trigger"]`) is the
 * supported shape: every `task()`/`schedules.task()` export under a listed
 * directory is an externally invoked entry, exactly like a Next.js route
 * handler. Without this surface the dead-code detector reports each task as
 * a zero-reference symbol.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePathSeparators as normalizePath } from '../domain/path-normalization.js';
import { isMissingProjectFileError, readProjectFileText } from '../source/primitives/project-file-boundary.js';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbValue } from '../storage/per-db-cache.js';

export interface FrameworkTaskDirectory {
  /** Project-relative posix directory path without a trailing slash. */
  directory: string;
  framework: 'trigger.dev';
  /** The configuration file that declared the directory. */
  config: string;
}

export interface FrameworkTaskSurface {
  directories: FrameworkTaskDirectory[];
}

const TRIGGER_CONFIG_NAMES = ['trigger.config.ts', 'trigger.config.mts', 'trigger.config.js', 'trigger.config.mjs'];
const TRIGGER_DEFAULT_DIRS = ['./src/trigger', './trigger'];
const TRIGGER_DIRS_PATTERN = /\bdirs\s*:\s*\[([^\]]*)\]/;
const STRING_LITERAL_PATTERN = /["'`]([^"'`]+)["'`]/g;
const CONFIG_SCAN_ROOTS = ['', 'apps', 'packages', 'services'];

// Derives from config files on disk, which can change in watch mode.
const frameworkTaskSurfaceCache = createPerDbValue<FrameworkTaskSurface>('framework-task-surface', {
  clearGroups: ['whole-project'],
});

export function frameworkTaskSurface(db: ScipDatabase): FrameworkTaskSurface {
  return frameworkTaskSurfaceCache.get(db, () => discoverFrameworkTaskSurface(db));
}

/** True when `file` lives under a directory a job framework scans for tasks. */
export function isFrameworkTaskFile(db: ScipDatabase, file: string): boolean {
  const normalized = normalizePath(file);
  return frameworkTaskSurface(db).directories.some(
    (entry) => normalized === entry.directory || normalized.startsWith(`${entry.directory}/`),
  );
}

function discoverFrameworkTaskSurface(db: ScipDatabase): FrameworkTaskSurface {
  const directories = new Map<string, FrameworkTaskDirectory>();
  for (const config of findTriggerConfigs(db.config.projectRoot)) {
    for (const directory of triggerTaskDirectories(db, config)) {
      if (!directories.has(directory)) directories.set(directory, { directory, framework: 'trigger.dev', config });
    }
  }
  return {
    directories: [...directories.values()].sort((left, right) => left.directory.localeCompare(right.directory)),
  };
}

function findTriggerConfigs(projectRoot: string): string[] {
  const configs: string[] = [];
  const consider = (relativeDir: string): void => {
    for (const name of TRIGGER_CONFIG_NAMES) {
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      if (existsSync(join(projectRoot, relative))) configs.push(relative);
    }
  };
  consider('');
  for (const root of CONFIG_SCAN_ROOTS.slice(1)) {
    const absolute = join(projectRoot, root);
    if (!existsSync(absolute)) continue;
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      continue;
    }
    for (const entry of entries) consider(`${root}/${entry}`);
  }
  return configs;
}

function triggerTaskDirectories(db: ScipDatabase, config: string): string[] {
  let text: string;
  try {
    text = readProjectFileText(db.config.projectRoot, config, { inputKind: 'framework task config' });
  } catch (error) {
    if (isMissingProjectFileError(error)) return [];
    return [];
  }
  const configDir = config.includes('/') ? config.slice(0, config.lastIndexOf('/')) : '';
  const declared = TRIGGER_DIRS_PATTERN.exec(text)?.[1];
  const candidates = declared
    ? [...declared.matchAll(STRING_LITERAL_PATTERN)].map((match) => match[1]!)
    : TRIGGER_DEFAULT_DIRS;
  const directories: string[] = [];
  for (const candidate of candidates) {
    const relative = normalizePath(join(configDir, candidate)).replace(/\/+$/, '');
    if (relative === '' || relative.startsWith('..')) continue;
    if (!existsSync(join(db.config.projectRoot, relative))) continue;
    directories.push(relative);
  }
  return directories;
}
