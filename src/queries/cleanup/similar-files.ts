import type { ScipDatabase } from '../../storage/db.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';
import { jaccard } from '../../analysis/similarity.js';
import {
  pairwiseCandidateIndexFromKeys,
  rankedPairwiseProfileResults,
  type PairwiseFileProfile,
} from '../internal/pairwise-profiles.js';

export interface SimilarFileResult {
  fileA: string;
  fileB: string;
  /** Jaccard similarity after excluding dependencies imported by >=5 files and >30% of the repository. */
  similarity: number;
  /** Candidate relationship based on filtered dependency sets, not behavioral equivalence. */
  evidenceBasis: 'filtered-dependency-overlap';
  sharedDeps: string[];
  uniqueToA: string[];
  uniqueToB: string[];
}

/**
 * Find files with similar dependency profiles.
 *
 * Compares observed dependency sets after removing globally common dependencies.
 * A result identifies shared structural dependencies; it does not establish
 * duplicated behavior, a common conceptual owner, or safe consolidation.
 * At least two low-popularity dependencies must be shared (one when minDeps=1).
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
  const minDeps = opts.minDeps ?? (filePattern ? 1 : 4);

  // Build dependency profile for each file
  const { profiles, distinctiveDeps } = buildFileProfiles(db, { scope, minDeps });
  const candidateIndex = pairwiseCandidateIndexFromKeys(profiles, (profile) => profile.deps);

  return rankedPairwiseProfileResults({
    profiles,
    limit,
    filePattern,
    overrunFactor: 5,
    candidateIndex,
    profile: { name: 'similar-files' },
    compare: (a, b) => compareFileProfiles(a, b, minSimilarity, distinctiveDeps, minDeps),
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
  const depMap = buildFileDepGraph(db);
  const { universalDeps, distinctiveDeps } = classifyDependencyPopularity(depMap);

  // Filter to files with enough deps
  const profiles: FileProfile[] = [];
  for (const [file, deps] of depMap) {
    if (scope && !file.includes(scope)) continue;
    const filtered = new Set([...deps].filter((dep) => !universalDeps.has(dep)));
    if (filtered.size >= minDeps) {
      profiles.push({
        file,
        deps: filtered,
      });
    }
  }

  return { profiles, distinctiveDeps };
}

function classifyDependencyPopularity(depMap: Map<string, Set<string>>): {
  universalDeps: Set<string>;
  distinctiveDeps: Set<string>;
} {
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

function compareFileProfiles(
  a: FileProfile,
  b: FileProfile,
  minSimilarity: number,
  distinctiveDeps: ReadonlySet<string>,
  minDeps: number,
): SimilarFileResult | null {
  const shared = new Set<string>();
  for (const dep of a.deps) {
    if (b.deps.has(dep)) shared.add(dep);
  }

  // The explicit minimum controls comparison size as well as candidate selection.
  if (shared.size < Math.min(3, minDeps)) return null;

  let distinctiveShared = 0;
  for (const dep of shared) {
    if (distinctiveDeps.has(dep)) distinctiveShared++;
  }
  if (distinctiveShared < Math.min(2, minDeps)) return null;

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
    evidenceBasis: 'filtered-dependency-overlap',
    sharedDeps: [...shared],
    uniqueToA: uniqueA,
    uniqueToB: uniqueB,
  };
}
