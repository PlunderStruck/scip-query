import { existsSync, readFileSync } from 'node:fs';
import type { ProjectConfig, SupportedLanguage } from '../domain/types.js';
import { detectLanguages } from '../reindex/detect.js';
import { fingerprintProjectFiles } from '../reindex/project-files.js';

export type IndexFreshnessState = 'fresh' | 'stale' | 'missing' | 'unknown';

export interface IndexFreshness {
  state: IndexFreshnessState;
  checkedAt: string;
  metaPath: string;
  reason: string;
  remedy?: string;
  updatedAt?: string;
}

interface ReindexMetadataLike {
  version?: number;
  status?: string;
  updatedAt?: string;
  fingerprint?: unknown;
  indexedLanguages?: unknown;
}

interface RuntimeFingerprint {
  version: 1;
  languages: SupportedLanguage[];
  pnpmWorkspaces: boolean;
  files: { path: string; size: number; hash: string }[];
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
    return {
      state: fresh ? 'fresh' : 'stale',
      checkedAt,
      metaPath: paths.metaPath,
      updatedAt: metadata.updatedAt,
      reason: fresh
        ? 'Index metadata fingerprint matches current source files.'
        : 'Index metadata fingerprint differs from current source files.',
      remedy: fresh ? undefined : 'Run: scip-query reindex',
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

function runtimeFingerprint(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  config: ProjectConfig,
): RuntimeFingerprint {
  return {
    version: 1,
    languages: [...languages].sort(),
    pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces === true,
    files: fingerprintProjectFiles(projectRoot),
  };
}
