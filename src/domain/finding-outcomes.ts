/**
 * Dependency-free identities and transitions for detector finding outcomes.
 *
 * This model is shared by the local SQLite ledger, the committed repository
 * event ledger, and runtime reconciliation. None of those persistence or
 * orchestration mechanisms owns what an outcome means.
 */

export type FindingOutcome = 'resolved' | 'suppressed' | 'still-open';

export interface FindingOutcomeRecord {
  check: string;
  findingId: string;
  firstSeen: number;
  lastSeen: number;
  timesShown: number;
  outcome: FindingOutcome;
}

export interface ObservedFinding {
  check: string;
  findingId: string;
  suppressed: boolean;
}

export function ledgerKey(check: string, findingId: string): string {
  return `${check}\0${findingId}`;
}

export type OutcomeEventKind = 'caught' | 'resolved' | 'suppressed' | 'reopened';

export interface OutcomeEvent {
  /** Wall-clock ms when the transition was observed. */
  ts: number;
  check: string;
  findingId: string;
  event: OutcomeEventKind;
  /** HEAD commit at observation time; null when git is unavailable. */
  commit: string | null;
  /** Resolved commit used as the gate's diff baseline for this observation. */
  comparisonBaseCommit?: string;
  /** Original comparison commit replayed to prove a cross-HEAD resolution. */
  verifiedAgainstCommit?: string;
  /** SCIP symbol of the finding when known — enables rename ("moved") reclassification at query time. */
  symbol?: string;
}

export interface OutcomeEventEvidence {
  comparisonBaseCommit?: string;
  verifiedAgainstByFinding?: ReadonlyMap<string, string>;
}

/** Compare finding-ledger snapshots and emit the immutable events describing their transitions. */
export function deriveOutcomeEvents(
  previous: readonly FindingOutcomeRecord[],
  next: readonly FindingOutcomeRecord[],
  symbolByFindingId: ReadonlyMap<string, string>,
  commit: string | null,
  now: number,
  evidence: OutcomeEventEvidence = {},
): OutcomeEvent[] {
  const prevByKey = new Map(previous.map((record) => [ledgerKey(record.check, record.findingId), record]));
  const events: OutcomeEvent[] = [];

  const push = (record: FindingOutcomeRecord, event: OutcomeEventKind) => {
    const symbol = symbolByFindingId.get(record.findingId);
    const verifiedAgainstCommit =
      event === 'resolved'
        ? evidence.verifiedAgainstByFinding?.get(ledgerKey(record.check, record.findingId))
        : undefined;
    events.push({
      ts: now,
      check: record.check,
      findingId: record.findingId,
      event,
      commit,
      ...(evidence.comparisonBaseCommit ? { comparisonBaseCommit: evidence.comparisonBaseCommit } : {}),
      ...(verifiedAgainstCommit ? { verifiedAgainstCommit } : {}),
      ...(symbol ? { symbol } : {}),
    });
  };

  for (const record of next) {
    const before = prevByKey.get(ledgerKey(record.check, record.findingId));
    if (!before) {
      push(record, 'caught');
      if (record.outcome === 'suppressed') push(record, 'suppressed');
      continue;
    }
    if (before.outcome === record.outcome) continue;
    if (record.outcome === 'resolved') push(record, 'resolved');
    else if (record.outcome === 'suppressed') push(record, 'suppressed');
    else if (record.outcome === 'still-open') push(record, 'reopened');
  }

  return events;
}

/** The caught/reopened event that began the finding's current lifecycle. */
export function latestOutcomeLifecycleAnchor(events: readonly OutcomeEvent[]): OutcomeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.event === 'caught' || event?.event === 'reopened') return event;
  }
  return undefined;
}
