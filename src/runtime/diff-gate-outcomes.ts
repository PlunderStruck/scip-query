import { diffGateFailedClosed, type DiffGateResult } from '../queries/impact/diff-gate.js';
import { readLedgerRecords, updateFindingOutcomeLedger } from '../queries/health/finding-outcome-ledger.js';
import {
  deriveOutcomeEvents,
  latestOutcomeLifecycleAnchor,
  ledgerKey,
  type FindingOutcomeRecord,
  type ObservedFinding,
  type OutcomeEvent,
} from '../domain/finding-outcomes.js';
import type { ScipDatabase } from '../storage/db.js';
import { appendOutcomeEvents, readOutcomeEvents } from '../storage/outcome-events.js';
import { gitOutput, resolveGitWorktreeContext } from '../platform/git-worktree.js';

export interface DiffGateOutcomeRuntime {
  now?: () => number;
  headCommit?: (projectRoot: string) => string | null;
  resolveCommit?: (projectRoot: string, ref: string) => string | null;
  worktreeIsClean?: (projectRoot: string) => boolean;
  readEvents?: (projectRoot: string) => OutcomeEvent[];
  replayGate?: (baseCommit: string) => DiffGateResult;
  appendEvents?: (projectRoot: string, events: readonly OutcomeEvent[]) => void;
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
  const observed = observationsForResult(result);
  const previous = readLedgerRecords(db);
  const projectRoot = db.config.projectRoot;
  const commit = runtime.headCommit
    ? runtime.headCommit(projectRoot)
    : (resolveGitWorktreeContext(projectRoot)?.headCommit ?? null);
  const comparisonBaseCommit = runtime.resolveCommit
    ? runtime.resolveCommit(projectRoot, result.base)
    : resolveCommit(projectRoot, result.base);
  const reconciliation = reconcileMissingFindings({
    previous,
    observed,
    result,
    projectRoot,
    commit,
    comparisonBaseCommit,
    runtime,
  });
  const ledger = updateFindingOutcomeLedger(
    db,
    reconciliation.ledgerObserved,
    reconciliation.checksRun,
    now,
    reconciliation.retainedKeys,
  );

  try {
    const symbolByFindingId = new Map<string, string>();
    for (const finding of result.findings) {
      if (finding.symbol) symbolByFindingId.set(finding.id, finding.symbol);
    }
    for (const entry of result.suppressed) {
      if (entry.finding.symbol) symbolByFindingId.set(entry.finding.id, entry.finding.symbol);
    }
    for (const [findingId, symbol] of reconciliation.replaySymbols) symbolByFindingId.set(findingId, symbol);
    const events = deriveOutcomeEvents(previous, ledger, symbolByFindingId, commit, now, {
      ...(comparisonBaseCommit ? { comparisonBaseCommit } : {}),
      verifiedAgainstByFinding: reconciliation.verifiedAgainstByFinding,
    });
    (runtime.appendEvents ?? appendOutcomeEvents)(projectRoot, events);
    return {
      ledger,
      observed,
      now,
      ...(reconciliation.warning ? { warning: reconciliation.warning } : {}),
    };
  } catch (error) {
    return {
      ledger,
      observed,
      now,
      warning: [
        reconciliation.warning,
        `outcome event ledger not updated: ${error instanceof Error ? error.message : String(error)}`,
      ]
        .filter(Boolean)
        .join('; '),
    };
  }
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

  let history: OutcomeEvent[];
  try {
    history = (input.runtime.readEvents ?? readOutcomeEvents)(input.projectRoot);
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
  for (const [baseCommit, records] of replayByBase) {
    let replay: DiffGateResult;
    try {
      replay = input.runtime.replayGate(baseCommit);
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
