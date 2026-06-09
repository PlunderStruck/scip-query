import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { getCommitHistory } from '../analysis/git-history.js';

export interface DocDriftSubject {
  file: string;
  /** Commits where doc and subject changed together (historical coupling). */
  coChanges: number;
  /** Commits touching the subject AFTER the doc's last change. */
  changesSinceDocUpdate: number;
}

export interface DocDriftFinding {
  doc: string;
  /** Unix seconds of the doc's last change in the analyzed window. */
  docLastChangedAt: number;
  /** Σ subject changes since the doc last changed — the staleness score. */
  staleness: number;
  subjects: DocDriftSubject[];
}

export interface DocDriftResult {
  /** False when git history is unavailable. */
  available: boolean;
  commitsAnalyzed: number;
  findings: DocDriftFinding[];
}

const DOC_FILE_PATTERN = /\.(?:md|mdx|rst|txt)$/i;
const MIN_COUPLING = 3;

/**
 * Standards/docs drift: a doc that HISTORICALLY co-changed with code files
 * but has NOT changed while those files kept churning is going stale — and
 * stale standards docs are worse than none when agents read them before
 * implementing (they implement to a dead spec).
 *
 * Inverse of the hidden-coupling detector: there the coupling is the
 * finding; here the BROKEN coupling is.
 */
export function docDrift(
  db: ScipDatabase,
  opts: { doc?: string; limit?: number; minCoupling?: number } = {},
): DocDriftResult {
  const { doc, limit = 20, minCoupling = MIN_COUPLING } = opts;
  const history = getCommitHistory(db);
  if (!history) return { available: false, commitsAnalyzed: 0, findings: [] };

  // One pass: per-file change timestamps + doc↔code co-change counts.
  const changeTimes = new Map<string, number[]>();
  const coupling = new Map<string, Map<string, number>>(); // doc -> code -> together
  for (const commit of history.commits) {
    const files = [...new Set(commit.files)];
    const docs = files.filter((file) => DOC_FILE_PATTERN.test(file));
    const code = files.filter((file) => !DOC_FILE_PATTERN.test(file));
    for (const file of files) {
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

  const findings: DocDriftFinding[] = [];
  for (const [docFile, partners] of coupling) {
    if (doc !== undefined && !docFile.includes(doc)) continue;
    if (!existsSync(join(db.config.projectRoot, docFile))) continue;
    const docLastChangedAt = Math.max(...(changeTimes.get(docFile) ?? [0]));

    const subjects: DocDriftSubject[] = [];
    for (const [codeFile, together] of partners) {
      if (together < minCoupling) continue;
      if (!existsSync(join(db.config.projectRoot, codeFile))) continue;
      const changesSince = (changeTimes.get(codeFile) ?? [])
        .filter((timestamp) => timestamp > docLastChangedAt).length;
      if (changesSince === 0) continue;
      subjects.push({ file: codeFile, coChanges: together, changesSinceDocUpdate: changesSince });
    }
    if (subjects.length === 0) continue;

    subjects.sort((left, right) => right.changesSinceDocUpdate - left.changesSinceDocUpdate);
    findings.push({
      doc: docFile,
      docLastChangedAt,
      staleness: subjects.reduce((sum, subject) => sum + subject.changesSinceDocUpdate, 0),
      subjects: subjects.slice(0, 8),
    });
  }

  findings.sort((left, right) => right.staleness - left.staleness);
  return {
    available: true,
    commitsAnalyzed: history.commits.length,
    findings: findings.slice(0, limit),
  };
}
