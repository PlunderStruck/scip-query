import type { ScipDatabase } from '../db.js';
import type { SimilarFileResult } from '../types.js';

/**
 * Find files with similar dependency profiles.
 *
 * Two files that depend on (import from) the same set of other files
 * are structurally doing similar work. High Jaccard similarity between
 * their dependency sets = likely copy-paste variants or consolidation candidates.
 */
export function similarFiles(
  db: ScipDatabase,
  opts: {
    minSimilarity?: number;
    limit?: number;
    scope?: string;
    minDeps?: number;
    filePattern?: string;
  } = {},
): SimilarFileResult[] {
  const { minSimilarity = 0.5, limit = 20, scope, minDeps = 3, filePattern } = opts;

  // Build dependency profile for each file
  const profiles = buildFileProfiles(db, { scope, minDeps });

  const results: SimilarFileResult[] = [];

  if (filePattern) {
    // Compare one file against all others
    const target = profiles.find((p) => p.file.includes(filePattern));
    if (!target) return [];

    for (const candidate of profiles) {
      if (candidate.file === target.file) continue;
      const result = compareProfiles(target, candidate, minSimilarity);
      if (result) results.push(result);
    }
  } else {
    // Pairwise comparison across all files
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const result = compareProfiles(profiles[i]!, profiles[j]!, minSimilarity);
        if (result) results.push(result);
      }
      if (results.length > limit * 5) break;
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

// ── Internal ───────────────────────────────────────────────

interface FileProfile {
  file: string;
  deps: Set<string>;
}

function buildFileProfiles(
  db: ScipDatabase,
  opts: { scope?: string; minDeps: number },
): FileProfile[] {
  const { scope, minDeps } = opts;
  const scopeFilter = scope ? `AND d1.relative_path LIKE '%${scope}%'` : '';

  // Get all file dependency edges
  const edges = db.all<{ from_file: string; to_file: string }>(
    `SELECT DISTINCT
      d1.relative_path AS from_file,
      d2.relative_path AS to_file
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d2 ON der.document_id = d2.id
    WHERE d1.id != d2.id
      AND m.role = 0
      AND d1.relative_path NOT LIKE 'node_modules/%'
      AND d2.relative_path NOT LIKE 'node_modules/%'
      ${scopeFilter}`,
  );

  // Group by source file
  const depMap = new Map<string, Set<string>>();
  for (const e of edges) {
    if (db.isIgnored(e.from_file) || db.isIgnored(e.to_file)) continue;
    if (!depMap.has(e.from_file)) depMap.set(e.from_file, new Set());
    depMap.get(e.from_file)!.add(e.to_file);
  }

  // Filter to files with enough deps
  const profiles: FileProfile[] = [];
  for (const [file, deps] of depMap) {
    if (deps.size >= minDeps) {
      profiles.push({ file, deps });
    }
  }

  return profiles;
}

function compareProfiles(
  a: FileProfile,
  b: FileProfile,
  minSimilarity: number,
): SimilarFileResult | null {
  const shared = new Set<string>();
  for (const dep of a.deps) {
    if (b.deps.has(dep)) shared.add(dep);
  }

  if (shared.size === 0) return null;

  const unionSize = new Set([...a.deps, ...b.deps]).size;
  const similarity = shared.size / unionSize;

  if (similarity < minSimilarity) return null;

  const uniqueA: string[] = [];
  for (const dep of a.deps) {
    if (!b.deps.has(dep)) uniqueA.push(dep);
  }
  const uniqueB: string[] = [];
  for (const dep of b.deps) {
    if (!a.deps.has(dep)) uniqueB.push(dep);
  }

  return {
    fileA: a.file,
    fileB: b.file,
    similarity,
    sharedDeps: [...shared],
    uniqueToA: uniqueA,
    uniqueToB: uniqueB,
  };
}
