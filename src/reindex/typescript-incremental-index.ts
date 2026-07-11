import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import { inspectTypeScriptDocumentProducer } from './typescript-document-emitter.js';
import {
  assembleAffectedTypeScriptFragments,
  assembleTypeScriptIndexes,
  commitTypeScriptFragmentGeneration,
  ensureTypeScriptFragmentGeneration,
} from './typescript-fragment-store.js';
import {
  commitTypeScriptOverlay,
  materializeTypeScriptOverlay,
  TYPESCRIPT_DEFERRED_SCIP_THRESHOLD_BYTES,
} from './typescript-overlay-store.js';
import { publishedTypeScriptIndexGeneration } from './typescript-index-protocol.js';
import { TypeScriptIndexRequester } from './typescript-index-requester.js';
import { classifyProjectInputPath } from './project-files.js';
import { discoverTypeScriptProjectRoots } from './typescript-projects.js';
import type { SemanticReferenceFragment } from '../semantic/types.js';

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
  candidateAffectedScipPath: string;
  /** Whether previousShardPath already represents previousSnapshot. */
  baseShardCurrent: boolean;
  previousSnapshot: ProjectInputSnapshot | null;
  currentSnapshot: ProjectInputSnapshot;
  projectMode: TypeScriptProjectMode | undefined;
  onStatus: (message: string) => void;
}

export interface MaterializedTypeScriptIncrementalIndex {
  scipPath: string;
  candidateScipPath: string;
  affectedScipPath: string;
  /** False when the accepted database is current but the whole SCIP companion is represented by an overlay. */
  completeScipUpdated: boolean;
  durationMs: number;
  cold: boolean;
  changedFiles: string[];
  affectedFiles: string[];
  producerIdentity: string;
  previousFragmentGeneration: string;
  nextFragmentGeneration: string;
  manifest: ProjectChangeManifest;
  plan: AffectedFilePlan;
  projectFileCount: number;
  referenceFragmentsByFile: Map<string, SemanticReferenceFragment[]>;
  timings: {
    runtimeMs: number;
    graphMs: number;
    requestMs: number;
    serviceMs: number;
    assemblyMs: number;
    fragmentStoreMs: number;
    writeMs: number;
  };
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
    let phaseStartedAt = performance.now();
    const availability = inspectTypeScriptDocumentProducer();
    if (!availability.available) throw new Error(availability.reason);
    const runtimeMs = performance.now() - phaseStartedAt;
    phaseStartedAt = performance.now();
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
    const graphMs = performance.now() - phaseStartedAt;
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

    phaseStartedAt = performance.now();
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
    const requestMs = performance.now() - phaseStartedAt;
    const deferCompleteScip = statSync(input.previousShardPath).size >= TYPESCRIPT_DEFERRED_SCIP_THRESHOLD_BYTES;
    phaseStartedAt = performance.now();
    const baseIndexBytes = deferCompleteScip ? null : readFileSync(input.previousShardPath);
    const assembled = deferCompleteScip
      ? {
          completeIndexBytes: null,
          affectedIndexBytes: assembleAffectedTypeScriptFragments(response.fragments),
        }
      : assembleTypeScriptIndexes({
          packageVersion: availability.packageVersion,
          baseIndexBytes: baseIndexBytes!,
          fragments: response.fragments,
        });
    const assemblyMs = performance.now() - phaseStartedAt;
    phaseStartedAt = performance.now();
    if (deferCompleteScip) {
      commitTypeScriptOverlay({
        cacheDir: input.cacheDir,
        previousGenerationIdentity: eligibility.previousFragmentGeneration,
        nextGenerationIdentity: eligibility.nextFragmentGeneration,
        producerIdentity: availability.producerIdentity,
        projectIdentity: eligibility.projectIdentity,
        baseShardCurrent: input.baseShardCurrent,
        fragments: response.fragments,
      });
    } else {
      ensureTypeScriptFragmentGeneration({
        cacheDir: input.cacheDir,
        packageVersion: availability.packageVersion,
        indexBytes: baseIndexBytes!,
        producerIdentity: availability.producerIdentity,
        projectIdentity: eligibility.projectIdentity,
        generationIdentity: eligibility.previousFragmentGeneration,
        documentIdentities: eligibility.previousDocumentIdentities,
        allowUntrackedDocuments: true,
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
    }
    const fragmentStoreMs = performance.now() - phaseStartedAt;
    phaseStartedAt = performance.now();
    if (assembled.completeIndexBytes) writeFileSync(input.candidateShardPath, assembled.completeIndexBytes);
    writeFileSync(input.candidateAffectedScipPath, assembled.affectedIndexBytes);
    const writeMs = performance.now() - phaseStartedAt;
    const result = {
      scipPath: deferCompleteScip ? input.previousShardPath : input.candidateShardPath,
      candidateScipPath: input.candidateShardPath,
      affectedScipPath: input.candidateAffectedScipPath,
      completeScipUpdated: !deferCompleteScip,
      durationMs: Date.now() - startedAt,
      cold: response.cold,
      changedFiles: eligibility.plan.changedFiles,
      affectedFiles: eligibility.plan.affectedFiles,
      producerIdentity: availability.producerIdentity,
      previousFragmentGeneration: eligibility.previousFragmentGeneration,
      nextFragmentGeneration: eligibility.nextFragmentGeneration,
      manifest: eligibility.manifest,
      plan: eligibility.plan,
      projectFileCount: projectFiles.length,
      referenceFragmentsByFile: new Map(
        response.fragments.map((fragment) => [fragment.relativePath, fragment.referenceFragments]),
      ),
      timings: {
        runtimeMs,
        graphMs,
        requestMs,
        serviceMs: response.durationMs,
        assemblyMs,
        fragmentStoreMs,
        writeMs,
      },
    };
    input.onStatus(
      `Incremental TypeScript index emitted ${result.affectedFiles.length} affected document(s) in ${(result.durationMs / 1000).toFixed(3)}s (${result.cold ? 'cold' : 'warm'} service; ${deferCompleteScip ? 'whole SCIP deferred' : 'whole SCIP current'}; runtime ${runtimeMs.toFixed(0)}ms, graph ${graphMs.toFixed(0)}ms, request ${requestMs.toFixed(0)}ms, assembly ${assemblyMs.toFixed(0)}ms, fragments ${fragmentStoreMs.toFixed(0)}ms, write ${writeMs.toFixed(0)}ms).`,
    );
    return result;
  } catch (error) {
    input.onStatus(
      `Incremental TypeScript index unavailable: ${error instanceof Error ? error.message : String(error)}. Falling back to the whole-project indexer.`,
    );
    return null;
  }
}

export function materializeDeferredTypeScriptIndex(input: {
  cacheDir: string;
  generationIdentity: string;
  baseShardPath: string;
  candidateShardPath: string;
}): void {
  const availability = inspectTypeScriptDocumentProducer();
  if (!availability.available) throw new Error(availability.reason);
  const bytes = materializeTypeScriptOverlay({
    cacheDir: input.cacheDir,
    generationIdentity: input.generationIdentity,
    baseIndexBytes: readFileSync(input.baseShardPath),
    packageVersion: availability.packageVersion,
  });
  writeFileSync(input.candidateShardPath, bytes);
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
  const snapshotPaths = new Set(snapshot.files.map((file) => file.path));
  const builder = createTypeScriptSemanticIdentityBuilder({
    projectFiles: projectFiles.filter((file) => snapshotPaths.has(file)),
    snapshot,
    graph,
    engineIdentity: producerIdentity,
  });
  const result = new Map<string, string>();
  for (const file of requestedFiles) {
    const identity = builder.identityFor(file, 'typescript-scip-document-v1');
    if (identity.key) {
      result.set(file, identity.key);
      continue;
    }
    if (snapshotPaths.has(file)) return null;
    // Upstream indexers may include ignored generated outputs. They are not
    // project inputs and cannot trigger this route, so bind their retained
    // fragment to the producer/path instead of pretending they were hashed.
    result.set(file, sha256(JSON.stringify({ version: 1, producerIdentity, generatedDocument: file })));
  }
  return result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
