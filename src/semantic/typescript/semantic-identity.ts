import type { ProjectInputSnapshot, FileDependencyGraph } from '../../reindex/affected-set.js';
import { classifyProjectInputPath, type ProjectFileFingerprint } from '../../reindex/project-files.js';
import { sha256Hex } from '../../storage/evidence-cache.js';

export type TypeScriptSemanticIdentityMode = 'dependency-closure' | 'whole-project' | 'unkeyed';

export type TypeScriptSemanticIdentityReason =
  | 'dependency-graph-unavailable'
  | 'duplicate-input-path'
  | 'missing-input-fingerprint'
  | 'target-outside-project'
  | 'unreadable-input';

export interface TypeScriptSemanticIdentity {
  version: 1;
  key: string | null;
  mode: TypeScriptSemanticIdentityMode;
  inputFiles: string[];
  reasons: TypeScriptSemanticIdentityReason[];
}

export interface TypeScriptSemanticIdentityInput {
  targetFile: string;
  projectFiles: readonly string[];
  snapshot: ProjectInputSnapshot;
  graph: FileDependencyGraph | null;
  engineIdentity: string;
  schemaVersion: string;
}

export function buildTypeScriptSemanticIdentity(input: TypeScriptSemanticIdentityInput): TypeScriptSemanticIdentity {
  const projectFiles = sortedUnique(input.projectFiles);
  if (!projectFiles.includes(input.targetFile)) {
    return unkeyed('target-outside-project');
  }
  if (new Set(input.snapshot.files.map((file) => file.path)).size !== input.snapshot.files.length) {
    return unkeyed('duplicate-input-path');
  }

  const filesByPath = new Map(input.snapshot.files.map((file) => [file.path, file]));
  const globalInputs = input.snapshot.files
    .filter((file) => {
      const kind = classifyProjectInputPath(file.path, ['typescript']);
      return kind === 'config' || kind === 'ambient';
    })
    .map((file) => file.path);
  const requiredProjectFiles = sortedUnique([...projectFiles, ...globalInputs]);
  const missingProjectInput = requiredProjectFiles.find((path) => !filesByPath.has(path));
  if (missingProjectInput) return unkeyed('missing-input-fingerprint');
  if (requiredProjectFiles.some((path) => isUnreadable(filesByPath.get(path)!))) {
    return unkeyed('unreadable-input');
  }

  const reasons: TypeScriptSemanticIdentityReason[] = [];
  let semanticFiles: string[];
  let mode: TypeScriptSemanticIdentityMode;
  if (input.graph === null) {
    reasons.push('dependency-graph-unavailable');
    mode = 'whole-project';
    semanticFiles = requiredProjectFiles;
  } else {
    const closure = dependencyClosure(input.targetFile, input.graph);
    const missingDependency = closure.find((path) => !filesByPath.has(path));
    if (missingDependency) return unkeyed('missing-input-fingerprint');
    semanticFiles = sortedUnique([...closure, ...globalInputs]);
    if (semanticFiles.some((path) => isUnreadable(filesByPath.get(path)!))) {
      return unkeyed('unreadable-input');
    }
    mode = 'dependency-closure';
  }

  const fingerprints = semanticFiles.map((path) => fingerprintValue(filesByPath.get(path)!));
  const key = sha256Hex(
    JSON.stringify({
      version: 1,
      engineIdentity: input.engineIdentity,
      schemaVersion: input.schemaVersion,
      project: {
        pnpmWorkspaces: input.snapshot.pnpmWorkspaces,
        typescriptProjectMode: input.snapshot.typescriptProjectMode,
        typescriptProjects: sortedUnique(input.snapshot.typescriptProjects),
        membership: projectFiles,
      },
      inputs: fingerprints,
    }),
  );
  return { version: 1, key, mode, inputFiles: semanticFiles, reasons };
}

function dependencyClosure(targetFile: string, graph: FileDependencyGraph): string[] {
  const visited = new Set<string>();
  const pending = [targetFile];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const dependency of [...(graph.get(current) ?? [])].sort()) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited].sort();
}

function fingerprintValue(file: ProjectFileFingerprint): ProjectFileFingerprint {
  return { path: file.path, size: file.size, hash: file.hash };
}

function isUnreadable(file: ProjectFileFingerprint): boolean {
  return file.size < 0 || file.hash === 'unreadable';
}

function unkeyed(reason: TypeScriptSemanticIdentityReason): TypeScriptSemanticIdentity {
  return { version: 1, key: null, mode: 'unkeyed', inputFiles: [], reasons: [reason] };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
