/**
 * Effectiveness stats over the committed outcome-event ledger
 * (.scipquery/ledger/events.jsonl): per check, how many findings the gate
 * caught, how many were fixed by code changes, how many were suppressed as
 * accepted/false findings, and how long fixes took.
 *
 * "Fixed" is strictly "the finding stopped matching without a suppression"
 * — an agent suppressing a finding is a precision datapoint, not a fix.
 * Rename noise is reclassified at query time: a resolved finding whose
 * symbol was re-caught under the same check at the same commit is counted
 * as `moved`, not fixed (finding ids embed the file path, so renames mint
 * a new id — see findingId() in diff-gate.ts).
 *
 * Pure module: callers supply events (src/storage/outcome-events.ts) and
 * the clock.
 */

import type { OutcomeEvent } from '../../storage/outcome-events.js';

export interface EffectivenessOptions {
  /** Only count findings first caught at/after this timestamp (ms). */
  sinceMs?: number;
  /** Restrict to one check. */
  check?: string;
}

export interface CheckEffectiveness {
  check: string;
  caught: number;
  fixed: number;
  suppressed: number;
  reopened: number;
  moved: number;
  open: number;
  /** fixed / (fixed + suppressed); null until at least one finding concluded. */
  precision: number | null;
  /** Median days from caught to resolved; null when nothing was fixed. */
  medianDaysToFix: number | null;
}

export interface EffectivenessReport {
  totalEvents: number;
  windowStart: number | null;
  checks: CheckEffectiveness[];
}

const MS_PER_DAY = 86_400_000;

interface FindingHistory {
  check: string;
  findingId: string;
  caughtAt: number;
  events: OutcomeEvent[];
}

export function computeEffectiveness(
  events: readonly OutcomeEvent[],
  options: EffectivenessOptions = {},
): EffectivenessReport {
  const relevant = options.check ? events.filter((event) => event.check === options.check) : [...events];
  const ordered = [...relevant].sort((left, right) => left.ts - right.ts);

  // Group per finding; the window applies to when the finding was caught,
  // so a fix landing after the window still credits the caught-in-window finding.
  const histories = new Map<string, FindingHistory>();
  for (const event of ordered) {
    const key = `${event.check}\0${event.findingId}`;
    let history = histories.get(key);
    if (!history) {
      // First sighting counts as the catch even when the first event is a
      // transition (ledger predating the event log, or a lost caught line).
      history = { check: event.check, findingId: event.findingId, caughtAt: event.ts, events: [] };
      histories.set(key, history);
    }
    history.events.push(event);
  }

  const inWindow = [...histories.values()].filter(
    (history) => options.sinceMs === undefined || history.caughtAt >= options.sinceMs,
  );

  const movedKeys = movedFindingKeys(ordered);

  const byCheck = new Map<string, FindingHistory[]>();
  for (const history of inWindow) {
    const bucket = byCheck.get(history.check) ?? [];
    bucket.push(history);
    byCheck.set(history.check, bucket);
  }

  const checks: CheckEffectiveness[] = [];
  for (const [check, group] of byCheck) {
    let fixed = 0;
    let suppressed = 0;
    let reopened = 0;
    let moved = 0;
    let open = 0;
    const daysToFix: number[] = [];

    for (const history of group) {
      reopened += history.events.filter((event) => event.event === 'reopened').length;
      const terminal = history.events[history.events.length - 1];
      const key = `${history.check}\0${history.findingId}`;
      if (terminal.event === 'resolved' && movedKeys.has(key)) {
        moved += 1;
      } else if (terminal.event === 'resolved') {
        fixed += 1;
        daysToFix.push((terminal.ts - history.caughtAt) / MS_PER_DAY);
      } else if (terminal.event === 'suppressed') {
        suppressed += 1;
      } else {
        open += 1;
      }
    }

    const concluded = fixed + suppressed;
    checks.push({
      check,
      caught: group.length,
      fixed,
      suppressed,
      reopened,
      moved,
      open,
      precision: concluded > 0 ? fixed / concluded : null,
      medianDaysToFix: daysToFix.length > 0 ? median(daysToFix) : null,
    });
  }

  return {
    totalEvents: ordered.length,
    windowStart: options.sinceMs ?? null,
    checks: checks.sort((left, right) => left.check.localeCompare(right.check)),
  };
}

/**
 * Rename detection: a resolved finding counts as `moved` when a different
 * finding id with the same (check, symbol) was caught at the same commit
 * the resolution was observed at — the classic file-rename signature given
 * path-inclusive finding ids.
 */
function movedFindingKeys(ordered: readonly OutcomeEvent[]): Set<string> {
  const caughtByCommit = new Map<string, OutcomeEvent[]>();
  for (const event of ordered) {
    if (event.event !== 'caught' || !event.commit || !event.symbol) continue;
    const bucket = caughtByCommit.get(event.commit) ?? [];
    bucket.push(event);
    caughtByCommit.set(event.commit, bucket);
  }

  const symbolByFinding = new Map<string, string>();
  for (const event of ordered) {
    if (event.event === 'caught' && event.symbol) {
      symbolByFinding.set(`${event.check}\0${event.findingId}`, event.symbol);
    }
  }

  const moved = new Set<string>();
  for (const event of ordered) {
    if (event.event !== 'resolved' || !event.commit) continue;
    const key = `${event.check}\0${event.findingId}`;
    const symbol = event.symbol ?? symbolByFinding.get(key);
    if (!symbol) continue;
    const candidates = caughtByCommit.get(event.commit) ?? [];
    if (
      candidates.some(
        (candidate) =>
          candidate.check === event.check && candidate.symbol === symbol && candidate.findingId !== event.findingId,
      )
    ) {
      moved.add(key);
    }
  }
  return moved;
}

/** Parse `--since` values: `30d`/`12w` relative windows or an ISO date. */
export function parseSinceMs(raw: string, now: number): number | null {
  const relative = /^(\d+)([dw])$/.exec(raw.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === 'w' ? 7 * MS_PER_DAY : MS_PER_DAY;
    return now - amount * unitMs;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
