/**
 * Pure finding-outcome ledger math. Closes the round-1 finding "the
 * validation axis computes per-detector lift and feeds nothing": this
 * module tracks, per finding identity, whether a detector's output is
 * actually being acted on — and reports that, without changing which
 * findings get emitted (downranking stays a human/config decision).
 *
 * Storage lives in src/storage/evidence-cache.ts (finding_outcome_ledger
 * table); this module is the pure transition + stats core the storage
 * layer's rows flow through. Clock is injected everywhere so tests never
 * depend on wall time.
 */

import type { ScipDatabase } from '../../storage/db.js';
import { readFindingOutcomeLedger, writeFindingOutcomeLedger } from '../../storage/evidence-cache.js';
import {
  ledgerKey,
  type FindingOutcome,
  type FindingOutcomeRecord,
  type ObservedFinding,
} from '../../domain/finding-outcomes.js';

export { ledgerKey } from '../../domain/finding-outcomes.js';
export type { FindingOutcome, FindingOutcomeRecord, ObservedFinding } from '../../domain/finding-outcomes.js';

/**
 * Pure ledger transition for one diff-gate (or health) run.
 *   - observed, not suppressed -> outcome 'still-open', timesShown += 1, lastSeen = now
 *   - observed, suppressed     -> outcome 'suppressed', timesShown += 1, lastSeen = now
 *   - previously tracked for a check that ran this time but not observed now
 *     -> outcome 'resolved' (the id stopped matching because the code changed)
 *   - previously tracked for a check that did NOT run this time -> untouched
 */
export function recordFindingOutcomes(
  previous: readonly FindingOutcomeRecord[],
  observed: readonly ObservedFinding[],
  checksRun: readonly string[],
  now: number,
  retainedKeys: ReadonlySet<string> = new Set(),
): FindingOutcomeRecord[] {
  const byKey = new Map(previous.map((record) => [ledgerKey(record.check, record.findingId), record]));
  const observedKeys = new Set(observed.map((finding) => ledgerKey(finding.check, finding.findingId)));
  const runChecks = new Set(checksRun);

  for (const finding of observed) {
    const key = ledgerKey(finding.check, finding.findingId);
    const existing = byKey.get(key);
    const outcome: FindingOutcome = finding.suppressed ? 'suppressed' : 'still-open';
    if (existing) {
      byKey.set(key, { ...existing, lastSeen: now, timesShown: existing.timesShown + 1, outcome });
    } else {
      byKey.set(key, {
        check: finding.check,
        findingId: finding.findingId,
        firstSeen: now,
        lastSeen: now,
        timesShown: 1,
        outcome,
      });
    }
  }

  for (const record of previous) {
    if (!runChecks.has(record.check)) continue;
    const key = ledgerKey(record.check, record.findingId);
    if (observedKeys.has(key)) continue;
    if (retainedKeys.has(key)) continue;
    if (record.outcome === 'resolved') continue;
    byKey.set(key, { ...record, outcome: 'resolved' });
  }

  return [...byKey.values()];
}

export interface DetectorPrecisionStats {
  check: string;
  /** Distinct finding identities ever recorded for this check. */
  seen: number;
  resolved: number;
  suppressed: number;
  stillOpen: number;
  resolutionRate: number;
  suppressionRate: number;
  /** Age (days) of the oldest still-open finding; null when none are open. */
  oldestOpenAgeDays: number | null;
}

export function detectorPrecision(ledger: readonly FindingOutcomeRecord[], now: number): DetectorPrecisionStats[] {
  const byCheck = new Map<string, FindingOutcomeRecord[]>();
  for (const record of ledger) {
    const bucket = byCheck.get(record.check) ?? [];
    bucket.push(record);
    byCheck.set(record.check, bucket);
  }

  const stats: DetectorPrecisionStats[] = [];
  for (const [check, records] of byCheck) {
    const resolved = records.filter((record) => record.outcome === 'resolved').length;
    const suppressed = records.filter((record) => record.outcome === 'suppressed').length;
    const stillOpen = records.filter((record) => record.outcome === 'still-open').length;
    const seen = records.length;
    const oldestOpen = records
      .filter((record) => record.outcome === 'still-open')
      .sort((left, right) => left.firstSeen - right.firstSeen)[0];
    stats.push({
      check,
      seen,
      resolved,
      suppressed,
      stillOpen,
      resolutionRate: seen > 0 ? resolved / seen : 0,
      suppressionRate: seen > 0 ? suppressed / seen : 0,
      oldestOpenAgeDays: oldestOpen ? Math.floor((now - oldestOpen.firstSeen) / MS_PER_DAY) : null,
    });
  }
  return stats.sort((left, right) => left.check.localeCompare(right.check));
}

const MS_PER_DAY = 86_400_000;
const TRAILING_WINDOW = 50;
const LOW_RESOLUTION_THRESHOLD = 0.1;
/** Below this many trailing records, a resolution rate is noise, not signal — never nudge on it. */
const MIN_SAMPLES_FOR_NUDGE = 10;

/** Resolution rate over the most-recently-first-seen N records for a check — the hook nudge input. */
export function trailingResolutionRate(
  ledger: readonly FindingOutcomeRecord[],
  check: string,
  windowSize = TRAILING_WINDOW,
): number | null {
  const records = trailingRecords(ledger, check, windowSize);
  if (records.length === 0) return null;
  const resolved = records.filter((record) => record.outcome === 'resolved').length;
  return resolved / records.length;
}

function trailingRecords(
  ledger: readonly FindingOutcomeRecord[],
  check: string,
  windowSize: number,
): FindingOutcomeRecord[] {
  return ledger
    .filter((record) => record.check === check)
    .sort((left, right) => right.firstSeen - left.firstSeen)
    .slice(0, windowSize);
}

/**
 * Hook-mode prepend line: "N finding(s), M shown before and unresolved
 * (oldest: X day(s))" — only when at least one currently-shown finding has
 * been shown before. Returns null when there is nothing to add.
 */
export function formatUnresolvedStreakLine(
  ledger: readonly FindingOutcomeRecord[],
  observed: readonly ObservedFinding[],
  now: number,
): string | null {
  if (observed.length === 0) return null;
  const byKey = new Map(ledger.map((record) => [ledgerKey(record.check, record.findingId), record]));
  const shownBefore = observed
    .map((finding) => byKey.get(ledgerKey(finding.check, finding.findingId)))
    .filter((record): record is FindingOutcomeRecord => record !== undefined && record.timesShown > 1);
  if (shownBefore.length === 0) return null;
  const oldestDays = Math.max(...shownBefore.map((record) => Math.floor((now - record.firstSeen) / MS_PER_DAY)));
  return `${observed.length} finding(s), ${shownBefore.length} shown before and unresolved (oldest: ${oldestDays} day(s))`;
}

/**
 * Per-check nudge lines for checks whose trailing resolution rate is low —
 * appended after the streak line. Requires at least MIN_SAMPLES_FOR_NUDGE
 * trailing records before judging a check; a fresh ledger with 1-2 entries
 * would otherwise always look like a 0% resolution rate.
 */
export function formatLowResolutionNudges(
  ledger: readonly FindingOutcomeRecord[],
  checksRun: readonly string[],
): string[] {
  const lines: string[] = [];
  for (const check of [...new Set(checksRun)].sort()) {
    const records = trailingRecords(ledger, check, TRAILING_WINDOW);
    if (records.length < MIN_SAMPLES_FOR_NUDGE) continue;
    const resolved = records.filter((record) => record.outcome === 'resolved').length;
    const rate = resolved / records.length;
    if (rate >= LOW_RESOLUTION_THRESHOLD) continue;
    lines.push(
      `(the ${check} check's findings are rarely acted on in this repo — consider suppressing with reasons or tuning its config)`,
    );
  }
  return lines;
}

// ── Storage shell (side effects live here; math above stays pure) ──

export function readLedgerRecords(db: ScipDatabase): FindingOutcomeRecord[] {
  return readFindingOutcomeLedger(db).map((row) => ({
    check: row.check,
    findingId: row.findingId,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    timesShown: row.timesShown,
    outcome: row.outcome as FindingOutcome,
  }));
}

/**
 * Read-transition-write in one call — the shell diff-gate's hook mode
 * invokes once per run. Returns the next ledger state so the caller can
 * immediately format the hook nudge lines from it without a second read.
 */
export function updateFindingOutcomeLedger(
  db: ScipDatabase,
  observed: readonly ObservedFinding[],
  checksRun: readonly string[],
  now: number = Date.now(),
  retainedKeys: ReadonlySet<string> = new Set(),
): FindingOutcomeRecord[] {
  const previous = readLedgerRecords(db);
  const next = recordFindingOutcomes(previous, observed, checksRun, now, retainedKeys);
  writeFindingOutcomeLedger(db, next);
  return next;
}
