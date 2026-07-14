import { existsSync, readFileSync } from 'node:fs';
import type { LastRefreshMetadata, ProjectConfig, SupportedLanguage } from '../domain/types.js';
import { detectLanguages } from '../reindex/detect.js';
import { buildProjectInputFingerprint, type ProjectInputFingerprint } from '../reindex/project-files.js';
import { inspectSqliteGeneration } from '../reindex/sqlite-generation-store.js';

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

interface ReindexMetadataLike {
  version?: number;
  status?: string;
  updatedAt?: string;
  fingerprint?: unknown;
  indexedLanguages?: unknown;
  lastRefresh?: LastRefreshMetadata;
}

export function getIndexFreshness(
  projectRoot: string,
  config: ProjectConfig,
  paths: { dbPath: string; metaPath: string },
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
    const metadata = JSON.parse(readFileSync(paths.metaPath, 'utf-8')) as ReindexMetadataLike;
    const languages = config.languages ?? detectLanguages(projectRoot);
    const current = runtimeFingerprint(projectRoot, languages, config);
    const metadataLanguages = Array.isArray(metadata.indexedLanguages) ? [...metadata.indexedLanguages].sort() : [];
    const fresh =
      (metadata.version === 2 || metadata.version === 3) &&
      metadata.status === 'complete' &&
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
