/**
 * Suppression inventory — the detectors' feedback loop.
 *
 * Every `scip-query: ignore-<category>` comment is a ground-truth label a
 * user attached to a finding: "this was wrong, or accepted by design."
 * Reporting suppressed counts beside active counts turns detector precision
 * from a guess into a measured signal.
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
  clearGroups: ['whole-project'],
});

export function getSuppressionInventory(db: ScipDatabase): SuppressionInventory {
  return inventoryCache.get(db, () => scanSuppressions(db));
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
    for (const line of source.split(/\r?\n/)) {
      const rawCategory = suppressionCommentCategory(line);
      if (rawCategory === null) continue;
      total += 1;
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
      const category = normalizeCategory(rawCategory);
      byCategory[category] += 1;
    }
  }

  for (const suppression of db.config.suppressions ?? []) {
    if (suppression.expiresAt && Date.parse(suppression.expiresAt) <= Date.now()) continue;
    total += 1;
    if (suppression.file) byFile.set(suppression.file, (byFile.get(suppression.file) ?? 0) + 1);
    byCategory[normalizeCategory(suppression.check)] += 1;
  }

  return { total, byCategory, byFile };
}

function normalizeCategory(raw: string | undefined | null): SuppressionCategory {
  if (!raw) return 'uncategorized';
  const lower = raw.toLowerCase();
  if (lower === 'dead-code' || lower === 'new-dead') return 'dead';
  if (lower.includes('twin')) return 'twin';
  if (lower.includes('similar') || lower.includes('duplicate')) return 'similar';
  if (lower.includes('wrapper')) return 'wrapper';
  if (lower.includes('passthrough')) return 'passthrough';
  if (lower.includes('drift')) return 'drift';
  if (lower.includes('extract')) return 'extract';
  if (lower.includes('stale')) return 'stale';
  return 'uncategorized';
}
