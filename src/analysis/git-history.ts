/**
 * Git history evidence — the ground-truth data source the reference graph
 * lacks. Two files that share no symbols can still implement one concept;
 * the change graph (which files change together, how often, in fix commits)
 * sees that where SCIP cannot.
 *
 * All readers degrade gracefully: when git is unavailable or the project is
 * not a repository, they return null and consumers report the axis as
 * unavailable instead of guessing.
 */
import { execFileSync } from 'node:child_process';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbValue } from '../storage/per-db-cache.js';

export interface CommitRecord {
  hash: string;
  timestamp: number;
  subject: string;
  files: string[];
}

export interface CommitHistory {
  head: string;
  commits: CommitRecord[];
  /** Commits skipped as bulk operations (touched more than the file cap). */
  skippedBulkCommits: number;
}

export interface FileChurn {
  changes: number;
  fixChanges: number;
  lastChangedAt: number;
}

export interface ChangeAmplification {
  medianFilesPerCommit: number;
  p90FilesPerCommit: number;
  commitsAnalyzed: number;
}

export interface CoChangePair {
  fileA: string;
  fileB: string;
  /** Commits where both files changed. */
  together: number;
  /** max(P(B|A), P(A|B)) — how reliably one drags the other along. */
  confidence: number;
  changesA: number;
  changesB: number;
}

const MAX_COMMITS = 2_000;
const BULK_COMMIT_FILE_CAP = 50;
const FIX_SUBJECT_PATTERN = /\b(?:fix(?:es|ed)?|bug|regression|hotfix)\b/i;

/**
 * The one lifecycle every git-derived value shares: cache per db, revalidate
 * against HEAD so long-lived processes (watch mode) recompute after commits,
 * return null when git is unavailable.
 */
function headKeyedGitValue<T>(name: string): (db: ScipDatabase, load: (projectRoot: string, head: string) => T | null) => T | null {
  const cache = createPerDbValue<{ head: string; value: T | null }>(name, { clearGroups: ['whole-project'] });
  return (db, load) => {
    const head = resolveHead(db.config.projectRoot);
    if (!head) return null;
    const cached = cache.has(db) ? cache.get(db, () => ({ head: '', value: null })) : null;
    if (cached && cached.head === head) return cached.value;
    cache.invalidate(db);
    return cache.get(db, () => ({ head, value: load(db.config.projectRoot, head) })).value;
  };
}

const commitHistoryCache = headKeyedGitValue<CommitHistory>('git-commit-history');

export function getCommitHistory(db: ScipDatabase): CommitHistory | null {
  return commitHistoryCache(db, loadCommitHistory);
}

function resolveHead(projectRoot: string): string | null {
  try {
    return runGit(projectRoot, ['rev-parse', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

function runGit(projectRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function loadCommitHistory(projectRoot: string, head: string): CommitHistory | null {
  let raw: string;
  try {
    raw = runGit(projectRoot, [
      'log',
      '--no-merges',
      '--name-only',
      `-n`, String(MAX_COMMITS),
      '--pretty=format:%x01%H%x00%ct%x00%s',
    ]);
  } catch {
    return null;
  }

  const commits: CommitRecord[] = [];
  let skippedBulkCommits = 0;
  for (const block of raw.split('\x01')) {
    if (block.trim() === '') continue;
    const newline = block.indexOf('\n');
    const header = newline >= 0 ? block.slice(0, newline) : block;
    const [hash, timestampRaw, subject] = header.split('\x00');
    if (!hash || !timestampRaw) continue;
    const files = newline >= 0
      ? block.slice(newline + 1).split('\n').map((line) => line.trim()).filter((line) => line !== '')
      : [];
    if (files.length > BULK_COMMIT_FILE_CAP) {
      skippedBulkCommits += 1;
      continue;
    }
    commits.push({
      hash,
      timestamp: Number(timestampRaw) || 0,
      subject: subject ?? '',
      files,
    });
  }

  return { head, commits, skippedBulkCommits };
}

// ── Derived facts ──────────────────────────────────────────────────

export function isFixCommit(commit: Pick<CommitRecord, 'subject'>): boolean {
  return FIX_SUBJECT_PATTERN.test(commit.subject);
}

export function getFileChurn(db: ScipDatabase): Map<string, FileChurn> | null {
  const history = getCommitHistory(db);
  if (!history) return null;
  const churn = new Map<string, FileChurn>();
  for (const commit of history.commits) {
    const fix = isFixCommit(commit);
    for (const file of commit.files) {
      const entry = churn.get(file) ?? { changes: 0, fixChanges: 0, lastChangedAt: 0 };
      entry.changes += 1;
      if (fix) entry.fixChanges += 1;
      if (commit.timestamp > entry.lastChangedAt) entry.lastChangedAt = commit.timestamp;
      churn.set(file, entry);
    }
  }
  return churn;
}

export function getChangeAmplification(db: ScipDatabase): ChangeAmplification | null {
  const history = getCommitHistory(db);
  if (!history || history.commits.length === 0) return null;
  const sizes = history.commits
    .map((commit) => commit.files.length)
    .filter((size) => size > 0)
    .sort((left, right) => left - right);
  if (sizes.length === 0) return null;
  return {
    medianFilesPerCommit: percentile(sizes, 0.5),
    p90FilesPerCommit: percentile(sizes, 0.9),
    commitsAnalyzed: sizes.length,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

const trackedFilesCache = headKeyedGitValue<Set<string>>('git-tracked-files');

/** All git-tracked files (including docs, configs — not just indexed sources). */
export function getTrackedFiles(db: ScipDatabase): Set<string> | null {
  return trackedFilesCache(db, (projectRoot) => {
    try {
      const raw = runGit(projectRoot, ['ls-files']);
      return new Set(raw.split('\n').map((line) => line.trim()).filter((line) => line !== ''));
    } catch {
      return null;
    }
  });
}

interface FileAddRecord {
  /** Commits ago (0 = newest) of the file's earliest known add in the window. */
  commitsAgo: number;
  addedAt: number;
}

const fileAddCache = headKeyedGitValue<Map<string, FileAddRecord>>('git-file-adds');

/**
 * When each file was first added, from `git log --diff-filter=A` over the
 * bounded window. Files older than the window are absent — callers should
 * treat absence as "established".
 */
export function getFileAddRecords(db: ScipDatabase): Map<string, FileAddRecord> | null {
  return fileAddCache(db, (projectRoot) => loadFileAddRecords(projectRoot));
}

function loadFileAddRecords(projectRoot: string): Map<string, FileAddRecord> | null {
  let raw: string;
  try {
    raw = runGit(projectRoot, [
      'log',
      '--no-merges',
      '--diff-filter=A',
      '--name-only',
      '-n', String(MAX_COMMITS),
      '--pretty=format:%x01%H%x00%ct%x00%s',
    ]);
  } catch {
    return null;
  }
  const adds = new Map<string, FileAddRecord>();
  let commitsAgo = -1;
  for (const block of raw.split('\x01')) {
    if (block.trim() === '') continue;
    commitsAgo += 1;
    const newline = block.indexOf('\n');
    const header = newline >= 0 ? block.slice(0, newline) : block;
    const [, timestampRaw] = header.split('\x00');
    const addedAt = Number(timestampRaw) || 0;
    if (newline < 0) continue;
    for (const line of block.slice(newline + 1).split('\n')) {
      const file = line.trim();
      if (file === '') continue;
      // Newest-first walk: keep the OLDEST add we see (re-adds overwrite).
      adds.set(file, { commitsAgo, addedAt });
    }
  }
  return adds;
}

/**
 * Pairwise co-change counts across the bounded history. Pair generation is
 * O(k²) per commit but k is capped at BULK_COMMIT_FILE_CAP.
 */
export function getCoChangePairs(
  db: ScipDatabase,
  opts: { minTogether?: number; minConfidence?: number; maxFilesPerCommit?: number } = {},
): CoChangePair[] | null {
  const {
    minTogether = 4,
    minConfidence = 0.6,
    maxFilesPerCommit = BULK_COMMIT_FILE_CAP,
  } = opts;
  const history = getCommitHistory(db);
  if (!history) return null;

  const fileChanges = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const commit of history.commits) {
    const files = [...new Set(commit.files)].sort();
    if (files.length > maxFilesPerCommit) continue;
    for (const file of files) {
      fileChanges.set(file, (fileChanges.get(file) ?? 0) + 1);
    }
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\x00${files[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: CoChangePair[] = [];
  for (const [key, together] of pairCounts) {
    if (together < minTogether) continue;
    const [fileA, fileB] = key.split('\x00') as [string, string];
    const changesA = fileChanges.get(fileA) ?? together;
    const changesB = fileChanges.get(fileB) ?? together;
    const confidence = Math.max(together / changesA, together / changesB);
    if (confidence < minConfidence) continue;
    pairs.push({ fileA, fileB, together, confidence, changesA, changesB });
  }

  pairs.sort((left, right) =>
    right.together - left.together
    || right.confidence - left.confidence
    || left.fileA.localeCompare(right.fileA),
  );
  return pairs;
}
