import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { getCommitHistory, getTrackedFiles } from '../../analysis/git-history.js';
import { fileContentHash, readCachedFileEvidence, writeCachedFileEvidence } from '../../storage/evidence-cache.js';
import { markdownCitationContext } from './doc-citation-context.js';
import { matchingDocTerms } from './doc-terms.js';

export type DocDriftIntent = 'current-guidance' | 'historical-note' | 'unknown';
export type DocDriftActionTier = 'direct' | 'signal' | 'support';

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
  /** Strength of action implied by the evidence and doc intent. */
  actionTier: DocDriftActionTier;
  /** Whether the doc reads like current guidance, historical context, or neither. */
  docIntent: DocDriftIntent;
  /** Bounded reasons for the doc intent classification. */
  docIntentReasons: string[];
  /** Nearby doc text that gives the file citation its meaning, when available. */
  citationContexts?: string[];
}

export interface DocFileCitation {
  file: string;
  /** Bounded nearby doc text for each citation of this file. */
  contexts: string[];
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

interface DocDriftScanIndex {
  changeTimes: Map<string, number[]>;
  coupling: Map<string, Map<string, number>>;
  docFiles: string[];
  everSeenInHistory: Set<string>;
  historyCommitCount: number;
  tracked: Set<string>;
  trackedBySuffix: Map<string, string[]>;
}

const DOC_FILE_PATTERN = /\.(?:md|mdx|rst|txt)$/i;
/**
 * Archival docs (dated plans, ADRs, RFCs, changelogs) record a moment in
 * time — they cite code as of their date and are never meant to track it.
 */
export function isArchivalDoc(path: string): boolean {
  return (
    /(?:^|\/)(?:docs\/plans|plans|adrs?|rfcs?|decisions|changelogs?|archive|reports?)\//i.test(path) ||
    /(?:^|\/)CHANGELOG\.(?:md|mdx|rst|txt)$/i.test(path)
  );
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
  const scan = buildDocDriftScanIndex(db);
  if (!scan) return { available: false, commitsAnalyzed: 0, docsScanned: 0, findings: [] };

  const findings: DocDriftFinding[] = [];
  for (const docFile of scan.docFiles) {
    if (doc !== undefined && !docFile.includes(doc)) continue;
    // Explicitly requested docs bypass the archival filter (detail mode).
    if (doc === undefined && !isLivingDoc(db, docFile)) continue;
    if (doc !== undefined && !existsSync(join(db.config.projectRoot, docFile))) continue;
    const docLastChangedAt = Math.max(0, ...(scan.changeTimes.get(docFile) ?? []));
    const docIntent = classifyDocDriftIntent(db, docFile);

    const subjects = new Map<string, DocDriftSubject>();

    // Evidence 1: content references.
    const { resolved, broken, citations } = extractFileReferences(
      db,
      docFile,
      scan.tracked,
      scan.trackedBySuffix,
      scan.everSeenInHistory,
    );
    const citationsByFile = new Map(citations.map((citation) => [citation.file, citation.contexts]));
    for (const referenced of resolved) {
      if (referenced === docFile || DOC_FILE_PATTERN.test(referenced)) continue;
      const changesSince = (scan.changeTimes.get(referenced) ?? []).filter(
        (timestamp) => timestamp > docLastChangedAt,
      ).length;
      if (changesSince === 0) continue;
      subjects.set(referenced, {
        file: referenced,
        evidence: 'reference',
        coChanges: 0,
        changesSinceDocUpdate: changesSince,
        ...docDriftSubjectMetadata('reference', docIntent),
        citationContexts: citationsByFile.get(referenced),
      });
    }

    // Evidence 2: historical co-change.
    for (const [codeFile, together] of scan.coupling.get(docFile) ?? []) {
      if (together < minCoupling) continue;
      if (!scan.tracked.has(codeFile)) continue;
      const changesSince = (scan.changeTimes.get(codeFile) ?? []).filter(
        (timestamp) => timestamp > docLastChangedAt,
      ).length;
      if (changesSince === 0) continue;
      const existing = subjects.get(codeFile);
      if (existing) {
        existing.evidence = 'both';
        existing.coChanges = together;
        Object.assign(existing, docDriftSubjectMetadata('both', docIntent));
      } else {
        subjects.set(codeFile, {
          file: codeFile,
          evidence: 'co-change',
          coChanges: together,
          changesSinceDocUpdate: changesSince,
          ...docDriftSubjectMetadata('co-change', docIntent),
        });
      }
    }

    if (subjects.size === 0 && broken.length === 0) continue;

    const ordered = [...subjects.values()].sort(
      (left, right) => right.changesSinceDocUpdate - left.changesSinceDocUpdate,
    );
    findings.push({
      doc: docFile,
      docLastChangedAt,
      // Broken references weigh heavily — the spec cites deleted code.
      staleness: ordered.reduce((sum, subject) => sum + subject.changesSinceDocUpdate, 0) + broken.length * 10,
      subjects: ordered.slice(0, 8),
      brokenReferences: broken,
    });
  }

  findings.sort((left, right) => right.staleness - left.staleness);
  return {
    available: true,
    commitsAnalyzed: scan.historyCommitCount,
    docsScanned: scan.docFiles.length,
    findings: findings.slice(0, limit),
  };
}

interface DocDriftIntentClassification {
  docIntent: DocDriftIntent;
  reasons: string[];
}

function classifyDocDriftIntent(db: ScipDatabase, docFile: string): DocDriftIntentClassification {
  let text: string;
  try {
    text = readFileSync(join(db.config.projectRoot, docFile), 'utf8').slice(0, 6_000);
  } catch {
    return { docIntent: 'unknown', reasons: ['doc text unavailable'] };
  }

  const haystack = `${docFile}\n${text}`.toLowerCase();
  const historicalHits = matchingDocTerms(haystack, [
    'historical note',
    'historical record',
    'history note',
    'retrospective',
    'postmortem',
    'post-mortem',
    'archived',
    'archive',
    'previously',
    'legacy',
    'recorded',
    'record of',
    'snapshot',
    'as of',
    'migration note',
    'decision record',
  ]);
  if (historicalHits.length > 0) {
    return { docIntent: 'historical-note', reasons: [`historical-note terms: ${historicalHits.join(', ')}`] };
  }

  const currentHits = matchingDocTerms(haystack, [
    'current',
    'standard',
    'standards',
    'must',
    'should',
    'policy',
    'guide',
    'guidance',
    'workflow',
    'contract',
    'invariant',
    'source of truth',
  ]);
  if (currentHits.length > 0) {
    return { docIntent: 'current-guidance', reasons: [`current-guidance terms: ${currentHits.join(', ')}`] };
  }

  return { docIntent: 'unknown', reasons: ['no current-guidance or historical-note markers found'] };
}

function docDriftSubjectMetadata(
  evidence: DocDriftSubject['evidence'],
  intent: DocDriftIntentClassification,
): Pick<DocDriftSubject, 'actionTier' | 'docIntent' | 'docIntentReasons'> {
  return {
    actionTier: docDriftActionTier(evidence, intent.docIntent),
    docIntent: intent.docIntent,
    docIntentReasons: intent.reasons,
  };
}

function docDriftActionTier(evidence: DocDriftSubject['evidence'], intent: DocDriftIntent): DocDriftActionTier {
  if (intent === 'historical-note') return 'support';
  return evidence === 'co-change' ? 'signal' : 'direct';
}

function buildDocDriftScanIndex(db: ScipDatabase): DocDriftScanIndex | null {
  const history = getCommitHistory(db);
  if (!history) return null;
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

  return {
    changeTimes,
    coupling,
    // Every tracked doc is a candidate — content references need no history.
    docFiles: [...tracked].filter((file) => DOC_FILE_PATTERN.test(file)),
    everSeenInHistory,
    historyCommitCount: history.commits.length,
    tracked,
    trackedBySuffix: buildSuffixIndex(tracked),
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
): Array<{ doc: string; cited: string[]; citations: DocFileCitation[]; citedClaims: string[] }> {
  if (targets.size === 0) return [];
  const tracked = getTrackedFiles(db) ?? new Set<string>();
  const trackedBySuffix = buildSuffixIndex(tracked);
  const targetCandidates = targetPathCandidates(targets, trackedBySuffix);
  const out: Array<{ doc: string; cited: string[]; citations: DocFileCitation[]; citedClaims: string[] }> = [];
  for (const docFile of tracked) {
    if (!isLivingDoc(db, docFile)) continue;
    const candidates = docPathCandidates(db, docFile);
    if (!candidates) continue;
    const citedByCandidate = citedTargetsFromCandidates(candidates, targets, targetCandidates, tracked, trackedBySuffix);
    if (citedByCandidate.size === 0) continue;

    const contextCandidates = [...new Set([...citedByCandidate.values()].flatMap((cited) => [...cited]))];
    const contextsByCandidate = docCitationContextWindows(db, docFile, contextCandidates);
    const citations: DocFileCitation[] = [...citedByCandidate]
      .map(([file, fileCandidates]) => ({
        file,
        contexts: uniqueCitationContexts([...fileCandidates].flatMap((candidate) => contextsByCandidate.get(candidate) ?? []))
          .slice(0, 3),
      }))
      .filter((citation) => citation.contexts.length > 0);
    const cited = [...citedByCandidate.keys()];
    if (cited.length > 0) {
      const sortedCited = cited.sort();
      out.push({
        doc: docFile,
        cited: sortedCited,
        citations,
        citedClaims: uniqueCitationContexts(citations.flatMap((citation) => citation.contexts)).slice(0, 3),
      });
    }
  }
  return out;
}

/** A doc that exists, isn't archival, and is eligible for drift tracking. */
function isLivingDoc(db: ScipDatabase, docFile: string): boolean {
  return DOC_FILE_PATTERN.test(docFile) && !isArchivalDoc(docFile) && existsSync(join(db.config.projectRoot, docFile));
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

function targetPathCandidates(
  targets: ReadonlySet<string>,
  trackedBySuffix: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const candidates = new Set<string>(targets);
  for (const target of targets) {
    const segments = target.split('/');
    for (const depth of [2, 3]) {
      if (segments.length < depth) continue;
      const suffix = segments.slice(-depth).join('/');
      const resolved = trackedBySuffix.get(suffix);
      if (resolved?.length === 1 && resolved[0] === target) candidates.add(suffix);
    }
  }
  return candidates;
}

function citedTargetsFromCandidates(
  candidates: readonly string[],
  targets: ReadonlySet<string>,
  targetCandidates: ReadonlySet<string>,
  tracked: ReadonlySet<string>,
  trackedBySuffix: ReadonlyMap<string, readonly string[]>,
): Map<string, Set<string>> {
  const citedByCandidate = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (!targetCandidates.has(candidate)) continue;
    let cited: string | undefined;
    if (tracked.has(candidate)) {
      cited = candidate;
    } else {
      const bySuffix = trackedBySuffix.get(candidate);
      if (bySuffix?.length === 1) cited = bySuffix[0];
    }
    if (!cited || !targets.has(cited)) continue;
    const bucket = citedByCandidate.get(cited) ?? new Set<string>();
    bucket.add(candidate);
    citedByCandidate.set(cited, bucket);
  }
  return citedByCandidate;
}

function extractFileReferences(
  db: ScipDatabase,
  docFile: string,
  tracked: ReadonlySet<string>,
  trackedBySuffix: ReadonlyMap<string, string[]>,
  everSeenInHistory: ReadonlySet<string>,
): { resolved: Set<string>; broken: string[]; citations: DocFileCitation[] } {
  const resolved = new Set<string>();
  const broken = new Set<string>();
  const candidates = docPathCandidates(db, docFile);
  if (!candidates) return { resolved, broken: [], citations: [] };
  const contextsByCandidate = docCitationContextWindows(db, docFile, candidates);
  const contextsByFile = new Map<string, string[]>();

  const recordCitation = (file: string, candidate: string): void => {
    const contexts = contextsByCandidate.get(candidate);
    if (!contexts || contexts.length === 0) return;
    const bucket = contextsByFile.get(file) ?? [];
    bucket.push(...contexts);
    contextsByFile.set(file, uniqueCitationContexts(bucket).slice(0, 3));
  };

  for (const candidate of candidates) {
    if (tracked.has(candidate)) {
      resolved.add(candidate);
      recordCitation(candidate, candidate);
      continue;
    }
    const bySuffix = trackedBySuffix.get(candidate);
    if (bySuffix && bySuffix.length === 1) {
      resolved.add(bySuffix[0]!);
      recordCitation(bySuffix[0]!, candidate);
      continue;
    }
    if (bySuffix && bySuffix.length > 1) continue; // ambiguous citation — skip
    // Broken only when the cited path verifiably existed before — an
    // illustrative example path in prose never did.
    if (everSeenInHistory.has(candidate)) broken.add(candidate);
  }
  return {
    resolved,
    broken: [...broken],
    citations: [...contextsByFile].map(([file, contexts]) => ({ file, contexts })),
  };
}

function docCitationContextWindows(
  db: ScipDatabase,
  docFile: string,
  candidates: readonly string[],
): Map<string, string[]> {
  let lines: string[];
  try {
    lines = readFileSync(join(db.config.projectRoot, docFile), 'utf-8').split(/\r?\n/);
  } catch {
    return new Map();
  }

  const candidateSet = new Set(candidates);
  const contexts = new Map<string, string[]>();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    for (const match of line.matchAll(PATH_REFERENCE_PATTERN)) {
      const candidate = match[0].replace(/^\.?\//, '');
      if (!candidateSet.has(candidate)) continue;
      const context = markdownCitationContext(lines, lineIndex);
      if (context.length === 0) continue;
      const bucket = contexts.get(candidate) ?? [];
      bucket.push(context);
      contexts.set(candidate, uniqueCitationContexts(bucket).slice(0, 3));
    }
  }
  return contexts;
}

function uniqueCitationContexts(values: readonly string[]): string[] {
  const contexts: string[] = [];
  for (const value of new Set(values)) {
    if (contexts.some((existing) => citationContextsOverlap(existing, value))) continue;
    contexts.push(value);
  }
  return contexts;
}

function citationContextsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftLines = left
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const rightLines = right
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const smaller = Math.min(leftLines.length, rightLines.length);
  if (smaller === 0) return false;
  if (smaller < 3) return left.includes(right) || right.includes(left);
  const rightSet = new Set(rightLines);
  const shared = leftLines.filter((line) => rightSet.has(line)).length;
  return shared >= 3 && shared / smaller >= 0.6;
}

/**
 * The path-shaped tokens in a doc's text, persistently cached by content
 * hash — the regex scan over large docs dominates diff-gate's doc-reference
 * check on doc-heavy repos. Only extraction is cached; resolution against the
 * tracked-file set stays live, so results track the current repo exactly.
 * Null = doc unreadable.
 */
function docPathCandidates(db: ScipDatabase, docFile: string): string[] | null {
  let content: string;
  try {
    content = readFileSync(join(db.config.projectRoot, docFile), 'utf-8');
  } catch {
    return null;
  }
  const contentHash = fileContentHash(db, docFile, content);
  const cached = readCachedFileEvidence(db, 'doc-path-tokens', docFile, contentHash);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as string[];
    } catch {
      // corrupt payload — fall through and re-extract
    }
  }
  const candidates = [
    ...new Set([...content.matchAll(PATH_REFERENCE_PATTERN)].map((match) => match[0].replace(/^\.?\//, ''))),
  ];
  writeCachedFileEvidence(db, 'doc-path-tokens', docFile, contentHash, JSON.stringify(candidates));
  return candidates;
}
