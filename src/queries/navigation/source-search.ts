import type { ScipDatabase } from '../../storage/db.js';
import { searchSourceBatch } from './source-search-batch.js';
import type { SourceSearchOptions, SourceSearchResult } from './source-search-types.js';

export type {
  SourceObservationFreshness,
  SourceSemanticFreshnessState,
} from '../../source/primitives/repository-text.js';
export type {
  SourceSearchFileCoverage,
  SourceSearchIdentity,
  SourceSearchIdentityCoverage,
  SourceSearchMatch,
  SourceSearchOptions,
  SourceSearchResult,
  SourceSearchScopeHint,
  SourceSearchTextCoverage,
} from './source-search-types.js';

/** Search the source of indexed documents and retain line and symbol ownership. */
export function searchSource(db: ScipDatabase, pattern: string, opts: SourceSearchOptions = {}): SourceSearchResult {
  if (pattern.length === 0) throw new Error('The source search pattern must not be empty.');
  return searchSourceBatch(db, [pattern], opts)[0]!;
}
