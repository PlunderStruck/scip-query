import type { ScipDatabase } from '../storage/db.js';
import { getFileAddRecords } from '../analysis/git-history.js';
import { similarAll } from './similar.js';

export interface RecentDuplicateFinding {
  /** 'echo': recent code duplicating established code. 'twin': both sides are new. */
  kind: 'echo' | 'twin';
  echoSymbol: string;
  echoFile: string;
  /** Commits ago the echo's file was added. */
  echoAgeCommits: number;
  establishedSymbol: string;
  establishedFile: string;
  /** Commits ago the established file was added; null = older than the window. */
  establishedAgeCommits: number | null;
  similarity: number;
  sharedCallees: string[];
}

export interface RecentDuplicatesResult {
  /** False when git history is unavailable. */
  available: boolean;
  windowCommits: number;
  findings: RecentDuplicateFinding[];
}

/**
 * Recent re-implementations: AI agents (and humans in a hurry) write new
 * helpers that duplicate code they didn't know existed. Generic similarity
 * finds the pairs; this makes them DIRECTIONAL using git file ages — which
 * side is the established original, which is the recent echo.
 *
 * 'echo'  → the new code should probably use or extend the established code;
 *           delete the echo.
 * 'twin'  → both sides landed recently (often one agent session duplicating
 *           itself); pick one and consolidate before they diverge.
 *
 * Pairs where both sides are established are ordinary `similar` territory
 * and are skipped here.
 */
export function recentDuplicates(
  db: ScipDatabase,
  opts: {
    windowCommits?: number;
    minSimilarity?: number;
    limit?: number;
    scope?: string;
    scanLimit?: number;
    semantic?: boolean;
  } = {},
): RecentDuplicatesResult {
  const { windowCommits = 100, minSimilarity = 0.7, limit = 30, scope, scanLimit } = opts;
  const adds = getFileAddRecords(db);
  if (!adds) return { available: false, windowCommits, findings: [] };

  const pairs = similarAll(db, {
    scope,
    minSimilarity,
    limit: limit * 5,
    crossFileOnly: true,
    scanLimit,
    semantic: opts.semantic,
  });

  const findings: RecentDuplicateFinding[] = [];
  for (const pair of pairs) {
    const ageA = adds.get(pair.fileA)?.commitsAgo ?? null;
    const ageB = adds.get(pair.fileB)?.commitsAgo ?? null;
    const newA = ageA !== null && ageA <= windowCommits;
    const newB = ageB !== null && ageB <= windowCommits;
    if (!newA && !newB) continue; // both established — ordinary `similar` territory

    if (newA && newB) {
      // Twin: orient by recency so output is stable (newer file = echo).
      const aIsEcho = (ageA ?? 0) <= (ageB ?? 0);
      findings.push({
        kind: 'twin',
        echoSymbol: aIsEcho ? pair.shortNameA : pair.shortNameB,
        echoFile: aIsEcho ? pair.fileA : pair.fileB,
        echoAgeCommits: (aIsEcho ? ageA : ageB) ?? 0,
        establishedSymbol: aIsEcho ? pair.shortNameB : pair.shortNameA,
        establishedFile: aIsEcho ? pair.fileB : pair.fileA,
        establishedAgeCommits: aIsEcho ? ageB : ageA,
        similarity: pair.similarity,
        sharedCallees: pair.sharedCallees,
      });
    } else {
      findings.push({
        kind: 'echo',
        echoSymbol: newA ? pair.shortNameA : pair.shortNameB,
        echoFile: newA ? pair.fileA : pair.fileB,
        echoAgeCommits: (newA ? ageA : ageB) ?? 0,
        establishedSymbol: newA ? pair.shortNameB : pair.shortNameA,
        establishedFile: newA ? pair.fileB : pair.fileA,
        establishedAgeCommits: newA ? ageB : ageA,
        similarity: pair.similarity,
        sharedCallees: pair.sharedCallees,
      });
    }
    if (findings.length >= limit) break;
  }

  // Echoes first (clear directionality), then by similarity.
  findings.sort((left, right) =>
    (left.kind === right.kind ? 0 : left.kind === 'echo' ? -1 : 1)
    || right.similarity - left.similarity);
  return { available: true, windowCommits, findings };
}
