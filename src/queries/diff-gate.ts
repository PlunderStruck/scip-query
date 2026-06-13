import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ScipDatabase } from '../storage/db.js';
import { isEntrySurface, isRootedSymbol } from '../analysis/file-classifier.js';
import { getCoChangePairs } from '../analysis/git-history.js';
import { ProjectIndex } from '../core/project-index.js';
import { isCoChangeNoiseFile } from './co-change.js';
import { diffImpact, diffImpactPlan } from './diff-impact.js';
import type { DiffImpactPlan } from './diff-impact.js';
import { docsCitingFiles } from './doc-drift.js';
import { checkHealthBaseline, resolveBaselinePath } from './health-baseline.js';
import { incompleteMigration } from './incomplete-migration.js';
import { similar } from './similar.js';
import { unusedParams } from './unused-params.js';
import type { FindingSuppression } from '../domain/types.js';

export type DiffGateCheck =
  | 'echo'
  | 'incomplete-migration'
  | 'co-change-partner'
  | 'doc-reference'
  | 'unused-params'
  | 'new-dead'
  | 'baseline';

/** Canonical check list — the CLI validates `--skip` values against this. */
export const DIFF_GATE_CHECKS: readonly DiffGateCheck[] = [
  'echo',
  'incomplete-migration',
  'co-change-partner',
  'doc-reference',
  'unused-params',
  'new-dead',
  'baseline',
];

export type DiffGateEvidence =
  | 'graph-fact'
  | 'semantic'
  | 'heuristic'
  | 'change-graph'
  | 'baseline';

export type DiffGateSeverity = 'info' | 'warning' | 'error';

export interface DiffGateFinding {
  id: string;
  check: DiffGateCheck;
  severity: DiffGateSeverity;
  evidence: DiffGateEvidence;
  confidence?: number;
  file?: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  relatedFiles?: string[];
  message: string;
  why: string[];
  /** Concrete remediation an agent can act on without human triage. */
  remediation: string;
  suppressionHint?: string;
}

export interface DiffGateResult {
  base: string;
  changedFiles: string[];
  changedSymbols: number;
  checksRun: DiffGateCheck[];
  /** Checks that could not run (no git history, no baseline file, ...). */
  skipped: Array<{ check: DiffGateCheck; reason: string }>;
  /** Findings accepted by structured .scipquery.json suppressions. */
  suppressed: Array<{ finding: DiffGateFinding; suppression: FindingSuppression }>;
  findings: DiffGateFinding[];
  note?: string;
}

/**
 * Slop prevention at the moment of creation: every detector, scoped to what
 * THIS diff introduces. O(diff), no LLM calls, exit-code friendly — the
 * leading-indicator companion to the repo-wide ratchet.
 *
 * Checks:
 * - echo:               a symbol this diff touched closely resembles
 *                       established code elsewhere — likely re-implementation.
 * - incomplete-migration: a helper added in this diff was wired into some
 *                       sites, but similar un-migrated sites remain elsewhere
 *                       — the extraction stopped partway.
 * - co-change-partner:  a changed file's strong historical partner is NOT in
 *                       the diff — the change-graph contract says they move
 *                       together (auto-derived sync enforcement).
 * - doc-reference:      a doc cites a changed file but isn't updated in the
 *                       diff — the drift starts here.
 * - unused-params:      changed files now contain trailing parameters no body
 *                       uses — speculative generality landing fresh.
 * - new-dead:           changed symbols with zero indexed consumers — possibly
 *                       a half-wired feature.
 * - baseline:           the committed health baseline gained new findings.
 */
export function diffGate(
  db: ScipDatabase,
  opts: {
    base?: string;
    minTogether?: number;
    minConfidence?: number;
    maxEchoChecks?: number;
    maxHelpers?: number;
    minSimilarity?: number;
    skip?: readonly DiffGateCheck[];
  } = {},
): DiffGateResult {
  const base = opts.base ?? 'HEAD';
  const {
    minTogether = 6,
    minConfidence = 0.6,
    maxEchoChecks = Number.POSITIVE_INFINITY,
    maxHelpers = Number.POSITIVE_INFINITY,
    minSimilarity = 0.8,
  } = opts;
  const skip = new Set(opts.skip ?? []);

  const impactPlan = diffImpactPlan(db, { base });
  const impact = diffImpact(db, { base, plan: impactPlan });
  const changedFiles = impact.changedFiles;
  const changed = new Set(changedFiles);
  const result: DiffGateResult = {
    base,
    changedFiles,
    changedSymbols: impact.changedSymbols.length,
    checksRun: [],
    skipped: [],
    suppressed: [],
    findings: [],
    note: impact.summary.note,
  };
  if (changedFiles.length === 0) return result;

  const runUnlessSkipped = (check: DiffGateCheck, run: () => void): void => {
    if (skip.has(check)) {
      result.skipped.push({ check, reason: 'skipped via --skip' });
      return;
    }
    run();
  };
  runUnlessSkipped('echo', () => runEchoCheck(db, impact.changedSymbols, changed, maxEchoChecks, minSimilarity, result));
  runUnlessSkipped('incomplete-migration', () => runIncompleteMigrationCheck(db, base, impactPlan, maxHelpers, result));
  runUnlessSkipped('co-change-partner', () => runCoChangePartnerCheck(db, changed, minTogether, minConfidence, result));
  runUnlessSkipped('doc-reference', () => runDocReferenceCheck(db, changed, result));
  runUnlessSkipped('unused-params', () => runUnusedParamsCheck(db, changedFiles, result));
  runUnlessSkipped('new-dead', () => runNewDeadCheck(db, impact.changedSymbols, result));
  runUnlessSkipped('baseline', () => runBaselineCheck(db, result));
  applyStructuredSuppressions(result, db.config.suppressions ?? []);

  return result;
}

function applyStructuredSuppressions(
  result: DiffGateResult,
  suppressions: readonly FindingSuppression[],
): void {
  if (suppressions.length === 0 || result.findings.length === 0) return;
  const kept: DiffGateFinding[] = [];
  for (const finding of result.findings) {
    const suppression = suppressions.find((candidate) => suppressionMatches(candidate, finding));
    if (suppression) {
      result.suppressed.push({ finding, suppression });
    } else {
      kept.push(finding);
    }
  }
  result.findings = kept;
}

function suppressionMatches(
  suppression: FindingSuppression,
  finding: DiffGateFinding,
): boolean {
  if (!suppression.reason || suppression.reason.trim() === '') return false;
  if (suppression.expiresAt && Date.parse(suppression.expiresAt) <= Date.now()) return false;
  if (suppression.id && suppression.id !== finding.id) return false;
  if (suppression.check && suppression.check !== finding.check) return false;
  if (suppression.file && suppression.file !== finding.file) return false;
  return Boolean(suppression.id || suppression.check);
}

function runEchoCheck(
  db: ScipDatabase,
  changedSymbols: ReadonlyArray<{ symbol: string; shortName: string; file: string }>,
  changed: ReadonlySet<string>,
  maxEchoChecks: number,
  minSimilarity: number,
  result: DiffGateResult,
): void {
  result.checksRun.push('echo');
  for (const changedSymbol of changedSymbols.slice(0, maxEchoChecks)) {
    const matches = similar(db, changedSymbol.symbol, { minSimilarity, limit: 3 });
    for (const match of matches) {
      const otherFile = match.fileA === changedSymbol.file ? match.fileB : match.fileA;
      const otherShort = match.fileA === changedSymbol.file ? match.shortNameB : match.shortNameA;
      const otherSymbol = match.fileA === changedSymbol.file ? match.symbolB : match.symbolA;
      if (changed.has(otherFile)) continue; // both sides in the diff — handled by review
      const id = findingId('echo', changedSymbol.symbol, changedSymbol.file, otherSymbol, otherFile);
      result.findings.push({
        id,
        check: 'echo',
        severity: 'warning',
        evidence: 'heuristic',
        confidence: match.similarity,
        file: changedSymbol.file,
        symbol: changedSymbol.symbol,
        relatedFiles: [otherFile],
        message: `${changedSymbol.shortName} (${changedSymbol.file}) is ${Math.round(match.similarity * 100)}% similar to established ${otherShort} (${otherFile})`,
        why: [
          `${changedSymbol.shortName} was changed in this diff.`,
          `${otherShort} is outside this diff and scored ${Math.round(match.similarity * 100)}% similar by ${match.similarityBasis ?? 'callee'} evidence.`,
          `Shared evidence: ${match.sharedCallees.slice(0, 5).join(', ') || '(none listed)'}.`,
        ],
        remediation: `Extend or reuse ${otherShort} instead of keeping the re-implementation.`,
        suppressionHint: `scip-query: ignore echo ${id} -- <reason>`,
      });
    }
  }
  if (changedSymbols.length > maxEchoChecks) {
    result.skipped.push({
      check: 'echo',
      reason: `echo check capped at ${maxEchoChecks} of ${changedSymbols.length} changed symbols`,
    });
  }
}

function runIncompleteMigrationCheck(
  db: ScipDatabase,
  base: string,
  diffPlan: DiffImpactPlan,
  maxHelpers: number,
  result: DiffGateResult,
): void {
  const migration = incompleteMigration(db, { base, maxHelpers, diffPlan });
  if (!migration.available) {
    result.skipped.push({ check: 'incomplete-migration', reason: 'no git history' });
    return;
  }
  result.checksRun.push('incomplete-migration');
  if (migration.note) {
    result.skipped.push({ check: 'incomplete-migration', reason: migration.note });
  }
  for (const finding of migration.findings) {
    const sites = finding.leftovers
      .map((leftover) => `${leftover.shortName} (${leftover.file}, ${Math.round(leftover.containment * 100)}%)`)
      .join(', ');
    const relatedFiles = [
      ...finding.migratedFiles,
      ...finding.leftovers.map((leftover) => leftover.file),
    ];
    const confidence = finding.leftovers.length === 0
      ? undefined
      : Math.max(...finding.leftovers.map((leftover) => leftover.containment));
    const id = findingId('incomplete-migration', finding.helperSymbol, finding.helperFile, relatedFiles.join('|'));
    result.findings.push({
      id,
      check: 'incomplete-migration',
      severity: 'warning',
      evidence: 'heuristic',
      confidence,
      file: finding.helperFile,
      symbol: finding.helperSymbol,
      relatedFiles,
      message: `new helper ${finding.helperShortName} (${finding.helperFile}) is wired into ${finding.migratedFiles.length} file(s), but ${finding.leftovers.length} similar un-migrated site(s) remain: ${sites}`,
      why: [
        `${finding.helperShortName} is new in this diff and already referenced by ${finding.migratedFiles.join(', ')}.`,
        `Unchanged site(s) still contain the helper's callee pattern: ${sites}.`,
      ],
      remediation: `Migrate the remaining sites to ${finding.helperShortName}, or confirm they are intentionally different.`,
      suppressionHint: `scip-query: ignore incomplete-migration ${id} -- <reason>`,
    });
  }
}

function runCoChangePartnerCheck(
  db: ScipDatabase,
  changed: ReadonlySet<string>,
  minTogether: number,
  minConfidence: number,
  result: DiffGateResult,
): void {
    const pairs = getCoChangePairs(db, { minTogether, minConfidence: 0, maxFilesPerCommit: 20 });
  if (!pairs) {
    result.skipped.push({ check: 'co-change-partner', reason: 'no git history' });
    return;
  }
  result.checksRun.push('co-change-partner');
  const reported = new Set<string>();
  for (const pair of pairs) {
    const aChanged = changed.has(pair.fileA);
    const bChanged = changed.has(pair.fileB);
    if (aChanged === bChanged) continue; // both or neither — fine
    const changedSide = aChanged ? pair.fileA : pair.fileB;
    const partner = aChanged ? pair.fileB : pair.fileA;
    // Directional: how often does editing the changed side mean editing the partner?
    const changedSideTotal = aChanged ? pair.changesA : pair.changesB;
    const confidence = changedSideTotal > 0 ? pair.together / changedSideTotal : 0;
    if (confidence < minConfidence) continue;
    if (isCoChangeNoiseFile(partner) || isCoChangeNoiseFile(changedSide)) continue;
    if (!existsSync(`${db.config.projectRoot}/${partner}`)) continue;
      const key = `${changedSide}|${partner}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const id = findingId('co-change-partner', changedSide, partner, String(pair.together));
      result.findings.push({
        id,
        check: 'co-change-partner',
        severity: 'warning',
        evidence: 'change-graph',
        confidence,
        file: changedSide,
        relatedFiles: [partner],
        message: `${changedSide} changed, but ${partner} did not — they change together ${pair.together}x (${Math.round(confidence * 100)}% of the time)`,
        why: [
          `${changedSide} is in this diff and ${partner} is not.`,
          `Git history shows ${pair.together} co-change(s), which is ${Math.round(confidence * 100)}% of changes to the edited side.`,
        ],
        remediation: `Update ${partner} alongside this change, or confirm the coupling no longer holds.`,
        suppressionHint: `scip-query: ignore co-change-partner ${id} -- <reason>`,
      });
    }
  }

function runDocReferenceCheck(
  db: ScipDatabase,
  changed: ReadonlySet<string>,
  result: DiffGateResult,
): void {
  result.checksRun.push('doc-reference');
    for (const citation of docsCitingFiles(db, changed)) {
      if (changed.has(citation.doc)) continue; // doc updated in the same diff
      const id = findingId('doc-reference', citation.doc, citation.cited.join('|'));
      result.findings.push({
        id,
        check: 'doc-reference',
        severity: 'warning',
        evidence: 'change-graph',
        confidence: 1,
        file: citation.doc,
        relatedFiles: citation.cited,
        message: `${citation.doc} cites ${citation.cited.join(', ')} — changed in this diff, doc untouched`,
        why: [
          `${citation.cited.join(', ')} changed in this diff.`,
          `${citation.doc} cites the changed file(s) but was not updated in the same diff.`,
        ],
        remediation: `Re-read ${citation.doc} and update its claims, or update its citations.`,
        suppressionHint: `scip-query: ignore doc-reference ${id} -- <reason>`,
      });
    }
  }

function runUnusedParamsCheck(
  db: ScipDatabase,
  changedFiles: readonly string[],
  result: DiffGateResult,
): void {
  result.checksRun.push('unused-params');
  for (const finding of unusedParams(db, { files: changedFiles, limit: 50 })) {
    const id = findingId('unused-params', finding.symbol, finding.file, finding.unusedTrailing.join('|'));
    result.findings.push({
      id,
      check: 'unused-params',
      severity: 'warning',
      evidence: 'heuristic',
      confidence: 0.85,
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      symbol: finding.symbol,
      message: `${finding.shortName} (${finding.file}) has trailing unused parameter(s): ${finding.unusedTrailing.join(', ')}`,
      why: [
        `${finding.shortName} is in a changed file.`,
        `The trailing parameter(s) ${finding.unusedTrailing.join(', ')} are not referenced in the function body.`,
      ],
      remediation: 'Drop the unused trailing parameters and their call-site arguments.',
      suppressionHint: `scip-query: ignore unused-params ${id} -- <reason>`,
    });
  }
}

function runNewDeadCheck(
  db: ScipDatabase,
  changedSymbols: ReadonlyArray<{ symbol: string; shortName: string; file: string; fanIn: number }>,
  result: DiffGateResult,
): void {
  result.checksRun.push('new-dead');
  const index = new ProjectIndex(db);
  for (const changedSymbol of changedSymbols) {
    if (changedSymbol.fanIn > 0) continue;
      if (index.fileKind(changedSymbol.file) === 'test') continue;
      if (isEntrySurface(db, changedSymbol.file)) continue;
      if (isRootedSymbol(db, changedSymbol.symbol, changedSymbol.file)) continue;
      const id = findingId('new-dead', changedSymbol.symbol, changedSymbol.file);
      result.findings.push({
        id,
        check: 'new-dead',
        severity: 'warning',
        evidence: 'graph-fact',
        confidence: 0.9,
        file: changedSymbol.file,
        symbol: changedSymbol.symbol,
        message: `${changedSymbol.shortName} (${changedSymbol.file}) was changed but has zero indexed consumers`,
        why: [
          `${changedSymbol.shortName} is a changed production symbol.`,
          'The index reports zero consumers for this symbol.',
          'The symbol is not in a detected entry surface or configured live root.',
        ],
        remediation: 'Wire it up, or remove it before it becomes permanent dead code.',
        suppressionHint: `scip-query: ignore new-dead ${id} -- <reason>`,
      });
    }
  }

function runBaselineCheck(db: ScipDatabase, result: DiffGateResult): void {
  if (!existsSync(resolveBaselinePath(db))) {
    result.skipped.push({ check: 'baseline', reason: 'no .scipquery-baseline.json — run health --write-baseline to enable' });
    return;
  }
  result.checksRun.push('baseline');
  const comparison = checkHealthBaseline(db);
  for (const finding of comparison.newFindings) {
    const id = findingId('baseline', finding);
    result.findings.push({
      id,
      check: 'baseline',
      severity: 'error',
      evidence: 'baseline',
      confidence: 1,
      message: `new finding vs committed baseline: ${finding}`,
      why: [
        'A committed health baseline exists.',
        'The current health result contains a finding not present in that baseline.',
      ],
      remediation: 'Fix the finding, or knowingly accept it via health --write-baseline.',
      suppressionHint: `scip-query: ignore baseline ${id} -- <reason>`,
    });
  }
}

function findingId(check: DiffGateCheck, ...parts: readonly string[]): string {
  const digest = createHash('sha256')
    .update([check, ...parts].join('\0'))
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `SQ${digest}`;
}
