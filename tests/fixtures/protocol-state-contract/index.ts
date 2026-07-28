import type { ProcessFileLockObservation } from '../../../src/platform/process-file-lock.js';
import type { SemanticAvailability } from '../../../src/semantic/types.js';
import type { CliOutputPage } from '../../../src/runtime/output-pagination.js';
import type { WatchServiceLoopIterationResult } from '../../../src/runtime/watch-server.js';
import type { WatchServiceStopResult } from '../../../src/runtime/watch-service.js';
import type { WorkerLaneResponse } from '../../../src/runtime/worker-request-lane.js';

const completePage: CliOutputPage = {
  offset: 0,
  returnedCharacters: 3,
  totalCharacters: 3,
  omittedCharacters: 0,
  remainingCharacters: 0,
  outputHash: 'a'.repeat(64),
  complete: true,
};
const incompletePage: CliOutputPage = {
  offset: 0,
  returnedCharacters: 3,
  totalCharacters: 6,
  omittedCharacters: 3,
  remainingCharacters: 3,
  outputHash: 'a'.repeat(64),
  complete: false,
  continuation: { cursor: 'next', command: 'scip-query refs x' },
};
const success: WorkerLaneResponse<string, { requests: number }> = {
  kind: 'response',
  requestId: 'one',
  ok: true,
  result: 'done',
  status: { requests: 1 },
};
const failure: WorkerLaneResponse<string, { requests: number }> = {
  kind: 'response',
  requestId: 'one',
  ok: false,
  error: 'failed',
  status: { requests: 1 },
};

// @ts-expect-error incomplete pages require a continuation
const incompleteWithoutContinuation: CliOutputPage = { ...completePage, complete: false };
// @ts-expect-error complete pages forbid a continuation
const completeWithContinuation: CliOutputPage = { ...incompletePage, complete: true };
// @ts-expect-error successful Worker responses require a result
const successWithoutResult: WorkerLaneResponse<string, number> = {
  kind: 'response',
  requestId: 'one',
  ok: true,
  status: 1,
};
// @ts-expect-error failed Worker responses require an error
const failureWithoutError: WorkerLaneResponse<string, number> = {
  kind: 'response',
  requestId: 'one',
  ok: false,
  status: 1,
};
// @ts-expect-error continued watch iterations require their selected delay
const runningWithoutDelay: WatchServiceLoopIterationResult = {
  indexRequests: 0,
  semanticRequests: 0,
  processedRequests: 0,
  consecutiveIdlePolls: 1,
  stopped: false,
};
// @ts-expect-error stopped watch iterations cannot carry a delay
const stoppedWithDelay: WatchServiceLoopIterationResult = {
  indexRequests: 0,
  semanticRequests: 0,
  processedRequests: 0,
  consecutiveIdlePolls: 1,
  stopped: true,
  delayMs: 50,
};
// @ts-expect-error a successful stop owns the stopped process identity
const stoppedWithoutPid: WatchServiceStopResult = { disposition: 'stopped' };
// @ts-expect-error an already-stopped service has no stopped process identity
const alreadyStoppedWithPid: WatchServiceStopResult = { disposition: 'already-stopped', pid: 1 };
// @ts-expect-error a valid lock observation requires the parsed record and owner
const validLockWithoutRecord: ProcessFileLockObservation = { state: 'valid' };
// @ts-expect-error unavailable semantic evidence requires a reason
const unavailableWithoutReason: SemanticAvailability = { available: false };
// @ts-expect-error available semantic evidence cannot carry a failure reason
const availableWithReason: SemanticAvailability = { available: true, reason: 'failed' };

void [
  completePage,
  incompletePage,
  success,
  failure,
  incompleteWithoutContinuation,
  completeWithContinuation,
  successWithoutResult,
  failureWithoutError,
  runningWithoutDelay,
  stoppedWithDelay,
  stoppedWithoutPid,
  alreadyStoppedWithPid,
  validLockWithoutRecord,
  unavailableWithoutReason,
  availableWithReason,
];
