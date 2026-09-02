import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Project } from 'ts-morph';
import type * as TsMorph from 'ts-morph';
import type { SemanticProvider } from '../types.js';

export type TsMorphModule = typeof TsMorph;

export interface ProjectBundle {
  tsconfigPath: string;
  /** The compiler project, created on first access so unused tsconfigs cost nothing. */
  readonly project: Project;
  /** True once the compiler project exists. */
  readonly loaded: boolean;
  /** Absolute paths the tsconfig includes, or null when the config could not be parsed. */
  readonly fileNames: ReadonlySet<string> | null;
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

export function createTsMorphProjectBundles(tsMorph: TsMorphModule, tsconfigPaths: readonly string[]): ProjectBundle[] {
  return tsconfigPaths.map((tsconfigPath) => createLazyProjectBundle(tsMorph, tsconfigPath));
}

/**
 * A repository with many tsconfigs cannot afford one compiler program per
 * config up front: the sum is what exhausted the semantic worker. Each bundle
 * knows its file membership from the parsed config and builds its program
 * only when a request needs one of its files.
 */
function createLazyProjectBundle(tsMorph: TsMorphModule, tsconfigPath: string): ProjectBundle {
  let project: Project | null = null;
  let fileNames: ReadonlySet<string> | null | undefined;
  return {
    tsconfigPath,
    get project(): Project {
      project ??= new tsMorph.Project({ tsConfigFilePath: tsconfigPath, skipFileDependencyResolution: true });
      return project;
    },
    get loaded(): boolean {
      return project !== null;
    },
    get fileNames(): ReadonlySet<string> | null {
      if (fileNames === undefined) fileNames = readTsconfigFileNames(tsMorph, tsconfigPath);
      return fileNames;
    },
  };
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
