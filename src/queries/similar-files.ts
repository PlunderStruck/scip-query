import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph } from '../reference-graph.js';
import { jaccard } from '../similarity.js';
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
  const { minSimilarity = 0.5, limit = 20, scope, filePattern } = opts;
  const minDeps = opts.minDeps ?? (filePattern ? 1 : 3);

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
  const depMap = buildFileDepGraph(db, scope);
  const universalDeps = findUniversalDependencies(depMap);

  // Filter to files with enough deps
  const profiles: FileProfile[] = [];
  for (const [file, deps] of depMap) {
    if (deps.size >= minDeps) {
      profiles.push({
        file,
        deps: new Set([...deps].filter((dep) => !universalDeps.has(dep))),
      });
    }
  }

  return profiles;
}

function findUniversalDependencies(
  depMap: Map<string, Set<string>>,
): Set<string> {
  const universalDeps = new Set<string>();
  const fileCount = depMap.size;
  if (fileCount === 0) return universalDeps;

  const depCounts = new Map<string, number>();
  for (const deps of depMap.values()) {
    for (const dep of deps) {
      depCounts.set(dep, (depCounts.get(dep) ?? 0) + 1);
    }
  }

  for (const [dep, count] of depCounts) {
    // Treat any dep imported by more than 30% of files as "infrastructure"
    // and exclude from similarity scoring. The previous 80% threshold was
    // too high — query-support, db, and symbol-parser are imported by
    // ~70% of scip-query's files but they're shared because everything
    // needs them, not because the importers are similar to each other.
    if (count >= 5 && count / fileCount > 0.3) {
      universalDeps.add(dep);
    }
  }

  return universalDeps;
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

  // Require at least 3 substantive shared deps and at least 4 deps on each
  // side. Smaller dep sets give misleadingly high Jaccard scores — a file
  // with 2 deps shared with another file with 2 deps reads as 100% similar
  // even though neither file has enough structural surface to compare.
  if (shared.size < 3) return null;
  if (a.deps.size < 4 || b.deps.size < 4) return null;

  const similarity = jaccard(a.deps, b.deps);

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
