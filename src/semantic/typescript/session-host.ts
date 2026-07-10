import { resolve } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import type { ProjectChangeManifest, ProjectFileChange } from '../../reindex/affected-set.js';
import type { SemanticProvider } from '../types.js';
import { createTsMorphProviderFromProjects } from './ts-morph-provider.js';
import {
  createTsMorphProjectBundles,
  loadTsMorph,
  unavailableProvider,
  type ProjectBundle,
  type TsMorphModule,
} from './ts-morph-runtime.js';
import { discoverTypeScriptTsconfigs } from './tsconfig-discovery.js';

export type TypeScriptSessionTransitionMode = 'reuse' | 'refresh' | 'replace';

export interface TypeScriptSessionTransition {
  mode: TypeScriptSessionTransitionMode;
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  reasons: string[];
}

export interface TypeScriptSemanticHostStats {
  providerRequests: number;
  sessionsCreated: number;
  sessionsReused: number;
  sessionsRefreshed: number;
  sessionsReplaced: number;
  projectsCreated: number;
}

export interface TypeScriptSemanticHostOptions {
  loadModule?: () => TsMorphModule | null;
  discoverTsconfigs?: (db: ScipDatabase) => string[];
  createProjects?: (module: TsMorphModule, tsconfigPaths: readonly string[]) => ProjectBundle[];
  createProvider?: (db: ScipDatabase, module: TsMorphModule, projects: ProjectBundle[]) => SemanticProvider;
}

export class TypeScriptSemanticHost {
  private readonly loadModule: () => TsMorphModule | null;
  private readonly discoverTsconfigs: (db: ScipDatabase) => string[];
  private readonly createProjects: (module: TsMorphModule, tsconfigPaths: readonly string[]) => ProjectBundle[];
  private readonly createProvider: (
    db: ScipDatabase,
    module: TsMorphModule,
    projects: ProjectBundle[],
  ) => SemanticProvider;
  private db: ScipDatabase;
  private module: TsMorphModule | null = null;
  private projects: ProjectBundle[] | null = null;
  private provider: SemanticProvider | null = null;
  private stats: TypeScriptSemanticHostStats = {
    providerRequests: 0,
    sessionsCreated: 0,
    sessionsReused: 0,
    sessionsRefreshed: 0,
    sessionsReplaced: 0,
    projectsCreated: 0,
  };

  constructor(db: ScipDatabase, opts: TypeScriptSemanticHostOptions = {}) {
    this.db = db;
    this.loadModule = opts.loadModule ?? loadTsMorph;
    this.discoverTsconfigs = opts.discoverTsconfigs ?? discoverTypeScriptTsconfigs;
    this.createProjects = opts.createProjects ?? createTsMorphProjectBundles;
    this.createProvider =
      opts.createProvider ??
      ((providerDb, module, projects) =>
        createTsMorphProviderFromProjects(providerDb, module, projects, { reusedProjects: true }));
  }

  semanticProvider(): SemanticProvider {
    this.stats.providerRequests += 1;
    if (this.provider) {
      this.stats.sessionsReused += 1;
      return this.provider;
    }
    return this.createSession();
  }

  advanceGeneration(db: ScipDatabase, manifest: ProjectChangeManifest): TypeScriptSessionTransition {
    const transition = planTypeScriptSessionTransition(manifest);
    this.provider?.dispose?.();
    this.provider = null;
    this.db = db;
    if (!this.projects) return transition;

    if (transition.mode === 'replace') {
      this.projects = null;
      this.module = null;
      this.stats.sessionsReplaced += 1;
      return transition;
    }
    if (transition.mode === 'refresh') {
      applyProjectSourceChanges(this.projects, db.config.projectRoot, transition);
      this.stats.sessionsRefreshed += 1;
    }
    return transition;
  }

  snapshotStats(): TypeScriptSemanticHostStats {
    return { ...this.stats };
  }

  dispose(): void {
    this.provider?.dispose?.();
    this.provider = null;
    this.projects = null;
    this.module = null;
  }

  private createSession(): SemanticProvider {
    const module = this.module ?? this.loadModule();
    if (!module) {
      this.provider = unavailableProvider('ts-morph is not installed');
      return this.provider;
    }
    this.module = module;
    if (!this.projects) {
      const tsconfigPaths = this.discoverTsconfigs(this.db);
      if (tsconfigPaths.length === 0) {
        this.provider = unavailableProvider('no tsconfig found');
        return this.provider;
      }
      this.projects = this.createProjects(module, tsconfigPaths);
      this.stats.projectsCreated += this.projects.length;
    }
    this.provider = this.createProvider(this.db, module, this.projects);
    this.stats.sessionsCreated += 1;
    return this.provider;
  }
}

export function planTypeScriptSessionTransition(manifest: ProjectChangeManifest): TypeScriptSessionTransition {
  const reasons = new Set<string>();
  if (manifest.projectIdentityChanged) reasons.add('project-identity-changed');
  for (const uncertainty of manifest.uncertainty) reasons.add(uncertainty);
  for (const change of manifest.changes) {
    if (change.inputKind !== 'source') reasons.add(`${change.inputKind}-input-changed`);
  }
  if (reasons.size > 0) {
    return {
      mode: 'replace',
      addedFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      reasons: [...reasons].sort(),
    };
  }

  const addedFiles = changedPaths(manifest.changes, 'added');
  const modifiedFiles = changedPaths(manifest.changes, 'modified');
  const deletedFiles = changedPaths(manifest.changes, 'deleted');
  return {
    mode: addedFiles.length + modifiedFiles.length + deletedFiles.length === 0 ? 'reuse' : 'refresh',
    addedFiles,
    modifiedFiles,
    deletedFiles,
    reasons: [],
  };
}

function changedPaths(changes: readonly ProjectFileChange[], kind: ProjectFileChange['kind']): string[] {
  return changes
    .filter((change) => change.kind === kind)
    .map((change) => change.path)
    .sort();
}

function applyProjectSourceChanges(
  projects: readonly ProjectBundle[],
  projectRoot: string,
  transition: TypeScriptSessionTransition,
): void {
  for (const bundle of projects) {
    for (const relativePath of transition.deletedFiles) {
      bundle.project.getSourceFile(resolve(projectRoot, relativePath))?.forget();
    }
    for (const relativePath of transition.modifiedFiles) {
      const sourceFile = bundle.project.getSourceFile(resolve(projectRoot, relativePath));
      if (sourceFile) sourceFile.refreshFromFileSystemSync();
    }
    if (transition.addedFiles.length > 0) {
      bundle.project.addSourceFilesFromTsConfig(bundle.tsconfigPath);
    }
  }
}
