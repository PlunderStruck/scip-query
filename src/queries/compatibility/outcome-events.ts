import type { ObservationReceipt } from '../../domain/observation-receipt.js';

/** @deprecated The outcome-event journal was retired; retained for one minor release for stored-record readers. */
export type OutcomeEventKind = 'caught' | 'resolved' | 'suppressed' | 'reopened';

/** @deprecated The outcome-event journal was retired; retained for one minor release for stored-record readers. */
export type OutcomeObserverKind = 'local-agent' | 'local-human' | 'protected-ci';

/** @deprecated The outcome-event journal was retired; retained for one minor release for stored-record readers. */
export type OutcomeObserverAuthority = 'repository-writable' | 'protected-external';

/** @deprecated The outcome-event journal was retired; retained for one minor release for stored-record readers. */
export interface OutcomeObserverProvenance {
  kind: OutcomeObserverKind;
  authority: OutcomeObserverAuthority;
  source?: string;
}

/**
 * Historical serialized outcome-event shape.
 *
 * @deprecated scip-query no longer writes or reads an outcome-event journal.
 * This type remains for one minor release so consumers can decode records they
 * already own without implying that current scip-query persists them.
 */
export interface OutcomeEvent {
  ts: number;
  check: string;
  findingId: string;
  event: OutcomeEventKind;
  commit: string | null;
  comparisonBaseCommit?: string;
  verifiedAgainstCommit?: string;
  symbol?: string;
  gateRunId?: string;
  observer?: OutcomeObserverProvenance;
  observation?: ObservationReceipt;
  suppressionPolicyVersion?: number;
}
