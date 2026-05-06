// scip-query — Language-agnostic code intelligence powered by SCIP indexes

export { ScipDatabase } from './db.js';
export { createGitignoreFilter } from './gitignore-filter.js';
export { parseSymbol, shortenSymbol, leafName } from './symbol-parser.js';
export { reindex, detectLanguages, augmentAuxiliaryDocuments, augmentVueResolvedReferences, getIndexerConfig, INDEXER_CONFIGS, mergeScipFiles, mergeScipIndexes, isBinaryAvailable, isIndexerInstalled, tryInstallIndexer, tryInstallScipCli } from './reindex/index.js';
export { loadProjectConfig, resolveIndexPaths, resolveCacheDir, initProjectConfig } from './config.js';
export { Watcher } from './watch.js';
export { installSkills } from './setup.js';
export { isScipInstalled, getScipVersion, printScipInstallInstructions } from './scip-cli.js';
export * from './queries/index.js';
export type * from './types.js';
