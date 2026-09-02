import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Project } from 'ts-morph';
import type * as TsMorph from 'ts-morph';
import type { SemanticProvider } from '../types.js';
import { currentProjectFileBudget } from './project-budget.js';

export type TsMorphModule = typeof TsMorph;

/**
 * `project`: the compiler program holds every file the tsconfig lists, so
 * project-wide answers (references, hierarchies) are complete.
 * `file-closure`: the tsconfig lists more files than the worker heap can
 * hold; the program starts empty and grows by the import closure of each
 * requested file. Per-file answers (callees, signatures, import usage) stay
 * exact because the checker still resolves every import; project-wide
 * answers are unavailable.
 */
export type ProjectScope = 'project' | 'file-closure';

export interface ProjectBundle {
  tsconfigPath: string;
  /** The compiler project, created on first access so unused tsconfigs cost nothing. */
  readonly project: Project;
  /** True once the compiler project exists. */
  readonly loaded: boolean;
  /** Absolute paths the tsconfig includes, or null when the config could not be parsed. */
  readonly fileNames: ReadonlySet<string> | null;
  /** How much of the tsconfig the compiler program holds; decided from the file count and the heap budget. */
  readonly scope: ProjectScope;
}

export interface ProjectBundleOptions {
  /** Files a whole-project program may hold; above it the bundle is file-scoped. Defaults to the current heap's budget. */
  fileBudget?: number;
}

const require = createRequire(import.meta.url);
let tsMorphModule: TsMorphModule | null | undefined;
let engineIdentity: string | undefined;

export function loadTsMorph(): TsMorphModule | null {
  if (tsMorphModule !== undefined) return tsMorphModule;
  try {
    tsMorphModule = require('ts-morph') as TsMorphModule;
  } catch {
    tsMorphModule = null;
  }
  return tsMorphModule;
}

export function typeScriptSemanticEngineIdentity(): string {
  if (engineIdentity) return engineIdentity;
  const tsMorph = loadTsMorph();
  if (!tsMorph) return 'ts-morph:unavailable';
  let tsMorphVersion = 'unknown';
  try {
    tsMorphVersion = (require('ts-morph/package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    // The runtime module and compiler version still distinguish the engine.
  }
  engineIdentity = `ts-morph:${tsMorphVersion}:typescript:${tsMorph.ts.version}`;
  return engineIdentity;
}

export function createTsMorphProjectBundles(
  tsMorph: TsMorphModule,
  tsconfigPaths: readonly string[],
  options: ProjectBundleOptions = {},
): ProjectBundle[] {
  return tsconfigPaths.map((tsconfigPath) => createLazyProjectBundle(tsMorph, tsconfigPath, options));
}

/**
 * A repository with many tsconfigs cannot afford one compiler program per
 * config up front: the sum is what exhausted the semantic worker. Each bundle
 * knows its file membership from the parsed config and builds its program
 * only when a request needs one of its files.
 */
function createLazyProjectBundle(
  tsMorph: TsMorphModule,
  tsconfigPath: string,
  options: ProjectBundleOptions,
): ProjectBundle {
  let project: Project | null = null;
  let fileNames: ReadonlySet<string> | null | undefined;
  let scope: ProjectScope | undefined;
  const files = (): ReadonlySet<string> | null => {
    if (fileNames === undefined) fileNames = readTsconfigFileNames(tsMorph, tsconfigPath);
    return fileNames;
  };
  const resolveScope = (): ProjectScope => {
    if (scope === undefined) {
      const budget = options.fileBudget ?? currentProjectFileBudget();
      // The file set records each path twice at most (configured and real);
      // the listed count is the configured half.
      const listed = files();
      const count = listed === null ? 0 : Math.ceil(listed.size / 2);
      scope = count > budget ? 'file-closure' : 'project';
    }
    return scope;
  };
  return {
    tsconfigPath,
    get project(): Project {
      project ??= new tsMorph.Project({
        tsConfigFilePath: tsconfigPath,
        skipFileDependencyResolution: true,
        ...(resolveScope() === 'file-closure' ? { skipAddingFilesFromTsConfig: true } : {}),
      });
      return project;
    },
    get loaded(): boolean {
      return project !== null;
    },
    get fileNames(): ReadonlySet<string> | null {
      return files();
    },
    get scope(): ProjectScope {
      return resolveScope();
    },
  };
}

export const FILE_SCOPED_PROJECT_MESSAGE =
  'TypeScript project-wide semantics are unavailable: a compiler project is file-scoped because its tsconfig lists more files than the worker heap can hold.';

/** True when any bundle serves file closures only, so project-wide answers would be incomplete. */
export function hasFileScopedProject(projects: readonly ProjectBundle[]): boolean {
  return projects.some((bundle) => bundle.scope === 'file-closure');
}

/** Every absolute path the given tsconfigs list, read from the configs without building a compiler project. */
export function typescriptProjectFileNames(tsMorph: TsMorphModule, tsconfigPaths: readonly string[]): Set<string> {
  const files = new Set<string>();
  for (const tsconfigPath of tsconfigPaths) {
    for (const fileName of readTsconfigFileNames(tsMorph, tsconfigPath) ?? []) files.add(fileName);
  }
  return files;
}

function readTsconfigFileNames(tsMorph: TsMorphModule, tsconfigPath: string): ReadonlySet<string> | null {
  try {
    const ts = tsMorph.ts;
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.error || !read.config) return null;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath), undefined, tsconfigPath);
    // Record both the configured path and its real path so a symlinked
    // checkout matches whichever form the resolver hands in.
    const fileNames = new Set<string>();
    for (const fileName of parsed.fileNames) {
      const resolved = resolve(fileName);
      fileNames.add(resolved);
      try {
        fileNames.add(realpathSync(resolved));
      } catch {
        // A listed file that does not exist has no real path; the resolved form stands.
      }
    }
    return fileNames;
  } catch {
    return null;
  }
}

export function unavailableProvider(reason: string, tsconfigPath?: string, tsconfigPaths?: string[]): SemanticProvider {
  return {
    language: 'typescript',
    availability: () => ({ available: false, reason, tsconfigPath, tsconfigPaths }),
    importUsage: () => [],
    referencesFor: () => [],
    calleesFor: () => [],
    signatureFor: () => null,
  };
}
