import {
  classifyProjectInputPath,
  type FileDependencyGraph,
  type ProjectFileFingerprint,
  type ProjectInputSnapshot,
} from '../../domain/project-input.js';
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

export interface TypeScriptSemanticIdentityBuilderInput {
  projectFiles: readonly string[];
  snapshot: ProjectInputSnapshot;
  graph: FileDependencyGraph | null;
  engineIdentity: string;
}

export interface TypeScriptSemanticIdentityBuilder {
  identityFor(targetFile: string, schemaVersion: string): TypeScriptSemanticIdentity;
}

export function buildTypeScriptSemanticIdentity(input: TypeScriptSemanticIdentityInput): TypeScriptSemanticIdentity {
  return createTypeScriptSemanticIdentityBuilder(input).identityFor(input.targetFile, input.schemaVersion);
}

export function createTypeScriptSemanticIdentityBuilder(
  input: TypeScriptSemanticIdentityBuilderInput,
): TypeScriptSemanticIdentityBuilder {
  const projectFiles = sortedUnique(input.projectFiles);
  const projectFileSet = new Set(projectFiles);
  const filesByPath = new Map(input.snapshot.files.map((file) => [file.path, file]));
  const globalInputs = input.snapshot.files
    .filter((file) => {
      const kind = classifyProjectInputPath(file.path, ['typescript']);
      return kind === 'config' || kind === 'ambient';
    })
    .map((file) => file.path);
  const requiredProjectFiles = sortedUnique([...projectFiles, ...globalInputs]);
  const missingProjectInput = requiredProjectFiles.find((path) => !filesByPath.has(path));
  const hasDuplicateInput = new Set(input.snapshot.files.map((file) => file.path)).size !== input.snapshot.files.length;
  const hasUnreadableProjectInput =
    !missingProjectInput && requiredProjectFiles.some((path) => isUnreadable(filesByPath.get(path)!));
  const projectIdentity = sha256Hex(
    JSON.stringify({
      pnpmWorkspaces: input.snapshot.pnpmWorkspaces,
      typescriptProjectMode: input.snapshot.typescriptProjectMode,
      typescriptProjects: sortedUnique(input.snapshot.typescriptProjects),
      membership: projectFiles,
    }),
  );
  const closureCache = new Map<string, string[]>();

  return {
    identityFor(targetFile, schemaVersion) {
      if (!projectFileSet.has(targetFile)) return unkeyed('target-outside-project');
      if (hasDuplicateInput) return unkeyed('duplicate-input-path');
      if (missingProjectInput) return unkeyed('missing-input-fingerprint');
      if (hasUnreadableProjectInput) return unkeyed('unreadable-input');

      const reasons: TypeScriptSemanticIdentityReason[] = [];
      let semanticFiles: string[];
      let mode: TypeScriptSemanticIdentityMode;
      if (input.graph === null) {
        reasons.push('dependency-graph-unavailable');
        mode = 'whole-project';
        semanticFiles = requiredProjectFiles;
      } else {
        const closure = cachedDependencyClosure(targetFile, input.graph, closureCache);
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
          schemaVersion,
          projectIdentity,
          inputs: fingerprints,
        }),
      );
      return { version: 1, key, mode, inputFiles: semanticFiles, reasons };
    },
  };
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

function cachedDependencyClosure(
  targetFile: string,
  graph: FileDependencyGraph,
  cache: Map<string, string[]>,
): string[] {
  const existing = cache.get(targetFile);
  if (existing) return existing;
  const closure = dependencyClosure(targetFile, graph);
  cache.set(targetFile, closure);
  return closure;
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
