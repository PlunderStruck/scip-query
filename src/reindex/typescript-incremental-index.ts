import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TypeScriptProjectMode } from '../domain/types.js';
import { createTypeScriptSemanticIdentityBuilder } from '../semantic/typescript/semantic-identity.js';
import { isTypeScriptLike } from '../semantic/typescript/source-kinds.js';
import { ScipDatabase } from '../storage/db.js';
import { indexedDocumentPaths } from '../storage/scip-documents.js';
import { buildFileDepGraph } from '../symbols/graph/file-dep-graph.js';
import {
  buildProjectChangeManifest,
  planAffectedFiles,
  type AffectedFilePlan,
  type FileDependencyGraph,
  type ProjectChangeManifest,
  type ProjectInputSnapshot,
} from './affected-set.js';
import { loadTypeScriptDocumentRuntime } from './typescript-document-emitter.js';
import {
  assembleTypeScriptIndex,
  commitTypeScriptFragmentGeneration,
  seedTypeScriptFragmentGeneration,
} from './typescript-fragment-store.js';
import { publishedTypeScriptIndexGeneration } from './typescript-index-protocol.js';
import { TypeScriptIndexRequester } from './typescript-index-requester.js';
import { classifyProjectInputPath } from './project-files.js';
import { discoverTypeScriptProjectRoots } from './typescript-projects.js';

export interface TypeScriptIncrementalEligibilityInput {
  projectMode: TypeScriptProjectMode | undefined;
  workspaceProjects?: readonly string[];
  previousSnapshot: ProjectInputSnapshot | null;
  currentSnapshot: ProjectInputSnapshot;
  projectFiles: readonly string[];
  graph: FileDependencyGraph | null;
  producerIdentity: string;
  rootTsconfigExists: boolean;
}

export type TypeScriptIncrementalEligibility =
  | {
      eligible: true;
      manifest: ProjectChangeManifest;
      plan: AffectedFilePlan;
      projectIdentity: string;
      previousFragmentGeneration: string;
      nextFragmentGeneration: string;
      previousDocumentIdentities: Map<string, string>;
      nextDocumentIdentities: Map<string, string>;
    }
  | { eligible: false; reason: string };

export interface MaterializeTypeScriptIncrementalInput {
  projectRoot: string;
  cacheDir: string;
  previousDbPath: string;
  previousIndexPath: string;
  previousShardPath: string;
  candidateShardPath: string;
  previousSnapshot: ProjectInputSnapshot | null;
  currentSnapshot: ProjectInputSnapshot;
  projectMode: TypeScriptProjectMode | undefined;
  onStatus: (message: string) => void;
}

export interface MaterializedTypeScriptIncrementalIndex {
  scipPath: string;
  durationMs: number;
  cold: boolean;
  changedFiles: string[];
  affectedFiles: string[];
  producerIdentity: string;
  previousFragmentGeneration: string;
  nextFragmentGeneration: string;
}

export function planTypeScriptIncrementalUpdate(
  input: TypeScriptIncrementalEligibilityInput,
): TypeScriptIncrementalEligibility {
  if (
    input.projectMode === 'workspace' &&
    (input.workspaceProjects?.length !== 1 || input.workspaceProjects[0] !== '.')
  ) {
    return { eligible: false, reason: 'workspace has multiple TypeScript projects' };
  }
  if (!input.rootTsconfigExists) return { eligible: false, reason: 'root tsconfig unavailable' };
  if (!input.previousSnapshot) return { eligible: false, reason: 'prior project snapshot unavailable' };
  if (input.graph === null) return { eligible: false, reason: 'dependency graph unavailable' };
  if (input.projectFiles.length === 0) return { eligible: false, reason: 'prior TypeScript documents unavailable' };

  const manifest = buildProjectChangeManifest(input.previousSnapshot, input.currentSnapshot);
  if (manifest.changes.length === 0) return { eligible: false, reason: 'no changed project inputs' };
  if (
    manifest.changes.some(
      (change) => change.kind !== 'modified' || change.inputKind !== 'source' || !isTypeScriptLike(change.path),
    )
  ) {
    return { eligible: false, reason: 'change is not a modified TypeScript source file' };
  }
  const plan = planAffectedFiles(manifest, input.graph, input.projectFiles);
  if (plan.mode !== 'closure' || plan.affectedFiles.length === 0) {
    return {
      eligible: false,
      reason: plan.reasons.length > 0 ? `affected set widened: ${plan.reasons.join(', ')}` : 'empty affected set',
    };
  }

  const projectIdentity = typeScriptFragmentProjectIdentity(
    input.currentSnapshot,
    input.projectFiles,
    input.producerIdentity,
  );
  const previousProjectIdentity = typeScriptFragmentProjectIdentity(
    input.previousSnapshot,
    input.projectFiles,
    input.producerIdentity,
  );
  if (projectIdentity !== previousProjectIdentity) {
    return { eligible: false, reason: 'TypeScript fragment project identity changed' };
  }
  const previousDocumentIdentities = documentIdentities(
    input.previousSnapshot,
    input.projectFiles,
    input.graph,
    input.producerIdentity,
    input.projectFiles,
  );
  if (!previousDocumentIdentities) return { eligible: false, reason: 'prior document identity unavailable' };
  const nextDocumentIdentities = documentIdentities(
    input.currentSnapshot,
    input.projectFiles,
    input.graph,
    input.producerIdentity,
    plan.affectedFiles,
  );
  if (!nextDocumentIdentities) return { eligible: false, reason: 'next document identity unavailable' };

  return {
    eligible: true,
    manifest,
    plan,
    projectIdentity,
    previousFragmentGeneration: typeScriptFragmentGenerationIdentity(input.previousSnapshot, input.producerIdentity),
    nextFragmentGeneration: typeScriptFragmentGenerationIdentity(input.currentSnapshot, input.producerIdentity),
    previousDocumentIdentities,
    nextDocumentIdentities,
  };
}

export function tryMaterializeTypeScriptIncrementalIndex(
  input: MaterializeTypeScriptIncrementalInput,
): MaterializedTypeScriptIncrementalIndex | null {
  const startedAt = Date.now();
  try {
    if (!existsSync(input.previousDbPath) || !existsSync(input.previousShardPath)) {
      throw new Error('prior TypeScript graph or language shard unavailable');
    }
    const availability = loadTypeScriptDocumentRuntime();
    if (!availability.available) throw new Error(availability.reason);
    const db = new ScipDatabase({
      projectRoot: input.projectRoot,
      dbPath: input.previousDbPath,
      indexPath: input.previousIndexPath,
    });
    let projectFiles: string[];
    let graph: FileDependencyGraph;
    try {
      projectFiles = indexedDocumentPaths(db, { includeIgnored: false }).filter(isTypeScriptLike).sort();
      graph = buildFileDepGraph(db);
    } finally {
      db.close();
    }
    const eligibility = planTypeScriptIncrementalUpdate({
      projectMode: input.projectMode,
      workspaceProjects:
        input.projectMode === 'workspace'
          ? discoverTypeScriptProjectRoots(input.projectRoot, input.currentSnapshot.typescriptProjects)
          : undefined,
      previousSnapshot: input.previousSnapshot,
      currentSnapshot: input.currentSnapshot,
      projectFiles,
      graph,
      producerIdentity: availability.producerIdentity,
      rootTsconfigExists: existsSync(join(input.projectRoot, 'tsconfig.json')),
    });
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    const baseGeneration = publishedTypeScriptIndexGeneration(input.previousDbPath);
    if (!baseGeneration) throw new Error('published TypeScript base generation unavailable');

    const requester = new TypeScriptIndexRequester({
      projectRoot: input.projectRoot,
      cacheDir: input.cacheDir,
      baseGeneration,
    });
    const response = requester.request({
      kind: 'emit-documents',
      tsconfigPath: 'tsconfig.json',
      projectArgument: '.',
      projectIdentity: eligibility.projectIdentity,
      producerIdentity: availability.producerIdentity,
      modifiedFiles: eligibility.plan.changedFiles,
      affectedFiles: eligibility.plan.affectedFiles,
    });
    const baseIndexBytes = readFileSync(input.previousShardPath);
    const candidateBytes = assembleTypeScriptIndex({
      runtime: availability.runtime,
      baseIndexBytes,
      fragments: response.fragments,
    });
    seedTypeScriptFragmentGeneration({
      cacheDir: input.cacheDir,
      runtime: availability.runtime,
      indexBytes: baseIndexBytes,
      producerIdentity: availability.producerIdentity,
      projectIdentity: eligibility.projectIdentity,
      generationIdentity: eligibility.previousFragmentGeneration,
      documentIdentities: eligibility.previousDocumentIdentities,
    });
    commitTypeScriptFragmentGeneration({
      cacheDir: input.cacheDir,
      previousGenerationIdentity: eligibility.previousFragmentGeneration,
      producerIdentity: availability.producerIdentity,
      projectIdentity: eligibility.projectIdentity,
      generationIdentity: eligibility.nextFragmentGeneration,
      fragments: response.fragments,
      documentIdentities: eligibility.nextDocumentIdentities,
    });
    writeFileSync(input.candidateShardPath, candidateBytes);
    const result = {
      scipPath: input.candidateShardPath,
      durationMs: Date.now() - startedAt,
      cold: response.cold,
      changedFiles: eligibility.plan.changedFiles,
      affectedFiles: eligibility.plan.affectedFiles,
      producerIdentity: availability.producerIdentity,
      previousFragmentGeneration: eligibility.previousFragmentGeneration,
      nextFragmentGeneration: eligibility.nextFragmentGeneration,
    };
    input.onStatus(
      `Incremental TypeScript index emitted ${result.affectedFiles.length} affected document(s) in ${(result.durationMs / 1000).toFixed(3)}s (${result.cold ? 'cold' : 'warm'} service).`,
    );
    return result;
  } catch (error) {
    input.onStatus(
      `Incremental TypeScript index unavailable: ${error instanceof Error ? error.message : String(error)}. Falling back to the whole-project indexer.`,
    );
    return null;
  }
}

function typeScriptFragmentProjectIdentity(
  snapshot: ProjectInputSnapshot,
  projectFiles: readonly string[],
  producerIdentity: string,
): string {
  const nonSourceInputs = snapshot.files
    .filter((file) => classifyProjectInputPath(file.path, snapshot.languages) !== 'source')
    .map((file) => ({ path: file.path, size: file.size, hash: file.hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256(
    JSON.stringify({
      version: 1,
      producerIdentity,
      pnpmWorkspaces: snapshot.pnpmWorkspaces,
      typescriptProjectMode: snapshot.typescriptProjectMode,
      typescriptProjects: [...snapshot.typescriptProjects].sort(),
      projectFiles: [...projectFiles].sort(),
      nonSourceInputs,
    }),
  );
}

function typeScriptFragmentGenerationIdentity(snapshot: ProjectInputSnapshot, producerIdentity: string): string {
  return sha256(JSON.stringify({ version: 1, producerIdentity, snapshot }));
}

function documentIdentities(
  snapshot: ProjectInputSnapshot,
  projectFiles: readonly string[],
  graph: FileDependencyGraph,
  producerIdentity: string,
  requestedFiles: readonly string[],
): Map<string, string> | null {
  const builder = createTypeScriptSemanticIdentityBuilder({
    projectFiles,
    snapshot,
    graph,
    engineIdentity: producerIdentity,
  });
  const result = new Map<string, string>();
  for (const file of requestedFiles) {
    const identity = builder.identityFor(file, 'typescript-scip-document-v1');
    if (!identity.key) return null;
    result.set(file, identity.key);
  }
  return result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
