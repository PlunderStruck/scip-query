import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { classifyFile } from '../../analysis/file-classifier.js';
import { getCoChangePairs, getCommitHistory } from '../../analysis/git-history.js';
import { buildFileDepGraph } from '../../symbols/file-dep-graph.js';

export interface CoChangeFinding {
  fileA: string;
  fileB: string;
  /** Commits in the analyzed window where both files changed. */
  together: number;
  /** max(P(B|A), P(A|B)) over the analyzed window. */
  confidence: number;
  changesA: number;
  changesB: number;
  /** True when a dependency edge or declared coupling already explains the pair. */
  structurallyLinked: boolean;
}

export interface CoChangeResult {
  /** False when git history is unavailable (not a repo, git missing). */
  available: boolean;
  commitsAnalyzed: number;
  findings: CoChangeFinding[];
}

// Changelogs co-change with everything BY POLICY — intentional coupling,
// not a hidden concept (same class as tests and same-stem siblings).
export function isCoChangeNoiseFile(file: string): boolean {
  return NOISE_FILE_PATTERN.test(file);
}

const NOISE_FILE_PATTERN = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|CHANGELOG(?:\.[a-z]+)?|.*\.map)$|(?:^|\/)(?:dist|build|out|node_modules|docs\/plans)\//i;

/**
 * Hidden coupling from the change graph: file pairs that repeatedly change
 * in the same commits but have no structural link between them.
 *
 * The reference graph cannot see that two mechanisms implement one concept —
 * a config list and the test that checks it share no symbols. The commit
 * history can: if editing one reliably means editing the other, a maintainer
 * who edits only one is probably introducing drift. With a `file` argument,
 * reports that file's co-change partners instead (including structurally
 * linked ones — exploration mode).
 */
export function coChange(
  db: ScipDatabase,
  file?: string,
  opts: {
    minTogether?: number;
    minConfidence?: number;
    limit?: number;
    includeLinked?: boolean;
    maxFilesPerCommit?: number;
  } = {},
): CoChangeResult {
  const { minTogether = 4, minConfidence = 0.6, limit = 30, maxFilesPerCommit = 20 } = opts;
  const history = getCommitHistory(db);
  const partnersMode = file !== undefined;
  const pairs = getCoChangePairs(db, {
    minTogether: partnersMode ? Math.min(minTogether, 2) : minTogether,
    minConfidence: partnersMode ? 0 : minConfidence,
    maxFilesPerCommit,
  });
  if (!history || !pairs) return { available: false, commitsAnalyzed: 0, findings: [] };

  const graph = buildFileDepGraph(db);
  const declaredCouplings = declaredCouplingSets(db);
  const includeLinked = opts.includeLinked === true || partnersMode;

  const findings: CoChangeFinding[] = [];
  for (const pair of pairs) {
    if (NOISE_FILE_PATTERN.test(pair.fileA) || NOISE_FILE_PATTERN.test(pair.fileB)) continue;
    // History contains files that were since moved or deleted — a pair is
    // only actionable when both sides still exist.
    if (!fileStillExists(db, pair.fileA) || !fileStillExists(db, pair.fileB)) continue;
    if (partnersMode && !pair.fileA.includes(file) && !pair.fileB.includes(file)) continue;
    if (!partnersMode) {
      // Tests co-changing with their subject is expected (and healthy) —
      // the hidden-coupling detector targets production/config/doc pairs.
      if (classifyFile(pair.fileA) === 'test' || classifyFile(pair.fileB) === 'test') continue;
      // Same-stem siblings (Component.vue / .script.ts / .css) are one unit
      // split across files — expected coupling, not a hidden concept.
      if (isSameStemSibling(pair.fileA, pair.fileB)) continue;
    }
    const structurallyLinked = hasStructuralLink(graph, declaredCouplings, pair.fileA, pair.fileB);
    if (!includeLinked && structurallyLinked) continue;
    findings.push({ ...pair, structurallyLinked });
    if (findings.length >= limit) break;
  }

  return {
    available: true,
    commitsAnalyzed: history.commits.length,
    findings,
  };
}

function fileStillExists(db: ScipDatabase, relativePath: string): boolean {
  return existsSync(join(db.config.projectRoot, relativePath));
}

function isSameStemSibling(fileA: string, fileB: string): boolean {
  const lastSlashA = fileA.lastIndexOf('/');
  const lastSlashB = fileB.lastIndexOf('/');
  if (fileA.slice(0, lastSlashA) !== fileB.slice(0, lastSlashB)) return false;
  const stemA = fileA.slice(lastSlashA + 1).split('.')[0];
  const stemB = fileB.slice(lastSlashB + 1).split('.')[0];
  return stemA !== '' && stemA === stemB;
}

function declaredCouplingSets(db: ScipDatabase): Array<ReadonlySet<string>> {
  return (db.config.declaredCouplings ?? [])
    .filter((coupling) => Array.isArray(coupling.files) && coupling.files.length >= 2)
    .map((coupling) => new Set(coupling.files));
}

function hasStructuralLink(
  graph: Map<string, Set<string>>,
  declaredCouplings: readonly ReadonlySet<string>[],
  fileA: string,
  fileB: string,
): boolean {
  if (graph.get(fileA)?.has(fileB) === true || graph.get(fileB)?.has(fileA) === true) {
    return true;
  }
  return declaredCouplings.some((group) => group.has(fileA) && group.has(fileB));
}
