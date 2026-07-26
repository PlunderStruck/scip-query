export type RecordCompatibilityState = 'legacy' | 'current' | 'unsupported-older' | 'unsupported-future' | 'malformed';

export interface RecordCompatibilityObservation {
  path: string;
  state: RecordCompatibilityState;
  reason?: string;
}

export interface RecordCompatibilityIssue {
  path: string;
  state: Exclude<RecordCompatibilityState, 'legacy' | 'current'>;
  reason: string;
}

/**
 * Exact accounting for a set of persisted record candidates. A partial read
 * may still return accepted records, but it cannot represent that subset as a
 * complete repository history.
 */
export interface RecordCompatibilitySummary {
  complete: boolean;
  total: number;
  accepted: number;
  legacy: number;
  current: number;
  unsupportedOlder: number;
  unsupportedFuture: number;
  malformed: number;
  omitted: number;
  issues: RecordCompatibilityIssue[];
}

export function summarizeRecordCompatibility(
  observations: readonly RecordCompatibilityObservation[],
): RecordCompatibilitySummary {
  let legacy = 0;
  let current = 0;
  let unsupportedOlder = 0;
  let unsupportedFuture = 0;
  let malformed = 0;
  const issues: RecordCompatibilityIssue[] = [];

  for (const observation of observations) {
    switch (observation.state) {
      case 'legacy':
        legacy += 1;
        break;
      case 'current':
        current += 1;
        break;
      case 'unsupported-older':
        unsupportedOlder += 1;
        issues.push(issueFromObservation(observation));
        break;
      case 'unsupported-future':
        unsupportedFuture += 1;
        issues.push(issueFromObservation(observation));
        break;
      case 'malformed':
        malformed += 1;
        issues.push(issueFromObservation(observation));
        break;
    }
  }

  const accepted = legacy + current;
  const omitted = unsupportedOlder + unsupportedFuture + malformed;
  return {
    complete: omitted === 0,
    total: observations.length,
    accepted,
    legacy,
    current,
    unsupportedOlder,
    unsupportedFuture,
    malformed,
    omitted,
    issues,
  };
}

export function formatRecordCompatibilityWarning(
  label: string,
  summary: RecordCompatibilitySummary,
): string | undefined {
  if (summary.complete) return undefined;
  return `${label} coverage is incomplete: accepted ${summary.accepted} of ${summary.total} record(s); omitted ${summary.omitted} (${summary.unsupportedOlder} unsupported older, ${summary.unsupportedFuture} unsupported future, ${summary.malformed} malformed).`;
}

function issueFromObservation(observation: RecordCompatibilityObservation): RecordCompatibilityIssue {
  if (observation.state === 'legacy' || observation.state === 'current') {
    throw new Error(`accepted record ${observation.path} cannot become a compatibility issue`);
  }
  return {
    path: observation.path,
    state: observation.state,
    reason: observation.reason ?? observation.state,
  };
}
