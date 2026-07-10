import { createRequire } from 'node:module';
import type { Project } from 'ts-morph';
import type * as TsMorph from 'ts-morph';
import type { SemanticProvider } from '../types.js';

export type TsMorphModule = typeof TsMorph;

export interface ProjectBundle {
  tsconfigPath: string;
  project: Project;
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
  return tsconfigPaths.map((tsconfigPath) => ({
    tsconfigPath,
    project: new tsMorph.Project({
      tsConfigFilePath: tsconfigPath,
      skipFileDependencyResolution: true,
    }),
  }));
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
