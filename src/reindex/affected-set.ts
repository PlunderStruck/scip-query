import type { FileDependencyGraph, ProjectChangeManifest } from '../domain/project-input.js';

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
