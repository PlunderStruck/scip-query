import { existsSync } from 'node:fs';
import type { ScipDatabase } from '../storage/db.js';
import { isEntrySurface, isRootedSymbol } from '../analysis/file-classifier.js';
import { getCoChangePairs } from '../analysis/git-history.js';
import { ProjectIndex } from '../core/project-index.js';
import { isCoChangeNoiseFile } from './co-change.js';
import { diffImpact } from './diff-impact.js';
import { docsCitingFiles } from './doc-drift.js';
import { checkHealthBaseline, resolveBaselinePath } from './health-baseline.js';
import { incompleteMigration } from './incomplete-migration.js';
import { similar } from './similar.js';
import { unusedParams } from './unused-params.js';

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

export interface DiffGateFinding {
  check: DiffGateCheck;
  message: string;
  /** Concrete remediation an agent can act on without human triage. */
  remediation: string;
}

export interface DiffGateResult {
  base: string;
  changedFiles: string[];
  changedSymbols: number;
  checksRun: DiffGateCheck[];
  /** Checks that could not run (no git history, no baseline file, ...). */
  skipped: Array<{ check: DiffGateCheck; reason: string }>;
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

  const impact = diffImpact(db, { base });
  const changedFiles = impact.changedFiles;
  const changed = new Set(changedFiles);
  const result: DiffGateResult = {
    base,
    changedFiles,
    changedSymbols: impact.changedSymbols.length,
    checksRun: [],
    skipped: [],
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
  runUnlessSkipped('incomplete-migration', () => runIncompleteMigrationCheck(db, base, maxHelpers, result));
  runUnlessSkipped('co-change-partner', () => runCoChangePartnerCheck(db, changed, minTogether, minConfidence, result));
  runUnlessSkipped('doc-reference', () => runDocReferenceCheck(db, changed, result));
  runUnlessSkipped('unused-params', () => runUnusedParamsCheck(db, changedFiles, result));
  runUnlessSkipped('new-dead', () => runNewDeadCheck(db, impact.changedSymbols, result));
  runUnlessSkipped('baseline', () => runBaselineCheck(db, result));

  return result;
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
      if (changed.has(otherFile)) continue; // both sides in the diff — handled by review
      result.findings.push({
        check: 'echo',
        message: `${changedSymbol.shortName} (${changedSymbol.file}) is ${Math.round(match.similarity * 100)}% similar to established ${otherShort} (${otherFile})`,
        remediation: `Extend or reuse ${otherShort} instead of keeping the re-implementation.`,
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
  maxHelpers: number,
  result: DiffGateResult,
): void {
  const migration = incompleteMigration(db, { base, maxHelpers });
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
    result.findings.push({
      check: 'incomplete-migration',
      message: `new helper ${finding.helperShortName} (${finding.helperFile}) is wired into ${finding.migratedFiles.length} file(s), but ${finding.leftovers.length} similar un-migrated site(s) remain: ${sites}`,
      remediation: `Migrate the remaining sites to ${finding.helperShortName}, or confirm they are intentionally different.`,
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
  const pairs = getCoChangePairs(db, { minTogether, minConfidence: 0 });
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
    result.findings.push({
      check: 'co-change-partner',
      message: `${changedSide} changed, but ${partner} did not — they change together ${pair.together}x (${Math.round(confidence * 100)}% of the time)`,
      remediation: `Update ${partner} alongside this change, or confirm the coupling no longer holds.`,
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
    result.findings.push({
      check: 'doc-reference',
      message: `${citation.doc} cites ${citation.cited.join(', ')} — changed in this diff, doc untouched`,
      remediation: `Re-read ${citation.doc} and update its claims, or update its citations.`,
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
    result.findings.push({
      check: 'unused-params',
      message: `${finding.shortName} (${finding.file}) has trailing unused parameter(s): ${finding.unusedTrailing.join(', ')}`,
      remediation: 'Drop the unused trailing parameters and their call-site arguments.',
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
    result.findings.push({
      check: 'new-dead',
      message: `${changedSymbol.shortName} (${changedSymbol.file}) was changed but has zero indexed consumers`,
      remediation: 'Wire it up, or remove it before it becomes permanent dead code.',
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
    result.findings.push({
      check: 'baseline',
      message: `new finding vs committed baseline: ${finding}`,
      remediation: 'Fix the finding, or knowingly accept it via health --write-baseline.',
    });
  }
}
