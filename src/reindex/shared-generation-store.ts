import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { deserializeSCIP } from '@c4312/scip';
import Database from 'better-sqlite3';
import { decodeReindexMetadata, type ReindexMetadata } from '../domain/reindex-metadata.js';
import { monotonicNowMs } from '../domain/time.js';
import type { ProjectConfig } from '../domain/types.js';
import {
  cloneFileDurable,
  ensureDirectoryDurable,
  mergeDirectorySyncStatus,
  syncDirectoryDurable,
  type DirectorySyncStatus,
} from '../storage/atomic-file.js';
import { cliVersion } from '../platform/cli-version.js';
import { acquireProcessFileLock, acquireRepositoryCacheLock } from '../platform/repository-cache-lock.js';
import { tryAcquireProcessFileLock, type LegacyProcessLockDecoder } from '../platform/process-file-lock.js';
import {
  automaticSharedCacheEnabled,
  canonicalCacheIdentity,
  resolveDefaultCacheDir,
  resolveRepositoryCacheDir,
  resolveScipQueryCacheRoot,
  type resolveIndexStoragePaths,
} from '../platform/cache-layout.js';
import { listGitWorktrees, resolveGitWorktreeContext, type GitWorktreeContext } from '../platform/git-worktree.js';
import {
  hashFileWithinLimit,
  readFileWithinLimit,
  readTextFileWithinLimit,
  SCIP_ARTIFACT_MAX_BYTES,
  sha256FileWithinLimit,
  SMALL_ARTIFACT_MAX_BYTES,
} from '../platform/bounded-file.js';
import {
  buildProjectInputFingerprint,
  normalizeProjectInputFingerprintConfiguration,
  type ProjectInputFingerprint,
  type ProjectInputFingerprintConfiguration,
  type ProjectInputFingerprintOptions,
} from '../platform/project-files.js';
import { writeJsonDurable } from '../storage/atomic-json.js';
import { detectLanguages } from './detect.js';
import {
  describeIndexArtifactSet,
  indexArtifactPath,
  validateIndexArtifactRelativePath,
  INDEX_ARTIFACT_CATALOG_VERSION,
  LANGUAGE_INDEX_DIRECTORY,
} from './index-artifacts.js';
import { rebaseScipFileProjectRoot } from './merge.js';
import {
  inspectSqliteGeneration,
  promoteReindexArtifacts,
  SQLITE_GENERATION_DIRECTORY,
  SQLITE_GENERATION_STORE_VERSION,
} from './sqlite-generation-store.js';
import { TYPESCRIPT_FRAGMENT_STORE_DIRECTORY, TYPESCRIPT_FRAGMENT_STORE_VERSION } from './typescript-fragment-store.js';
import { TYPESCRIPT_OVERLAY_STORE_DIRECTORY, TYPESCRIPT_OVERLAY_STORE_VERSION } from './typescript-overlay-store.js';

export const SHARED_GENERATION_FORMAT_VERSION = 1;
export const SHARED_GENERATION_ENV = 'SCIP_QUERY_SHARED_CACHE';
export const SHARED_GENERATION_PRODUCER_IDENTITY = JSON.stringify({
  cliVersion,
  artifactCatalogVersion: INDEX_ARTIFACT_CATALOG_VERSION,
  sqliteGenerationStoreVersion: SQLITE_GENERATION_STORE_VERSION,
  typescriptFragmentStoreVersion: TYPESCRIPT_FRAGMENT_STORE_VERSION,
  typescriptOverlayStoreVersion: TYPESCRIPT_OVERLAY_STORE_VERSION,
});
const SHARED_GENERATION_MANIFEST = 'manifest.json';
const WORKTREE_CACHE_POINTER = 'shared-cache.json';
const MANAGED_ARTIFACT_DIRECTORIES = [
  LANGUAGE_INDEX_DIRECTORY,
  TYPESCRIPT_FRAGMENT_STORE_DIRECTORY,
  TYPESCRIPT_OVERLAY_STORE_DIRECTORY,
] as const;

export interface SharedGenerationSnapshot {
  repositoryId: string;
  worktreeId: string;
  projectRoot: string;
  treeOid: string;
  fingerprint: ProjectInputFingerprint;
  producerIdentity: string;
  generationId: string;
  repositoryCacheDir: string;
}

export interface SharedGenerationArtifact {
  path: string;
  size: number;
  sha256: string;
}

export interface SharedGenerationManifest {
  version: typeof SHARED_GENERATION_FORMAT_VERSION;
  artifactCatalogVersion: typeof INDEX_ARTIFACT_CATALOG_VERSION;
  generationId: string;
  repositoryId: string;
  treeOid: string;
  fingerprint: ProjectInputFingerprint;
  producerIdentity: string;
  sourceProjectRoot: string;
  scipProjectRoot: string;
  createdAt: string;
  artifacts: SharedGenerationArtifact[];
}

export interface SharedBaselineGeneration {
  snapshot: SharedGenerationSnapshot;
  manifest: SharedGenerationManifest;
}

export type SharedGenerationPublicationResult = {
  kind: 'existing' | 'published';
  manifest: SharedGenerationManifest;
  achievedDurability: 'file-flushed' | 'directory-durable';
  directorySync: Exclude<DirectorySyncStatus, 'not-requested'>;
};

// scip-query: ignore-stale -- Named publication stages form the durability fault-injection contract.
export type SharedGenerationPublicationStage =
  | 'after-artifact-flushed'
  | 'after-manifest-flushed'
  | 'after-staging-directory-synced'
  | 'after-generation-renamed'
  | 'after-generations-directory-synced';

interface SharedGenerationPublicationInput {
  snapshot: SharedGenerationSnapshot;
  sourceCacheDir: string;
  sourceProjectRoot: string;
  now?: () => Date;
  sourceStillValid?: () => boolean;
  /** @internal deterministic crash-boundary probe for persistence tests. */
  onPublicationStage?: (stage: SharedGenerationPublicationStage, artifactPath?: string) => void;
}

export type SharedCacheAction =
  | { kind: 'local-fresh' }
  | { kind: 'attached'; generationId: string }
  | { kind: 'peer-imported'; generationId: string; sourceProjectRoot: string }
  | { kind: 'overlay' }
  | { kind: 'built'; generationId: string }
  | { kind: 'waited'; generationId: string }
  | { kind: 'missed'; reason: string }
  | { kind: 'bypassed'; reason: string }
  | { kind: 'failed'; reason: string };

export interface WorktreeCacheLease {
  version: 1;
  repositoryId: string;
  worktreeId: string;
  projectRoot: string;
  treeOid?: string;
  localCacheDir: string;
  baseGenerationId?: string;
  activeGenerationId?: string;
  ownershipChecksum: string;
  lastAction: SharedCacheAction['kind'];
  lastReason?: string;
  lastSeenAt: string;
}

export interface WorktreeLeaseTouchOptions {
  /** @internal deterministic barrier for a competing generation/lease writer. */
  onBeforeRepositoryLock?: () => void;
}

export type SharedBuildLockResult =
  | { kind: 'owner'; release: () => void }
  | { kind: 'generation-ready' }
  | { kind: 'timeout' };

type IndexStoragePaths = ReturnType<typeof resolveIndexStoragePaths>;

export function buildSharedGenerationSnapshot(
  context: GitWorktreeContext,
  fingerprint: ProjectInputFingerprint,
): SharedGenerationSnapshot | undefined {
  if (!context.clean || !context.treeOid) return undefined;
  const generationId = sha256(
    JSON.stringify({
      version: SHARED_GENERATION_FORMAT_VERSION,
      repositoryId: context.repositoryId,
      treeOid: context.treeOid,
      fingerprint,
      producerIdentity: SHARED_GENERATION_PRODUCER_IDENTITY,
    }),
  );
  return {
    repositoryId: context.repositoryId,
    worktreeId: context.worktreeId,
    projectRoot: context.projectRoot,
    treeOid: context.treeOid,
    fingerprint,
    producerIdentity: SHARED_GENERATION_PRODUCER_IDENTITY,
    generationId,
    repositoryCacheDir: resolveRepositoryCacheDir(context.repositoryId),
  };
}

export function sharedCacheBypassReason(
  projectRoot: string,
  outputDb: string,
  config?: ProjectConfig,
): string | undefined {
  if (process.env[SHARED_GENERATION_ENV] === '0') return `${SHARED_GENERATION_ENV}=0`;
  if (!automaticSharedCacheEnabled(config)) return 'explicit cache or database override';
  if (
    canonicalCacheIdentity(dirname(outputDb)) !== canonicalCacheIdentity(resolveDefaultCacheDir(projectRoot)) ||
    outputDb !== join(dirname(outputDb), 'index.db')
  ) {
    return 'index database is outside the managed worktree cache';
  }
  return undefined;
}

export function resolveSharedEvidenceDbPath(
  projectRoot: string,
  config?: ProjectConfig,
  resolvedContext?: GitWorktreeContext,
): string | undefined {
  if (!automaticSharedCacheEnabled(config)) return undefined;
  const context = resolvedContext ?? resolveGitWorktreeContext(projectRoot);
  return context ? join(resolveRepositoryCacheDir(context.repositoryId), 'evidence.db') : undefined;
}

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
export function readSharedGeneration(
  snapshot: SharedGenerationSnapshot,
  verifyArtifacts = true,
): SharedGenerationManifest | null {
  const generationDir = sharedGenerationDirectory(snapshot);
  let manifest: SharedGenerationManifest;
  try {
    manifest = parseSharedGenerationManifest(
      readTextFileWithinLimit(join(generationDir, SHARED_GENERATION_MANIFEST), {
        inputKind: 'shared-generation manifest',
        maxBytes: SMALL_ARTIFACT_MAX_BYTES,
      }),
    );
  } catch {
    return null;
  }
  if (
    manifest.generationId !== snapshot.generationId ||
    manifest.repositoryId !== snapshot.repositoryId ||
    manifest.treeOid !== snapshot.treeOid ||
    manifest.producerIdentity !== snapshot.producerIdentity ||
    JSON.stringify(manifest.fingerprint) !== JSON.stringify(snapshot.fingerprint)
  ) {
    return null;
  }
  if (!verifyArtifacts) return manifest;
  try {
    for (const artifact of manifest.artifacts) {
      const path = indexArtifactPath(generationDir, artifact.path);
      const stat = statSync(path);
      if (
        !stat.isFile() ||
        stat.size !== artifact.size ||
        sha256FileWithinLimit(path, {
          inputKind: 'shared-generation artifact',
          maxBytes: SCIP_ARTIFACT_MAX_BYTES,
        }) !== artifact.sha256
      )
        return null;
    }
  } catch {
    return null;
  }
  return manifest;
}

/**
 * Finds the immutable generation for a worktree's committed HEAD without
 * pretending the worktree's current dirty files have the baseline fingerprint.
 *
 * Manifests are cheap-filtered first. Artifact hashing is then attempted in
 * deterministic newest-first order until one complete candidate validates.
 */
export function findSharedBaselineGeneration(
  context: GitWorktreeContext,
  languages: readonly ProjectInputFingerprint['languages'][number][],
  options: ProjectInputFingerprintOptions,
): SharedBaselineGeneration | null {
  if (!context.treeOid) return null;
  const requestedConfiguration = normalizeProjectInputFingerprintConfiguration(languages, options);
  const unresolvedRepositoryCacheDir = join(resolveScipQueryCacheRoot(), 'repositories', context.repositoryId);
  let repositoryCacheDir: string;
  try {
    const repositoryStat = lstatSync(unresolvedRepositoryCacheDir);
    if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink()) return null;
    repositoryCacheDir = realpathSync(unresolvedRepositoryCacheDir);
  } catch {
    return null;
  }
  const generationsDir = join(repositoryCacheDir, 'generations');
  const candidates: SharedGenerationManifest[] = [];

  try {
    for (const generationId of readdirSync(generationsDir)) {
      if (!/^[a-f0-9]{64}$/.test(generationId)) continue;
      const generationDir = join(generationsDir, generationId);
      let generationStat;
      try {
        generationStat = lstatSync(generationDir);
      } catch {
        continue;
      }
      if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) continue;
      try {
        const manifest = parseSharedGenerationManifest(
          readTextFileWithinLimit(join(generationDir, SHARED_GENERATION_MANIFEST), {
            inputKind: 'shared-generation baseline manifest',
            maxBytes: SMALL_ARTIFACT_MAX_BYTES,
          }),
        );
        if (
          manifest.generationId === generationId &&
          manifest.repositoryId === context.repositoryId &&
          manifest.treeOid === context.treeOid &&
          manifest.producerIdentity === SHARED_GENERATION_PRODUCER_IDENTITY &&
          sameFingerprintConfiguration(manifest.fingerprint, requestedConfiguration)
        ) {
          candidates.push(manifest);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  candidates.sort((left, right) => {
    const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return created || left.generationId.localeCompare(right.generationId);
  });
  for (const candidate of candidates) {
    const snapshot: SharedGenerationSnapshot = {
      repositoryId: context.repositoryId,
      worktreeId: context.worktreeId,
      projectRoot: context.projectRoot,
      treeOid: context.treeOid,
      fingerprint: candidate.fingerprint,
      producerIdentity: candidate.producerIdentity,
      generationId: candidate.generationId,
      repositoryCacheDir,
    };
    const manifest = readSharedGeneration(snapshot);
    if (manifest) return { snapshot, manifest };
  }
  return null;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; staging, manifest publication, and lease updates are one transaction.
export function publishSharedGeneration(input: SharedGenerationPublicationInput): SharedGenerationPublicationResult {
  const publicationLock = acquireProcessFileLock(
    join(input.snapshot.repositoryCacheDir, 'locks', `${input.snapshot.generationId}.publish.lock`),
  );
  if (!publicationLock) {
    throw new Error(`shared generation publication is already in progress for ${input.snapshot.generationId}`);
  }
  try {
    return publishSharedGenerationOwned(input);
  } finally {
    publicationLock.release();
  }
}

function publishSharedGenerationOwned(input: SharedGenerationPublicationInput): SharedGenerationPublicationResult {
  const existing = readSharedGeneration(input.snapshot);
  if (existing) return existingSharedGenerationResult(input.snapshot, existing);
  if (!validateSourceGeneration(input.sourceCacheDir, input.sourceProjectRoot, input.snapshot.fingerprint)) {
    throw new Error('source index is incomplete, incompatible, or corrupt');
  }
  const sourceSignature = sourceGenerationSignature(input.sourceCacheDir);
  if (!sourceSignature) throw new Error('source index artifacts are incomplete');

  const artifacts = describeIndexArtifactSet(input.sourceCacheDir);
  const generationsDir = join(input.snapshot.repositoryCacheDir, 'generations');
  const directoryStatuses: Exclude<DirectorySyncStatus, 'not-requested'>[] = [ensureDirectoryDurable(generationsDir)];
  const stagingDir = mkdtempSync(join(generationsDir, `.tmp-${process.pid}-`));
  try {
    const records: SharedGenerationArtifact[] = [];
    for (const relativePath of artifacts.files) {
      const source = indexArtifactPath(input.sourceCacheDir, relativePath);
      const target = indexArtifactPath(stagingDir, relativePath);
      directoryStatuses.push(cloneArtifactFile(source, target, 0o444));
      input.onPublicationStage?.('after-artifact-flushed', relativePath);
      const size = statSync(target).size;
      records.push({
        path: relativePath,
        size,
        sha256: sha256FileWithinLimit(target, {
          inputKind: 'staged shared-generation artifact',
          maxBytes: SCIP_ARTIFACT_MAX_BYTES,
        }),
      });
    }
    const scipProjectRoot = deserializeSCIP(
      readFileWithinLimit(join(stagingDir, 'index.scip'), {
        inputKind: 'staged shared SCIP index',
        maxBytes: SCIP_ARTIFACT_MAX_BYTES,
      }),
    ).metadata?.projectRoot;
    if (!scipProjectRoot) throw new Error('shared SCIP generation has no project root metadata');
    const expectedSourceRoot = canonicalProjectRootUrl(input.sourceProjectRoot);
    if (scipProjectRoot !== expectedSourceRoot) {
      throw new Error('shared SCIP generation root does not match its source worktree');
    }
    if (
      sourceGenerationSignature(input.sourceCacheDir) !== sourceSignature ||
      (input.sourceStillValid && !input.sourceStillValid())
    ) {
      throw new Error('source index changed while staging a shared generation');
    }
    const manifest: SharedGenerationManifest = {
      version: SHARED_GENERATION_FORMAT_VERSION,
      artifactCatalogVersion: INDEX_ARTIFACT_CATALOG_VERSION,
      generationId: input.snapshot.generationId,
      repositoryId: input.snapshot.repositoryId,
      treeOid: input.snapshot.treeOid,
      fingerprint: input.snapshot.fingerprint,
      producerIdentity: input.snapshot.producerIdentity,
      sourceProjectRoot: input.sourceProjectRoot,
      scipProjectRoot,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      artifacts: records.sort((left, right) => left.path.localeCompare(right.path)),
    };
    const manifestWrite = writeJsonDurable(join(stagingDir, SHARED_GENERATION_MANIFEST), manifest, {
      spacing: 2,
      trailingNewline: true,
    });
    if (manifestWrite.directorySync !== 'not-requested') directoryStatuses.push(manifestWrite.directorySync);
    input.onPublicationStage?.('after-manifest-flushed');
    directoryStatuses.push(syncDirectoryDurable(stagingDir));
    input.onPublicationStage?.('after-staging-directory-synced');
    const targetDir = sharedGenerationDirectory(input.snapshot);
    try {
      if (existsSync(targetDir) && !readSharedGeneration(input.snapshot)) {
        const corruptDir = `${targetDir}.corrupt-${process.pid}-${Date.now()}`;
        renameSync(targetDir, corruptDir);
        rmSync(corruptDir, { recursive: true, force: true });
      }
      renameSync(stagingDir, targetDir);
    } catch (error) {
      const raced = readSharedGeneration(input.snapshot);
      if (raced) return existingSharedGenerationResult(input.snapshot, raced);
      throw error;
    }
    input.onPublicationStage?.('after-generation-renamed');
    directoryStatuses.push(syncDirectoryDurable(generationsDir));
    input.onPublicationStage?.('after-generations-directory-synced');
    const directorySync = mergeDirectorySyncStatus(...directoryStatuses);
    return {
      kind: 'published',
      manifest,
      achievedDurability: directorySync === 'synced' ? 'directory-durable' : 'file-flushed',
      directorySync,
    };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function existingSharedGenerationResult(
  snapshot: SharedGenerationSnapshot,
  manifest: SharedGenerationManifest,
): SharedGenerationPublicationResult {
  const directorySync = syncDirectoryDurable(join(snapshot.repositoryCacheDir, 'generations'));
  return {
    kind: 'existing',
    manifest,
    achievedDurability: directorySync === 'synced' ? 'directory-durable' : 'file-flushed',
    directorySync,
  };
}

// scip-query: ignore-extract — reviewed E1 workflow owner; validation, artifact hydration, and metadata updates stay atomic.
export function hydrateSharedGeneration(input: {
  snapshot: SharedGenerationSnapshot;
  manifest: SharedGenerationManifest;
  targetCacheDir: string;
  targetProjectRoot: string;
  now?: () => Date;
  action?: WorktreeCacheLease['lastAction'];
  persistLease?: boolean;
}): void {
  const generationDir = sharedGenerationDirectory(input.snapshot);
  mkdirSync(input.targetCacheDir, { recursive: true });
  const hydrationLock = acquireProcessFileLock(join(input.targetCacheDir, 'cache-lifecycle.lock'), { waitMs: 30_000 });
  if (!hydrationLock) throw new Error('timed out waiting for another cache hydration');
  let stagingDir: string | undefined;
  let rollback: HydrationRollback | undefined;
  let targetMutationStarted = false;
  try {
    stagingDir = mkdtempSync(join(input.targetCacheDir, '.shared-hydrate-'));
    assertManifestMatchesSnapshot(input.manifest, input.snapshot);
    for (const artifact of input.manifest.artifacts) {
      const source = indexArtifactPath(generationDir, artifact.path);
      const target = indexArtifactPath(stagingDir, artifact.path);
      cloneArtifactFile(source, target);
      const size = statSync(target).size;
      if (
        size !== artifact.size ||
        sha256FileWithinLimit(target, {
          inputKind: 'hydrated shared-generation artifact',
          maxBytes: SCIP_ARTIFACT_MAX_BYTES,
        }) !== artifact.sha256
      ) {
        throw new Error(`shared artifact is corrupt: ${artifact.path}`);
      }
    }

    const targetScipRoot = canonicalProjectRootUrl(input.targetProjectRoot);
    if (targetScipRoot !== input.manifest.scipProjectRoot) {
      for (const artifact of input.manifest.artifacts) {
        if (artifact.path.endsWith('.scip')) {
          rebaseScipFileProjectRoot(
            indexArtifactPath(stagingDir, artifact.path),
            input.manifest.scipProjectRoot,
            targetScipRoot,
          );
        }
      }
    }

    if (!validateSourceGeneration(stagingDir, input.targetProjectRoot, input.snapshot.fingerprint, false)) {
      throw new Error('staged shared generation failed completeness or integrity validation');
    }
    rollback = backupHydrationTarget(input.targetCacheDir, stagingDir);
    targetMutationStarted = true;
    installHydratedArtifactDirectories(stagingDir, input.targetCacheDir, rollback);
    promoteReindexArtifacts({
      tempOutputScip: join(stagingDir, 'index.scip'),
      tempOutputDb: join(stagingDir, 'index.db'),
      tempMetaPath: join(stagingDir, 'meta.json'),
      outputScip: join(input.targetCacheDir, 'index.scip'),
      outputDb: join(input.targetCacheDir, 'index.db'),
      metaPath: join(input.targetCacheDir, 'meta.json'),
      now: input.now,
    });
    const inspection = inspectSqliteGeneration(
      join(input.targetCacheDir, 'index.db'),
      join(input.targetCacheDir, 'meta.json'),
    );
    if (inspection.state === 'invalid' || inspection.state === 'drifted') {
      throw new Error(`hydrated SQLite generation failed validation: ${inspection.reason}`);
    }
    if (input.persistLease !== false) {
      writeWorktreeLease(input.snapshot, input.targetCacheDir, input.action ?? 'attached', input.now);
    }
  } catch (error) {
    if (targetMutationStarted && rollback) restoreHydrationTarget(input.targetCacheDir, rollback);
    throw error;
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    hydrationLock.release();
  }
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function prepareSharedGenerationForProject(
  projectRoot: string,
  config: ProjectConfig,
  paths: IndexStoragePaths,
  resolvedContext?: GitWorktreeContext,
): SharedCacheAction {
  const bypass = sharedCacheBypassReason(projectRoot, paths.dbPath, config);
  if (bypass) return { kind: 'bypassed', reason: bypass };
  try {
    const context = resolvedContext ?? resolveGitWorktreeContext(projectRoot);
    if (!context) return { kind: 'missed', reason: 'Git worktree identity is unavailable' };
    if (!context.clean) {
      writeManagedWorktreeLease(context, paths.cacheDir, 'missed', undefined, 'worktree has uncommitted changes');
      return { kind: 'missed', reason: 'worktree has uncommitted changes' };
    }
    const languages = config.languages ?? detectLanguages(projectRoot);
    const fingerprint = buildProjectInputFingerprint(projectRoot, languages, configFingerprintOptions(config));
    const snapshot = buildSharedGenerationSnapshot(context, fingerprint);
    if (!snapshot) return { kind: 'missed', reason: 'clean committed snapshot is unavailable' };
    let manifest = readSharedGeneration(snapshot);
    if (manifest) {
      hydrateSharedGeneration({ snapshot, manifest, targetCacheDir: paths.cacheDir, targetProjectRoot: projectRoot });
      return { kind: 'attached', generationId: snapshot.generationId };
    }

    const peer = importPeerGeneration(snapshot, projectRoot);
    if (!peer) {
      writeManagedWorktreeLease(
        context,
        paths.cacheDir,
        'missed',
        undefined,
        'no exact shared or peer generation exists',
      );
      return { kind: 'missed', reason: 'no exact shared or peer generation exists' };
    }
    manifest = peer.manifest;
    hydrateSharedGeneration({
      snapshot,
      manifest,
      targetCacheDir: paths.cacheDir,
      targetProjectRoot: projectRoot,
      action: 'peer-imported',
    });
    return { kind: 'peer-imported', generationId: snapshot.generationId, sourceProjectRoot: peer.sourceProjectRoot };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

// scip-query: ignore-similar — reviewed M1 lifecycle variation; preparation reads/imports while publication creates and leases.
// scip-query: ignore-extract — reviewed E1 workflow owner; fingerprinting, publication, and worktree leasing stay together.
export function publishFreshLocalGenerationForProject(
  projectRoot: string,
  config: ProjectConfig,
  paths: IndexStoragePaths,
  resolvedContext?: GitWorktreeContext,
): SharedCacheAction {
  const bypass = sharedCacheBypassReason(projectRoot, paths.dbPath, config);
  if (bypass) return { kind: 'bypassed', reason: bypass };
  try {
    const context = resolvedContext ?? resolveGitWorktreeContext(projectRoot);
    if (!context) return { kind: 'missed', reason: 'Git worktree identity is unavailable' };
    if (!context.clean) {
      writeManagedWorktreeLease(
        context,
        paths.cacheDir,
        'missed',
        undefined,
        'worktree is not a clean committed snapshot',
      );
      return { kind: 'missed', reason: 'worktree is not a clean committed snapshot' };
    }
    const languages = config.languages ?? detectLanguages(projectRoot);
    const fingerprint = buildProjectInputFingerprint(projectRoot, languages, configFingerprintOptions(config));
    const snapshot = buildSharedGenerationSnapshot(context, fingerprint);
    if (!snapshot) {
      writeManagedWorktreeLease(
        context,
        paths.cacheDir,
        'missed',
        undefined,
        'worktree is not a clean committed snapshot',
      );
      return { kind: 'missed', reason: 'worktree is not a clean committed snapshot' };
    }
    const existing = readSharedGeneration(snapshot);
    if (existing) {
      if (validateSourceGeneration(paths.cacheDir, projectRoot, fingerprint)) {
        writeWorktreeLease(snapshot, paths.cacheDir, 'local-fresh');
        return { kind: 'local-fresh' };
      }
      hydrateSharedGeneration({
        snapshot,
        manifest: existing,
        targetCacheDir: paths.cacheDir,
        targetProjectRoot: projectRoot,
      });
      return { kind: 'attached', generationId: snapshot.generationId };
    }
    const metadata = readPublishableReindexMetadata(paths.cacheDir);
    if (
      !metadata ||
      JSON.stringify(metadata.fingerprint) !== JSON.stringify(fingerprint) ||
      JSON.stringify([...(metadata.indexedLanguages ?? [])].sort()) !== JSON.stringify([...languages].sort())
    ) {
      return { kind: 'missed', reason: 'local metadata does not match the clean worktree snapshot' };
    }
    if (!validateSourceGeneration(paths.cacheDir, projectRoot, fingerprint)) {
      return { kind: 'missed', reason: 'local index artifacts are incomplete or incompatible' };
    }
    publishSharedGeneration({
      snapshot,
      sourceCacheDir: paths.cacheDir,
      sourceProjectRoot: projectRoot,
      sourceStillValid: () => {
        const current = resolveGitWorktreeContext(projectRoot);
        return (
          (current ? buildSharedGenerationSnapshot(current, fingerprint) : undefined)?.generationId ===
          snapshot.generationId
        );
      },
    });
    writeWorktreeLease(snapshot, paths.cacheDir, 'built');
    return { kind: 'built', generationId: snapshot.generationId };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export async function acquireSharedGenerationBuildLock(
  snapshot: SharedGenerationSnapshot,
  opts: { timeoutMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<SharedBuildLockResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const now = opts.now ?? monotonicNowMs;
  const deadline = now() + timeoutMs;
  const locksDir = join(snapshot.repositoryCacheDir, 'locks');
  const lockPath = join(locksDir, `${snapshot.generationId}.lock`);
  const parseLegacyBuildLock: LegacyProcessLockDecoder = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const pid = (value as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { pid } : null;
  };

  while (now() <= deadline) {
    if (readSharedGeneration(snapshot)) return { kind: 'generation-ready' };
    const acquired = tryAcquireProcessFileLock(lockPath, {
      kind: 'shared-generation-build',
      detail: { generationId: snapshot.generationId },
      parseLegacy: parseLegacyBuildLock,
    });
    if (acquired.kind === 'acquired') {
      return {
        kind: 'owner',
        release: () => acquired.lock.release(),
      };
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await delay(Math.min(pollMs, remainingMs));
  }
  return readSharedGeneration(snapshot) ? { kind: 'generation-ready' } : { kind: 'timeout' };
}

export function writeWorktreeLease(
  snapshot: SharedGenerationSnapshot,
  localCacheDir: string,
  lastAction: WorktreeCacheLease['lastAction'],
  now: (() => Date) | undefined = undefined,
): WorktreeCacheLease {
  const leaseWithoutChecksum = {
    version: 1,
    repositoryId: snapshot.repositoryId,
    worktreeId: snapshot.worktreeId,
    projectRoot: snapshot.projectRoot,
    treeOid: snapshot.treeOid,
    localCacheDir,
    baseGenerationId: snapshot.generationId,
    activeGenerationId: snapshot.generationId,
    lastAction,
    lastSeenAt: (now ?? (() => new Date()))().toISOString(),
  } as const;
  const lease: WorktreeCacheLease = {
    ...leaseWithoutChecksum,
    ownershipChecksum: worktreeLeaseOwnershipChecksum(leaseWithoutChecksum),
  };
  persistWorktreeLease(snapshot.repositoryCacheDir, lease, true);
  return lease;
}

/**
 * Records a private worktree cache derived from an immutable shared baseline.
 *
 * The baseline remains protected for lineage and future reuse, while the
 * absent active generation states that local publication may diverge from the
 * shared bytes.
 */
export function writeWorktreeOverlayLease(
  snapshot: SharedGenerationSnapshot,
  localCacheDir: string,
  now: (() => Date) | undefined = undefined,
): WorktreeCacheLease {
  const leaseWithoutChecksum = {
    version: 1,
    repositoryId: snapshot.repositoryId,
    worktreeId: snapshot.worktreeId,
    projectRoot: snapshot.projectRoot,
    treeOid: snapshot.treeOid,
    localCacheDir,
    baseGenerationId: snapshot.generationId,
    lastAction: 'overlay',
    lastReason: `private cache forked from shared baseline ${snapshot.generationId}`,
    lastSeenAt: (now ?? (() => new Date()))().toISOString(),
  } as const;
  const lease: WorktreeCacheLease = {
    ...leaseWithoutChecksum,
    ownershipChecksum: worktreeLeaseOwnershipChecksum(leaseWithoutChecksum),
  };
  persistWorktreeLease(snapshot.repositoryCacheDir, lease, true);
  return lease;
}

export function writeManagedWorktreeLease(
  context: GitWorktreeContext,
  localCacheDir: string,
  lastAction: WorktreeCacheLease['lastAction'],
  now: (() => Date) | undefined = undefined,
  lastReason: string | undefined = undefined,
): WorktreeCacheLease {
  const leaseWithoutChecksum = {
    version: 1,
    repositoryId: context.repositoryId,
    worktreeId: context.worktreeId,
    projectRoot: context.projectRoot,
    treeOid: context.treeOid,
    localCacheDir,
    lastAction,
    ...(lastReason ? { lastReason } : {}),
    lastSeenAt: (now ?? (() => new Date()))().toISOString(),
  } as const;
  const lease: WorktreeCacheLease = {
    ...leaseWithoutChecksum,
    ownershipChecksum: worktreeLeaseOwnershipChecksum(leaseWithoutChecksum),
  };
  persistWorktreeLease(resolveRepositoryCacheDir(context.repositoryId), lease, false);
  return lease;
}

/** A deterministic ownership proof binding a lease to its managed path and worktree identity. */
export function worktreeLeaseOwnershipChecksum(
  lease: Pick<WorktreeCacheLease, 'repositoryId' | 'worktreeId' | 'projectRoot' | 'localCacheDir'>,
): string {
  return sha256(
    JSON.stringify({
      version: 1,
      repositoryId: lease.repositoryId,
      worktreeId: lease.worktreeId,
      projectRoot: resolve(lease.projectRoot),
      localCacheDir: resolve(lease.localCacheDir),
    }),
  );
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function touchExistingWorktreeLease(
  projectRoot: string,
  localCacheDir: string,
  now: (() => Date) | undefined = undefined,
  resolvedContext?: GitWorktreeContext,
  options: WorktreeLeaseTouchOptions = {},
): WorktreeCacheLease | null {
  try {
    const observedPointer = readWorktreeCachePointer(localCacheDir);
    if (!observedPointer) return null;
    const repositoryCacheDir = resolveRepositoryCacheDir(observedPointer.repositoryId);
    options.onBeforeRepositoryLock?.();
    const lock = acquireRepositoryCacheLock(repositoryCacheDir, { waitMs: 5_000 });
    if (!lock) return null;
    try {
      const pointer = readWorktreeCachePointer(localCacheDir);
      if (
        !pointer ||
        pointer.repositoryId !== observedPointer.repositoryId ||
        pointer.worktreeId !== observedPointer.worktreeId
      ) {
        return null;
      }
      const leasePath = join(repositoryCacheDir, 'worktrees', `${pointer.worktreeId}.json`);
      const lease = JSON.parse(
        readTextFileWithinLimit(leasePath, {
          inputKind: 'worktree cache lease',
          maxBytes: SMALL_ARTIFACT_MAX_BYTES,
        }),
      ) as WorktreeCacheLease;
      const context = resolvedContext ?? resolveGitWorktreeContext(projectRoot);
      if (
        !context?.clean ||
        !context.treeOid ||
        lease.version !== 1 ||
        lease.repositoryId !== pointer.repositoryId ||
        lease.worktreeId !== pointer.worktreeId ||
        lease.repositoryId !== context.repositoryId ||
        lease.worktreeId !== context.worktreeId ||
        resolve(lease.projectRoot) !== resolve(context.projectRoot) ||
        lease.treeOid !== context.treeOid ||
        resolve(lease.localCacheDir) !== resolve(localCacheDir) ||
        lease.ownershipChecksum !== worktreeLeaseOwnershipChecksum(lease)
      ) {
        return null;
      }
      const metadata = readPublishableReindexMetadata(localCacheDir);
      if (!isProjectInputFingerprint(metadata?.fingerprint)) return null;
      const snapshot = buildSharedGenerationSnapshot(context, metadata.fingerprint);
      if (
        !snapshot ||
        snapshot.repositoryCacheDir !== repositoryCacheDir ||
        lease.baseGenerationId !== snapshot.generationId ||
        lease.activeGenerationId !== snapshot.generationId ||
        !validateSourceGeneration(localCacheDir, projectRoot, snapshot.fingerprint, true, false)
      ) {
        return null;
      }
      const current = (now ?? (() => new Date()))();
      if (Number.isFinite(Date.parse(lease.lastSeenAt)) && current.getTime() - Date.parse(lease.lastSeenAt) < 60_000) {
        return lease;
      }
      const touched = { ...lease, lastSeenAt: current.toISOString() };
      writeJsonDurable(leasePath, touched, { spacing: 2, trailingNewline: true });
      return touched;
    } finally {
      lock.release();
    }
  } catch {
    return null;
  }
}

export function parseSharedGenerationManifest(value: string): SharedGenerationManifest {
  const parsed = JSON.parse(value) as Partial<SharedGenerationManifest>;
  if (
    parsed.version !== SHARED_GENERATION_FORMAT_VERSION ||
    parsed.artifactCatalogVersion !== INDEX_ARTIFACT_CATALOG_VERSION ||
    typeof parsed.generationId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.generationId) ||
    typeof parsed.repositoryId !== 'string' ||
    !/^[a-f0-9]{24}$/.test(parsed.repositoryId) ||
    typeof parsed.treeOid !== 'string' ||
    !parsed.treeOid ||
    typeof parsed.producerIdentity !== 'string' ||
    parsed.producerIdentity !== SHARED_GENERATION_PRODUCER_IDENTITY ||
    typeof parsed.sourceProjectRoot !== 'string' ||
    typeof parsed.scipProjectRoot !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    !parsed.fingerprint ||
    !Array.isArray(parsed.artifacts)
  ) {
    throw new Error('invalid shared generation manifest');
  }
  const seen = new Set<string>();
  for (const artifact of parsed.artifacts) {
    if (
      !artifact ||
      typeof artifact.path !== 'string' ||
      typeof artifact.size !== 'number' ||
      artifact.size < 0 ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new Error('invalid shared generation artifact');
    }
    validateIndexArtifactRelativePath(artifact.path);
    if (seen.has(artifact.path)) throw new Error(`duplicate shared generation artifact: ${artifact.path}`);
    seen.add(artifact.path);
  }
  for (const required of ['index.db', 'index.scip', 'meta.json']) {
    if (!seen.has(required)) throw new Error(`shared generation is missing ${required}`);
  }
  return parsed as SharedGenerationManifest;
}

export function cloneArtifactFile(
  source: string,
  target: string,
  mode = 0o600,
): Exclude<DirectorySyncStatus, 'not-requested'> {
  return cloneFileDurable(source, target, { mode });
}

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
function importPeerGeneration(
  snapshot: SharedGenerationSnapshot,
  targetProjectRoot: string,
): { manifest: SharedGenerationManifest; sourceProjectRoot: string } | null {
  for (const record of listGitWorktrees(targetProjectRoot)) {
    if (resolve(record.path) === resolve(targetProjectRoot)) continue;
    const cacheDir = resolveDefaultCacheDir(record.path);
    const metadata = readPublishableReindexMetadata(cacheDir);
    if (
      !metadata ||
      JSON.stringify(metadata.fingerprint) !== JSON.stringify(snapshot.fingerprint) ||
      JSON.stringify([...(metadata.indexedLanguages ?? [])].sort()) !==
        JSON.stringify([...snapshot.fingerprint.languages].sort())
    ) {
      continue;
    }
    if (!validateSourceGeneration(cacheDir, record.path, snapshot.fingerprint)) continue;
    try {
      const publication = publishSharedGeneration({
        snapshot,
        sourceCacheDir: cacheDir,
        sourceProjectRoot: record.path,
      });
      return { manifest: publication.manifest, sourceProjectRoot: record.path };
    } catch {
      continue;
    }
  }
  return null;
}

function writeWorktreeCachePointer(localCacheDir: string, repositoryId: string, worktreeId: string): void {
  mkdirSync(localCacheDir, { recursive: true });
  writeJsonDurable(
    join(localCacheDir, WORKTREE_CACHE_POINTER),
    { version: 1, repositoryId, worktreeId },
    { spacing: 2, trailingNewline: true },
  );
}

function sourceGenerationSignature(cacheDir: string): string | null {
  try {
    const artifacts = describeIndexArtifactSet(cacheDir);
    const hash = createHash('sha256');
    for (const file of artifacts.files) {
      const path = indexArtifactPath(cacheDir, file);
      const size = statSync(path).size;
      hash.update(file).update('\0').update(String(size)).update('\0');
      hashFileWithinLimit(
        path,
        { inputKind: 'source-generation artifact', maxBytes: SCIP_ARTIFACT_MAX_BYTES },
        (chunk) => hash.update(chunk),
      );
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function readPublishableReindexMetadata(cacheDir: string): ReindexMetadata | undefined {
  try {
    const decoded = decodeReindexMetadata(
      readTextFileWithinLimit(join(cacheDir, 'meta.json'), {
        inputKind: 'reindex metadata',
        maxBytes: SMALL_ARTIFACT_MAX_BYTES,
      }),
    );
    return (decoded.kind === 'legacy' || decoded.kind === 'supported') && decoded.capabilities.publishableGeneration
      ? decoded.metadata
      : undefined;
  } catch {
    return undefined;
  }
}

function configFingerprintOptions(config: ProjectConfig): ProjectInputFingerprintOptions {
  return {
    pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces,
    typescriptProjectMode: config.indexer?.typescript?.projectMode,
    typescriptProjects: config.indexer?.typescript?.projects,
    clojureConfigPath: config.indexer?.clojure?.configPath,
  };
}

function sameFingerprintConfiguration(
  fingerprint: ProjectInputFingerprint,
  expected: ProjectInputFingerprintConfiguration,
): boolean {
  const actual = normalizeProjectInputFingerprintConfiguration(fingerprint.languages, fingerprint);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sharedGenerationDirectory(snapshot: SharedGenerationSnapshot): string {
  return join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId);
}

function readWorktreeCachePointer(
  localCacheDir: string,
): { version: 1; repositoryId: string; worktreeId: string } | null {
  const pointer = JSON.parse(
    readTextFileWithinLimit(join(localCacheDir, WORKTREE_CACHE_POINTER), {
      inputKind: 'worktree cache pointer',
      maxBytes: SMALL_ARTIFACT_MAX_BYTES,
    }),
  ) as {
    version?: unknown;
    repositoryId?: unknown;
    worktreeId?: unknown;
  };
  if (
    pointer.version !== 1 ||
    typeof pointer.repositoryId !== 'string' ||
    !/^[a-f0-9]{24}$/.test(pointer.repositoryId) ||
    typeof pointer.worktreeId !== 'string' ||
    !/^[a-f0-9]{24}$/.test(pointer.worktreeId)
  ) {
    return null;
  }
  return {
    version: pointer.version,
    repositoryId: pointer.repositoryId,
    worktreeId: pointer.worktreeId,
  };
}

function persistWorktreeLease(repositoryCacheDir: string, lease: WorktreeCacheLease, requireGeneration: boolean): void {
  const lock = acquireRepositoryCacheLock(repositoryCacheDir, { waitMs: 5_000 });
  if (!lock) throw new Error('repository cache cleanup is busy');
  try {
    if (requireGeneration) {
      const generationId = lease.activeGenerationId ?? lease.baseGenerationId;
      if (!generationId || !existsSync(join(repositoryCacheDir, 'generations', generationId))) {
        throw new Error('shared generation disappeared before its lease was attached');
      }
    }
    const worktreesDir = join(repositoryCacheDir, 'worktrees');
    mkdirSync(worktreesDir, { recursive: true });
    writeJsonDurable(join(worktreesDir, `${lease.worktreeId}.json`), lease, {
      spacing: 2,
      trailingNewline: true,
    });
    writeWorktreeCachePointer(lease.localCacheDir, lease.repositoryId, lease.worktreeId);
  } finally {
    lock.release();
  }
}

interface HydrationRollback {
  root: string;
  stableFiles: Map<string, boolean>;
  managedDirectories: Map<string, boolean>;
  generationStoreExisted: boolean;
}

function backupHydrationTarget(targetCacheDir: string, stagingDir: string): HydrationRollback {
  const root = join(stagingDir, '.rollback');
  const stableFiles = new Map<string, boolean>();
  const managedDirectories = new Map<string, boolean>();
  mkdirSync(root, { recursive: true });
  for (const file of ['index.scip', 'index.db', 'meta.json']) {
    const source = join(targetCacheDir, file);
    const existed = existsSync(source);
    stableFiles.set(file, existed);
    if (existed) cloneArtifactFile(source, join(root, 'stable', file));
  }
  for (const directory of MANAGED_ARTIFACT_DIRECTORIES) {
    const target = join(targetCacheDir, directory);
    const existed = existsSync(target);
    if (existed) {
      const stat = lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`managed artifact path is not a directory: ${directory}`);
      }
    }
    managedDirectories.set(directory, existed);
  }
  const generationStore = join(targetCacheDir, SQLITE_GENERATION_DIRECTORY);
  const generationStoreExisted = existsSync(generationStore);
  if (generationStoreExisted) cloneDirectory(generationStore, join(root, 'sqlite-generations'));
  return { root, stableFiles, managedDirectories, generationStoreExisted };
}

function installHydratedArtifactDirectories(
  stagingDir: string,
  targetCacheDir: string,
  rollback: HydrationRollback,
): void {
  for (const directory of MANAGED_ARTIFACT_DIRECTORIES) {
    const target = join(targetCacheDir, directory);
    if (rollback.managedDirectories.get(directory)) {
      const backup = join(rollback.root, 'managed', directory);
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(target, backup);
    }
    const staged = join(stagingDir, directory);
    if (existsSync(staged)) renameSync(staged, target);
  }
}

function restoreHydrationTarget(targetCacheDir: string, rollback: HydrationRollback): void {
  for (const directory of MANAGED_ARTIFACT_DIRECTORIES) {
    const target = join(targetCacheDir, directory);
    const backup = join(rollback.root, 'managed', directory);
    if (rollback.managedDirectories.get(directory)) {
      if (existsSync(backup)) {
        rmSync(target, { recursive: true, force: true });
        renameSync(backup, target);
      }
    } else {
      rmSync(target, { recursive: true, force: true });
    }
  }
  for (const [file, existed] of rollback.stableFiles) {
    const target = join(targetCacheDir, file);
    if (!existed) {
      rmSync(target, { force: true });
      continue;
    }
    const replacement = `${target}.shared-restore-${randomUUID()}`;
    cloneArtifactFile(join(rollback.root, 'stable', file), replacement);
    rmSync(target, { force: true });
    renameSync(replacement, target);
  }
  const generationStore = join(targetCacheDir, SQLITE_GENERATION_DIRECTORY);
  rmSync(generationStore, { recursive: true, force: true });
  const backupGenerationStore = join(rollback.root, 'sqlite-generations');
  if (rollback.generationStoreExisted && existsSync(backupGenerationStore)) {
    renameSync(backupGenerationStore, generationStore);
  }
}

function cloneDirectory(sourceRoot: string, targetRoot: string): void {
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const target = join(targetRoot, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`managed cache backup cannot contain a symlink: ${source}`);
    if (entry.isDirectory()) cloneDirectory(source, target);
    else if (entry.isFile()) cloneArtifactFile(source, target);
  }
}

function assertManifestMatchesSnapshot(manifest: SharedGenerationManifest, snapshot: SharedGenerationSnapshot): void {
  if (
    manifest.generationId !== snapshot.generationId ||
    manifest.repositoryId !== snapshot.repositoryId ||
    manifest.treeOid !== snapshot.treeOid ||
    manifest.producerIdentity !== snapshot.producerIdentity ||
    JSON.stringify(manifest.fingerprint) !== JSON.stringify(snapshot.fingerprint)
  ) {
    throw new Error('shared generation manifest does not match the requested snapshot');
  }
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function validateSourceGeneration(
  cacheDir: string,
  projectRoot: string,
  expectedFingerprint: ProjectInputFingerprint,
  requireCurrentState = true,
  deepSqliteIntegrity = true,
): boolean {
  try {
    const metadata = readPublishableReindexMetadata(cacheDir);
    if (
      !metadata ||
      JSON.stringify(metadata.fingerprint) !== JSON.stringify(expectedFingerprint) ||
      JSON.stringify([...(metadata.indexedLanguages ?? [])].sort()) !==
        JSON.stringify([...expectedFingerprint.languages].sort())
    ) {
      debugSharedCache('source validation rejected metadata');
      return false;
    }
    const artifacts = describeIndexArtifactSet(cacheDir);
    const inspection = inspectSqliteGeneration(join(cacheDir, 'index.db'), join(cacheDir, 'meta.json'));
    if (
      requireCurrentState
        ? inspection.state !== 'current'
        : inspection.state === 'invalid' || inspection.state === 'drifted'
    ) {
      debugSharedCache(`source validation rejected SQLite generation state ${inspection.state}`);
      return false;
    }
    const db = new Database(join(cacheDir, 'index.db'), { readonly: true, fileMustExist: true });
    try {
      if (deepSqliteIntegrity) {
        const result = db.pragma('quick_check(1)', { simple: true });
        if (result !== 'ok') return false;
      } else {
        db.pragma('schema_version', { simple: true });
      }
    } finally {
      db.close();
    }
    const expectedRoot = canonicalProjectRootUrl(projectRoot);
    const scipArtifacts = deepSqliteIntegrity
      ? artifacts.files.filter((file) => file.endsWith('.scip'))
      : ['index.scip'];
    const rootsMatch = scipArtifacts.every((file) => {
      const actualRoot = deserializeSCIP(
        readFileWithinLimit(indexArtifactPath(cacheDir, file), {
          inputKind: 'shared SCIP validation artifact',
          maxBytes: SCIP_ARTIFACT_MAX_BYTES,
        }),
      ).metadata?.projectRoot;
      if (actualRoot !== expectedRoot)
        debugSharedCache(`source validation rejected SCIP root for ${file}: ${String(actualRoot)}`);
      return actualRoot === expectedRoot;
    });
    if (!rootsMatch) debugSharedCache('source validation rejected SCIP project roots');
    return rootsMatch;
  } catch (error) {
    debugSharedCache(`source validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function debugSharedCache(message: string): void {
  if (process.env['SCIP_QUERY_DEBUG']) console.error(`shared-cache: ${message}`);
}

function canonicalProjectRootUrl(projectRoot: string): string {
  try {
    return pathToFileURL(realpathSync(projectRoot)).href;
  } catch {
    return pathToFileURL(resolve(projectRoot)).href;
  }
}

function isProjectInputFingerprint(value: unknown): value is ProjectInputFingerprint {
  if (!value || typeof value !== 'object') return false;
  const fingerprint = value as Partial<ProjectInputFingerprint>;
  return (
    fingerprint.version === 2 &&
    Array.isArray(fingerprint.languages) &&
    typeof fingerprint.pnpmWorkspaces === 'boolean' &&
    (fingerprint.typescriptProjectMode === 'single' || fingerprint.typescriptProjectMode === 'workspace') &&
    Array.isArray(fingerprint.typescriptProjects) &&
    Array.isArray(fingerprint.files) &&
    fingerprint.files.every(
      (file) =>
        file !== null &&
        typeof file === 'object' &&
        typeof file.path === 'string' &&
        typeof file.size === 'number' &&
        typeof file.hash === 'string',
    )
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
