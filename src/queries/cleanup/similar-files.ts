import type { ScipDatabase } from '../../storage/db.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';
import { jaccard } from '../../analysis/similarity.js';
import { rankedPairwiseProfileResults, type PairwiseFileProfile } from '../internal/pairwise-profiles.js';

export interface SimilarFileResult {
  fileA: string;
  fileB: string;
  /** Jaccard similarity of dependency sets (0-1) */
  similarity: number;
  sharedDeps: string[];
  uniqueToA: string[];
  uniqueToB: string[];
}

/**
 * Find files with similar dependency profiles.
 *
 * Two files that depend on (import from) the same set of other files
 * are structurally doing similar work. High Jaccard similarity between
 * their dependency sets = likely copy-paste variants or consolidation candidates.
 *
 * Evidence policy: a pair must share at least two *distinctive* deps —
 * deps with low global fan-in. Files that overlap only on family
 * infrastructure (the modules everyone in their directory imports) are
 * not copy-paste variants; adapter families sharing an SDK scored 100%
 * before this gate while differing in everything that matters.
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
  const { profiles, distinctiveDeps } = buildFileProfiles(db, { scope, minDeps });

  return rankedPairwiseProfileResults({
    profiles,
    limit,
    filePattern,
    overrunFactor: 5,
    compare: (a, b) => compareProfiles(a, b, minSimilarity, distinctiveDeps),
  });
}

// ── Internal ───────────────────────────────────────────────

interface FileProfile extends PairwiseFileProfile {
  file: string;
  deps: Set<string>;
}

function buildFileProfiles(
  db: ScipDatabase,
  opts: { scope?: string; minDeps: number },
): { profiles: FileProfile[]; distinctiveDeps: Set<string> } {
  const { scope, minDeps } = opts;
  const depMap = buildFileDepGraph(db, scope);
  const { universalDeps, distinctiveDeps } = classifyDependencyPopularity(depMap);

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

  return { profiles, distinctiveDeps };
}

function classifyDependencyPopularity(
  depMap: Map<string, Set<string>>,
): { universalDeps: Set<string>; distinctiveDeps: Set<string> } {
  const universalDeps = new Set<string>();
  const distinctiveDeps = new Set<string>();
  const fileCount = depMap.size;
  if (fileCount === 0) return { universalDeps, distinctiveDeps };

  const depCounts = new Map<string, number>();
  for (const deps of depMap.values()) {
    for (const dep of deps) {
      depCounts.set(dep, (depCounts.get(dep) ?? 0) + 1);
    }
  }

  // A dep is *distinctive* when few files import it — sharing one is real
  // evidence the two importers do related work. Scale with project size but
  // never below 3 importers.
  const distinctiveMax = Math.max(3, Math.ceil(fileCount * 0.03));

  for (const [dep, count] of depCounts) {
    // Treat any dep imported by more than 30% of files as "infrastructure"
    // and exclude from similarity scoring. The previous 80% threshold was
    // too high — query-support, db, and symbol-parser are imported by
    // ~70% of scip-query's files but they're shared because everything
    // needs them, not because the importers are similar to each other.
    if (count >= 5 && count / fileCount > 0.3) {
      universalDeps.add(dep);
    } else if (count <= distinctiveMax) {
      distinctiveDeps.add(dep);
    }
  }

  return { universalDeps, distinctiveDeps };
}

function compareProfiles(
  a: FileProfile,
  b: FileProfile,
  minSimilarity: number,
  distinctiveDeps: ReadonlySet<string>,
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

  // Distinctive-evidence gate: overlap made only of mid-popularity family
  // infrastructure (every adapter imports the same SDK modules) is not
  // copy-paste evidence. Require at least two low-fan-in shared deps.
  let distinctiveShared = 0;
  for (const dep of shared) {
    if (distinctiveDeps.has(dep)) distinctiveShared++;
  }
  if (distinctiveShared < 2) return null;

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
