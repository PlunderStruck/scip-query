import type { SupportedLanguage } from '../domain/types.js';
import type { RefreshTrigger } from '../domain/maintenance-types.js';
import { reindex, type ReindexResult } from '../reindex/index.js';
import type { resolveIndexStoragePaths } from '../platform/cache-layout.js';
import type { ProjectConfig } from '../domain/types.js';

export interface ConfiguredProjectReindexOptions {
  languages?: SupportedLanguage[];
  force?: boolean;
  allowPartial?: boolean;
  allowExpensiveRebuild?: boolean;
  skipAutoInstall?: boolean;
  installMissing?: boolean;
  trustProjectTools?: boolean;
  indexerConcurrency?: number;
  trigger: RefreshTrigger;
  onStatus?: (message: string) => void;
}

/**
 * Run the one repository-configured index build used by both the explicit
 * reindex command and evidence-command freshness fallback.
 */
export function reindexConfiguredProject(
  projectRoot: string,
  config: ProjectConfig,
  paths: ReturnType<typeof resolveIndexStoragePaths>,
  options: ConfiguredProjectReindexOptions,
): Promise<ReindexResult> {
  return reindex({
    projectRoot,
    languages: options.languages?.length ? options.languages : config.languages,
    outputScip: paths.indexPath,
    outputDb: paths.dbPath,
    pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces,
    typescriptProjectMode: config.indexer?.typescript?.projectMode,
    typescriptProjects: config.indexer?.typescript?.projects,
    maxHeapMb: config.indexer?.typescript?.maxHeapMb,
    clojureConfigPath: config.indexer?.clojure?.configPath,
    skipIfUnchanged: options.force !== true,
    allowPartial: options.allowPartial === true,
    // A forced reindex is an explicit request to rebuild everything, so it
    // carries the whole-project rebuild permission with it; rebuild cost is
    // bounded by compiler sharding rather than gated behind a second flag.
    allowExpensiveRebuild: options.allowExpensiveRebuild === true || options.force === true,
    skipAutoInstall: options.skipAutoInstall === true,
    installMissing: options.installMissing === true,
    trustProjectTools: options.trustProjectTools === true,
    indexerConcurrency: options.indexerConcurrency ?? config.indexerConcurrency,
    trigger: options.trigger,
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
  });
}
