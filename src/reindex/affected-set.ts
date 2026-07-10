import type { SupportedLanguage } from '../domain/types.js';
import { isRecord, stringArray } from '../storage/evidence-payload.js';
import { classifyProjectInputPath, type ProjectFileFingerprint, type ProjectInputPathKind } from './project-files.js';

export interface ProjectInputSnapshot {
  version: number;
  languages: readonly SupportedLanguage[];
  pnpmWorkspaces: boolean;
  typescriptProjectMode: string;
  typescriptProjects: readonly string[];
  clojureConfigPath?: string;
  files: readonly ProjectFileFingerprint[];
}

interface ProjectFileChangeBase {
  path: string;
  inputKind: ProjectInputPathKind;
}

export interface AddedProjectFileChange extends ProjectFileChangeBase {
  kind: 'added';
  after: ProjectFileFingerprint;
}

export interface ModifiedProjectFileChange extends ProjectFileChangeBase {
  kind: 'modified';
  before: ProjectFileFingerprint;
  after: ProjectFileFingerprint;
}

export interface DeletedProjectFileChange extends ProjectFileChangeBase {
  kind: 'deleted';
  before: ProjectFileFingerprint;
}

export type ProjectFileChange = AddedProjectFileChange | ModifiedProjectFileChange | DeletedProjectFileChange;

export type ProjectChangeUncertainty =
  | 'prior-snapshot-unavailable'
  | 'snapshot-version-changed'
  | 'duplicate-input-path'
  | 'unreadable-input';

export interface ProjectChangeManifest {
  version: 1;
  changes: ProjectFileChange[];
  projectIdentityChanged: boolean;
  uncertainty: ProjectChangeUncertainty[];
}

export type AffectedSetFallbackReason =
  | 'prior-snapshot-unavailable'
  | 'snapshot-version-changed'
  | 'duplicate-input-path'
  | 'project-identity-changed'
  | 'file-added'
  | 'file-deleted'
  | 'configuration-changed'
  | 'ambient-declaration-changed'
  | 'unreadable-input'
  | 'unclassified-input'
  | 'dependency-graph-unavailable'
  | 'changed-file-outside-project';

export interface AffectedSetFallbackDecision {
  fullProject: boolean;
  reasons: AffectedSetFallbackReason[];
}

export interface AffectedFilePlan {
  mode: 'none' | 'closure' | 'full-project';
  changedFiles: string[];
  affectedFiles: string[];
  reasons: AffectedSetFallbackReason[];
}

export type FileDependencyGraph = ReadonlyMap<string, ReadonlySet<string>>;

export function projectInputSnapshotOrNull(value: unknown): ProjectInputSnapshot | null {
  if (!isRecord(value)) return null;
  if (typeof value['version'] !== 'number') return null;
  if (stringArray(value['languages']) === null) return null;
  if (typeof value['pnpmWorkspaces'] !== 'boolean') return null;
  if (typeof value['typescriptProjectMode'] !== 'string') return null;
  if (stringArray(value['typescriptProjects']) === null) return null;
  if (value['clojureConfigPath'] !== undefined && typeof value['clojureConfigPath'] !== 'string') return null;
  if (!Array.isArray(value['files']) || !value['files'].every(isProjectFileFingerprint)) return null;

  return value as unknown as ProjectInputSnapshot;
}

export function buildProjectChangeManifest(
  previous: ProjectInputSnapshot | null,
  current: ProjectInputSnapshot,
): ProjectChangeManifest {
  const previousFiles = new Map((previous?.files ?? []).map((file) => [file.path, file]));
  const currentFiles = new Map(current.files.map((file) => [file.path, file]));
  const paths = new Set([...previousFiles.keys(), ...currentFiles.keys()]);
  const changes: ProjectFileChange[] = [];

  for (const path of [...paths].sort()) {
    const before = previousFiles.get(path);
    const after = currentFiles.get(path);
    const inputKind = classifyProjectInputPath(path, current.languages);
    if (!before && after) {
      changes.push({ kind: 'added', path, inputKind, after });
    } else if (before && !after) {
      changes.push({ kind: 'deleted', path, inputKind, before });
    } else if (before && after && (before.hash !== after.hash || before.size !== after.size)) {
      changes.push({ kind: 'modified', path, inputKind, before, after });
    }
  }

  const uncertainty = new Set<ProjectChangeUncertainty>();
  if (!previous) uncertainty.add('prior-snapshot-unavailable');
  if (previous && previous.version !== current.version) uncertainty.add('snapshot-version-changed');
  if (hasDuplicatePaths(previous?.files ?? []) || hasDuplicatePaths(current.files)) {
    uncertainty.add('duplicate-input-path');
  }
  if ([...(previous?.files ?? []), ...current.files].some(isUnreadableFingerprint)) {
    uncertainty.add('unreadable-input');
  }

  return {
    version: 1,
    changes,
    projectIdentityChanged: previous ? !sameProjectIdentity(previous, current) : true,
    uncertainty: [...uncertainty].sort(),
  };
}

function hasDuplicatePaths(files: readonly ProjectFileFingerprint[]): boolean {
  return new Set(files.map((file) => file.path)).size !== files.length;
}

function isProjectFileFingerprint(value: unknown): value is ProjectFileFingerprint {
  return (
    isRecord(value) &&
    typeof value['path'] === 'string' &&
    typeof value['size'] === 'number' &&
    typeof value['hash'] === 'string'
  );
}

function isUnreadableFingerprint(file: ProjectFileFingerprint): boolean {
  return file.hash === 'unreadable' || file.size < 0;
}

export function classifyAffectedSetFallback(manifest: ProjectChangeManifest): AffectedSetFallbackDecision {
  const reasons = new Set<AffectedSetFallbackReason>();
  for (const uncertainty of manifest.uncertainty) reasons.add(uncertainty);
  if (manifest.projectIdentityChanged) reasons.add('project-identity-changed');

  for (const change of manifest.changes) {
    if (change.kind === 'added') reasons.add('file-added');
    if (change.kind === 'deleted') reasons.add('file-deleted');
    if (change.inputKind === 'config') reasons.add('configuration-changed');
    if (change.inputKind === 'ambient') reasons.add('ambient-declaration-changed');
    if (change.inputKind === 'other') reasons.add('unclassified-input');
  }

  return { fullProject: reasons.size > 0, reasons: [...reasons].sort() };
}

export function planAffectedFiles(
  manifest: ProjectChangeManifest,
  graph: FileDependencyGraph | null,
  projectFiles: readonly string[],
): AffectedFilePlan {
  const changedFiles = manifest.changes.map((change) => change.path).sort();
  if (changedFiles.length === 0 && !manifest.projectIdentityChanged && manifest.uncertainty.length === 0) {
    return { mode: 'none', changedFiles, affectedFiles: [], reasons: [] };
  }

  const projectFileSet = new Set(projectFiles);
  const fallback = classifyAffectedSetFallback(manifest);
  const reasons = new Set(fallback.reasons);
  if (changedFiles.some((path) => !projectFileSet.has(path))) reasons.add('changed-file-outside-project');

  if (graph === null) {
    reasons.add('dependency-graph-unavailable');
    return fullProjectPlan(changedFiles, projectFileSet, reasons);
  }

  if (reasons.size > 0) {
    return fullProjectPlan(changedFiles, projectFileSet, reasons);
  }

  return {
    mode: 'closure',
    changedFiles,
    affectedFiles: reverseDependencyClosure(changedFiles, graph, projectFileSet),
    reasons: [],
  };
}

function fullProjectPlan(
  changedFiles: string[],
  projectFiles: ReadonlySet<string>,
  reasons: ReadonlySet<AffectedSetFallbackReason>,
): AffectedFilePlan {
  return {
    mode: 'full-project',
    changedFiles,
    affectedFiles: [...projectFiles].sort(),
    reasons: [...reasons].sort(),
  };
}

function reverseDependencyClosure(
  changedFiles: readonly string[],
  graph: FileDependencyGraph,
  projectFiles: ReadonlySet<string>,
): string[] {
  const consumers = new Map<string, Set<string>>();
  for (const [consumer, dependencies] of graph) {
    if (!projectFiles.has(consumer)) continue;
    for (const dependency of dependencies) {
      if (!projectFiles.has(dependency)) continue;
      const entries = consumers.get(dependency) ?? new Set<string>();
      entries.add(consumer);
      consumers.set(dependency, entries);
    }
  }

  const affected = new Set(changedFiles);
  const pending = [...changedFiles];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current === undefined) continue;
    for (const consumer of consumers.get(current) ?? []) {
      if (affected.has(consumer)) continue;
      affected.add(consumer);
      pending.push(consumer);
    }
  }
  return [...affected].sort();
}

function sameProjectIdentity(left: ProjectInputSnapshot, right: ProjectInputSnapshot): boolean {
  return (
    sameStrings(left.languages, right.languages) &&
    left.pnpmWorkspaces === right.pnpmWorkspaces &&
    left.typescriptProjectMode === right.typescriptProjectMode &&
    sameStrings(left.typescriptProjects, right.typescriptProjects) &&
    left.clojureConfigPath === right.clojureConfigPath
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
