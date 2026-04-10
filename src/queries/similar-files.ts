import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph } from '../query-support.js';
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
    if (count / fileCount > 0.5) {
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
