/**
 * Source-file reader with a per-database cache. Tiny module, but the cache
 * itself is hot — every per-language parser, every source-text-driven
 * query (refs/dataflow/trace), and the AST runtime all read source
 * through here so we pay the disk cost once per file per process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbCache } from '../storage/per-db-cache.js';

const SOURCE_TEXT_CACHE = createPerDbCache<string, string>('source-text', {
  clearGroups: ['whole-project', 'source-file'],
});

export function getSourceText(
  db: ScipDatabase,
  relativePath: string,
): string {
  const normalized = relativePath.replace(/\\/g, '/');
  return SOURCE_TEXT_CACHE.get(db, normalized, () => {
    const fullPath = join(db.config.projectRoot, normalized);
    if (!existsSync(fullPath)) return '';
    return readFileSync(fullPath, 'utf-8');
  });
}

const SUPPRESS_COMMENT_RE = /scip-query[\s:-]*ignore[\s:-]*(?:dead(?:-code)?|stale|wrapper|passthrough|drift|extract)?/i;

/**
 * True when a `// scip-query: ignore-...` (or similar) comment appears on
 * the line immediately preceding `startLine` (0-indexed). Used by the
 * health-suite heuristics to let users opt out of false positives without
 * touching the detector.
 */
export function hasSuppressionComment(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
): boolean {
  if (startLine <= 0) return false;
  const source = getSourceText(db, relativePath);
  if (!source) return false;
  const lines = source.split('\n');
  // Walk upward through contiguous comment / blank / decorator lines so a
  // suppression comment placed two lines above (with a JSDoc in between, etc.)
  // still counts.
  for (let i = startLine - 1; i >= 0 && i >= startLine - 5; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    if (SUPPRESS_COMMENT_RE.test(line)) return true;
    // Stop scanning once we hit a non-comment, non-decorator line.
    if (!line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*') && !line.startsWith('@') && !line.startsWith('#')) {
      return false;
    }
  }
  return false;
}
