/**
 * Inventory of source directives and unexpired configuration records.
 * Entries record review decisions, including accepted design tradeoffs.
 * They are not matched-finding counts or measurements of detector precision:
 * an annotation may outlive its target or never match a current detector.
 */
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbValue } from '../storage/per-db-cache.js';
import { getSourceFiles } from '../source/primitives/source-fileset.js';
import { getSourceText, suppressionCommentCategory } from '../source/primitives/source-text.js';

export type SuppressionCategory =
  | 'dead'
  | 'stale'
  | 'wrapper'
  | 'passthrough'
  | 'drift'
  | 'extract'
  | 'similar'
  | 'twin'
  | 'uncategorized';

export interface SuppressionInventory {
  total: number;
  byCategory: Record<SuppressionCategory, number>;
  byFile: Map<string, number>;
}

// Derived from source text on disk — drops with the other source evidence.
const inventoryCache = createPerDbValue<SuppressionInventory>('suppression-inventory', {
  clearGroups: ['whole-project', 'source-file'],
});

export function getSuppressionInventory(db: ScipDatabase): SuppressionInventory {
  const source = inventoryCache.get(db, () => scanSuppressions(db));
  const inventory = { total: source.total, byCategory: { ...source.byCategory }, byFile: new Map(source.byFile) };
  const nowMs = Date.now();
  // Configuration and wall-clock expiry can change without source invalidation.
  for (const suppression of db.config.suppressions ?? []) {
    if (suppression.expiresAt && Date.parse(suppression.expiresAt) <= nowMs) continue;
    inventory.total += 1;
    if (suppression.file) inventory.byFile.set(suppression.file, (inventory.byFile.get(suppression.file) ?? 0) + 1);
    inventory.byCategory[normalizeCategory(suppression.check)] += 1;
  }
  return inventory;
}

function scanSuppressions(db: ScipDatabase): SuppressionInventory {
  const byCategory: Record<SuppressionCategory, number> = {
    dead: 0,
    stale: 0,
    wrapper: 0,
    passthrough: 0,
    drift: 0,
    extract: 0,
    similar: 0,
    twin: 0,
    uncategorized: 0,
  };
  const byFile = new Map<string, number>();
  let total = 0;

  for (const file of getSourceFiles(db)) {
    const source = getSourceText(db, file);
    if (!source || !source.includes('scip-query')) continue;
    total += countSourceSuppressions(source, file, byCategory, byFile);
  }

  return { total, byCategory, byFile };
}

function countSourceSuppressions(
  source: string,
  file: string,
  byCategory: SuppressionInventory['byCategory'],
  byFile: Map<string, number>,
): number {
  let total = 0;
  for (const line of source.split(/\r?\n/)) {
    const rawCategory = suppressionCommentCategory(line);
    if (rawCategory === null) continue;
    total += 1;
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
    const category = normalizeCategory(rawCategory);
    byCategory[category] += 1;
  }
  return total;
}

const SOURCE_SUPPRESSION_CATEGORIES = [
  'dead',
  'stale',
  'wrapper',
  'passthrough',
  'drift',
  'extract',
  'similar',
  'twin',
] as const;
const CHECK_CATEGORIES = new Map<string, SuppressionCategory>([
  ['dead-code', 'dead'],
  ['new-dead', 'dead'],
  ['twin-drift', 'twin'],
  ['similar-files', 'similar'],
  ['similar-signatures', 'similar'],
  ['recent-duplicates', 'similar'],
  ['duplicate-bodies', 'similar'],
  ['duplication', 'similar'],
  ['passthrough-candidates', 'passthrough'],
  ['slice-cohesion', 'extract'],
]);

function normalizeCategory(raw: string | undefined | null): SuppressionCategory {
  const lower = raw?.toLowerCase() ?? '';
  return (
    SOURCE_SUPPRESSION_CATEGORIES.find((category) => category === lower) ??
    CHECK_CATEGORIES.get(lower) ??
    'uncategorized'
  );
}
