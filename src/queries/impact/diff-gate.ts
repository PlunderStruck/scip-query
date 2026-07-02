import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ScipDatabase } from '../../storage/db.js';
import { isEntrySurface, isRootedSymbol } from '../../analysis/file-classifier.js';
import { gitEvidenceProduct } from '../../analysis/git-history.js';
import type { CoChangeCommitScope, CoChangeRecency, CoChangeSubjectContext } from '../../analysis/git-history.js';
import { ProjectIndex } from '../../core/project-index.js';
import {
  classifyCoChangePartner,
  coChangeStructuralLinkChecker,
  declaredCouplingSuggestionForPair,
  isCoChangeNoiseFile,
} from './co-change.js';
import type { CoChangePartnerClass, DeclaredCouplingSuggestion } from './co-change.js';
import { baseContentPathsForDiffPlan, createBaseContentReader, diffImpact, diffImpactPlan } from './diff-impact.js';
import type { AttributionNote, BaseContentReader, ChangedLineRange, DiffImpactPlan } from './diff-impact.js';
import { baselineFindingMetadata } from './diff-gate-baseline-policy.js';
import { docReferencePolicy } from './diff-gate-doc-policy.js';
import type { DiffGateActionTier, DocCitationKind } from './diff-gate-types.js';
import { docsCitingFiles } from '../cleanup/doc-drift.js';
import { exactDuplicateBodyMatches } from '../cleanup/duplicate-bodies.js';
import { allTwinGroups } from '../cleanup/twin-drift.js';
import type { TwinGroup } from '../cleanup/twin-drift.js';
import { checkHealthBaseline, resolveBaselinePath } from '../health/health-baseline.js';
import { incompleteMigration } from './incomplete-migration.js';
import { similar } from '../cleanup/similar.js';
import { unusedParams } from '../cleanup/unused-params.js';
import { escapeRegex } from '../../source/source-stripper.js';
import type { FindingSuppression } from '../../domain/types.js';
import { isCallableSymbol, leafName, leafSuffix } from '../../symbols/symbol-parser.js';
import { profileSpan } from '../../instrumentation/profile.js';

export type DiffGateCheck =
  | 'echo'
  | 'incomplete-migration'
  | 'co-change-partner'
  | 'twin-partner'
  | 'doc-reference'
  | 'unused-params'
  | 'new-dead'
  | 'baseline';

/** Canonical check list — the CLI validates `--skip` values against this. */
export const DIFF_GATE_CHECKS: readonly DiffGateCheck[] = [
  'echo',
  'incomplete-migration',
  'co-change-partner',
  'twin-partner',
  'doc-reference',
  'unused-params',
  'new-dead',
  'baseline',
];

export type DiffGateEvidence = 'graph-fact' | 'semantic' | 'heuristic' | 'change-graph' | 'baseline';

export type DiffGateSeverity = 'info' | 'warning' | 'error';

export type { DiffGateActionTier, DocCitationKind } from './diff-gate-types.js';

export interface DiffGateFinding {
  id: string;
  check: DiffGateCheck;
  severity: DiffGateSeverity;
  evidence: DiffGateEvidence;
  /** Actionability tier for reviewers and automation. */
  actionTier?: DiffGateActionTier;
  /** Stable grouping key for multiple evidence rows behind one review item. */
  groupKey?: string;
  confidence?: number;
  file?: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  relatedFiles?: string[];
  /**
   * Advisory findings surface useful signal but must never be the sole
   * cause of a nonzero diff-gate exit code (see `blockingFindings`). Used
   * by twin-partner until calibration (remediation plan phase 21) says the
   * check's precision earns a hard gate.
   */
  advisory?: boolean;
  /** Underlying analyzer family when one gate finding wraps another analyzer. */
  sourceAnalyzer?: string;
  /** Stable root-cause grouping key inside the source analyzer. */
  rootCauseKey?: string;
  /** Relationship label for co-change partner findings. */
  partnerClass?: CoChangePartnerClass;
  partnerClassReasons?: string[];
  declaredCouplingSuggestion?: DeclaredCouplingSuggestion;
  commitScope?: CoChangeCommitScope;
  recency?: CoChangeRecency;
  focusedTogether?: number;
  broadTogether?: number;
  broadCommitRatio?: number;
  lastTogetherAt?: number;
  recentTogether?: number;
  subjectContext?: CoChangeSubjectContext;
  /** Why a doc cites changed code, when check is doc-reference. */
  citationKind?: DocCitationKind;
  citationKindReasons?: string[];
  /** Bounded nearby doc text that contains the changed-file citation. */
  citedClaims?: string[];
  message: string;
  why: string[];
  /** Concrete remediation an agent can act on without human triage. */
  remediation: string;
  suppressionHint?: string;
  legacySuppressionIds?: string[];
}

export interface DiffGateRootCauseGroup {
  groupKey: string;
  check: DiffGateCheck;
  severity: DiffGateSeverity;
  actionTier?: DiffGateActionTier;
  sourceAnalyzer?: string;
  rootCauseKey?: string;
  count: number;
  findingIds: string[];
  files: string[];
  relatedFiles: string[];
  message: string;
  remediation: string;
}

interface EchoMatch {
  otherFile: string;
  otherShort: string;
  otherSymbol: string;
  similarity: number;
  similarityBasis: 'callees' | 'source-tokens' | 'exact-body';
  sharedEvidence: string[];
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
  attributionNotes: AttributionNote[];
  /** Root-cause review items derived from unsuppressed findings. */
  rootCauseGroups?: DiffGateRootCauseGroup[];
  note?: string;
}

type DiffGateFindingDraft = Omit<DiffGateFinding, 'suppressionHint'>;

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
 * - twin-partner:       (advisory, never fails the gate alone) a changed
 *                       symbol has a same-(near-)name twin elsewhere that
 *                       was identical or already-divergent and is NOT in
 *                       the diff — a one-sided fix candidate.
 * - doc-reference:      a doc cites a changed file but isn't updated in the
 *                       diff — the drift starts here.
 * - unused-params:      changed files now contain trailing parameters no body
 *                       uses — speculative generality landing fresh.
 * - new-dead:           changed symbols with zero indexed consumers — possibly
 *                       a half-wired feature.
 * - baseline:           optional full health-baseline ratchet.
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
    includeBaseline?: boolean;
    scanLimit?: number;
    semantic?: boolean;
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
    includeBaseline = false,
    scanLimit,
  } = opts;
  const semantic = opts.semantic !== false;
  const skip = new Set(opts.skip ?? []);

  const impactPlan = diffImpactPlan(db, { base });
  const impact = diffImpact(db, { base, plan: impactPlan });
  const changedFiles = impact.changedFiles;
  const changed = new Set(changedFiles);
  const changedGitFiles = new Set(impactPlan.changedFileLines);
  const changedForCoordination = new Set([...changed, ...changedGitFiles]);
  const baseContentAt = createBaseContentReader(
    db.config.projectRoot,
    base,
    baseContentPathsForDiffPlan(impactPlan, changedFiles),
  );
  const symbolPreexistedAtBase = symbolPreexistenceChecker(db.config.projectRoot, base, impactPlan, baseContentAt);
  const result: DiffGateResult = {
    base,
    changedFiles,
    changedSymbols: impact.changedSymbols.length,
    checksRun: [],
    skipped: [],
    suppressed: [],
    findings: [],
    attributionNotes: impact.attributionNotes,
    rootCauseGroups: [],
    note: impact.summary.note,
  };
  if (changedFiles.length === 0) return result;

  const runUnlessSkipped = (check: DiffGateCheck, run: () => void): void => {
    if (skip.has(check)) {
      result.skipped.push({ check, reason: 'skipped via --skip' });
      return;
    }
    const findingsBefore = result.findings.length;
    const skippedBefore = result.skipped.length;
    const checksRunBefore = result.checksRun.length;
    profileSpan(`diff-gate.check.${check}`, run, () => ({
      check,
      changedFiles: changedFiles.length,
      changedSymbols: impact.changedSymbols.length,
      findingsAdded: result.findings.length - findingsBefore,
      skippedAdded: result.skipped.length - skippedBefore,
      checksRunAdded: result.checksRun.length - checksRunBefore,
    }));
  };
  runUnlessSkipped('echo', () =>
    runEchoCheck(
      db,
      impact.changedSymbols,
      changed,
      symbolPreexistedAtBase,
      maxEchoChecks,
      minSimilarity,
      scanLimit,
      semantic,
      result,
    ),
  );
  runUnlessSkipped('incomplete-migration', () =>
    runIncompleteMigrationCheck(db, base, impactPlan, maxHelpers, scanLimit, semantic, baseContentAt, result),
  );
  runUnlessSkipped('co-change-partner', () =>
    runCoChangePartnerCheck(db, changedForCoordination, minTogether, minConfidence, result),
  );
  runUnlessSkipped('twin-partner', () => runTwinPartnerCheck(db, impact.changedSymbols, changed, scanLimit, result));
  runUnlessSkipped('doc-reference', () =>
    runDocReferenceCheck(db, changed, changedGitFiles, impactPlan.changedRanges, result),
  );
  runUnlessSkipped('unused-params', () => runUnusedParamsCheck(db, changedFiles, result));
  runUnlessSkipped('new-dead', () => runNewDeadCheck(db, impact.changedSymbols, symbolPreexistedAtBase, result));
  if (includeBaseline) runUnlessSkipped('baseline', () => runBaselineCheck(db, result));
  applyStructuredSuppressions(result, db.config.suppressions ?? []);
  result.rootCauseGroups = diffGateRootCauseGroups(result.findings);

  return result;
}

/**
 * Findings that count toward the pass/fail decision. Advisory findings
 * (currently: twin-partner) still print and are still suppressible, but a
 * diff with only advisory findings must exit 0 — see the `advisory` field
 * doc comment on `DiffGateFinding`.
 */
export function blockingFindings(findings: readonly DiffGateFinding[]): DiffGateFinding[] {
  return findings.filter((finding) => !finding.advisory);
}

function diffGateRootCauseGroups(findings: readonly DiffGateFinding[]): DiffGateRootCauseGroup[] {
  const groups = new Map<
    string,
    Omit<DiffGateRootCauseGroup, 'files' | 'relatedFiles'> & {
      files: Set<string>;
      relatedFiles: Set<string>;
    }
  >();

  for (const finding of findings) {
    const groupKey = finding.groupKey ?? `${finding.check}:${finding.id}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        check: finding.check,
        severity: finding.severity,
        actionTier: finding.actionTier,
        sourceAnalyzer: finding.sourceAnalyzer,
        rootCauseKey: finding.rootCauseKey,
        count: 0,
        findingIds: [],
        files: new Set<string>(),
        relatedFiles: new Set<string>(),
        message: finding.message,
        remediation: finding.remediation,
      };
      groups.set(groupKey, group);
    }

    group.count += 1;
    group.findingIds.push(finding.id);
    group.severity = strongerSeverity(group.severity, finding.severity);
    group.actionTier = strongerActionTier(group.actionTier, finding.actionTier);
    if (finding.file) group.files.add(finding.file);
    for (const file of finding.relatedFiles ?? []) group.relatedFiles.add(file);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      files: [...group.files].sort(),
      relatedFiles: [...group.relatedFiles].sort(),
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        severityRank(right.severity) - severityRank(left.severity) ||
        left.groupKey.localeCompare(right.groupKey),
    );
}

function strongerSeverity(left: DiffGateSeverity, right: DiffGateSeverity): DiffGateSeverity {
  return severityRank(right) > severityRank(left) ? right : left;
}

function severityRank(severity: DiffGateSeverity): number {
  return severity === 'error' ? 2 : severity === 'warning' ? 1 : 0;
}

function strongerActionTier(
  left: DiffGateActionTier | undefined,
  right: DiffGateActionTier | undefined,
): DiffGateActionTier | undefined {
  if (!left) return right;
  if (!right) return left;
  return actionTierRank(right) > actionTierRank(left) ? right : left;
}

function actionTierRank(actionTier: DiffGateActionTier): number {
  return actionTier === 'direct' ? 2 : actionTier === 'signal' ? 1 : 0;
}

function applyStructuredSuppressions(result: DiffGateResult, suppressions: readonly FindingSuppression[]): void {
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

function suppressionMatches(suppression: FindingSuppression, finding: DiffGateFinding): boolean {
  if (!suppression.reason || suppression.reason.trim() === '') return false;
  if (suppression.expiresAt && Date.parse(suppression.expiresAt) <= Date.now()) return false;
  if (suppression.id && suppression.id !== finding.id && !finding.legacySuppressionIds?.includes(suppression.id)) {
    return false;
  }
  if (suppression.check && suppression.check !== finding.check) return false;
  if (suppression.file && suppression.file !== finding.file) return false;
  return Boolean(suppression.id || suppression.check);
}

function recordFinding(result: DiffGateResult, finding: DiffGateFindingDraft): void {
  result.findings.push({
    ...finding,
    suppressionHint: `scip-query: ignore ${finding.check} ${finding.id} -- <reason>`,
  });
}

function runEchoCheck(
  db: ScipDatabase,
  changedSymbols: ReadonlyArray<{ symbol: string; shortName: string; file: string }>,
  changed: ReadonlySet<string>,
  symbolPreexistedAtBase: (changedSymbol: { symbol: string; file: string }) => boolean,
  maxEchoChecks: number,
  minSimilarity: number,
  scanLimit: number | undefined,
  semantic: boolean,
  result: DiffGateResult,
): void {
  result.checksRun.push('echo');
  for (const changedSymbol of changedSymbols.slice(0, maxEchoChecks)) {
    if (!isCallableSymbol(changedSymbol.symbol)) continue;
    if (symbolPreexistedAtBase(changedSymbol)) continue;
    const exactMatches = exactDuplicateBodyMatches(db, changedSymbol.symbol, {
      maxLoc: 15,
      scanLimit,
    })
      .filter((match) => !changed.has(match.file))
      .slice(0, 5)
      .map(
        (match): EchoMatch => ({
          otherFile: match.file,
          otherShort: match.shortName,
          otherSymbol: match.symbol,
          similarity: 1,
          similarityBasis: 'exact-body',
          sharedEvidence: [`exact normalized body (${match.loc} LOC)`],
        }),
      );
    if (exactMatches.length > 0) {
      const id = findingId('echo', changedSymbol.symbol, changedSymbol.file);
      const legacyId = findingId(
        'echo',
        changedSymbol.symbol,
        changedSymbol.file,
        ...exactMatches.map((match) => `${match.otherSymbol}|${match.otherFile}`).sort(),
      );
      const topMatch = exactMatches[0]!;
      recordFinding(result, {
        id,
        legacySuppressionIds: legacyId === id ? undefined : [legacyId],
        groupKey: id,
        actionTier: 'direct',
        check: 'echo',
        severity: 'warning',
        evidence: 'heuristic',
        confidence: 1,
        file: changedSymbol.file,
        symbol: changedSymbol.symbol,
        relatedFiles: [...new Set(exactMatches.map((match) => match.otherFile))].sort(),
        sourceAnalyzer: 'duplicate-bodies',
        rootCauseKey: `${changedSymbol.symbol}:${topMatch.otherSymbol}`,
        message: echoMessage(changedSymbol, exactMatches),
        why: echoWhy(changedSymbol, exactMatches),
        remediation: echoRemediation('direct', changedSymbol.shortName, topMatch.otherShort),
      });
      continue;
    }
    const matches = similar(db, changedSymbol.symbol, {
      minSimilarity,
      limit: 5,
      scanLimit,
      semantic,
      sourceCandidateMode: 'target-pruned',
    });
    const eligibleMatches: EchoMatch[] = [];
    for (const match of matches) {
      const otherFile = match.fileA === changedSymbol.file ? match.fileB : match.fileA;
      const otherShort = match.fileA === changedSymbol.file ? match.shortNameB : match.shortNameA;
      const otherSymbol = match.fileA === changedSymbol.file ? match.symbolB : match.symbolA;
      if (changed.has(otherFile)) continue; // both sides in the diff — handled by review
      eligibleMatches.push({
        otherFile,
        otherShort,
        otherSymbol,
        similarity: match.similarity,
        similarityBasis: match.similarityBasis ?? 'callees',
        sharedEvidence: match.sharedCallees,
      });
    }
    if (eligibleMatches.length === 0) continue;
    const topMatch = eligibleMatches[0]!;
    const legacyId = findingId(
      'echo',
      changedSymbol.symbol,
      changedSymbol.file,
      ...eligibleMatches.map((match) => `${match.otherSymbol}|${match.otherFile}`).sort(),
    );
    const id = findingId('echo', changedSymbol.symbol, changedSymbol.file);
    const actionTier = echoActionTier(changedSymbol, eligibleMatches);
    recordFinding(result, {
      id,
      legacySuppressionIds: legacyId === id ? undefined : [legacyId],
      groupKey: id,
      actionTier,
      check: 'echo',
      severity: 'warning',
      evidence: 'heuristic',
      confidence: topMatch.similarity,
      file: changedSymbol.file,
      symbol: changedSymbol.symbol,
      relatedFiles: [...new Set(eligibleMatches.map((match) => match.otherFile))].sort(),
      message: echoMessage(changedSymbol, eligibleMatches),
      why: echoWhy(changedSymbol, eligibleMatches),
      remediation: echoRemediation(actionTier, changedSymbol.shortName, topMatch.otherShort),
    });
  }
  if (changedSymbols.length > maxEchoChecks) {
    result.skipped.push({
      check: 'echo',
      reason: `echo check capped at ${maxEchoChecks} of ${changedSymbols.length} changed symbols`,
    });
  }
}

function echoActionTier(changedSymbol: { symbol: string }, matches: readonly EchoMatch[]): DiffGateActionTier {
  const directSourceMatch = matches.some((match) => isDirectSourceEcho(changedSymbol.symbol, match));
  return directSourceMatch ? 'direct' : 'signal';
}

function isDirectSourceEcho(changedSymbol: string, match: EchoMatch): boolean {
  if (match.similarityBasis === 'exact-body') return true;
  if (match.similarityBasis !== 'source-tokens') return false;
  if (match.similarity < 0.98 || match.sharedEvidence.length > 8) return false;

  const changedLeaf = leafName(changedSymbol);
  const otherLeaf = leafName(match.otherSymbol);
  if (!changedLeaf || !otherLeaf) return false;
  if (changedLeaf === otherLeaf) return true;
  if (isGenericTokenScaffold(match.sharedEvidence)) return false;
  return haveCompatibleLeafTokens(changedLeaf, otherLeaf);
}

function haveCompatibleLeafTokens(a: string, b: string): boolean {
  const aTokens = leafTokens(a);
  const bTokens = leafTokens(b);
  if (aTokens.length === 0 || bTokens.length === 0) return false;
  const bSet = new Set(bTokens);
  const shared = aTokens.filter((token) => bSet.has(token)).length;
  return shared >= 2 && shared / Math.min(aTokens.length, bTokens.length) >= 0.5;
}

function leafTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2);
}

const GENERIC_TOKEN_SCAFFOLD_EVIDENCE = new Set(['bytes', 'crypto', 'hex', 'num', 'random', 'secret', 'to', 'token']);

function isGenericTokenScaffold(sharedEvidence: readonly string[]): boolean {
  return (
    sharedEvidence.length >= 3 &&
    sharedEvidence.every((token) => GENERIC_TOKEN_SCAFFOLD_EVIDENCE.has(token.toLowerCase()))
  );
}

function echoMessage(changedSymbol: { shortName: string; file: string }, matches: readonly EchoMatch[]): string {
  const topMatch = matches[0]!;
  const topScore = Math.round(topMatch.similarity * 100);
  if (matches.length === 1) {
    return `${changedSymbol.shortName} (${changedSymbol.file}) is ${topScore}% similar to established ${topMatch.otherShort} (${topMatch.otherFile})`;
  }
  return `${changedSymbol.shortName} (${changedSymbol.file}) resembles ${matches.length} established symbol(s); strongest is ${topScore}% similar to ${topMatch.otherShort} (${topMatch.otherFile})`;
}

function echoWhy(changedSymbol: { shortName: string }, matches: readonly EchoMatch[]): string[] {
  const lines = [`${changedSymbol.shortName} was changed in this diff.`];
  for (const match of matches.slice(0, 3)) {
    lines.push(
      `${match.otherShort} is outside this diff and scored ${Math.round(match.similarity * 100)}% similar by ${match.similarityBasis} evidence.`,
    );
    lines.push(`Shared evidence: ${match.sharedEvidence.slice(0, 5).join(', ') || '(none listed)'}.`);
  }
  if (matches.length > 3) lines.push(`${matches.length - 3} additional similar match(es) grouped into this finding.`);
  return lines;
}

function echoRemediation(actionTier: DiffGateActionTier, changedShort: string, topOtherShort: string): string {
  if (actionTier === 'direct') {
    return `Extract or reuse the shared behavior with ${topOtherShort}, or keep the duplicate with a suppression reason.`;
  }
  return `Review whether ${changedShort} is intentionally parallel to the established implementation(s); extract shared behavior only if the product semantics match.`;
}

function runIncompleteMigrationCheck(
  db: ScipDatabase,
  base: string,
  diffPlan: DiffImpactPlan,
  maxHelpers: number,
  scanLimit: number | undefined,
  semantic: boolean,
  baseContentAt: BaseContentReader,
  result: DiffGateResult,
): void {
  const migration = incompleteMigration(db, { base, maxHelpers, diffPlan, scanLimit, semantic, baseContentAt });
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
      .map(
        (leftover) =>
          `${leftover.shortName} (${leftover.file}, ${Math.round(
            leftover.containment * 100,
          )}% helper / ${Math.round(leftover.siteCoverage * 100)}% site, ${leftover.migrationScope})`,
      )
      .join(', ');
    const scopeHints = finding.leftovers
      .map((leftover) => `${leftover.shortName}: ${leftover.migrationScope} (${leftover.migrationScopeReasons[0]})`)
      .join('; ');
    const relatedFiles = [...finding.migratedFiles, ...finding.leftovers.map((leftover) => leftover.file)];
    const confidence =
      finding.leftovers.length === 0
        ? undefined
        : Math.max(...finding.leftovers.map((leftover) => Math.min(leftover.containment, leftover.siteCoverage)));
    const hasPossibleSubtype = finding.leftovers.some((leftover) => leftover.migrationScope === 'possible-subtype');
    const legacyId = findingId(
      'incomplete-migration',
      finding.helperSymbol,
      finding.helperFile,
      relatedFiles.join('|'),
    );
    const id = findingId('incomplete-migration', finding.helperSymbol, finding.helperFile);
    recordFinding(result, {
      id,
      legacySuppressionIds: legacyId === id ? undefined : [legacyId],
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
        `Helper shape: ${finding.helperShape}; ${finding.specificHelperCalleeCount}/${finding.helperCalleeCount} helper callees are specific enough to score.`,
        `Unchanged site(s) still contain the helper's callee pattern: ${sites}.`,
        `Migration scope hints: ${scopeHints}.`,
      ],
      remediation: hasPossibleSubtype
        ? `Migrate same-scope sites to ${finding.helperShortName}; review possible subtype/variant sites before applying the helper.`
        : `Migrate the remaining sites to ${finding.helperShortName}, or confirm they are intentionally different.`,
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
  const pairs = gitEvidenceProduct(db).directionalCoChangePairsForFiles(changed, {
    minTogether,
    minConfidence: 0,
    maxFilesPerCommit: 20,
  });
  if (!pairs) {
    result.skipped.push({ check: 'co-change-partner', reason: 'no git history' });
    return;
  }
  result.checksRun.push('co-change-partner');
  const reported = new Set<string>();
  let structurallyLinked: ReturnType<typeof coChangeStructuralLinkChecker> | undefined;
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
    const legacyId = findingId('co-change-partner', changedSide, partner, String(pair.together));
    const id = findingId('co-change-partner', changedSide, partner);
    const classification = classifyCoChangePartner(changedSide, partner);
    const declaredCouplingSuggestion = declaredCouplingSuggestionForPair(
      {
        fileA: changedSide,
        fileB: partner,
        together: pair.together,
        confidence,
        commitScope: pair.commitScope,
        recency: pair.recency,
        subjectContext: pair.subjectContext,
      },
      classification,
      (structurallyLinked ??= coChangeStructuralLinkChecker(db))(changedSide, partner),
    );
    const rootCauseKey = [changedSide, partner].sort().join('|');
    result.findings.push({
      id,
      legacySuppressionIds: legacyId === id ? undefined : [legacyId],
      check: 'co-change-partner',
      severity: 'warning',
      evidence: 'change-graph',
      actionTier: 'signal',
      groupKey: `co-change-partner:${rootCauseKey}`,
      confidence,
      file: changedSide,
      relatedFiles: [partner],
      sourceAnalyzer: 'co-change',
      rootCauseKey,
      partnerClass: classification.partnerClass,
      partnerClassReasons: classification.reasons,
      commitScope: pair.commitScope,
      recency: pair.recency,
      focusedTogether: pair.focusedTogether,
      broadTogether: pair.broadTogether,
      broadCommitRatio: pair.broadCommitRatio,
      lastTogetherAt: pair.lastTogetherAt,
      recentTogether: pair.recentTogether,
      subjectContext: pair.subjectContext,
      ...(declaredCouplingSuggestion ? { declaredCouplingSuggestion } : {}),
      message: `${changedSide} changed, but ${partner} did not — they change together ${pair.together}x (${Math.round(confidence * 100)}% of the time)`,
      why: [
        `${changedSide} is in this diff and ${partner} is not.`,
        `Git history shows ${pair.together} co-change(s), which is ${Math.round(confidence * 100)}% of changes to the edited side.`,
        `History context: ${coChangeHistorySummary(pair)}.`,
        `Subject context: ${coChangeSubjectContextSummary(pair.subjectContext)}.`,
        ...coChangeHistoryCaveats(pair),
        `Partner class: ${classification.partnerClass} (${classification.reasons.join('; ')}).`,
      ],
      remediation: declaredCouplingSuggestion
        ? `Update ${partner} alongside this change, declare the coupling "${declaredCouplingSuggestion.name}", or confirm the coupling no longer holds.`
        : `Update ${partner} alongside this change, or confirm the coupling no longer holds.`,
    });
  }
}

/**
 * twin-partner (advisory): symbol-level companion to co-change-partner.
 * File-level co-change history can't see a same-name symbol pair whose
 * files never happened to co-change historically; twin-drift's grouping
 * gives us that symbol-level identity instead. Ships advisory — see the
 * `advisory` field doc comment on `DiffGateFinding` — until phase 21
 * calibration measures its precision on real repos.
 */
function runTwinPartnerCheck(
  db: ScipDatabase,
  changedSymbols: ReadonlyArray<{ symbol: string; shortName: string; file: string }>,
  changed: ReadonlySet<string>,
  scanLimit: number | undefined,
  result: DiffGateResult,
): void {
  result.checksRun.push('twin-partner');
  const groups = allTwinGroups(db, { scanLimit }).filter(
    (group) => group.relationship === 'divergent' || group.relationship === 'identical',
  );
  if (groups.length === 0) return;

  const groupBySymbol = new Map<string, TwinGroup>();
  for (const group of groups) {
    for (const member of group.members) groupBySymbol.set(member.symbol, group);
  }

  const reported = new Set<string>();
  for (const changedSymbol of changedSymbols) {
    if (!isCallableSymbol(changedSymbol.symbol)) continue;
    const group = groupBySymbol.get(changedSymbol.symbol);
    if (!group) continue;
    const unchangedPartners = group.members.filter(
      (member) => member.symbol !== changedSymbol.symbol && !changed.has(member.file),
    );
    if (unchangedPartners.length === 0) continue;

    const rootCauseKey = [changedSymbol.symbol, ...unchangedPartners.map((partner) => partner.symbol)].sort().join('|');
    if (reported.has(rootCauseKey)) continue;
    reported.add(rootCauseKey);

    const partner = unchangedPartners[0]!;
    const id = findingId('twin-partner', changedSymbol.symbol, changedSymbol.file, partner.symbol);
    recordFinding(result, {
      id,
      groupKey: `twin-partner:${rootCauseKey}`,
      check: 'twin-partner',
      severity: 'warning',
      evidence: 'heuristic',
      actionTier: 'signal',
      advisory: true,
      confidence: group.relationship === 'identical' ? 1 : Math.max(0, 1 - group.maxDivergence),
      file: changedSymbol.file,
      symbol: changedSymbol.symbol,
      relatedFiles: unchangedPartners.map((entry) => entry.file).sort(),
      sourceAnalyzer: 'twin-drift',
      rootCauseKey,
      message: `${changedSymbol.shortName} (${changedSymbol.file}) changed but its same-name twin ${partner.shortName} (${partner.file}) did not — verify the change shouldn't apply to both, or consolidate them.`,
      why: [
        `${changedSymbol.symbol} is in this diff.`,
        `${partner.symbol} shares its (near-)name and is classified '${group.relationship}' with it, but ${partner.file} is not in this diff.`,
        group.relationship === 'divergent'
          ? `The two bodies already diverge (~${Math.round(group.maxDivergence * 100)}% token difference) — this diff may widen or narrow that drift.`
          : 'The two bodies were byte-identical before this diff.',
        'Advisory: twin-partner never fails the gate by itself — see the twin-partner entry in the diff-gate checks table.',
      ],
      remediation: `Update ${partner.file} alongside this change, consolidate ${changedSymbol.shortName}/${partner.shortName} into one helper, or confirm the twin should diverge on purpose.`,
    });
  }
}

function coChangeHistorySummary(pair: {
  commitScope: CoChangeCommitScope;
  recency: CoChangeRecency;
  focusedTogether: number;
  broadTogether: number;
  broadCommitRatio: number;
  recentTogether: number;
  lastTogetherAt: number;
}): string {
  return `${pair.commitScope}/${pair.recency}; ${pair.focusedTogether} focused, ${
    pair.broadTogether
  } broad-sweep (${Math.round(pair.broadCommitRatio * 100)}% broad), ${pair.recentTogether} recent, last ${formatUnixDate(
    pair.lastTogetherAt,
  )}`;
}

function coChangeSubjectContextSummary(context: CoChangeSubjectContext): string {
  const labels = context.subjectLabels.length > 0 ? context.subjectLabels.slice(0, 5).join(', ') : 'none inferred';
  const refs = context.issueRefs.length > 0 ? context.issueRefs.slice(0, 5).join(', ') : 'none';
  const samples =
    context.sampleSubjects.length > 0
      ? context.sampleSubjects
          .slice(0, 3)
          .map((subject) => `"${subject}"`)
          .join('; ')
      : 'none';
  return `labels ${labels}; refs ${refs}; samples ${samples}; external issue/PR labels ${context.externalIssueLabelStatus}`;
}

function coChangeHistoryCaveats(pair: { commitScope: CoChangeCommitScope; recency: CoChangeRecency }): string[] {
  const caveats: string[] = [];
  if (pair.commitScope === 'broad-sweep') {
    caveats.push('Broad-sweep history is weaker than focused co-edits; confirm this is a real coordination contract.');
  }
  if (pair.recency === 'stale') {
    caveats.push('The pair has no co-change in the recent history window; confirm the coupling still holds.');
  }
  return caveats;
}

function formatUnixDate(timestampSeconds: number): string {
  if (timestampSeconds <= 0) return 'unknown';
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

function runDocReferenceCheck(
  db: ScipDatabase,
  changed: ReadonlySet<string>,
  changedGitFiles: ReadonlySet<string>,
  changedRanges: readonly ChangedLineRange[],
  result: DiffGateResult,
): void {
  result.checksRun.push('doc-reference');
  const targets = docReferencePolicy.referenceTargets(db, changed, changedRanges);
  if (targets.size === 0) return;
  for (const citation of docsCitingFiles(db, targets)) {
    if (changedGitFiles.has(citation.doc)) continue; // doc updated in the same diff
    const citedClaims =
      citation.citedClaims.length > 0
        ? citation.citedClaims
        : docReferencePolicy.citationContexts(db, citation.doc, citation.cited);
    const classification = docReferencePolicy.classifyCitation(citedClaims);
    const legacyId = findingId('doc-reference', citation.doc, citation.cited.join('|'));
    const id = findingId('doc-reference', citation.doc, citation.cited[0] ?? '');
    recordFinding(result, {
      id,
      legacySuppressionIds: legacyId === id ? undefined : [legacyId],
      check: 'doc-reference',
      severity: 'warning',
      evidence: 'change-graph',
      actionTier: classification.actionTier,
      confidence: 1,
      file: citation.doc,
      relatedFiles: citation.cited,
      citationKind: classification.citationKind,
      citationKindReasons: classification.reasons,
      citedClaims,
      message: `${citation.doc} cites ${citation.cited.join(', ')} as ${docReferencePolicy.citationKindLabel(classification.citationKind)} — changed in this diff, doc untouched`,
      why: [
        `${citation.cited.join(', ')} changed in this diff.`,
        `${citation.doc} cites the changed file(s) but was not updated in the same diff.`,
        ...classification.reasons.map((reason) => `Citation kind evidence: ${reason}`),
      ],
      remediation: docReferencePolicy.citationRemediation(classification.citationKind, citation.doc),
    });
  }
}

function runUnusedParamsCheck(db: ScipDatabase, changedFiles: readonly string[], result: DiffGateResult): void {
  result.checksRun.push('unused-params');
  for (const finding of unusedParams(db, { files: changedFiles, limit: 50 })) {
    const legacyId = findingId('unused-params', finding.symbol, finding.file, finding.unusedTrailing.join('|'));
    const id = findingId('unused-params', finding.symbol, finding.file);
    recordFinding(result, {
      id,
      legacySuppressionIds: legacyId === id ? undefined : [legacyId],
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
    });
  }
}

function runNewDeadCheck(
  db: ScipDatabase,
  changedSymbols: ReadonlyArray<{ symbol: string; shortName: string; file: string; fanIn: number }>,
  symbolPreexistedAtBase: (changedSymbol: { symbol: string; file: string }) => boolean,
  result: DiffGateResult,
): void {
  result.checksRun.push('new-dead');
  const index = new ProjectIndex(db);
  for (const changedSymbol of changedSymbols) {
    if (symbolPreexistedAtBase(changedSymbol)) continue;
    if (changedSymbol.fanIn > 0) continue;
    if (index.fileKind(changedSymbol.file) === 'test') continue;
    if (isEntrySurface(db, changedSymbol.file)) continue;
    if (isRootedSymbol(db, changedSymbol.symbol, changedSymbol.file)) continue;
    if (isCompileTimeContractAssertion(changedSymbol.symbol)) continue;
    const id = findingId('new-dead', changedSymbol.symbol, changedSymbol.file);
    recordFinding(result, {
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
    });
  }
}

function isCompileTimeContractAssertion(symbol: string): boolean {
  if (leafSuffix(symbol) !== 'type') return false;
  const name = leafName(symbol);
  return name.startsWith('_Assert') || name.startsWith('Assert');
}

export function symbolPreexistenceChecker(
  projectRoot: string,
  base: string,
  diffPlan: DiffImpactPlan,
  baseContentAt?: BaseContentReader,
): (changedSymbol: { symbol: string; file: string }) => boolean {
  const renamedFromByFile = new Map(diffPlan.renamedFiles.map((rename) => [rename.to, rename.from]));
  const readBaseContent =
    baseContentAt ?? createBaseContentReader(projectRoot, base, baseContentPathsForDiffPlan(diffPlan));
  return (changedSymbol) => {
    const oldPath = renamedFromByFile.get(changedSymbol.file) ?? changedSymbol.file;
    const leaf = leafName(changedSymbol.symbol);
    if (!leaf) return false;
    const content = readBaseContent(oldPath);
    return content !== null && containsLeaf(content, leaf);
  };
}

function containsLeaf(content: string, leaf: string): boolean {
  return new RegExp(`\\b${escapeRegex(leaf)}\\b`).test(content);
}

function runBaselineCheck(db: ScipDatabase, result: DiffGateResult): void {
  if (!existsSync(resolveBaselinePath(db))) {
    result.skipped.push({
      check: 'baseline',
      reason: 'no .scipquery-baseline.json — run health --write-baseline to enable',
    });
    return;
  }
  result.checksRun.push('baseline');
  const comparison = checkHealthBaseline(db);
  for (const finding of comparison.newFindings) {
    const metadata = baselineFindingMetadata(finding);
    const id = findingId('baseline', finding);
    recordFinding(result, {
      id,
      groupKey: `baseline:${metadata.sourceAnalyzer}:${metadata.rootCauseKey}`,
      check: 'baseline',
      severity: 'error',
      evidence: 'baseline',
      actionTier: metadata.actionTier,
      confidence: 1,
      file: metadata.file,
      relatedFiles: metadata.relatedFiles.length > 0 ? metadata.relatedFiles : undefined,
      sourceAnalyzer: metadata.sourceAnalyzer,
      rootCauseKey: metadata.rootCauseKey,
      message: `new ${metadata.label} vs committed baseline: ${finding}`,
      why: [
        'A committed health baseline exists.',
        'The current health result contains a finding not present in that baseline.',
        `Underlying analyzer: ${metadata.sourceAnalyzer}.`,
        `Inherited action tier: ${metadata.actionTier}.`,
        `Root cause key: ${metadata.rootCauseKey}.`,
        ...metadata.why,
      ],
      remediation: metadata.remediation,
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
