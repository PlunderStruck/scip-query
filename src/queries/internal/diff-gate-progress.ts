import type { DiffGateCheck } from './diff-gate-types.js';

export interface DiffGateProgressObserver {
  onCheckStart?(check: DiffGateCheck): void;
  onCheckComplete?(check: DiffGateCheck): void;
}

let activeObserver: DiffGateProgressObserver | undefined;

/**
 * Install diagnostic progress reporting only for the synchronous gate run in
 * `execute`. The observer is process-local implementation state, not part of
 * the public diff-gate query contract.
 */
export function withDiffGateProgressObserver<T>(observer: DiffGateProgressObserver, execute: () => T): T {
  const previousObserver = activeObserver;
  activeObserver = observer;
  try {
    return execute();
  } finally {
    activeObserver = previousObserver;
  }
}

export function notifyDiffGateCheckStart(check: DiffGateCheck): void {
  activeObserver?.onCheckStart?.(check);
}

export function notifyDiffGateCheckComplete(check: DiffGateCheck): void {
  activeObserver?.onCheckComplete?.(check);
}
