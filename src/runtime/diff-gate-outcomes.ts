import type { DiffGateResult } from '../queries/impact/diff-gate.js';
import {
  readLedgerRecords,
  updateFindingOutcomeLedger,
  type FindingOutcomeRecord,
  type ObservedFinding,
} from '../queries/health/finding-outcome-ledger.js';
import type { ScipDatabase } from '../storage/db.js';
import { appendOutcomeEvents, deriveOutcomeEvents, headCommit, type OutcomeEvent } from '../storage/outcome-events.js';

export interface DiffGateOutcomeRuntime {
  now?: () => number;
  headCommit?: (projectRoot: string) => string | null;
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
export function recordDiffGateOutcomes(
  db: ScipDatabase,
  result: DiffGateResult,
  runtime: DiffGateOutcomeRuntime = {},
): DiffGateOutcomeResult {
  const now = (runtime.now ?? Date.now)();
  const observed: ObservedFinding[] = [
    ...result.findings.map((finding) => ({ check: finding.check, findingId: finding.id, suppressed: false })),
    ...result.suppressed.map((entry) => ({
      check: entry.finding.check,
      findingId: entry.finding.id,
      suppressed: true,
    })),
  ];
  const previous = readLedgerRecords(db);
  const ledger = updateFindingOutcomeLedger(db, observed, result.checksRun, now);

  try {
    const symbolByFindingId = new Map<string, string>();
    for (const finding of result.findings) {
      if (finding.symbol) symbolByFindingId.set(finding.id, finding.symbol);
    }
    for (const entry of result.suppressed) {
      if (entry.finding.symbol) symbolByFindingId.set(entry.finding.id, entry.finding.symbol);
    }
    const commit = (runtime.headCommit ?? headCommit)(db.config.projectRoot);
    const events = deriveOutcomeEvents(previous, ledger, symbolByFindingId, commit, now);
    (runtime.appendEvents ?? appendOutcomeEvents)(db.config.projectRoot, events);
    return { ledger, observed, now };
  } catch (error) {
    return {
      ledger,
      observed,
      now,
      warning: `outcome event ledger not updated: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
