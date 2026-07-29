/**
 * Effectiveness stats over the committed outcome-event ledger
 * (.scipquery/events/*.json): per check, how many findings the gate
 * caught, how many disappeared under a comparable Git-base rerun, how many were
 * suppressed as accepted/false findings, and how long verified fixes took.
 *
 * "Fixed" is strictly "the finding stopped matching without a suppression on
 * a later run against the same resolved comparison commit". That can be a
 * direct rerun or a clean cross-HEAD replay carrying explicit proof. A changed
 * baseline without replay proof remains unverified because committing a
 * finding also clears the default diff.
 * An agent suppressing a finding is a handling-outcome datapoint, not a fix.
 * Rename noise is reclassified at query time: a resolved finding whose
 * symbol was re-caught under the same check at the same commit is counted
 * as `moved`, not fixed (finding ids embed the file path, so renames mint
 * a new id — see findingId() in diff-gate.ts).
 *
 * Pure module: callers supply events (src/storage/outcome-events.ts) and
 * the clock.
 */

import { latestOutcomeLifecycleAnchor, type OutcomeEvent } from '../../domain/finding-outcomes.js';
import { automaticSuppressionRateIsAnomalous } from '../../domain/suppression-adjudication.js';

export type {
  OutcomeEvent,
  OutcomeEventKind,
  OutcomeObserverAuthority,
  OutcomeObserverKind,
  OutcomeObserverProvenance,
} from '../../domain/finding-outcomes.js';

export interface EffectivenessOptions {
  /** Only count findings first caught at/after this timestamp (ms). */
  sinceMs?: number;
  /** Restrict to one check. */
  check?: string;
  /**
   * Gate-run identities attested by a separately controlled source. This set
   * must not be derived from the repository event fields themselves.
   */
  protectedGateRunIds?: ReadonlySet<string>;
}

export interface CheckEffectiveness {
  check: string;
  caught: number;
  fixed: number;
  suppressed: number;
  reopened: number;
  moved: number;
  /** Resolved after HEAD changed or without a comparable Git commit. */
  unverified: number;
  open: number;
  /** Whether the rows are writable telemetry or protected external evaluation. */
  authority: EffectivenessAuthority;
  /** fixed / (fixed + suppressed); an operational handling ratio, not a correctness grade. */
  resolutionVsSuppressionRate: number | null;
  /** The protected-evaluation alias. Always null for repository-writable or mixed observations. */
  precision: number | null;
  /** Median days from caught to resolved; null when nothing was fixed. */
  medianDaysToFix: number | null;
}

export interface EffectivenessReport {
  totalEvents: number;
  windowStart: number | null;
  authority: EffectivenessAuthority;
  provenance: EffectivenessProvenanceSummary;
  anomalies: EffectivenessAnomaly[];
  checks: CheckEffectiveness[];
}

export type EffectivenessAuthority =
  | 'no-data'
  | 'local-writable-telemetry'
  | 'mixed-authority-telemetry'
  | 'protected-external-evaluation';

export interface EffectivenessProvenanceSummary {
  localAgentEvents: number;
  localHumanEvents: number;
  protectedCiEvents: number;
  legacyUnknownEvents: number;
  repositoryWritableEvents: number;
  protectedExternalEvents: number;
  attestedProtectedEvents: number;
  unattestedProtectedClaims: number;
  distinctGateRuns: number;
  missingGateRunIdEvents: number;
}

export interface EffectivenessAnomalySample {
  check: string;
  findingId: string;
  gateRunId?: string;
}

export interface EffectivenessAnomaly {
  code:
    | 'legacy-provenance-missing'
    | 'gate-run-identity-missing'
    | 'mixed-observer-authority'
    | 'unattested-protected-claim'
    | 'automatic-suppression-rate';
  message: string;
  samples: EffectivenessAnomalySample[];
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
    let unverified = 0;
    let open = 0;
    const daysToFix: number[] = [];

    for (const history of group) {
      reopened += history.events.filter((event) => event.event === 'reopened').length;
      const terminal = history.events[history.events.length - 1];
      const key = `${history.check}\0${history.findingId}`;
      if (terminal.event === 'resolved' && movedKeys.has(key)) {
        moved += 1;
      } else if (terminal.event === 'resolved') {
        const anchor = latestOutcomeLifecycleAnchor(history.events.slice(0, -1));
        const comparisonBase = anchor?.comparisonBaseCommit ?? anchor?.commit;
        const terminalBase = terminal.comparisonBaseCommit ?? terminal.commit;
        if (comparisonBase && (terminalBase === comparisonBase || terminal.verifiedAgainstCommit === comparisonBase)) {
          fixed += 1;
          daysToFix.push((terminal.ts - history.caughtAt) / MS_PER_DAY);
        } else {
          unverified += 1;
        }
      } else if (terminal.event === 'suppressed') {
        suppressed += 1;
      } else {
        open += 1;
      }
    }

    const concluded = fixed + suppressed;
    const authority = effectivenessAuthority(
      group.flatMap((history) => history.events),
      options.protectedGateRunIds,
    );
    const resolutionVsSuppressionRate = concluded > 0 ? fixed / concluded : null;
    checks.push({
      check,
      caught: group.length,
      fixed,
      suppressed,
      reopened,
      moved,
      unverified,
      open,
      authority,
      resolutionVsSuppressionRate,
      precision: authority === 'protected-external-evaluation' ? resolutionVsSuppressionRate : null,
      medianDaysToFix: daysToFix.length > 0 ? median(daysToFix) : null,
    });
  }

  const windowEvents = inWindow.flatMap((history) => history.events);
  return {
    totalEvents: ordered.length,
    windowStart: options.sinceMs ?? null,
    authority: effectivenessAuthority(windowEvents, options.protectedGateRunIds),
    provenance: summarizeEffectivenessProvenance(windowEvents, options.protectedGateRunIds),
    anomalies: effectivenessAnomalies(inWindow, checks, options.protectedGateRunIds),
    checks: checks.sort((left, right) => left.check.localeCompare(right.check)),
  };
}

function effectivenessAuthority(
  events: readonly OutcomeEvent[],
  protectedGateRunIds: ReadonlySet<string> | undefined,
): EffectivenessAuthority {
  if (events.length === 0) return 'no-data';
  const protectedCount = events.filter((event) => isExternallyAttested(event, protectedGateRunIds)).length;
  if (protectedCount === events.length) return 'protected-external-evaluation';
  if (protectedCount > 0) return 'mixed-authority-telemetry';
  return 'local-writable-telemetry';
}

function summarizeEffectivenessProvenance(
  events: readonly OutcomeEvent[],
  protectedGateRunIds: ReadonlySet<string> | undefined,
): EffectivenessProvenanceSummary {
  const gateRuns = new Set(events.flatMap((event) => (event.gateRunId ? [event.gateRunId] : [])));
  const claimedProtected = events.filter((event) => event.observer?.authority === 'protected-external');
  const attestedProtected = claimedProtected.filter((event) => isExternallyAttested(event, protectedGateRunIds));
  return {
    localAgentEvents: events.filter((event) => event.observer?.kind === 'local-agent').length,
    localHumanEvents: events.filter((event) => event.observer?.kind === 'local-human').length,
    protectedCiEvents: events.filter((event) => event.observer?.kind === 'protected-ci').length,
    legacyUnknownEvents: events.filter((event) => event.observer === undefined).length,
    repositoryWritableEvents: events.filter((event) => event.observer?.authority === 'repository-writable').length,
    protectedExternalEvents: claimedProtected.length,
    attestedProtectedEvents: attestedProtected.length,
    unattestedProtectedClaims: claimedProtected.length - attestedProtected.length,
    distinctGateRuns: gateRuns.size,
    missingGateRunIdEvents: events.filter((event) => event.gateRunId === undefined).length,
  };
}

function effectivenessAnomalies(
  histories: readonly FindingHistory[],
  checks: readonly CheckEffectiveness[],
  protectedGateRunIds: ReadonlySet<string> | undefined,
): EffectivenessAnomaly[] {
  const events = histories.flatMap((history) => history.events);
  const anomalies: EffectivenessAnomaly[] = [];
  const withSamples = (candidates: readonly OutcomeEvent[]): EffectivenessAnomalySample[] =>
    candidates.slice(0, 5).map((event) => ({
      check: event.check,
      findingId: event.findingId,
      ...(event.gateRunId ? { gateRunId: event.gateRunId } : {}),
    }));

  const legacy = events.filter((event) => event.observer === undefined);
  if (legacy.length > 0) {
    anomalies.push({
      code: 'legacy-provenance-missing',
      message: `${legacy.length} event(s) predate observer provenance and remain repository-writable telemetry.`,
      samples: withSamples(legacy),
    });
  }
  const missingRun = events.filter((event) => event.gateRunId === undefined);
  if (missingRun.length > 0) {
    anomalies.push({
      code: 'gate-run-identity-missing',
      message: `${missingRun.length} event(s) lack an originating gate-run identity.`,
      samples: withSamples(missingRun),
    });
  }
  const unattestedClaims = events.filter(
    (event) => event.observer?.authority === 'protected-external' && !isExternallyAttested(event, protectedGateRunIds),
  );
  if (unattestedClaims.length > 0) {
    anomalies.push({
      code: 'unattested-protected-claim',
      message: `${unattestedClaims.length} event(s) claim protected authority without a separately supplied gate-run attestation; they remain writable telemetry.`,
      samples: withSamples(unattestedClaims),
    });
  }
  if (effectivenessAuthority(events, protectedGateRunIds) === 'mixed-authority-telemetry') {
    anomalies.push({
      code: 'mixed-observer-authority',
      message:
        'Protected external observations and repository-writable observations are mixed; no precision claim is valid.',
      samples: withSamples(events),
    });
  }
  for (const check of checks) {
    if (!automaticSuppressionRateIsAnomalous(check.suppressed, check.caught)) continue;
    const candidates = events.filter((event) => event.check === check.check && event.event === 'suppressed');
    anomalies.push({
      code: 'automatic-suppression-rate',
      message: `${check.check} suppressed ${check.suppressed} of ${check.caught} finding lifecycle(s), above the automatic calibration threshold.`,
      samples: withSamples(candidates),
    });
  }
  return anomalies;
}

function isExternallyAttested(event: OutcomeEvent, protectedGateRunIds: ReadonlySet<string> | undefined): boolean {
  return (
    event.observer?.kind === 'protected-ci' &&
    event.observer.authority === 'protected-external' &&
    event.gateRunId !== undefined &&
    protectedGateRunIds?.has(event.gateRunId) === true
  );
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
