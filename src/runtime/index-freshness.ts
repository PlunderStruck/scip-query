import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeReindexMetadata } from '../domain/reindex-metadata.js';
import { projectInputSnapshotOrNull } from '../domain/project-input.js';
import type { LastRefreshMetadata, ProjectConfig, SupportedLanguage } from '../domain/types.js';
import { normalizeSafeProjectRelativePath } from '../domain/path-normalization.js';
import {
  gitIndexAllowsTreeFingerprintReuse,
  refreshGitWorktreeContext,
  type GitWorktreeContext,
  type GitWorktreeContextObservation,
} from '../platform/git-worktree.js';
import {
  buildProjectInputFingerprint,
  listProjectFiles,
  normalizeProjectInputFingerprintConfiguration,
  type ProjectInputFingerprint,
  type ProjectInputFingerprintConfiguration,
} from '../platform/project-files.js';
import { typeScriptProjectSelectionIsTreeOwned } from '../platform/typescript-projects.js';
import { detectLanguages } from '../reindex/detect.js';
import { managedGenerationMatchesFingerprint } from '../reindex/shared-generation-store.js';
import { inspectSqliteGeneration } from '../reindex/sqlite-generation-store.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';

export type IndexFreshnessState = 'fresh' | 'stale' | 'missing' | 'unknown';

export interface IndexFreshness {
  state: IndexFreshnessState;
  checkedAt: string;
  metaPath: string;
  reason: string;
  remedy?: string;
  updatedAt?: string;
  lastRefresh?: LastRefreshMetadata;
}

/** True when a query can read the current SQLite generation even if the fingerprint is stale. */
export function indexCanAnswerQueries(freshness: IndexFreshness): boolean {
  if (freshness.state === 'fresh') return true;
  if (freshness.state !== 'stale') return false;
  return !freshness.reason.startsWith('SQLite generation requires repair');
}

export function getIndexFreshness(
  projectRoot: string,
  config: ProjectConfig,
  paths: { dbPath: string; metaPath: string; cacheDir?: string },
  opts: { gitContext?: GitWorktreeContext; gitObservation?: GitWorktreeContextObservation } = {},
): IndexFreshness {
  const checkedAt = new Date().toISOString();
  if (!existsSync(paths.dbPath)) {
    return {
      state: 'missing',
      checkedAt,
      metaPath: paths.metaPath,
      reason: 'No SQLite index database exists.',
      remedy: 'Run: scip-query reindex',
    };
  }
  if (!existsSync(paths.metaPath)) {
    return {
      state: 'unknown',
      checkedAt,
      metaPath: paths.metaPath,
      reason: 'No reindex metadata file exists next to the SQLite index.',
      remedy: 'Run: scip-query reindex',
    };
  }

  try {
    const decoded = decodeReindexMetadata(readSmallArtifactText(paths.metaPath, 'reindex metadata'));
    if (decoded.kind === 'unsupported') {
      return {
        state: 'unknown',
        checkedAt,
        metaPath: paths.metaPath,
        reason: `Reindex metadata version ${decoded.version} is unsupported by this scip-query build.`,
        remedy: 'Upgrade scip-query or run: scip-query reindex',
      };
    }
    if (decoded.kind === 'malformed') {
      return {
        state: 'unknown',
        checkedAt,
        metaPath: paths.metaPath,
        reason: `Could not decode reindex metadata: ${decoded.reason}`,
        remedy: 'Run: scip-query reindex',
      };
    }
    const metadata = decoded.metadata;
    const languages = config.languages ?? detectLanguages(projectRoot);
    const storedFingerprint = metadata.fingerprint;
    const managedFingerprint =
      paths.cacheDir &&
      opts.gitContext &&
      managedGenerationMatchesFingerprint(opts.gitContext, paths.cacheDir, storedFingerprint)
        ? storedFingerprint
        : undefined;
    const observedGitContext =
      paths.cacheDir &&
      opts.gitContext &&
      managedFingerprint &&
      fingerprintConfigurationMatches(managedFingerprint, languages, config) &&
      projectSelectionIsTreeOwned(projectRoot, managedFingerprint, config)
        ? opts.gitObservation?.context === opts.gitContext
          ? opts.gitContext
          : refreshGitWorktreeContext(opts.gitContext)
        : undefined;
    const cachedInventoryAfterSequence =
      opts.gitObservation && opts.gitObservation.context === opts.gitContext
        ? opts.gitObservation.projectFileInventorySequence
        : undefined;
    const currentGitContext =
      observedGitContext?.clean &&
      gitIndexAllowsTreeFingerprintReuse(projectRoot, undefined, { cachedInventoryAfterSequence })
        ? observedGitContext
        : undefined;
    const current =
      paths.cacheDir &&
      currentGitContext &&
      managedFingerprint &&
      managedGenerationMatchesFingerprint(currentGitContext, paths.cacheDir, managedFingerprint)
        ? managedFingerprint
        : runtimeFingerprint(projectRoot, languages, config);
    const metadataLanguages = [...(metadata.indexedLanguages ?? [])].sort();
    const fresh =
      decoded.capabilities.publishableGeneration &&
      JSON.stringify(metadata.fingerprint) === JSON.stringify(current) &&
      JSON.stringify(metadataLanguages) === JSON.stringify(current.languages);
    const generation = inspectSqliteGeneration(paths.dbPath, paths.metaPath);
    const generationDrift = generation.state === 'invalid' || generation.state === 'drifted';
    const accepted = fresh && !generationDrift;
    return {
      state: accepted ? 'fresh' : 'stale',
      checkedAt,
      metaPath: paths.metaPath,
      updatedAt: metadata.updatedAt,
      lastRefresh: metadata.lastRefresh,
      reason: generationDrift
        ? `SQLite generation requires repair: ${generation.reason}`
        : fresh
          ? 'Index metadata fingerprint matches current source files.'
          : 'Index metadata fingerprint differs from current source files.',
      remedy: accepted ? undefined : 'Run: scip-query reindex',
    };
  } catch (error) {
    return {
      state: 'unknown',
      checkedAt,
      metaPath: paths.metaPath,
      reason: `Could not read reindex metadata: ${error instanceof Error ? error.message : String(error)}`,
      remedy: 'Run: scip-query reindex',
    };
  }
}

/**
 * Checks the accepted publication artifacts without observing project files.
 * This is valid only immediately after the owning watcher completed a reindex
 * and proved that no later filesystem event is pending.
 */
export function getPublishedIndexFreshness(paths: { dbPath: string; metaPath: string }): IndexFreshness {
  const checkedAt = new Date().toISOString();
  if (!existsSync(paths.dbPath)) {
    return {
      state: 'missing',
      checkedAt,
      metaPath: paths.metaPath,
      reason: 'No SQLite index database exists.',
      remedy: 'Run: scip-query reindex',
    };
  }
  if (!existsSync(paths.metaPath)) {
    return {
      state: 'unknown',
      checkedAt,
      metaPath: paths.metaPath,
      reason: 'No reindex metadata file exists next to the SQLite index.',
      remedy: 'Run: scip-query reindex',
    };
  }
  try {
    const decoded = decodeReindexMetadata(readSmallArtifactText(paths.metaPath, 'reindex metadata'));
    if (decoded.kind === 'unsupported') {
      return {
        state: 'unknown',
        checkedAt,
        metaPath: paths.metaPath,
        reason: `Reindex metadata version ${decoded.version} is unsupported by this scip-query build.`,
        remedy: 'Upgrade scip-query or run: scip-query reindex',
      };
    }
    if (decoded.kind === 'malformed') {
      return {
        state: 'unknown',
        checkedAt,
        metaPath: paths.metaPath,
        reason: `Could not decode reindex metadata: ${decoded.reason}`,
        remedy: 'Run: scip-query reindex',
      };
    }
    const metadata = decoded.metadata;
    const metadataLanguages = [...(metadata.indexedLanguages ?? [])].sort();
    const fingerprint = projectInputSnapshotOrNull(metadata.fingerprint);
    const fingerprintLanguages = [...(fingerprint?.languages ?? [])].sort();
    const publishable =
      decoded.capabilities.publishableGeneration &&
      fingerprint !== null &&
      JSON.stringify(metadataLanguages) === JSON.stringify(fingerprintLanguages);
    const generation = inspectSqliteGeneration(paths.dbPath, paths.metaPath);
    const generationDrift = generation.state === 'invalid' || generation.state === 'drifted';
    const accepted = publishable && !generationDrift;
    return {
      state: accepted ? 'fresh' : 'stale',
      checkedAt,
      metaPath: paths.metaPath,
      updatedAt: metadata.updatedAt,
      lastRefresh: metadata.lastRefresh,
      reason: generationDrift
        ? `SQLite generation requires repair: ${generation.reason}`
        : publishable
          ? 'Watcher accepted the newly published index generation with no later changes pending.'
          : 'Published index metadata is not a complete queryable generation.',
      remedy: accepted ? undefined : 'Run: scip-query reindex',
    };
  } catch (error) {
    return {
      state: 'unknown',
      checkedAt,
      metaPath: paths.metaPath,
      reason: `Could not read reindex metadata: ${error instanceof Error ? error.message : String(error)}`,
      remedy: 'Run: scip-query reindex',
    };
  }
}

export function runtimeFingerprint(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  config: ProjectConfig,
): ProjectInputFingerprint {
  return buildProjectInputFingerprint(projectRoot, languages, {
    pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces,
    typescriptProjectMode: config.indexer?.typescript?.projectMode,
    typescriptProjects: config.indexer?.typescript?.projects,
    clojureConfigPath: config.indexer?.clojure?.configPath,
  });
}

function fingerprintConfigurationMatches(
  fingerprint: ProjectInputFingerprint,
  languages: readonly SupportedLanguage[],
  config: ProjectConfig,
): boolean {
  const current = normalizedFingerprintConfiguration(languages, config);
  return (
    fingerprint.version === current.version &&
    JSON.stringify([...fingerprint.languages].sort()) === JSON.stringify(current.languages) &&
    fingerprint.pnpmWorkspaces === current.pnpmWorkspaces &&
    fingerprint.typescriptProjectMode === current.typescriptProjectMode &&
    JSON.stringify([...fingerprint.typescriptProjects].sort()) === JSON.stringify(current.typescriptProjects) &&
    fingerprint.clojureConfigPath === current.clojureConfigPath
  );
}

function projectSelectionIsTreeOwned(
  projectRoot: string,
  fingerprint: ProjectInputFingerprint,
  config: ProjectConfig,
): boolean {
  const needsTrackedPaths = fingerprint.languages.includes('typescript') || Boolean(fingerprint.clojureConfigPath);
  if (!needsTrackedPaths) return true;
  const trackedPaths = listProjectFiles(projectRoot);
  if (fingerprint.clojureConfigPath) {
    const relativeConfigPath = normalizeSafeProjectRelativePath(fingerprint.clojureConfigPath);
    if (!trackedPaths.includes(relativeConfigPath)) return false;
    try {
      if (!lstatSync(resolve(projectRoot, relativeConfigPath)).isFile()) return false;
    } catch {
      return false;
    }
  }
  return (
    !fingerprint.languages.includes('typescript') ||
    typeScriptProjectSelectionIsTreeOwned(
      projectRoot,
      config.indexer?.typescript?.projectMode,
      config.indexer?.typescript?.projects ?? [],
      trackedPaths,
    )
  );
}

function normalizedFingerprintConfiguration(
  languages: readonly SupportedLanguage[],
  config: ProjectConfig,
): ProjectInputFingerprintConfiguration {
  return normalizeProjectInputFingerprintConfiguration(languages, {
    pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces,
    typescriptProjectMode: config.indexer?.typescript?.projectMode,
    typescriptProjects: config.indexer?.typescript?.projects,
    clojureConfigPath: config.indexer?.clojure?.configPath,
  });
}
