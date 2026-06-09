import type { ScipDatabase } from '../../storage/db.js';
import { clearRegisteredCaches } from '../../storage/cache-registry.js';

/**
 * Evidence-cache invalidation choke points. Membership is declared by each
 * cache at creation (see storage/cache-registry.ts) — this module only names
 * the two invalidation moments composite analyses care about.
 */

/**
 * Whole-project evidence invalidation used by composite analyses after a phase
 * has consumed parser, source, semantic, and symbol evidence caches.
 */
export function clearWholeProjectEvidenceCaches(
  db: ScipDatabase,
  opts: { semanticProvider?: boolean } = {},
): void {
  clearRegisteredCaches(db, {
    groups: opts.semanticProvider === true
      ? ['whole-project', 'semantic-provider']
      : ['whole-project'],
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
  clearRegisteredCaches(db, {
    groups: opts.definitions === true
      ? ['source-file', 'definition-catalog']
      : ['source-file'],
    file: relativePath.replace(/\\/g, '/'),
  });
}
