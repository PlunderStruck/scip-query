// scip-query — Language-agnostic code intelligence powered by SCIP indexes

export { ScipDatabase } from './storage/db.js';
export { ProjectIndex } from './core/project-index.js';
export { createGitignoreFilter } from './source/gitignore-filter.js';
export { parseSymbol, shortenSymbol, leafName } from './symbols/symbol-parser.js';
export type { ScipQueryConfig } from './domain/types.js';
