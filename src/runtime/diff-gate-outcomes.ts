import { createHash, randomUUID } from 'node:crypto';
import {
  DIFF_GATE_CHECKS,
  diffGateFailedClosed,
  type DiffGateCheck,
  type DiffGateResult,
} from '../queries/impact/diff-gate.js';
import { readLedgerRecords, updateFindingOutcomeLedger } from '../queries/health/finding-outcome-ledger.js';
import {
  deriveOutcomeEvents,
  latestOutcomeLifecycleAnchor,
  ledgerKey,
  type FindingOutcomeRecord,
  type ObservedFinding,
  type OutcomeEvent,
  type OutcomeObserverProvenance,
} from '../domain/finding-outcomes.js';
import type { ObservationReceipt } from '../domain/observation-receipt.js';
import type { ScipDatabase } from '../storage/db.js';
import { appendOutcomeEvents, readOutcomeEvents, type OutcomeEventReadResult } from '../storage/outcome-events.js';
import { gitOutput, resolveGitWorktreeContext } from '../platform/git-worktree.js';
import { cliVersion } from '../platform/cli-version.js';
import { formatRecordCompatibilityWarning } from '../domain/record-compatibility.js';
import { buildObservationReceipt } from './observation-receipt.js';

export interface DiffGateOutcomeRuntime {
  /** Stable across retries of one logical gate observation; retries also reuse its captured `now`. */
  observationId?: string;
  now?: () => number;
  headCommit?: (projectRoot: string) => string | null;
  resolveCommit?: (projectRoot: string, ref: string) => string | null;
  worktreeIsClean?: (projectRoot: string) => boolean;
  readEvents?: (projectRoot: string) => OutcomeEventReadResult;
  replayGate?: (baseCommit: string, checks: readonly DiffGateCheck[]) => DiffGateResult;
  /** Maximum historical comparison bases reconciled by one foreground gate. */
  maxReplayBases?: number;
  appendEvents?: (projectRoot: string, events: readonly OutcomeEvent[]) => void;
  /** Explicit caller provenance; ordinary local gates default conservatively to a writable agent observer. */
  observer?: OutcomeObserverProvenance;
  /** Externally captured authority receipt; otherwise the gate captures its current local state. */
  observation?: ObservationReceipt;
}

export interface DiffGateOutcomeResult {
  ledger: FindingOutcomeRecord[];
  observed: ObservedFinding[];
  now: number;
  warning?: string;
}

/**
 * Records one diff-gate observation in both ledgers: the rebuildable local
 * SQLite state and the append-only repository history. The repository append
 * is best-effort because recordkeeping must never change the gate decision.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function recordDiffGateOutcomes(
  db: ScipDatabase,
  result: DiffGateResult,
  runtime: DiffGateOutcomeRuntime = {},
): DiffGateOutcomeResult {
  const now = (runtime.now ?? Date.now)();
  const observationId = runtime.observationId ?? randomUUID();
  const observer = runtime.observer ?? outcomeObserverFromEnvironment();
  const observed = observationsForResult(result);
  const reconciliationPrevious = readLedgerRecords(db);
  const projectRoot = db.config.projectRoot;
  const commit = runtime.headCommit
    ? runtime.headCommit(projectRoot)
    : (resolveGitWorktreeContext(projectRoot)?.headCommit ?? null);
  const comparisonBaseCommit = runtime.resolveCommit
    ? runtime.resolveCommit(projectRoot, result.base)
    : resolveCommit(projectRoot, result.base);
  const observation = runtime.observation ?? diffGateObservationReceipt(db, projectRoot, now);
  const reconciliation = reconcileMissingFindings({
    previous: reconciliationPrevious,
    observed,
    result,
    projectRoot,
    commit,
    comparisonBaseCommit,
    runtime,
  });
  const update = updateFindingOutcomeLedger(
    db,
    reconciliation.ledgerObserved,
    reconciliation.checksRun,
    now,
    reconciliation.retainedKeys,
    observationId,
  );
  const ledger = update.current;
  const ledgerWarning =
    update.status === 'busy'
      ? 'finding outcome ledger not updated: evidence database remained busy'
      : update.status === 'unavailable'
        ? 'finding outcome ledger not updated: evidence database unavailable'
        : update.status === 'conflict'
          ? `finding outcome ledger not updated: observation id ${observationId} names different evidence`
          : undefined;

  try {
    const symbolByFindingId = new Map<string, string>();
    for (const finding of result.findings) {
      if (finding.symbol) symbolByFindingId.set(finding.id, finding.symbol);
    }
    for (const entry of result.suppressed) {
      if (entry.finding.symbol) symbolByFindingId.set(entry.finding.id, entry.finding.symbol);
    }
    const suppressionPolicyVersionByFinding = new Map<string, number>();
    for (const entry of result.suppressed) {
      const policyVersion = entry.suppression.decision?.policyVersion;
      if (policyVersion !== undefined) {
        suppressionPolicyVersionByFinding.set(ledgerKey(entry.finding.check, entry.finding.id), policyVersion);
      }
    }
    for (const [findingId, symbol] of reconciliation.replaySymbols) symbolByFindingId.set(findingId, symbol);
    const events = deriveOutcomeEvents(update.previous, ledger, symbolByFindingId, commit, now, {
      ...(comparisonBaseCommit ? { comparisonBaseCommit } : {}),
      verifiedAgainstByFinding: reconciliation.verifiedAgainstByFinding,
      gateRunId: observationId,
      observer,
      observation,
      suppressionPolicyVersionByFinding,
    });
    let appendWarning: string | undefined;
    if (runtime.appendEvents) {
      runtime.appendEvents(projectRoot, events);
    } else {
      appendWarning = appendOutcomeEvents(projectRoot, events, { toolVersion: cliVersion }).warning;
    }
    return {
      ledger,
      observed,
      now,
      ...withOutcomeWarning(reconciliation.warning, ledgerWarning, appendWarning),
    };
  } catch (error) {
    return {
      ledger,
      observed,
      now,
      ...withOutcomeWarning(
        reconciliation.warning,
        ledgerWarning,
        `outcome event ledger not updated: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
}

export function repositoryWritableObserver(
  kind: 'local-agent' | 'local-human',
  source?: string,
): OutcomeObserverProvenance {
  return {
    kind,
    authority: 'repository-writable',
    ...(source ? { source } : {}),
  };
}

export function outcomeObserverFromEnvironment(env: NodeJS.ProcessEnv = process.env): OutcomeObserverProvenance {
  const kind = env['SCIP_QUERY_OUTCOME_OBSERVER_KIND'] === 'local-human' ? 'local-human' : 'local-agent';
  const source = env['SCIP_QUERY_OUTCOME_OBSERVER_SOURCE']?.trim();
  return repositoryWritableObserver(kind, source && source.length <= 256 ? source : undefined);
}

function diffGateObservationReceipt(db: ScipDatabase, projectRoot: string, now: number): ObservationReceipt {
  const gitContext = resolveGitWorktreeContext(projectRoot);
  return buildObservationReceipt({
    projectRoot,
    observedAt: new Date(now),
    db,
    ...(gitContext
      ? {
          gitContext,
          statusPorcelain: gitOutput(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) ?? '',
          trackedDiff: gitOutput(projectRoot, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--']) ?? '',
        }
      : {}),
  });
}

function withOutcomeWarning(...warnings: Array<string | undefined>): { warning?: string } {
  const warning = warnings.filter((value): value is string => Boolean(value)).join('; ');
  return warning ? { warning } : {};
}

interface MissingFindingReconciliation {
  ledgerObserved: ObservedFinding[];
  checksRun: string[];
  retainedKeys: Set<string>;
  verifiedAgainstByFinding: Map<string, string>;
  replaySymbols: Map<string, string>;
  warning?: string;
}

function reconcileMissingFindings(input: {
  previous: readonly FindingOutcomeRecord[];
  observed: readonly ObservedFinding[];
  result: DiffGateResult;
  projectRoot: string;
  commit: string | null;
  comparisonBaseCommit: string | null;
  runtime: DiffGateOutcomeRuntime;
}): MissingFindingReconciliation {
  const ledgerObserved = [...input.observed];
  const effectiveChecksRun = new Set<string>(input.result.checksRun);
  const retainedKeys = new Set<string>();
  const verifiedAgainstByFinding = new Map<string, string>();
  const replaySymbols = new Map<string, string>();
  const observedKeys = new Set(input.observed.map((finding) => ledgerKey(finding.check, finding.findingId)));
  const checksRun = new Set<string>(input.result.checksRun);
  const cleanComparableResult =
    input.result.changedFiles.length === 0 &&
    !diffGateFailedClosed(input.result) &&
    input.commit !== null &&
    input.comparisonBaseCommit !== null;
  const missing = input.previous.filter(
    (record) =>
      record.outcome !== 'resolved' &&
      (checksRun.has(record.check) || cleanComparableResult) &&
      !observedKeys.has(ledgerKey(record.check, record.findingId)),
  );
  debugOutcomeVerification(
    `primary base=${String(input.comparisonBaseCommit)} head=${String(input.commit)} checks=${input.result.checksRun.join(',')} missing=${missing.length}`,
  );
  if (missing.length === 0)
    return {
      ledgerObserved,
      checksRun: [...effectiveChecksRun],
      retainedKeys,
      verifiedAgainstByFinding,
      replaySymbols,
    };

  let historyResult: OutcomeEventReadResult;
  try {
    historyResult = (input.runtime.readEvents ?? readOutcomeEvents)(input.projectRoot);
  } catch (error) {
    for (const record of missing) retainedKeys.add(ledgerKey(record.check, record.findingId));
    return {
      ledgerObserved,
      checksRun: [...effectiveChecksRun],
      retainedKeys,
      verifiedAgainstByFinding,
      replaySymbols,
      warning: `cross-HEAD outcome verification deferred: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!historyResult.compatibility.complete) {
    for (const record of missing) retainedKeys.add(ledgerKey(record.check, record.findingId));
    return {
      ledgerObserved,
      checksRun: [...effectiveChecksRun],
      retainedKeys,
      verifiedAgainstByFinding,
      replaySymbols,
      warning: `cross-HEAD outcome verification deferred: ${formatRecordCompatibilityWarning(
        'committed outcome history',
        historyResult.compatibility,
      )}`,
    };
  }
  const history = historyResult.events;
  const historyByKey = new Map<string, OutcomeEvent[]>();
  for (const event of history) {
    const key = ledgerKey(event.check, event.findingId);
    const events = historyByKey.get(key) ?? [];
    events.push(event);
    historyByKey.set(key, events);
  }

  const replayByBase = new Map<string, FindingOutcomeRecord[]>();
  for (const record of missing) {
    const key = ledgerKey(record.check, record.findingId);
    const anchor = latestOutcomeLifecycleAnchor(historyByKey.get(key) ?? []);
    const anchorBase = anchor?.comparisonBaseCommit ?? anchor?.commit;
    debugOutcomeVerification(
      `candidate ${key} anchor=${String(anchorBase)} current=${String(input.comparisonBaseCommit)}`,
    );
    if (!anchor?.comparisonBaseCommit && anchor?.commit && anchor.commit === input.commit) {
      effectiveChecksRun.add(record.check);
      continue;
    }
    if (!anchorBase || !input.commit || !input.comparisonBaseCommit) {
      retainedKeys.add(key);
      continue;
    }
    if (anchorBase === input.comparisonBaseCommit) {
      effectiveChecksRun.add(record.check);
      continue;
    }
    const records = replayByBase.get(anchorBase) ?? [];
    records.push(record);
    replayByBase.set(anchorBase, records);
  }
  if (replayByBase.size === 0) {
    return {
      ledgerObserved,
      checksRun: [...effectiveChecksRun],
      retainedKeys,
      verifiedAgainstByFinding,
      replaySymbols,
    };
  }

  const clean =
    input.runtime.worktreeIsClean?.(input.projectRoot) ?? resolveGitWorktreeContext(input.projectRoot)?.clean ?? false;
  debugOutcomeVerification(
    `replay groups=${replayByBase.size} clean=${clean} callback=${Boolean(input.runtime.replayGate)}`,
  );
  if (!clean || !input.runtime.replayGate) {
    for (const records of replayByBase.values()) {
      for (const record of records) retainedKeys.add(ledgerKey(record.check, record.findingId));
    }
    return {
      ledgerObserved,
      checksRun: [...effectiveChecksRun],
      retainedKeys,
      verifiedAgainstByFinding,
      replaySymbols,
    };
  }

  const warnings: string[] = [];
  const replayGroups = selectReplayGroups(replayByBase, input.commit, input.runtime.maxReplayBases);
  const selectedBases = new Set(replayGroups.map(([baseCommit]) => baseCommit));
  let deferredBases = 0;
  let deferredFindings = 0;
  for (const [baseCommit, records] of replayByBase) {
    if (selectedBases.has(baseCommit)) continue;
    deferredBases += 1;
    deferredFindings += records.length;
    for (const record of records) retainedKeys.add(ledgerKey(record.check, record.findingId));
  }
  if (deferredBases > 0) {
    warnings.push(
      `cross-HEAD outcome verification bounded to ${replayGroups.length} of ${replayByBase.size} historical base(s); retained ${deferredFindings} finding(s) across ${deferredBases} base(s) for later verification`,
    );
  }
  for (const [baseCommit, records] of replayGroups) {
    let replay: DiffGateResult;
    try {
      const checks = [...new Set(records.map((record) => record.check))]
        .filter((check): check is DiffGateCheck => DIFF_GATE_CHECKS.includes(check as DiffGateCheck))
        .sort();
      replay = input.runtime.replayGate(baseCommit, checks);
      debugOutcomeVerification(
        `replay base=${baseCommit} checks=${replay.checksRun.join(',')} findings=${replay.findings.length} suppressed=${replay.suppressed.length}`,
      );
    } catch (error) {
      for (const record of records) retainedKeys.add(ledgerKey(record.check, record.findingId));
      warnings.push(
        `cross-HEAD outcome verification deferred for ${baseCommit.slice(0, 12)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    const replayChecks = new Set<string>(replay.checksRun);
    const replayFindings = replayFindingDetails(replay);
    for (const record of records) {
      const key = ledgerKey(record.check, record.findingId);
      if (!replayChecks.has(record.check)) {
        retainedKeys.add(key);
        continue;
      }
      effectiveChecksRun.add(record.check);
      const exact = replayFindings.find((finding) => finding.key === key);
      if (exact) {
        debugOutcomeVerification(`replay retained exact ${key}`);
        ledgerObserved.push(exact.observed);
        if (exact.symbol) replaySymbols.set(exact.observed.findingId, exact.symbol);
        continue;
      }
      const anchor = latestOutcomeLifecycleAnchor(historyByKey.get(key) ?? []);
      const moved = anchor?.symbol
        ? replayFindings.find((finding) => finding.check === record.check && finding.symbol === anchor.symbol)
        : undefined;
      if (moved) {
        debugOutcomeVerification(`replay moved ${key} -> ${moved.key}`);
        ledgerObserved.push(moved.observed);
        if (moved.symbol) replaySymbols.set(moved.observed.findingId, moved.symbol);
        continue;
      }
      verifiedAgainstByFinding.set(key, baseCommit);
      debugOutcomeVerification(`replay verified ${key} against ${baseCommit}`);
    }
  }

  return {
    ledgerObserved,
    checksRun: [...effectiveChecksRun],
    retainedKeys,
    verifiedAgainstByFinding,
    replaySymbols,
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
  };
}

const DEFAULT_MAX_REPLAY_BASES = 1;

function selectReplayGroups(
  replayByBase: ReadonlyMap<string, FindingOutcomeRecord[]>,
  commit: string | null,
  configuredLimit: number | undefined,
): Array<[string, FindingOutcomeRecord[]]> {
  const groups = [...replayByBase.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (groups.length <= 1) return groups;
  const requestedLimit =
    configuredLimit === undefined || !Number.isSafeInteger(configuredLimit) || configuredLimit < 0
      ? DEFAULT_MAX_REPLAY_BASES
      : configuredLimit;
  const limit = Math.min(groups.length, requestedLimit);
  if (limit === 0) return [];
  if (limit >= groups.length) return groups;
  const digest = createHash('sha256')
    .update(commit ?? 'unresolved-head')
    .digest();
  const start = digest.readUInt32BE(0) % groups.length;
  return Array.from({ length: limit }, (_, offset) => groups[(start + offset) % groups.length]!);
}

function resolveCommit(projectRoot: string, ref: string): string | null {
  const sha = gitOutput(projectRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function debugOutcomeVerification(message: string): void {
  if (process.env['SCIP_QUERY_DEBUG']) console.error(`outcome-verification: ${message}`);
}

function observationsForResult(result: DiffGateResult): ObservedFinding[] {
  return [
    ...result.findings.map((finding) => ({ check: finding.check, findingId: finding.id, suppressed: false })),
    ...result.suppressed.map((entry) => ({
      check: entry.finding.check,
      findingId: entry.finding.id,
      suppressed: true,
    })),
  ];
}

function replayFindingDetails(result: DiffGateResult): Array<{
  key: string;
  check: string;
  observed: ObservedFinding;
  symbol?: string;
}> {
  return [
    ...result.findings.map((finding) => ({
      key: ledgerKey(finding.check, finding.id),
      check: finding.check,
      observed: { check: finding.check, findingId: finding.id, suppressed: false },
      ...(finding.symbol ? { symbol: finding.symbol } : {}),
    })),
    ...result.suppressed.map((entry) => ({
      key: ledgerKey(entry.finding.check, entry.finding.id),
      check: entry.finding.check,
      observed: { check: entry.finding.check, findingId: entry.finding.id, suppressed: true },
      ...(entry.finding.symbol ? { symbol: entry.finding.symbol } : {}),
    })),
  ];
}
