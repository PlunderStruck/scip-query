// scip-query — Language-agnostic code intelligence powered by SCIP indexes

export { ScipDatabase } from './storage/db.js';
export { ProjectIndex } from './core/project-index.js';
export { createGitignoreFilter } from './source/gitignore-filter.js';
export { parseSymbol, shortenSymbol, leafName } from './symbols/symbol-parser.js';
export { reindex, detectLanguages, augmentAuxiliaryDocuments, augmentVueResolvedReferences, getIndexerConfig, INDEXER_CONFIGS, mergeScipFiles, mergeScipIndexes, isBinaryAvailable, isIndexerInstalled, tryInstallIndexer, tryInstallScipCli } from './reindex/index.js';
export { loadProjectConfig, resolveIndexPaths, resolveCacheDir, initProjectConfig } from './runtime/config.js';
export { Watcher } from './runtime/watch.js';
export { installSkills } from './runtime/setup.js';
export { isScipInstalled, getScipVersion, printScipInstallInstructions } from './runtime/scip-cli.js';
export * from './queries/index.js';
export type * from './domain/types.js';
