import {
  typeScriptFragmentProjectIdentity,
  typeScriptFragmentGenerationIdentity,
} from './typescript-fragment-store.js';
import { chunked } from '../domain/array-batches.js';
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
import {
  classifyAffectedSetFallback,
  fullProjectPlan,
  planAffectedFiles,
  type AffectedFilePlan,
  type AffectedSetFallbackDecision,
} from './affected-set.js';
import { inspectTypeScriptDocumentProducer, type TypeScriptDocumentFragment } from './typescript-document-emitter.js';
import { assembleAffectedTypeScriptFragments } from './typescript-fragment-store.js';
import {
  commitTypeScriptOverlay,
  materializeTypeScriptOverlay,
  readTypeScriptOverlay,
  seedTypeScriptOverlay,
} from './typescript-overlay-store.js';
import type { TypeScriptDocumentBlobReference } from './typescript-document-blob.js';
import { publishedTypeScriptIndexGeneration } from './typescript-index-protocol.js';
import { TypeScriptIndexMemoryPressureError, TypeScriptIndexRequester } from './typescript-index-requester.js';
import { discoverTypeScriptProjectRoots } from '../platform/typescript-projects.js';
import type { SemanticReferenceFragment } from '../semantic/types.js';
import { readFileWithinLimit, SCIP_ARTIFACT_MAX_BYTES } from '../platform/bounded-file.js';
import { recoverTypeScriptPackageSemanticHash } from '../platform/typescript-semantic-hash.js';
import { activeTypeScriptProjectConfigPaths, isTypeScriptProjectConfigPath } from '../platform/typescript-projects.js';

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
  /**
   * The overlay generation the accepted publication carries. A publication
   * that reused the TypeScript shard advances the project snapshot without
   * committing a new overlay, so the snapshot-derived identity would name an
   * overlay that was never written; the publication record is authoritative.
   */
  previousOverlayGeneration?: string;
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
      /** True when every TypeScript edit changed only trivia, so relationship products remain exact. */
      dependencyGraphUnchanged: boolean;
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
  /** Overlay generation carried by the accepted publication, when its companion is deferred. */
  previousOverlayGeneration?: string;
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
  retainedDocumentCount?: number;
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
  /** True when semantic hashing proved that no TypeScript dependency relationship can have changed. */
  dependencyGraphUnchanged: boolean;
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
  return planTypeScriptUpdateWithDecision(input, workspaceProjects);
}

interface TypeScriptChangeDecision {
  manifest: ProjectChangeManifest;
  compilerManifest: ProjectChangeManifest;
  sourceChanges: ProjectFileChange[];
  projectIdentity: string;
  fallback: AffectedSetFallbackDecision;
  dependencyGraphUnchanged: boolean;
}

function planTypeScriptUpdateWithDecision(
  input: TypeScriptIncrementalEligibilityInput,
  workspaceProjects: readonly string[],
  preparedDecision?: TypeScriptChangeDecision,
): TypeScriptIncrementalEligibility {
  const prerequisites = incrementalPlanningPrerequisites(input, workspaceProjects);
  if (!prerequisites.eligible) return prerequisites;
  const { previousSnapshot, graph } = prerequisites;
  const decision =
    preparedDecision ??
    typeScriptChangeDecision(
      previousSnapshot,
      input.currentSnapshot,
      input.producerIdentity,
      activeTypeScriptProjectConfigPaths(workspaceProjects),
    );
  const {
    manifest,
    compilerManifest,
    sourceChanges: typescriptSourceChanges,
    projectIdentity,
    dependencyGraphUnchanged,
  } = decision;
  if (manifest.changes.length === 0) return { eligible: false, reason: 'no changed project inputs' };
  const deletedPaths = typescriptSourceChanges
    .filter((change) => change.kind === 'deleted')
    .map((change) => change.path);
  const modifiedChanges = typescriptSourceChanges.filter((change) => change.kind === 'modified');
  const replaceProject = decision.fallback.fullProject;
  if (typescriptSourceChanges.length === 0 && !replaceProject) {
    return { eligible: false, reason: 'change does not affect the configured TypeScript project' };
  }
  const { effectiveDeletedPaths, incrementalManifest, affected } = planIncrementalChangedFiles(
    input,
    graph,
    manifest,
    compilerManifest,
    typescriptSourceChanges,
    modifiedChanges,
    deletedPaths,
    decision.fallback,
  );
  if (!affected.eligible) return affected;
  const plan = affected.plan;
  const deletedSet = new Set(effectiveDeletedPaths);
  const projects = partitionWorkspacePlan(plan, workspaceProjects, graph, deletedSet);
  if (!projects) {
    return { eligible: false, reason: 'affected files cross or ambiguously match TypeScript projects' };
  }
  return incrementalEligibilityResult(
    input,
    previousSnapshot,
    incrementalManifest,
    plan,
    projectIdentity,
    projects,
    effectiveDeletedPaths,
    replaceProject,
    dependencyGraphUnchanged,
  );
}

function incrementalEligibilityResult(
  input: TypeScriptIncrementalEligibilityInput,
  previousSnapshot: ProjectInputSnapshot,
  incrementalManifest: ProjectChangeManifest,
  plan: AffectedFilePlan,
  projectIdentity: string,
  projects: TypeScriptIncrementalProjectPlan[],
  effectiveDeletedPaths: string[],
  replaceProject: boolean,
  dependencyGraphUnchanged: boolean,
): TypeScriptIncrementalEligibility {
  const singleProject = projects.length === 1 ? projects[0] : undefined;
  return {
    eligible: true,
    manifest: incrementalManifest,
    plan,
    projectIdentity,
    previousFragmentGeneration:
      input.previousOverlayGeneration ?? typeScriptFragmentGenerationIdentity(previousSnapshot, input.producerIdentity),
    nextFragmentGeneration: typeScriptFragmentGenerationIdentity(input.currentSnapshot, input.producerIdentity),
    projects,
    deletedFiles: effectiveDeletedPaths,
    replaceProject,
    dependencyGraphUnchanged,
    ...(singleProject
      ? { tsconfigPath: singleProject.tsconfigPath, projectArgument: singleProject.projectArgument }
      : {}),
  };
}

function incrementalPlanningPrerequisites(
  input: TypeScriptIncrementalEligibilityInput,
  workspaceProjects: readonly string[],
):
  | { eligible: false; reason: string }
  | { eligible: true; previousSnapshot: ProjectInputSnapshot; graph: FileDependencyGraph } {
  if (workspaceProjects.length === 0) return { eligible: false, reason: 'workspace project roots unavailable' };
  if (workspaceProjects.length === 1 && workspaceProjects[0] === '.' && !input.rootTsconfigExists) {
    return { eligible: false, reason: 'root tsconfig unavailable' };
  }
  if (!input.previousSnapshot) return { eligible: false, reason: 'prior project snapshot unavailable' };
  if (input.graph === null) return { eligible: false, reason: 'dependency graph unavailable' };
  if (input.projectFiles.length === 0) return { eligible: false, reason: 'prior TypeScript documents unavailable' };

  return { eligible: true, previousSnapshot: input.previousSnapshot, graph: input.graph };
}

function planIncrementalChangedFiles(
  input: TypeScriptIncrementalEligibilityInput,
  graph: FileDependencyGraph,
  manifest: ProjectChangeManifest,
  compilerManifest: ProjectChangeManifest,
  typescriptSourceChanges: ProjectFileChange[],
  modifiedChanges: ProjectFileChange[],
  deletedPaths: string[],
  fallback: AffectedSetFallbackDecision,
) {
  const replaceProject = fallback.fullProject;
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
        plan: fullProjectPlan(
          compilerManifest.changes.map((change) => change.path).sort(),
          new Set([...currentTypeScriptFiles, ...effectiveDeletedPaths]),
          new Set(fallback.reasons),
        ),
      }
    : planTypeScriptIncrementalAffectedSet(modifiedChanges, effectiveDeletedPaths, graph, input.projectFiles);
  return { effectiveDeletedPaths, incrementalManifest, affected };
}

function typeScriptCompilerChanges(
  manifest: ProjectChangeManifest,
  activeTypeScriptConfigs: ReadonlySet<string>,
): ProjectFileChange[] {
  return manifest.changes.filter(
    (change) =>
      (change.inputKind === 'source' && isTypeScriptLike(change.path)) ||
      (change.inputKind === 'config' &&
        (!isTypeScriptProjectConfigPath(change.path) || activeTypeScriptConfigs.has(change.path)) &&
        typeScriptConfigurationContentChanged(change)) ||
      change.inputKind === 'ambient',
  );
}

function typeScriptConfigurationContentChanged(change: ProjectFileChange): boolean {
  return (
    change.kind !== 'modified' ||
    change.before.semanticHash === undefined ||
    change.after.semanticHash === undefined ||
    change.before.semanticHash !== change.after.semanticHash
  );
}

function typeScriptChangeDecision(
  previousSnapshot: ProjectInputSnapshot,
  currentSnapshot: ProjectInputSnapshot,
  producerIdentity: string,
  activeTypeScriptConfigs: ReadonlySet<string>,
): TypeScriptChangeDecision {
  const manifest = buildProjectChangeManifest(previousSnapshot, currentSnapshot);
  const projectIdentity = typeScriptFragmentProjectIdentity(currentSnapshot, producerIdentity, activeTypeScriptConfigs);
  const previousProjectIdentity = typeScriptFragmentProjectIdentity(
    previousSnapshot,
    producerIdentity,
    activeTypeScriptConfigs,
  );
  const compilerManifest = { ...manifest, changes: typeScriptCompilerChanges(manifest, activeTypeScriptConfigs) };
  const fallback = classifyAffectedSetFallback(
    {
      ...compilerManifest,
      projectIdentityChanged: manifest.projectIdentityChanged || projectIdentity !== previousProjectIdentity,
    },
    { deletedFiles: 'closure', maxChanges: TYPESCRIPT_INCREMENTAL_CHANGE_LIMIT },
  );
  return {
    manifest,
    compilerManifest,
    sourceChanges: manifest.changes.filter((change) => change.inputKind === 'source' && isTypeScriptLike(change.path)),
    projectIdentity,
    fallback,
    dependencyGraphUnchanged: !fallback.fullProject && typeScriptDependencyGraphUnchanged(manifest),
  };
}

function planTypeScriptIncrementalAffectedSet(
  modifiedChanges: readonly ProjectFileChange[],
  deletedPaths: readonly string[],
  graph: FileDependencyGraph,
  projectFiles: readonly string[],
): { eligible: true; plan: AffectedFilePlan } | { eligible: false; reason: string } {
  if (modifiedChanges.length === 0) {
    if (deletedPaths.length === 0) return { eligible: false, reason: 'empty affected set' };
    return {
      eligible: true,
      plan: {
        mode: 'closure',
        changedFiles: [...new Set(deletedPaths)].sort(),
        affectedFiles: reverseDependencyClosure(deletedPaths, graph, projectFiles),
        reasons: [],
      },
    };
  }
  const modifiedPlan = planAffectedFiles(
    {
      version: 1,
      changes: modifiedChanges.filter(typeScriptSemanticContentChanged),
      projectIdentityChanged: false,
      uncertainty: [],
    },
    graph,
    projectFiles,
  );
  if (modifiedPlan.mode === 'full-project') {
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
      changedFiles: [...new Set([...modifiedChanges.map((change) => change.path), ...deletedPaths])].sort(),
      affectedFiles: [
        ...new Set([
          ...modifiedPlan.affectedFiles,
          ...modifiedChanges.map((change) => change.path),
          ...reverseDependencyClosure(deletedPaths, graph, projectFiles),
        ]),
      ].sort(),
      reasons: [],
    },
  };
}

function typeScriptSemanticContentChanged(change: ProjectFileChange): boolean {
  if (change.kind !== 'modified') return true;
  return (
    change.before.semanticHash === undefined ||
    change.after.semanticHash === undefined ||
    change.before.semanticHash !== change.after.semanticHash
  );
}

function typeScriptDependencyGraphUnchanged(manifest: ProjectChangeManifest): boolean {
  const sourceChanges = manifest.changes.filter(
    (change) => change.inputKind === 'source' && isTypeScriptLike(change.path),
  );
  return (
    sourceChanges.length > 0 &&
    sourceChanges.every((change) => change.kind === 'modified' && !typeScriptSemanticContentChanged(change))
  );
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
    const { eligibility, baseGeneration, projectFiles, dependencyGraphSnapshot, graphMs } =
      prepareTypeScriptMaterialization(input, availability.producerIdentity, phaseStartedAt);

    phaseStartedAt = performance.now();
    const {
      affectedBatches,
      referenceFragmentsByFile,
      responseDurations,
      anyCold,
      assemblyMs,
      fragmentStoreMs,
      writeMs,
      retainedDocumentCount,
    } = emitTypeScriptMaterializationBatches(input, eligibility, availability.producerIdentity, baseGeneration);
    const requestMs = performance.now() - phaseStartedAt;
    const result = {
      scipPath: input.previousShardPath,
      candidateScipPath: input.candidateShardPath,
      affectedScipPath: input.candidateAffectedScipPath,
      affectedBatches,
      retainedDocumentCount,
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
      dependencyGraphUnchanged: eligibility.dependencyGraphUnchanged,
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
      `${eligibility.replaceProject ? 'Bounded TypeScript project refresh' : 'Incremental TypeScript index'} emitted ${result.affectedFiles.length - result.deletedFiles.length - retainedDocumentCount} document(s), retained ${retainedDocumentCount}, removed ${result.deletedFiles.length}, and produced ${affectedBatches.length} bounded batch(es) across ${eligibility.projects.length} project(s) in ${(result.durationMs / 1000).toFixed(3)}s (${result.cold ? 'cold' : 'warm'} service; whole SCIP deferred; runtime ${runtimeMs.toFixed(0)}ms, graph ${graphMs.toFixed(0)}ms, request ${requestMs.toFixed(0)}ms, assembly ${assemblyMs.toFixed(0)}ms, fragments ${fragmentStoreMs.toFixed(0)}ms, write ${writeMs.toFixed(0)}ms).`,
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

function prepareTypeScriptMaterialization(
  input: MaterializeTypeScriptIncrementalInput,
  producerIdentity: string,
  phaseStartedAt: number,
) {
  const previousSnapshot = hydrateLegacyTypeScriptPackageHashes(
    input.projectRoot,
    input.previousSnapshot,
    input.currentSnapshot,
  );
  const workspaceProjects =
    input.projectMode === 'workspace'
      ? discoverTypeScriptProjectRoots(input.projectRoot, input.currentSnapshot.typescriptProjects)
      : ['.'];
  const activeTypeScriptConfigs = activeTypeScriptProjectConfigPaths(workspaceProjects);
  const decision = previousSnapshot
    ? typeScriptChangeDecision(previousSnapshot, input.currentSnapshot, producerIdentity, activeTypeScriptConfigs)
    : undefined;
  let projectFiles: string[];
  let graph: FileDependencyGraph;
  let dependencyGraphSnapshot: FileDependencyGraphSnapshot | undefined;
  const db = new ScipDatabase({
    projectRoot: input.projectRoot,
    dbPath: input.previousDbPath,
    indexPath: input.previousIndexPath,
  });
  try {
    projectFiles = indexedDocumentPaths(db, { includeIgnored: false }).filter(isTypeScriptLike).sort();
    const dependencyPlan = materializationDependencyGraph(db, decision);
    graph = dependencyPlan.graph;
    dependencyGraphSnapshot = dependencyPlan.dependencyGraphSnapshot;
  } finally {
    db.close();
  }
  const graphMs = performance.now() - phaseStartedAt;
  const eligibility = planTypeScriptUpdateWithDecision(
    {
      projectMode: input.projectMode,
      workspaceProjects: input.projectMode === 'workspace' ? workspaceProjects : undefined,
      previousSnapshot,
      currentSnapshot: input.currentSnapshot,
      projectFiles,
      graph,
      producerIdentity,
      rootTsconfigExists: existsSync(join(input.projectRoot, 'tsconfig.json')),
      ...(input.previousOverlayGeneration === undefined
        ? {}
        : { previousOverlayGeneration: input.previousOverlayGeneration }),
    },
    workspaceProjects,
    decision,
  );
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  const baseGeneration = publishedTypeScriptIndexGeneration(input.previousDbPath);
  if (!baseGeneration) throw new Error('published TypeScript base generation unavailable');

  return { eligibility, baseGeneration, projectFiles, dependencyGraphSnapshot, graphMs };
}

function materializationDependencyGraph(db: ScipDatabase, decision: TypeScriptChangeDecision | undefined) {
  let graph: FileDependencyGraph;
  let dependencyGraphSnapshot: FileDependencyGraphSnapshot | undefined;
  if (decision?.fallback.fullProject) {
    dependencyGraphSnapshot = readPersistedFileDependencyGraph(db, 'none') ?? undefined;
    graph = new Map();
  } else if (decision?.dependencyGraphUnchanged) {
    graph = new Map();
  } else {
    dependencyGraphSnapshot = captureTypeScriptPlanningDependencyGraph(db);
    graph = dependencyGraphSnapshot.graph;
  }
  return { graph, dependencyGraphSnapshot };
}

type EligibleTypeScriptMaterialization = Extract<TypeScriptIncrementalEligibility, { eligible: true }>;

function plannedTypeScriptDocumentBatches(projects: TypeScriptIncrementalProjectPlan[]) {
  return projects.flatMap((project) => {
    const affectedChunks = chunked(project.affectedFiles, TYPESCRIPT_DOCUMENT_BATCH_SIZE);
    const chunks = affectedChunks.length > 0 ? affectedChunks : [[]];
    return chunks.map((affectedFiles, index) => ({
      project,
      affectedFiles,
      removedFiles: index === 0 ? project.removedFiles : [],
      firstForProject: index === 0,
    }));
  });
}

function emitTypeScriptMaterializationBatches(
  input: MaterializeTypeScriptIncrementalInput,
  eligibility: EligibleTypeScriptMaterialization,
  producerIdentity: string,
  baseGeneration: string,
) {
  const requester = new TypeScriptIndexRequester(
    {
      projectRoot: input.projectRoot,
      cacheDir: input.cacheDir,
      baseGeneration,
    },
    { requireService: true },
  );
  const plannedBatches = plannedTypeScriptDocumentBatches(eligibility.projects);
  const knownDocuments = knownMaterializationDocuments(input, eligibility, producerIdentity);
  const affectedBatches: MaterializedTypeScriptIncrementalIndex['affectedBatches'] = [];
  const referenceFragmentsByFile = new Map<string, SemanticReferenceFragment[]>();
  const responseDurations: number[] = [];
  let anyCold = false;
  let retainedDocumentCount = 0;
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
      producerIdentity,
      modifiedFiles: batch.firstForProject ? batch.project.modifiedFiles : [],
      removedFiles: batch.firstForProject ? batch.project.removedFiles : [],
      affectedFiles: batch.affectedFiles,
      knownDocuments: batch.affectedFiles.flatMap((file) => knownDocuments.get(file) ?? []),
    });
    anyCold ||= response.cold;
    retainedDocumentCount += response.retainedDocuments?.length ?? 0;
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
    const committed = commitMaterializedTypeScriptBatch({
      input,
      eligibility,
      producerIdentity,
      response,
      fragments,
      batch,
      batchIndex,
      lastBatch: batchIndex === plannedBatches.length - 1,
      previousOverlayGeneration,
    });
    assemblyMs += committed.assemblyMs;
    writeMs += committed.writeMs;
    fragmentStoreMs += committed.fragmentStoreMs;
    previousOverlayGeneration = committed.nextOverlayGeneration;
    if (committed.affectedBatch.affectedFiles.length) affectedBatches.push(committed.affectedBatch);
  }
  return {
    affectedBatches,
    referenceFragmentsByFile,
    responseDurations,
    anyCold,
    retainedDocumentCount,
    assemblyMs,
    fragmentStoreMs,
    writeMs,
  };
}

function knownMaterializationDocuments(
  input: MaterializeTypeScriptIncrementalInput,
  eligibility: EligibleTypeScriptMaterialization,
  producerIdentity: string,
): Map<string, TypeScriptDocumentBlobReference> {
  const known = new Map<string, TypeScriptDocumentBlobReference>();
  if (eligibility.replaceProject || eligibility.projects.length !== 1) return known;
  // Overlapping projects can contribute different documents for one path.
  // Reuse is limited to one authoritative compiler project for now.
  if (
    input.projectMode === 'workspace' &&
    discoverTypeScriptProjectRoots(input.projectRoot, input.currentSnapshot.typescriptProjects).length !== 1
  )
    return known;
  const previous = knownMaterializationOverlay(input, eligibility, producerIdentity);
  if (previous?.producerIdentity !== producerIdentity || previous.projectIdentity !== eligibility.projectIdentity)
    return known;
  for (const record of previous.overlays) {
    if (record.blobHash !== null) known.set(record.relativePath, { ...record, blobHash: record.blobHash });
  }
  return known;
}

function knownMaterializationOverlay(
  input: MaterializeTypeScriptIncrementalInput,
  eligibility: EligibleTypeScriptMaterialization,
  producerIdentity: string,
) {
  let previous = readTypeScriptOverlay(input.cacheDir, eligibility.previousFragmentGeneration);
  if (
    !previous &&
    input.baseShardCurrent &&
    input.currentSnapshot.languages.length === 1 &&
    input.currentSnapshot.languages[0] === 'typescript'
  ) {
    const producer = inspectTypeScriptDocumentProducer();
    if (producer.available && producer.producerIdentity === producerIdentity) {
      previous = seedTypeScriptOverlay({
        cacheDir: input.cacheDir,
        generationIdentity: eligibility.previousFragmentGeneration,
        producerIdentity,
        projectIdentity: eligibility.projectIdentity,
        packageVersion: producer.packageVersion,
        indexBytes: readFileWithinLimit(input.previousIndexPath, {
          inputKind: 'accepted TypeScript index',
          maxBytes: SCIP_ARTIFACT_MAX_BYTES,
        }),
      });
    }
  }
  return previous;
}

function commitMaterializedTypeScriptBatch(context: {
  input: MaterializeTypeScriptIncrementalInput;
  eligibility: EligibleTypeScriptMaterialization;
  producerIdentity: string;
  response: ReturnType<TypeScriptIndexRequester['request']>;
  fragments: TypeScriptDocumentFragment[];
  batch: ReturnType<typeof plannedTypeScriptDocumentBatches>[number];
  batchIndex: number;
  lastBatch: boolean;
  previousOverlayGeneration: string;
}) {
  const {
    input,
    eligibility,
    producerIdentity,
    response,
    fragments,
    batch,
    batchIndex,
    lastBatch,
    previousOverlayGeneration,
  } = context;
  const assemblyStartedAt = performance.now();
  const affectedIndexBytes = fragments.length ? assembleAffectedTypeScriptFragments(response.fragments) : null;
  const assemblyMs = performance.now() - assemblyStartedAt;
  const scipPath =
    batchIndex === 0 ? input.candidateAffectedScipPath : `${input.candidateAffectedScipPath}.batch-${batchIndex}.scip`;
  const writeStartedAt = performance.now();
  if (affectedIndexBytes) writeFileSync(scipPath, affectedIndexBytes);
  const writeMs = performance.now() - writeStartedAt;
  const overlayStartedAt = performance.now();
  const nextOverlayGeneration = lastBatch
    ? eligibility.nextFragmentGeneration
    : typeScriptIntermediateOverlayGenerationIdentity({
        previousGenerationIdentity: previousOverlayGeneration,
        targetGenerationIdentity: eligibility.nextFragmentGeneration,
        fragments,
        retainedDocuments: response.retainedDocuments,
      });
  commitTypeScriptOverlay({
    cacheDir: input.cacheDir,
    previousGenerationIdentity: previousOverlayGeneration,
    nextGenerationIdentity: nextOverlayGeneration,
    producerIdentity,
    projectIdentity: eligibility.projectIdentity,
    baseShardCurrent: batchIndex === 0 ? input.baseShardCurrent : false,
    fragments,
    retainedDocuments: response.retainedDocuments,
    allowProjectIdentityChange: eligibility.replaceProject && batchIndex === 0,
    allowLegacyProjectIdentityMigration: true,
  });
  const fragmentStoreMs = performance.now() - overlayStartedAt;
  const affectedBatch = {
    scipPath,
    affectedFiles: fragments.map((fragment) => fragment.relativePath).sort(),
    deletedFiles: [...batch.removedFiles].sort(),
  };
  return { assemblyMs, writeMs, fragmentStoreMs, nextOverlayGeneration, affectedBatch };
}

function hydrateLegacyTypeScriptPackageHashes(
  projectRoot: string,
  previous: ProjectInputSnapshot | null,
  current: ProjectInputSnapshot,
): ProjectInputSnapshot | null {
  if (!previous) return null;
  const currentFiles = new Map(current.files.map((file) => [file.path, file]));
  let changed = false;
  const files = previous.files.map((file) => {
    const currentFile = currentFiles.get(file.path);
    if (file.semanticHash !== undefined || currentFile?.semanticHash === undefined) return file;
    const semanticHash = recoverTypeScriptPackageSemanticHash(projectRoot, file.path, file.hash);
    if (semanticHash === undefined) return file;
    changed = true;
    return { ...file, semanticHash };
  });
  return changed ? { ...previous, files } : previous;
}

export function typeScriptIntermediateOverlayGenerationIdentity(input: {
  previousGenerationIdentity: string;
  targetGenerationIdentity: string;
  fragments: readonly TypeScriptDocumentFragment[];
  retainedDocuments?: readonly TypeScriptDocumentBlobReference[];
}): string {
  const hash = createHash('sha256');
  hash.update('typescript-overlay-batch-v1\0');
  hash.update(input.previousGenerationIdentity);
  hash.update('\0');
  hash.update(input.targetGenerationIdentity);
  for (const fragment of [...input.fragments].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update('\0path\0');
    hash.update(fragment.relativePath);
    if (fragment.bytes === null) {
      hash.update('\0deleted');
    } else {
      hash.update('\0bytes\0');
      hash.update(createHash('sha256').update(fragment.bytes).digest());
    }
  }
  for (const retained of [...(input.retainedDocuments ?? [])].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update('\0retained\0').update(JSON.stringify([retained.relativePath, retained.blobHash, retained.byteLength]));
  }
  return hash.digest('hex');
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
