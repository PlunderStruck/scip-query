import type { ScipDatabase } from '../../storage/db.js';
import { clearLanguageParserCaches, clearLanguageParserCachesForFile } from '../../language-parsers/index.js';
import { clearSemanticProviderCache } from '../../semantic/index.js';
import { clearAstCache, clearAstCacheForFile } from '../../source/ast.js';
import { clearSourceStripperCache, clearSourceStripperCacheForFile } from '../../source/source-stripper.js';
import { clearSourceTextCache, clearSourceTextCacheForFile } from '../../source/source-text.js';
import { clearDefinitionCacheForFile } from '../../symbols/definition-catalog.js';
import { clearIdentifierIndexCache, clearIdentifierIndexCacheForFile } from '../../symbols/identifier-index.js';
import { clearSymbolEvidenceCaches } from '../../symbols/symbol-evidence-cache.js';

export type EvidenceCacheKind =
  | 'symbol-evidence'
  | 'semantic-provider'
  | 'identifier-index'
  | 'language-parser'
  | 'source-stripper'
  | 'ast-tree'
  | 'source-text'
  | 'definition-catalog';

export type CacheInvalidationScope =
  | { kind: 'database' }
  | { kind: 'file'; relativePath: string };

interface CacheRegistryEntry {
  kind: EvidenceCacheKind;
  clearDatabase?: (db: ScipDatabase) => void;
  clearFile?: (db: ScipDatabase, relativePath: string) => void;
}

const CACHE_REGISTRY: readonly CacheRegistryEntry[] = [
  { kind: 'symbol-evidence', clearDatabase: clearSymbolEvidenceCaches },
  { kind: 'semantic-provider', clearDatabase: clearSemanticProviderCache },
  {
    kind: 'identifier-index',
    clearDatabase: clearIdentifierIndexCache,
    clearFile: clearIdentifierIndexCacheForFile,
  },
  {
    kind: 'language-parser',
    clearDatabase: clearLanguageParserCaches,
    clearFile: clearLanguageParserCachesForFile,
  },
  {
    kind: 'source-stripper',
    clearDatabase: clearSourceStripperCache,
    clearFile: clearSourceStripperCacheForFile,
  },
  { kind: 'ast-tree', clearDatabase: clearAstCache, clearFile: clearAstCacheForFile },
  { kind: 'source-text', clearDatabase: clearSourceTextCache, clearFile: clearSourceTextCacheForFile },
  { kind: 'definition-catalog', clearFile: clearDefinitionCacheForFile },
];

const WHOLE_PROJECT_CACHE_KINDS: readonly EvidenceCacheKind[] = [
  'symbol-evidence',
  'identifier-index',
  'language-parser',
  'source-stripper',
  'ast-tree',
  'source-text',
];

const SOURCE_FILE_CACHE_KINDS: readonly EvidenceCacheKind[] = [
  'identifier-index',
  'language-parser',
  'source-stripper',
  'ast-tree',
  'source-text',
];

export function clearEvidenceCaches(
  db: ScipDatabase,
  opts: {
    scope: CacheInvalidationScope;
    kinds: readonly EvidenceCacheKind[];
  },
): void {
  const requested = new Set(opts.kinds);
  for (const entry of CACHE_REGISTRY) {
    if (!requested.has(entry.kind)) continue;
    if (opts.scope.kind === 'database') {
      entry.clearDatabase?.(db);
    } else {
      entry.clearFile?.(db, normalizeCachePath(opts.scope.relativePath));
    }
  }
}

/**
 * Whole-project evidence invalidation used by composite analyses after a phase
 * has consumed parser, source, semantic, and symbol evidence caches.
 */
export function clearWholeProjectEvidenceCaches(
  db: ScipDatabase,
  opts: { semanticProvider?: boolean } = {},
): void {
  clearEvidenceCaches(db, {
    scope: { kind: 'database' },
    kinds: opts.semanticProvider === true
      ? [...WHOLE_PROJECT_CACHE_KINDS, 'semantic-provider']
      : WHOLE_PROJECT_CACHE_KINDS,
  });
}

/**
 * File-scoped evidence invalidation used by source-backed scans after reading
 * a candidate file whose cached source, AST, parser, or identifier facts can be
 * safely discarded.
 */
export function clearSourceFileEvidenceCaches(
  db: ScipDatabase,
  relativePath: string,
  opts: { definitions?: boolean } = {},
): void {
  clearEvidenceCaches(db, {
    scope: { kind: 'file', relativePath },
    kinds: opts.definitions === true
      ? [...SOURCE_FILE_CACHE_KINDS, 'definition-catalog']
      : SOURCE_FILE_CACHE_KINDS,
  });
}

function normalizeCachePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

