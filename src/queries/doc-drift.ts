import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { getCommitHistory, getTrackedFiles } from '../analysis/git-history.js';

export interface DocDriftSubject {
  file: string;
  /**
   * 'reference': the doc's text mentions this file path.
   * 'co-change': the doc historically changed in the same commits as this file.
   * 'both': both evidence sources agree — strongest signal.
   */
  evidence: 'reference' | 'co-change' | 'both';
  /** Commits where doc and subject changed together (0 for pure references). */
  coChanges: number;
  /** Commits touching the subject AFTER the doc's last change. */
  changesSinceDocUpdate: number;
}

export interface DocDriftFinding {
  doc: string;
  /** Unix seconds of the doc's last change; 0 = never changed in the window. */
  docLastChangedAt: number;
  /** Σ subject changes since the doc last changed — the staleness score. */
  staleness: number;
  subjects: DocDriftSubject[];
  /** File paths the doc mentions that no longer exist (spec points at deleted code). */
  brokenReferences: string[];
}

export interface DocDriftResult {
  /** False when git history is unavailable. */
  available: boolean;
  commitsAnalyzed: number;
  /** Doc files scanned for content references. */
  docsScanned: number;
  findings: DocDriftFinding[];
}

const DOC_FILE_PATTERN = /\.(?:md|mdx|rst|txt)$/i;
/**
 * Archival docs (dated plans, ADRs, RFCs, changelogs) record a moment in
 * time — they cite code as of their date and are never meant to track it.
 */
export function isArchivalDoc(path: string): boolean {
  return /(?:^|\/)(?:docs\/plans|plans|adrs?|rfcs?|decisions|changelogs?|archive|reports?)\//i.test(path)
    || /(?:^|\/)CHANGELOG\.(?:md|mdx|rst|txt)$/i.test(path);
}
const MIN_COUPLING = 3;
/** Path-shaped tokens with a code-ish extension — what docs use to cite files. */
const PATH_REFERENCE_PATTERN = /[A-Za-z0-9_@-]+(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z0-9]{1,6}\b/g;

/**
 * Standards/docs drift, from two evidence sources:
 *
 * 1. CONTENT REFERENCES — the doc's text names file paths; those files kept
 *    changing after the doc last changed. Covers standards docs from day one
 *    (no history needed) and finds BROKEN references: paths the doc cites
 *    that no longer exist — a spec pointing at deleted code.
 * 2. CO-CHANGE — the doc historically changed in the same commits as code
 *    files, then stopped while they kept churning. Catches implicit coupling
 *    the doc never names.
 *
 * A stale standards doc is worse than none when agents read it before
 * implementing — they implement to a dead spec.
 */
export function docDrift(
  db: ScipDatabase,
  opts: { doc?: string; limit?: number; minCoupling?: number } = {},
): DocDriftResult {
  const { doc, limit = 20, minCoupling = MIN_COUPLING } = opts;
  const history = getCommitHistory(db);
  if (!history) return { available: false, commitsAnalyzed: 0, docsScanned: 0, findings: [] };
  const tracked = getTrackedFiles(db) ?? new Set<string>();

  // One history pass: per-file change timestamps + doc↔code co-change counts.
  const changeTimes = new Map<string, number[]>();
  const coupling = new Map<string, Map<string, number>>(); // doc -> code -> together
  const everSeenInHistory = new Set<string>();
  for (const commit of history.commits) {
    const files = [...new Set(commit.files)];
    const docs = files.filter((file) => DOC_FILE_PATTERN.test(file));
    const code = files.filter((file) => !DOC_FILE_PATTERN.test(file));
    for (const file of files) {
      everSeenInHistory.add(file);
      const bucket = changeTimes.get(file) ?? [];
      bucket.push(commit.timestamp);
      changeTimes.set(file, bucket);
    }
    for (const docFile of docs) {
      let partners = coupling.get(docFile);
      if (!partners) {
        partners = new Map();
        coupling.set(docFile, partners);
      }
      for (const codeFile of code) {
        partners.set(codeFile, (partners.get(codeFile) ?? 0) + 1);
      }
    }
  }

  // Every tracked doc is a candidate — content references need no history.
  const docFiles = [...tracked].filter((file) => DOC_FILE_PATTERN.test(file));
  const trackedBySuffix = buildSuffixIndex(tracked);

  const findings: DocDriftFinding[] = [];
  for (const docFile of docFiles) {
    if (doc !== undefined && !docFile.includes(doc)) continue;
    // Explicitly requested docs bypass the archival filter (detail mode).
    if (doc === undefined && !isLivingDoc(db, docFile)) continue;
    if (doc !== undefined && !existsSync(join(db.config.projectRoot, docFile))) continue;
    const docLastChangedAt = Math.max(0, ...(changeTimes.get(docFile) ?? []));

    const subjects = new Map<string, DocDriftSubject>();

    // Evidence 1: content references.
    const { resolved, broken } = extractFileReferences(
      db, docFile, tracked, trackedBySuffix, everSeenInHistory,
    );
    for (const referenced of resolved) {
      if (referenced === docFile || DOC_FILE_PATTERN.test(referenced)) continue;
      const changesSince = (changeTimes.get(referenced) ?? [])
        .filter((timestamp) => timestamp > docLastChangedAt).length;
      if (changesSince === 0) continue;
      subjects.set(referenced, {
        file: referenced,
        evidence: 'reference',
        coChanges: 0,
        changesSinceDocUpdate: changesSince,
      });
    }

    // Evidence 2: historical co-change.
    for (const [codeFile, together] of coupling.get(docFile) ?? []) {
      if (together < minCoupling) continue;
      if (!tracked.has(codeFile)) continue;
      const changesSince = (changeTimes.get(codeFile) ?? [])
        .filter((timestamp) => timestamp > docLastChangedAt).length;
      if (changesSince === 0) continue;
      const existing = subjects.get(codeFile);
      if (existing) {
        existing.evidence = 'both';
        existing.coChanges = together;
      } else {
        subjects.set(codeFile, {
          file: codeFile,
          evidence: 'co-change',
          coChanges: together,
          changesSinceDocUpdate: changesSince,
        });
      }
    }

    if (subjects.size === 0 && broken.length === 0) continue;

    const ordered = [...subjects.values()].sort((left, right) =>
      right.changesSinceDocUpdate - left.changesSinceDocUpdate);
    findings.push({
      doc: docFile,
      docLastChangedAt,
      // Broken references weigh heavily — the spec cites deleted code.
      staleness: ordered.reduce((sum, subject) => sum + subject.changesSinceDocUpdate, 0)
        + broken.length * 10,
      subjects: ordered.slice(0, 8),
      brokenReferences: broken,
    });
  }

  findings.sort((left, right) => right.staleness - left.staleness);
  return {
    available: true,
    commitsAnalyzed: history.commits.length,
    docsScanned: docFiles.length,
    findings: findings.slice(0, limit),
  };
}

/**
 * Docs whose text cites any of the target files — diff-gate uses this to ask
 * "you changed these files; which docs claim to describe them?"
 */
// scip-query: ignore-similar — deliberately shares the doc-walking toolkit
// (isLivingDoc, extractFileReferences) with docDrift; the two ask different
// questions and merging them would parameterize away their meaning.
export function docsCitingFiles(
  db: ScipDatabase,
  targets: ReadonlySet<string>,
): Array<{ doc: string; cited: string[] }> {
  const tracked = getTrackedFiles(db) ?? new Set<string>();
  const trackedBySuffix = buildSuffixIndex(tracked);
  const out: Array<{ doc: string; cited: string[] }> = [];
  for (const docFile of tracked) {
    if (!isLivingDoc(db, docFile)) continue;
    const { resolved } = extractFileReferences(db, docFile, tracked, trackedBySuffix, new Set());
    const cited = [...resolved].filter((file) => targets.has(file));
    if (cited.length > 0) out.push({ doc: docFile, cited: cited.sort() });
  }
  return out;
}

/** A doc that exists, isn't archival, and is eligible for drift tracking. */
function isLivingDoc(db: ScipDatabase, docFile: string): boolean {
  return DOC_FILE_PATTERN.test(docFile)
    && !isArchivalDoc(docFile)
    && existsSync(join(db.config.projectRoot, docFile));
}

/** Map "suffix after last two segments" → full tracked paths, for short citations. */

function buildSuffixIndex(tracked: ReadonlySet<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of tracked) {
    const segments = file.split('/');
    for (const depth of [2, 3]) {
      if (segments.length < depth) continue;
      const suffix = segments.slice(-depth).join('/');
      const bucket = index.get(suffix) ?? [];
      bucket.push(file);
      index.set(suffix, bucket);
    }
  }
  return index;
}

function extractFileReferences(
  db: ScipDatabase,
  docFile: string,
  tracked: ReadonlySet<string>,
  trackedBySuffix: ReadonlyMap<string, string[]>,
  everSeenInHistory: ReadonlySet<string>,
): { resolved: Set<string>; broken: string[] } {
  const resolved = new Set<string>();
  const broken = new Set<string>();
  let content: string;
  try {
    content = readFileSync(join(db.config.projectRoot, docFile), 'utf-8');
  } catch {
    return { resolved, broken: [] };
  }

  for (const match of content.matchAll(PATH_REFERENCE_PATTERN)) {
    const candidate = match[0].replace(/^\.?\//, '');
    if (tracked.has(candidate)) {
      resolved.add(candidate);
      continue;
    }
    const bySuffix = trackedBySuffix.get(candidate);
    if (bySuffix && bySuffix.length === 1) {
      resolved.add(bySuffix[0]!);
      continue;
    }
    if (bySuffix && bySuffix.length > 1) continue; // ambiguous citation — skip
    // Broken only when the cited path verifiably existed before — an
    // illustrative example path in prose never did.
    if (everSeenInHistory.has(candidate)) broken.add(candidate);
  }
  return { resolved, broken: [...broken] };
}
