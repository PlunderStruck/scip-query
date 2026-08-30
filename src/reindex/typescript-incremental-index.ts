import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildProjectChangeManifest,
  classifyProjectInputPath,
  type FileDependencyGraph,
  type ProjectChangeManifest,
  type ProjectFileChange,
  type ProjectInputSnapshot,
} from '../domain/project-input.js';
import type { TypeScriptProjectMode } from '../domain/types.js';
import { monotonicNowMs } from '../domain/time.js';
import { isTypeScriptLike } from '../semantic/typescript/source-kinds.js';
import { ScipDatabase } from '../storage/db.js';
import { indexedDocumentPaths } from '../storage/scip-documents.js';
import {
  captureTypeScriptPlanningDependencyGraph,
  readPersistedFileDependencyGraph,
  type FileDependencyGraphSnapshot,
} from '../symbols/graph/file-dep-graph.js';
import { planAffectedFiles, type AffectedFilePlan } from './affected-set.js';
import { inspectTypeScriptDocumentProducer, type TypeScriptDocumentFragment } from './typescript-document-emitter.js';
import { assembleAffectedTypeScriptFragments } from './typescript-fragment-store.js';
import { commitTypeScriptOverlay, materializeTypeScriptOverlay } from './typescript-overlay-store.js';
import { publishedTypeScriptIndexGeneration } from './typescript-index-protocol.js';
import { TypeScriptIndexMemoryPressureError, TypeScriptIndexRequester } from './typescript-index-requester.js';
import { discoverTypeScriptProjectRoots } from './typescript-projects.js';
import type { SemanticReferenceFragment } from '../semantic/types.js';
import { readFileWithinLimit, SCIP_ARTIFACT_MAX_BYTES } from '../platform/bounded-file.js';

const TYPESCRIPT_DOCUMENT_BATCH_SIZE = 128;
const TYPESCRIPT_INCREMENTAL_CHANGE_LIMIT = 256;

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

export interface TypeScriptIncrementalProjectPlan {
  tsconfigPath: string;
  projectArgument: string;
  modifiedFiles: string[];
  removedFiles: string[];
  affectedFiles: string[];
}

export type TypeScriptIncrementalEligibility =
  | {
      eligible: true;
      manifest: ProjectChangeManifest;
      plan: AffectedFilePlan;
      projectIdentity: string;
      previousFragmentGeneration: string;
      nextFragmentGeneration: string;
      /** @deprecated Document identities are no longer materialized during reindex planning. */
      previousDocumentIdentities?: Map<string, string>;
      /** @deprecated Document identities are no longer materialized during reindex planning. */
      nextDocumentIdentities?: Map<string, string>;
      projects: TypeScriptIncrementalProjectPlan[];
      deletedFiles: string[];
      replaceProject: boolean;
      /** Compatibility projection for single-project callers. */
      tsconfigPath?: string;
      /** Compatibility projection for single-project callers. */
      projectArgument?: string;
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
  /** Receives the exact reason that made the safe incremental path unavailable. */
  onUnavailable?: (reason: string) => void;
}

// scip-query: ignore-stale — reviewed S1 owned contract; this names the materialized incremental-index result.
export interface MaterializedTypeScriptIncrementalIndex {
  scipPath: string;
  candidateScipPath: string;
  affectedScipPath: string;
  affectedBatches: Array<{ scipPath: string; affectedFiles: string[]; deletedFiles: string[] }>;
  /** False when the accepted database is current but the whole SCIP companion is represented by an overlay. */
  completeScipUpdated: boolean;
  durationMs: number;
  cold: boolean;
  changedFiles: string[];
  affectedFiles: string[];
  deletedFiles: string[];
  producerIdentity: string;
  previousFragmentGeneration: string;
  nextFragmentGeneration: string;
  manifest: ProjectChangeManifest;
  plan: AffectedFilePlan;
  projectFileCount: number;
  /** Exact dependency graph used to plan this update, retained for next-generation carry-forward when loaded. */
  dependencyGraphSnapshot?: FileDependencyGraphSnapshot;
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
  const workspaceProjects = input.projectMode === 'workspace' ? (input.workspaceProjects ?? []) : ['.'];
  if (workspaceProjects.length === 0) return { eligible: false, reason: 'workspace project roots unavailable' };
  if (workspaceProjects.length === 1 && workspaceProjects[0] === '.' && !input.rootTsconfigExists) {
    return { eligible: false, reason: 'root tsconfig unavailable' };
  }
  if (!input.previousSnapshot) return { eligible: false, reason: 'prior project snapshot unavailable' };
  if (input.graph === null) return { eligible: false, reason: 'dependency graph unavailable' };
  if (input.projectFiles.length === 0) return { eligible: false, reason: 'prior TypeScript documents unavailable' };

  const manifest = buildProjectChangeManifest(input.previousSnapshot, input.currentSnapshot);
  if (manifest.changes.length === 0) return { eligible: false, reason: 'no changed project inputs' };
  const typescriptSourceChanges = manifest.changes.filter(
    (change) => change.inputKind === 'source' && isTypeScriptLike(change.path),
  );
  const compilerChanges = typeScriptCompilerChanges(manifest);
  const compilerManifest = { ...manifest, changes: compilerChanges };
  const addedPaths = typescriptSourceChanges.filter((change) => change.kind === 'added').map((change) => change.path);
  const deletedPaths = typescriptSourceChanges
    .filter((change) => change.kind === 'deleted')
    .map((change) => change.path);
  const modifiedChanges = typescriptSourceChanges.filter((change) => change.kind === 'modified');
  const projectIdentity = typeScriptFragmentProjectIdentity(input.currentSnapshot, input.producerIdentity);
  const previousProjectIdentity = typeScriptFragmentProjectIdentity(input.previousSnapshot, input.producerIdentity);
  const replaceProject = typeScriptProjectReplacementRequired(
    manifest,
    compilerChanges,
    projectIdentity,
    previousProjectIdentity,
  );
  if (typescriptSourceChanges.length === 0 && !replaceProject) {
    return { eligible: false, reason: 'change does not affect the configured TypeScript project' };
  }
  const currentTypeScriptFiles = input.currentSnapshot.files
    .filter(
      (file) =>
        classifyProjectInputPath(file.path, input.currentSnapshot.languages) === 'source' &&
        isTypeScriptLike(file.path),
    )
    .map((file) => file.path)
    .sort();
  const currentTypeScriptSet = new Set(currentTypeScriptFiles);
  const effectiveDeletedPaths = replaceProject
    ? input.projectFiles.filter((file) => !currentTypeScriptSet.has(file)).sort()
    : [...deletedPaths].sort();
  const incrementalManifest = replaceProject ? compilerManifest : { ...manifest, changes: typescriptSourceChanges };
  const affected = replaceProject
    ? {
        eligible: true as const,
        plan: {
          ...planAffectedFiles(compilerManifest, input.graph, [
            ...new Set([...currentTypeScriptFiles, ...effectiveDeletedPaths]),
          ]),
          mode: 'full-project' as const,
        },
      }
    : planTypeScriptIncrementalAffectedSet(
        modifiedChanges,
        addedPaths,
        effectiveDeletedPaths,
        input.graph,
        input.projectFiles,
      );
  if (!affected.eligible) return affected;
  const plan = affected.plan;
  const deletedSet = new Set(effectiveDeletedPaths);
  const projects = partitionWorkspacePlan(plan, workspaceProjects, input.graph, deletedSet);
  if (!projects) {
    return { eligible: false, reason: 'affected files cross or ambiguously match TypeScript projects' };
  }
  const singleProject = projects.length === 1 ? projects[0] : undefined;
  return {
    eligible: true,
    manifest: incrementalManifest,
    plan,
    projectIdentity,
    previousFragmentGeneration: typeScriptFragmentGenerationIdentity(input.previousSnapshot, input.producerIdentity),
    nextFragmentGeneration: typeScriptFragmentGenerationIdentity(input.currentSnapshot, input.producerIdentity),
    projects,
    deletedFiles: effectiveDeletedPaths,
    replaceProject,
    ...(singleProject
      ? { tsconfigPath: singleProject.tsconfigPath, projectArgument: singleProject.projectArgument }
      : {}),
  };
}

function typeScriptCompilerChanges(manifest: ProjectChangeManifest): ProjectFileChange[] {
  return manifest.changes.filter(
    (change) =>
      (change.inputKind === 'source' && isTypeScriptLike(change.path)) ||
      change.inputKind === 'config' ||
      change.inputKind === 'ambient',
  );
}

function typeScriptProjectReplacementRequired(
  manifest: ProjectChangeManifest,
  compilerChanges: readonly ProjectFileChange[],
  projectIdentity: string,
  previousProjectIdentity: string,
): boolean {
  return (
    projectIdentity !== previousProjectIdentity ||
    manifest.projectIdentityChanged ||
    manifest.uncertainty.length > 0 ||
    compilerChanges.length > TYPESCRIPT_INCREMENTAL_CHANGE_LIMIT ||
    compilerChanges.some((change) => change.inputKind === 'config' || change.inputKind === 'ambient')
  );
}

function planTypeScriptIncrementalAffectedSet(
  modifiedChanges: readonly ProjectFileChange[],
  addedPaths: readonly string[],
  deletedPaths: readonly string[],
  graph: FileDependencyGraph,
  projectFiles: readonly string[],
): { eligible: true; plan: AffectedFilePlan } | { eligible: false; reason: string } {
  if (modifiedChanges.length === 0) {
    if (addedPaths.length === 0 && deletedPaths.length === 0) return { eligible: false, reason: 'empty affected set' };
    return {
      eligible: true,
      plan: {
        mode: 'closure',
        changedFiles: [...new Set([...addedPaths, ...deletedPaths])].sort(),
        affectedFiles: [
          ...new Set([...addedPaths, ...reverseDependencyClosure(deletedPaths, graph, projectFiles)]),
        ].sort(),
        reasons: [],
      },
    };
  }
  const modifiedPlan = planAffectedFiles(
    {
      version: 1,
      changes: [...modifiedChanges],
      projectIdentityChanged: false,
      uncertainty: [],
    },
    graph,
    projectFiles,
  );
  if (modifiedPlan.mode !== 'closure' || modifiedPlan.affectedFiles.length === 0) {
    return {
      eligible: false,
      reason:
        modifiedPlan.reasons.length > 0
          ? `affected set widened: ${modifiedPlan.reasons.join(', ')}`
          : 'empty affected set',
    };
  }
  return {
    eligible: true,
    plan: {
      mode: 'closure',
      changedFiles: [...new Set([...modifiedPlan.changedFiles, ...addedPaths, ...deletedPaths])].sort(),
      affectedFiles: [
        ...new Set([
          ...modifiedPlan.affectedFiles,
          ...addedPaths,
          ...reverseDependencyClosure(deletedPaths, graph, projectFiles),
        ]),
      ].sort(),
      reasons: [],
    },
  };
}

function partitionWorkspacePlan(
  plan: AffectedFilePlan,
  workspaceProjects: readonly string[],
  graph: FileDependencyGraph,
  deletedFiles: ReadonlySet<string>,
): TypeScriptIncrementalProjectPlan[] | null {
  const affectedByProject = new Map<string, string[]>();
  for (const file of plan.affectedFiles) {
    const owner = ownedWorkspaceProject(file, workspaceProjects);
    if (!owner) return null;
    const files = affectedByProject.get(owner) ?? [];
    files.push(file);
    affectedByProject.set(owner, files);
  }

  const projects: TypeScriptIncrementalProjectPlan[] = [];
  for (const [projectArgument, affectedFiles] of [...affectedByProject].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const affectedSet = new Set(affectedFiles);
    const modifiedFiles = plan.changedFiles.filter(
      (changedFile) =>
        !deletedFiles.has(changedFile) &&
        (affectedSet.has(changedFile) || affectedFiles.some((file) => dependsOn(file, changedFile, graph))),
    );
    const removedFiles = plan.changedFiles.filter(
      (changedFile) =>
        deletedFiles.has(changedFile) &&
        (affectedSet.has(changedFile) || affectedFiles.some((file) => dependsOn(file, changedFile, graph))),
    );
    const survivingAffectedFiles = affectedFiles.filter((file) => !deletedFiles.has(file));
    if (modifiedFiles.length === 0 && removedFiles.length === 0 && survivingAffectedFiles.length === 0) return null;
    projects.push({
      projectArgument,
      tsconfigPath: projectArgument === '.' ? 'tsconfig.json' : `${projectArgument}/tsconfig.json`,
      modifiedFiles,
      removedFiles,
      affectedFiles: [...survivingAffectedFiles].sort(),
    });
  }
  return projects;
}

function reverseDependencyClosure(
  changedFiles: readonly string[],
  graph: FileDependencyGraph,
  projectFiles: readonly string[],
): string[] {
  const projectFileSet = new Set(projectFiles);
  const consumers = new Map<string, Set<string>>();
  for (const [consumer, dependencies] of graph) {
    if (!projectFileSet.has(consumer)) continue;
    for (const dependency of dependencies) {
      const bucket = consumers.get(dependency) ?? new Set<string>();
      bucket.add(consumer);
      consumers.set(dependency, bucket);
    }
  }
  const affected = new Set(changedFiles);
  const pending = [...changedFiles];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (!current) continue;
    for (const consumer of consumers.get(current) ?? []) {
      if (affected.has(consumer)) continue;
      affected.add(consumer);
      pending.push(consumer);
    }
  }
  return [...affected].sort();
}

function ownedWorkspaceProject(file: string, projects: readonly string[]): string | null {
  const matches = projects.filter((project) => project === '.' || file === project || file.startsWith(`${project}/`));
  if (matches.length === 0) return null;
  // Workspace discovery may include a root tsconfig plus nested project
  // tsconfigs. The compiler project that most specifically contains the file
  // owns it; `.` is the fallback, not an ambiguity with every nested project.
  const ordered = [...new Set(matches)].sort(
    (left, right) => projectSpecificity(right) - projectSpecificity(left) || left.localeCompare(right),
  );
  const owner = ordered[0]!;
  return ordered[1] && projectSpecificity(ordered[1]) === projectSpecificity(owner) ? null : owner;
}

function projectSpecificity(project: string): number {
  return project === '.' ? 0 : project.split('/').filter(Boolean).length;
}

function dependsOn(file: string, dependency: string, graph: FileDependencyGraph): boolean {
  const visited = new Set<string>();
  const pending = [file];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const direct of graph.get(current) ?? []) {
      if (direct === dependency) return true;
      if (!visited.has(direct)) pending.push(direct);
    }
  }
  return false;
}

export function tryMaterializeTypeScriptIncrementalIndex(
  input: MaterializeTypeScriptIncrementalInput,
): MaterializedTypeScriptIncrementalIndex | null {
  const startedAt = monotonicNowMs();
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
    let dependencyGraphSnapshot: FileDependencyGraphSnapshot | undefined;
    try {
      projectFiles = indexedDocumentPaths(db, { includeIgnored: false }).filter(isTypeScriptLike).sort();
      const manifest = input.previousSnapshot
        ? buildProjectChangeManifest(input.previousSnapshot, input.currentSnapshot)
        : null;
      const replaceWithoutGraph =
        manifest &&
        input.previousSnapshot &&
        typeScriptProjectReplacementRequired(
          manifest,
          typeScriptCompilerChanges(manifest),
          typeScriptFragmentProjectIdentity(input.currentSnapshot, availability.producerIdentity),
          typeScriptFragmentProjectIdentity(input.previousSnapshot, availability.producerIdentity),
        );
      if (replaceWithoutGraph) {
        dependencyGraphSnapshot = readPersistedFileDependencyGraph(db, 'none') ?? undefined;
        graph = new Map();
      } else {
        dependencyGraphSnapshot = captureTypeScriptPlanningDependencyGraph(db);
        graph = dependencyGraphSnapshot.graph;
      }
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
    const requester = new TypeScriptIndexRequester(
      {
        projectRoot: input.projectRoot,
        cacheDir: input.cacheDir,
        baseGeneration,
      },
      { requireService: true },
    );
    const plannedBatches = eligibility.projects.flatMap((project) => {
      const affectedChunks = chunked(project.affectedFiles, TYPESCRIPT_DOCUMENT_BATCH_SIZE);
      const chunks = affectedChunks.length > 0 ? affectedChunks : [[]];
      return chunks.map((affectedFiles, index) => ({
        project,
        affectedFiles,
        removedFiles: index === 0 ? project.removedFiles : [],
        firstForProject: index === 0,
      }));
    });
    const affectedBatches: MaterializedTypeScriptIncrementalIndex['affectedBatches'] = [];
    const referenceFragmentsByFile = new Map<string, SemanticReferenceFragment[]>();
    const responseDurations: number[] = [];
    let anyCold = false;
    let assemblyMs = 0;
    let fragmentStoreMs = 0;
    let writeMs = 0;
    let previousOverlayGeneration = eligibility.previousFragmentGeneration;
    for (const [batchIndex, batch] of plannedBatches.entries()) {
      const response = requester.request({
        kind: 'emit-documents',
        tsconfigPath: batch.project.tsconfigPath,
        projectArgument: batch.project.projectArgument,
        projectIdentity: eligibility.projectIdentity,
        producerIdentity: availability.producerIdentity,
        modifiedFiles: batch.firstForProject ? batch.project.modifiedFiles : [],
        removedFiles: batch.firstForProject ? batch.project.removedFiles : [],
        affectedFiles: batch.affectedFiles,
      });
      anyCold ||= response.cold;
      responseDurations.push(response.durationMs);
      const tombstones: TypeScriptDocumentFragment[] = batch.removedFiles.map((relativePath) => ({
        relativePath,
        bytes: null,
        occurrences: 0,
        symbols: 0,
        referenceFragments: [],
      }));
      const fragments = [...response.fragments, ...tombstones];
      if (!eligibility.replaceProject) {
        for (const fragment of fragments) {
          referenceFragmentsByFile.set(fragment.relativePath, fragment.referenceFragments);
        }
      }
      const assemblyStartedAt = performance.now();
      const affectedIndexBytes = assembleAffectedTypeScriptFragments(response.fragments);
      assemblyMs += performance.now() - assemblyStartedAt;
      const scipPath =
        batchIndex === 0
          ? input.candidateAffectedScipPath
          : `${input.candidateAffectedScipPath}.batch-${batchIndex}.scip`;
      const writeStartedAt = performance.now();
      writeFileSync(scipPath, affectedIndexBytes);
      writeMs += performance.now() - writeStartedAt;
      const overlayStartedAt = performance.now();
      const nextOverlayGeneration =
        batchIndex === plannedBatches.length - 1
          ? eligibility.nextFragmentGeneration
          : sha256(`${eligibility.nextFragmentGeneration}\0batch\0${batchIndex}`);
      commitTypeScriptOverlay({
        cacheDir: input.cacheDir,
        previousGenerationIdentity: previousOverlayGeneration,
        nextGenerationIdentity: nextOverlayGeneration,
        producerIdentity: availability.producerIdentity,
        projectIdentity: eligibility.projectIdentity,
        baseShardCurrent: batchIndex === 0 ? input.baseShardCurrent : false,
        fragments,
        allowProjectIdentityChange: eligibility.replaceProject && batchIndex === 0,
        allowLegacyProjectIdentityMigration: true,
      });
      fragmentStoreMs += performance.now() - overlayStartedAt;
      previousOverlayGeneration = nextOverlayGeneration;
      affectedBatches.push({
        scipPath,
        affectedFiles: [...batch.affectedFiles, ...batch.removedFiles].sort(),
        deletedFiles: [...batch.removedFiles].sort(),
      });
    }
    const requestMs = performance.now() - phaseStartedAt;
    const result = {
      scipPath: input.previousShardPath,
      candidateScipPath: input.candidateShardPath,
      affectedScipPath: input.candidateAffectedScipPath,
      affectedBatches,
      completeScipUpdated: false,
      durationMs: monotonicNowMs() - startedAt,
      cold: anyCold,
      changedFiles: eligibility.plan.changedFiles,
      affectedFiles: eligibility.plan.affectedFiles,
      deletedFiles: eligibility.deletedFiles,
      producerIdentity: availability.producerIdentity,
      previousFragmentGeneration: eligibility.previousFragmentGeneration,
      nextFragmentGeneration: eligibility.nextFragmentGeneration,
      manifest: eligibility.manifest,
      plan: eligibility.plan,
      projectFileCount: projectFiles.length,
      dependencyGraphSnapshot,
      referenceFragmentsByFile,
      timings: {
        runtimeMs,
        graphMs,
        requestMs,
        serviceMs: responseDurations.reduce((total, duration) => total + duration, 0),
        assemblyMs,
        fragmentStoreMs,
        writeMs,
      },
    };
    input.onStatus(
      `${eligibility.replaceProject ? 'Bounded TypeScript project refresh' : 'Incremental TypeScript index'} emitted ${result.affectedFiles.length - result.deletedFiles.length} document(s), removed ${result.deletedFiles.length}, and produced ${affectedBatches.length} bounded batch(es) across ${eligibility.projects.length} project(s) in ${(result.durationMs / 1000).toFixed(3)}s (${result.cold ? 'cold' : 'warm'} service; whole SCIP deferred; runtime ${runtimeMs.toFixed(0)}ms, graph ${graphMs.toFixed(0)}ms, request ${requestMs.toFixed(0)}ms, assembly ${assemblyMs.toFixed(0)}ms, fragments ${fragmentStoreMs.toFixed(0)}ms, write ${writeMs.toFixed(0)}ms).`,
    );
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.onUnavailable?.(reason);
    if (error instanceof TypeScriptIndexMemoryPressureError) {
      input.onStatus(
        `Incremental TypeScript index stopped after memory pressure survived one cold Worker retry: ${reason}. Preserving the accepted index instead of starting a memory-heavier whole-project rebuild.`,
      );
      throw error;
    }
    input.onStatus(`Incremental TypeScript index unavailable: ${reason}.`);
    return null;
  }
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) chunks.push(values.slice(offset, offset + size));
  return chunks;
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
    baseIndexBytes: readFileWithinLimit(input.baseShardPath, {
      inputKind: 'TypeScript base SCIP shard',
      maxBytes: SCIP_ARTIFACT_MAX_BYTES,
    }),
    packageVersion: availability.packageVersion,
  });
  writeFileSync(input.candidateShardPath, bytes);
}

function typeScriptFragmentProjectIdentity(snapshot: ProjectInputSnapshot, producerIdentity: string): string {
  const nonSourceInputs = snapshot.files
    .filter((file) => {
      const kind = classifyProjectInputPath(file.path, snapshot.languages);
      return kind === 'config' || kind === 'ambient';
    })
    .map((file) => ({ path: file.path, size: file.size, hash: file.hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return `typescript-project-v2:${sha256(
    JSON.stringify({
      version: 2,
      producerIdentity,
      pnpmWorkspaces: snapshot.pnpmWorkspaces,
      typescriptProjectMode: snapshot.typescriptProjectMode,
      typescriptProjects: [...snapshot.typescriptProjects].sort(),
      nonSourceInputs,
    }),
  )}`;
}

function typeScriptFragmentGenerationIdentity(snapshot: ProjectInputSnapshot, producerIdentity: string): string {
  return sha256(JSON.stringify({ version: 1, producerIdentity, snapshot }));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
