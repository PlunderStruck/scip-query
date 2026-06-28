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
import { readCachedFileEvidence, writeCachedFileEvidence } from '../storage/evidence-cache.js';

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
  /** Newest analyzed commit timestamp when `commits` is a focused subset. */
  newestAnalyzedAt?: number;
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

export type CoChangeCommitScope = 'focused' | 'mixed' | 'broad-sweep';
export type CoChangeRecency = 'recent' | 'stale';
export type CoChangeExternalIssueLabelStatus = 'unavailable';

export interface CoChangeSubjectContext {
  /** Locally inferred from commit subjects, not issue tracker metadata. */
  subjectLabels: string[];
  issueRefs: string[];
  sampleSubjects: string[];
  externalIssueLabelStatus: CoChangeExternalIssueLabelStatus;
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
  focusedTogether: number;
  broadTogether: number;
  broadCommitRatio: number;
  lastTogetherAt: number;
  recentTogether: number;
  commitScope: CoChangeCommitScope;
  recency: CoChangeRecency;
  subjectContext: CoChangeSubjectContext;
}

const MAX_COMMITS = 2_000;
const BULK_COMMIT_FILE_CAP = 50;
const FOCUSED_HISTORY_FILE_CAP = 64;
const BROAD_COCHANGE_FILE_THRESHOLD = 8;
const BROAD_COCHANGE_AREA_THRESHOLD = 3;
const RECENT_COCHANGE_WINDOW_SECONDS = 90 * 24 * 60 * 60;
const FIX_SUBJECT_PATTERN = /\b(?:fix(?:es|ed)?|bug|regression|hotfix)\b/i;
const SUBJECT_SAMPLE_LIMIT = 3;
const ISSUE_REF_PATTERN = /#\d+|\b[A-Z][A-Z0-9]+-\d+\b/g;
const CONVENTIONAL_SUBJECT_PATTERN = /^([a-z][a-z0-9-]+)(?:\([^)]+\))?!?:/i;

/**
 * The one lifecycle every git-derived value shares: cache per db, revalidate
 * against HEAD so long-lived processes (watch mode) recompute after commits,
 * return null when git is unavailable.
 */
function headKeyedGitValue<T>(
  name: string,
): (db: ScipDatabase, load: (projectRoot: string, head: string) => T | null) => T | null {
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
      `-n`,
      String(MAX_COMMITS),
      '--pretty=format:%x01%H%x00%ct%x00%s',
    ]);
  } catch {
    return null;
  }

  return { head, ...parseCommitHistoryBlocks(raw, BULK_COMMIT_FILE_CAP) };
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
      return new Set(
        raw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      );
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
const FILE_ADD_CACHE_KEY = '__git__/file-adds';

/**
 * When each file was first added, from `git log --diff-filter=A` over the
 * bounded window. Files older than the window are absent — callers should
 * treat absence as "established".
 */
export function getFileAddRecords(db: ScipDatabase): Map<string, FileAddRecord> | null {
  return fileAddCache(db, (projectRoot, head) => cachedFileAddRecords(db, projectRoot, head));
}

function cachedFileAddRecords(db: ScipDatabase, projectRoot: string, head: string): Map<string, FileAddRecord> | null {
  const cached = parseFileAddRecordsPayload(readCachedFileEvidence(db, 'git-file-adds', FILE_ADD_CACHE_KEY, head));
  if (cached) return cached;

  const adds = loadFileAddRecords(projectRoot);
  if (adds) writeCachedFileEvidence(db, 'git-file-adds', FILE_ADD_CACHE_KEY, head, serializeFileAddRecords(adds));
  return adds;
}

function serializeFileAddRecords(records: ReadonlyMap<string, FileAddRecord>): string {
  return JSON.stringify([...records.entries()]);
}

function parseFileAddRecordsPayload(payload: string | null): Map<string, FileAddRecord> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!Array.isArray(parsed)) return null;
    const records = new Map<string, FileAddRecord>();
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return null;
      const record = entry[1] as Partial<FileAddRecord> | undefined;
      if (
        !record ||
        typeof record.commitsAgo !== 'number' ||
        !Number.isFinite(record.commitsAgo) ||
        typeof record.addedAt !== 'number' ||
        !Number.isFinite(record.addedAt)
      ) {
        return null;
      }
      records.set(entry[0], { commitsAgo: record.commitsAgo, addedAt: record.addedAt });
    }
    return records;
  } catch {
    return null;
  }
}

function loadFileAddRecords(projectRoot: string): Map<string, FileAddRecord> | null {
  let raw: string;
  try {
    raw = runGit(projectRoot, [
      'log',
      '--no-merges',
      '--diff-filter=A',
      '--name-only',
      '-n',
      String(MAX_COMMITS),
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
  const history = getCommitHistory(db);
  if (!history) return null;

  return coChangePairsFromHistory(history, opts);
}

export function getCoChangePairsForFiles(
  db: ScipDatabase,
  files: ReadonlySet<string>,
  opts: { minTogether?: number; minConfidence?: number; maxFilesPerCommit?: number } = {},
): CoChangePair[] | null {
  const history = getCommitHistory(db);
  if (!history) return null;
  if (files.size === 0) return [];

  return coChangePairsFromHistory(history, opts, files);
}

export function getDirectionalCoChangePairsForFiles(
  db: ScipDatabase,
  files: ReadonlySet<string>,
  opts: { minTogether?: number; minConfidence?: number; maxFilesPerCommit?: number } = {},
): CoChangePair[] | null {
  if (files.size === 0) return [];
  const head = resolveHead(db.config.projectRoot);
  if (!head) return null;
  const maxFilesPerCommit = opts.maxFilesPerCommit ?? BULK_COMMIT_FILE_CAP;
  if (files.size > FOCUSED_HISTORY_FILE_CAP) return getCoChangePairsForFiles(db, files, opts);
  const history = loadFocusedCommitHistory(db.config.projectRoot, head, files, maxFilesPerCommit);
  if (!history) return null;
  return coChangePairsFromHistory(history, opts, files);
}

function coChangePairsFromHistory(
  history: CommitHistory,
  opts: { minTogether?: number; minConfidence?: number; maxFilesPerCommit?: number },
  focusFiles?: ReadonlySet<string>,
): CoChangePair[] {
  const { minTogether = 4, minConfidence = 0.6, maxFilesPerCommit = BULK_COMMIT_FILE_CAP } = opts;
  const fileChanges = new Map<string, number>();
  const pairContext = new Map<
    string,
    {
      together: number;
      focusedTogether: number;
      broadTogether: number;
      lastTogetherAt: number;
      timestamps: number[];
      subjects: string[];
    }
  >();
  let newestAnalyzedAt = history.newestAnalyzedAt ?? 0;
  for (const commit of history.commits) {
    const files = [...new Set(commit.files)].sort();
    if (files.length > maxFilesPerCommit) continue;
    if (history.newestAnalyzedAt === undefined && commit.timestamp > newestAnalyzedAt) {
      newestAnalyzedAt = commit.timestamp;
    }
    const broadCommit = isBroadCoChangeCommit(files);
    const hasFocusFile = focusFiles === undefined || files.some((file) => focusFiles.has(file));
    for (const file of files) {
      fileChanges.set(file, (fileChanges.get(file) ?? 0) + 1);
    }
    if (!hasFocusFile) continue;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        if (focusFiles && !focusFiles.has(files[i]!) && !focusFiles.has(files[j]!)) continue;
        const key = `${files[i]}\x00${files[j]}`;
        const entry = pairContext.get(key) ?? {
          together: 0,
          focusedTogether: 0,
          broadTogether: 0,
          lastTogetherAt: 0,
          timestamps: [],
          subjects: [],
        };
        entry.together += 1;
        if (broadCommit) {
          entry.broadTogether += 1;
        } else {
          entry.focusedTogether += 1;
        }
        if (commit.timestamp > entry.lastTogetherAt) entry.lastTogetherAt = commit.timestamp;
        entry.timestamps.push(commit.timestamp);
        entry.subjects.push(commit.subject);
        pairContext.set(key, entry);
      }
    }
  }

  const pairs: CoChangePair[] = [];
  const recentCutoff = newestAnalyzedAt - RECENT_COCHANGE_WINDOW_SECONDS;
  for (const [key, context] of pairContext) {
    const together = context.together;
    if (together < minTogether) continue;
    const [fileA, fileB] = key.split('\x00') as [string, string];
    const changesA = fileChanges.get(fileA) ?? together;
    const changesB = fileChanges.get(fileB) ?? together;
    const confidence = Math.max(together / changesA, together / changesB);
    if (confidence < minConfidence) continue;
    const broadCommitRatio = context.broadTogether / together;
    const recentTogether = context.timestamps.filter((timestamp) => timestamp >= recentCutoff).length;
    pairs.push({
      fileA,
      fileB,
      together,
      confidence,
      changesA,
      changesB,
      focusedTogether: context.focusedTogether,
      broadTogether: context.broadTogether,
      broadCommitRatio,
      lastTogetherAt: context.lastTogetherAt,
      recentTogether,
      commitScope: coChangeCommitScope(context.broadTogether, together),
      recency: recentTogether > 0 ? 'recent' : 'stale',
      subjectContext: coChangeSubjectContext(context.subjects),
    });
  }

  pairs.sort(
    (left, right) =>
      right.together - left.together || right.confidence - left.confidence || left.fileA.localeCompare(right.fileA),
  );
  return pairs;
}

function loadFocusedCommitHistory(
  projectRoot: string,
  head: string,
  focusFiles: ReadonlySet<string>,
  maxFilesPerCommit: number,
): CommitHistory | null {
  let globalHeaders: Array<{ hash: string; timestamp: number }>;
  try {
    globalHeaders = loadGlobalCommitHeaders(projectRoot);
  } catch {
    return null;
  }
  if (globalHeaders.length === 0) return { head, commits: [], skippedBulkCommits: 0, newestAnalyzedAt: 0 };

  let focusedHashesRaw: string;
  try {
    focusedHashesRaw = runGit(projectRoot, [
      'log',
      '--no-merges',
      '--format=%H',
      '-n',
      String(MAX_COMMITS),
      '--',
      ...[...focusFiles].sort(),
    ]);
  } catch {
    return null;
  }

  const globalWindow = new Set(globalHeaders.map((entry) => entry.hash));
  const focusedHashes = focusedHashesRaw
    .split('\n')
    .map((line) => line.trim())
    .filter((hash) => hash !== '' && globalWindow.has(hash));
  const newestAnalyzedAt = newestAnalyzedTimestamp(projectRoot, globalHeaders, maxFilesPerCommit);
  if (focusedHashes.length === 0) {
    return { head, commits: [], skippedBulkCommits: 0, newestAnalyzedAt };
  }

  let raw: string;
  try {
    raw = runGit(projectRoot, [
      'show',
      '--no-walk=unsorted',
      '--name-only',
      '--pretty=format:%x01%H%x00%ct%x00%s',
      ...focusedHashes,
    ]);
  } catch {
    return null;
  }

  const parsed = parseCommitHistoryBlocks(raw, maxFilesPerCommit);
  return { head, ...parsed, newestAnalyzedAt };
}

function loadGlobalCommitHeaders(projectRoot: string): Array<{ hash: string; timestamp: number }> {
  const raw = runGit(projectRoot, ['log', '--no-merges', '--format=%H%x00%ct', '-n', String(MAX_COMMITS)]);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [hash, timestampRaw] = line.split('\x00');
      return { hash: hash ?? '', timestamp: Number(timestampRaw) || 0 };
    })
    .filter((entry) => entry.hash !== '');
}

function newestAnalyzedTimestamp(
  projectRoot: string,
  headers: readonly { hash: string; timestamp: number }[],
  maxFilesPerCommit: number,
): number {
  const chunkSize = 20;
  for (let start = 0; start < headers.length; start += chunkSize) {
    const chunk = headers.slice(start, start + chunkSize);
    let raw: string;
    try {
      raw = runGit(projectRoot, [
        'show',
        '--no-walk=unsorted',
        '--name-only',
        '--pretty=format:%x01%H%x00%ct%x00%s',
        ...chunk.map((entry) => entry.hash),
      ]);
    } catch {
      return headers[0]?.timestamp ?? 0;
    }
    const parsed = parseCommitHistoryBlocks(raw, maxFilesPerCommit);
    if (parsed.commits.length > 0) return parsed.commits[0]!.timestamp;
  }
  return 0;
}

function parseCommitHistoryBlocks(
  raw: string,
  maxFilesPerCommit: number,
): Pick<CommitHistory, 'commits' | 'skippedBulkCommits'> {
  const commits: CommitRecord[] = [];
  let skippedBulkCommits = 0;
  for (const block of raw.split('\x01')) {
    if (block.trim() === '') continue;
    const newline = block.indexOf('\n');
    const header = newline >= 0 ? block.slice(0, newline) : block;
    const [hash, timestampRaw, subject] = header.split('\x00');
    if (!hash || !timestampRaw) continue;
    const files =
      newline >= 0
        ? block
            .slice(newline + 1)
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
        : [];
    if (files.length > maxFilesPerCommit) {
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
  return { commits, skippedBulkCommits };
}

function isBroadCoChangeCommit(files: readonly string[]): boolean {
  if (files.length >= BROAD_COCHANGE_FILE_THRESHOLD) return true;
  return coChangeAreas(files).size >= BROAD_COCHANGE_AREA_THRESHOLD;
}

function coChangeAreas(files: readonly string[]): Set<string> {
  const areas = new Set<string>();
  for (const file of files) {
    const slash = file.indexOf('/');
    areas.add(slash >= 0 ? file.slice(0, slash) : '.');
  }
  return areas;
}

function coChangeCommitScope(broadTogether: number, together: number): CoChangeCommitScope {
  if (broadTogether === 0) return 'focused';
  return broadTogether / together >= 0.5 ? 'broad-sweep' : 'mixed';
}

function coChangeSubjectContext(subjects: readonly string[]): CoChangeSubjectContext {
  const labels = new Set<string>();
  const issueRefs: string[] = [];
  const sampleSubjects: string[] = [];

  for (const subject of subjects) {
    if (!sampleSubjects.includes(subject) && sampleSubjects.length < SUBJECT_SAMPLE_LIMIT) {
      sampleSubjects.push(subject);
    }
    for (const label of subjectLabelsFor(subject)) {
      labels.add(label);
    }
    for (const ref of subject.match(ISSUE_REF_PATTERN) ?? []) {
      if (!issueRefs.includes(ref)) issueRefs.push(ref);
    }
  }

  return {
    subjectLabels: [...labels].sort(),
    issueRefs,
    sampleSubjects,
    externalIssueLabelStatus: 'unavailable',
  };
}

function subjectLabelsFor(subject: string): string[] {
  const labels = new Set<string>();
  const conventional = CONVENTIONAL_SUBJECT_PATTERN.exec(subject)?.[1]?.toLowerCase();
  if (conventional) labels.add(normalizeSubjectLabel(conventional));
  if (/\b(?:feat|feature)\b/i.test(subject)) labels.add('feature');
  if (/\b(?:fix(?:es|ed)?|bug|regression|hotfix)\b/i.test(subject)) labels.add('fix');
  if (/\b(?:docs?|documentation|guide|readme)\b/i.test(subject)) labels.add('docs');
  if (/\brefactor(?:ing|ed)?\b/i.test(subject)) labels.add('refactor');
  if (/\btests?\b/i.test(subject)) labels.add('test');
  if (/\b(?:release|version|v\d+\.\d+)\b/i.test(subject)) labels.add('release');
  if (/\bchore\b/i.test(subject)) labels.add('chore');
  if (/\bbuild\b/i.test(subject)) labels.add('build');
  if (/\bci\b/i.test(subject)) labels.add('ci');
  if (/\bperf(?:ormance)?\b/i.test(subject)) labels.add('perf');
  return [...labels];
}

function normalizeSubjectLabel(label: string): string {
  if (label === 'feat') return 'feature';
  return label;
}
