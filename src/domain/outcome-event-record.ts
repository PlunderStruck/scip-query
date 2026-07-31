import type {
  OutcomeEvent,
  OutcomeEventKind,
  OutcomeObserverAuthority,
  OutcomeObserverKind,
  OutcomeObserverProvenance,
} from './finding-outcomes.js';
import { isObservationReceipt } from './observation-receipt.js';
import type { RecordCompatibilityState } from './record-compatibility.js';
import { isBoundedRecordString, isRecordObject } from './record-validation.js';

export const OUTCOME_EVENT_RECORD_KIND = 'scip-query-outcome-event';
export const OUTCOME_EVENT_RECORD_SCHEMA_VERSION = 1;

export interface OutcomeEventRecordV1 extends OutcomeEvent {
  kind: typeof OUTCOME_EVENT_RECORD_KIND;
  schemaVersion: typeof OUTCOME_EVENT_RECORD_SCHEMA_VERSION;
  eventIdentity: string;
  writer: {
    tool: 'scip-query';
    version: string;
  };
}

export type DecodedOutcomeEventRecord =
  | {
      state: 'legacy' | 'current';
      event: OutcomeEvent;
      record: OutcomeEvent | OutcomeEventRecordV1;
      schemaVersion: 0 | typeof OUTCOME_EVENT_RECORD_SCHEMA_VERSION;
    }
  | {
      state: Exclude<RecordCompatibilityState, 'legacy' | 'current'>;
      error: string;
    };

export function outcomeEventIdentity(event: OutcomeEvent): string {
  return JSON.stringify([event.check, event.findingId, event.event, event.commit]);
}

export function createOutcomeEventRecord(event: OutcomeEvent, toolVersion: string): OutcomeEventRecordV1 {
  if (toolVersion.trim() === '') throw new Error('outcome event writer requires a non-empty tool version');
  return {
    ...event,
    kind: OUTCOME_EVENT_RECORD_KIND,
    schemaVersion: OUTCOME_EVENT_RECORD_SCHEMA_VERSION,
    eventIdentity: outcomeEventIdentity(event),
    writer: { tool: 'scip-query', version: toolVersion },
  };
}

export function decodeOutcomeEventRecord(value: unknown): DecodedOutcomeEventRecord {
  if (!isRecordObject(value)) return { state: 'malformed', error: 'not an outcome event object' };
  const candidate = value as Record<string, unknown>;
  const schemaVersion = candidate['schemaVersion'];
  if (schemaVersion === undefined) {
    if (
      candidate['kind'] !== undefined ||
      candidate['eventIdentity'] !== undefined ||
      candidate['writer'] !== undefined
    ) {
      return { state: 'malformed', error: 'outcome event envelope metadata requires schemaVersion' };
    }
    const event = eventFromRecord(candidate);
    return event
      ? { state: 'legacy', event, record: event, schemaVersion: 0 }
      : { state: 'malformed', error: 'invalid legacy outcome event fields' };
  }
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) {
    return Number.isSafeInteger(schemaVersion)
      ? { state: 'unsupported-older', error: `unsupported schemaVersion ${String(schemaVersion)}` }
      : { state: 'malformed', error: 'schemaVersion must be a positive safe integer' };
  }
  if (schemaVersion !== OUTCOME_EVENT_RECORD_SCHEMA_VERSION) {
    return {
      state:
        (schemaVersion as number) > OUTCOME_EVENT_RECORD_SCHEMA_VERSION ? 'unsupported-future' : 'unsupported-older',
      error: `unsupported schemaVersion ${String(schemaVersion)}`,
    };
  }
  if (candidate['kind'] !== OUTCOME_EVENT_RECORD_KIND) {
    return { state: 'malformed', error: `kind must be ${OUTCOME_EVENT_RECORD_KIND}` };
  }
  const event = eventFromRecord(candidate);
  if (!event) return { state: 'malformed', error: 'invalid current outcome event fields' };
  if (candidate['eventIdentity'] !== outcomeEventIdentity(event)) {
    return { state: 'malformed', error: 'eventIdentity does not match the outcome event' };
  }
  const writer = candidate['writer'];
  if (
    !isRecordObject(writer) ||
    writer['tool'] !== 'scip-query' ||
    typeof writer['version'] !== 'string' ||
    writer['version'].trim() === ''
  ) {
    return { state: 'malformed', error: 'missing valid writer metadata' };
  }
  return {
    state: 'current',
    event,
    record: candidate as unknown as OutcomeEventRecordV1,
    schemaVersion: OUTCOME_EVENT_RECORD_SCHEMA_VERSION,
  };
}

const EVENT_KINDS: readonly OutcomeEventKind[] = ['caught', 'resolved', 'suppressed', 'reopened'];

function eventFromRecord(candidate: Record<string, unknown>): OutcomeEvent | undefined {
  if (
    typeof candidate['ts'] !== 'number' ||
    !Number.isFinite(candidate['ts']) ||
    typeof candidate['check'] !== 'string' ||
    candidate['check'].trim() === '' ||
    typeof candidate['findingId'] !== 'string' ||
    candidate['findingId'].trim() === '' ||
    !EVENT_KINDS.includes(candidate['event'] as OutcomeEventKind) ||
    (candidate['commit'] !== null && typeof candidate['commit'] !== 'string') ||
    (candidate['comparisonBaseCommit'] !== undefined && typeof candidate['comparisonBaseCommit'] !== 'string') ||
    (candidate['verifiedAgainstCommit'] !== undefined &&
      (candidate['event'] !== 'resolved' || typeof candidate['verifiedAgainstCommit'] !== 'string')) ||
    (candidate['symbol'] !== undefined && typeof candidate['symbol'] !== 'string') ||
    (candidate['gateRunId'] !== undefined && !isBoundedRecordString(candidate['gateRunId'])) ||
    (candidate['observer'] !== undefined && !isOutcomeObserverProvenance(candidate['observer'])) ||
    (candidate['observation'] !== undefined && !isObservationReceipt(candidate['observation'])) ||
    (candidate['suppressionPolicyVersion'] !== undefined &&
      (candidate['event'] !== 'suppressed' ||
        !Number.isSafeInteger(candidate['suppressionPolicyVersion']) ||
        (candidate['suppressionPolicyVersion'] as number) < 1))
  ) {
    return undefined;
  }
  return {
    ts: candidate['ts'],
    check: candidate['check'],
    findingId: candidate['findingId'],
    event: candidate['event'] as OutcomeEventKind,
    commit: candidate['commit'],
    ...(typeof candidate['comparisonBaseCommit'] === 'string'
      ? { comparisonBaseCommit: candidate['comparisonBaseCommit'] }
      : {}),
    ...(typeof candidate['verifiedAgainstCommit'] === 'string'
      ? { verifiedAgainstCommit: candidate['verifiedAgainstCommit'] }
      : {}),
    ...(typeof candidate['symbol'] === 'string' ? { symbol: candidate['symbol'] } : {}),
    ...(typeof candidate['gateRunId'] === 'string' ? { gateRunId: candidate['gateRunId'] } : {}),
    ...(candidate['observer'] !== undefined ? { observer: candidate['observer'] as OutcomeObserverProvenance } : {}),
    ...(candidate['observation'] !== undefined
      ? { observation: candidate['observation'] as OutcomeEvent['observation'] }
      : {}),
    ...(typeof candidate['suppressionPolicyVersion'] === 'number'
      ? { suppressionPolicyVersion: candidate['suppressionPolicyVersion'] }
      : {}),
  };
}

const OBSERVER_KINDS: readonly OutcomeObserverKind[] = ['local-agent', 'local-human', 'protected-ci'];
const OBSERVER_AUTHORITIES: readonly OutcomeObserverAuthority[] = ['repository-writable', 'protected-external'];

function isOutcomeObserverProvenance(value: unknown): value is OutcomeObserverProvenance {
  if (!isRecordObject(value)) return false;
  const kind = value['kind'] as OutcomeObserverKind;
  const authority = value['authority'] as OutcomeObserverAuthority;
  return (
    OBSERVER_KINDS.includes(kind) &&
    OBSERVER_AUTHORITIES.includes(authority) &&
    (authority !== 'protected-external' || kind === 'protected-ci') &&
    (value['source'] === undefined ||
      (typeof value['source'] === 'string' && value['source'].length > 0 && value['source'].length <= 256))
  );
}
