import {
  RustAnalyzerReadinessError,
  rustAnalyzerOperationBudget,
  type RustAnalyzerServerStatus,
} from './lsp-client.js';

export type RustAnalyzerReadinessWorkerErrorEnvelope = { ok: false; error: string };

export interface RustAnalyzerReadinessClient {
  serverStatusGeneration(): number;
  waitForQuiescence(afterGeneration: number, timeoutMs: number): Promise<RustAnalyzerServerStatus>;
}

export async function waitForRustAnalyzerReadiness(
  client: RustAnalyzerReadinessClient,
  afterGeneration: number,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<void> {
  const remainingMs = deadlineMs - now();
  if (remainingMs <= 0) {
    throw new RustAnalyzerReadinessError('rust-analyzer readiness deadline expired before quiescence');
  }
  try {
    const status = await client.waitForQuiescence(afterGeneration, remainingMs);
    assertRustAnalyzerReadinessBudget(deadlineMs, now, 'during quiescence');
    if (status.health !== 'ok') {
      throw new RustAnalyzerReadinessError(`rust-analyzer reported ${status.health} health before reaching readiness`);
    }
    if (!status.quiescent) {
      throw new RustAnalyzerReadinessError('rust-analyzer did not report quiescence before reaching readiness');
    }
  } catch (error) {
    if (error instanceof RustAnalyzerReadinessError) throw error;
    throw new RustAnalyzerReadinessError(error instanceof Error ? error.message : String(error));
  }
}

export async function waitForRustAnalyzerPostOpenReadiness(
  client: RustAnalyzerReadinessClient,
  afterGeneration: number,
  openedDocumentCount: number,
  deadlineMs: number,
  settleDelayMs: number,
  now: () => number = Date.now,
  settle: (delayMs: number) => Promise<void> = sleep,
): Promise<void> {
  if (openedDocumentCount === 0) return;
  await waitForRustAnalyzerReadiness(client, afterGeneration, deadlineMs, now);
  await waitForRustAnalyzerDelayWithinDeadline(settleDelayMs, deadlineMs, now, settle);
}

export async function waitForRustAnalyzerDiagnosticsWithinDeadline(
  waitForDiagnostics: (timeoutMs: number) => Promise<void>,
  diagnosticsTimeoutMs: number,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<void> {
  const budget = rustAnalyzerOperationBudget(diagnosticsTimeoutMs, deadlineMs, now);
  await waitForDiagnostics(budget.timeoutMs);
  assertRustAnalyzerReadinessBudget(deadlineMs, now, 'during diagnostics');
}

export async function waitForRustAnalyzerDelayWithinDeadline(
  delayMs: number,
  deadlineMs: number,
  now: () => number = Date.now,
  wait: (delayMs: number) => Promise<void> = sleep,
): Promise<void> {
  if (delayMs <= 0) return;
  const budget = rustAnalyzerOperationBudget(delayMs, deadlineMs, now);
  if (budget.deadlineLimited) {
    throw new RustAnalyzerReadinessError('rust-analyzer readiness deadline cannot accommodate delay');
  }
  await wait(delayMs);
  assertRustAnalyzerReadinessBudget(deadlineMs, now, 'during delay');
}

export async function withRustAnalyzerReadinessInvalidation<T>(
  run: () => Promise<T>,
  invalidate: () => Promise<void>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RustAnalyzerReadinessError) await invalidate();
    throw error;
  }
}

export function rustAnalyzerReadinessWorkerErrorEnvelope(
  error: unknown,
): RustAnalyzerReadinessWorkerErrorEnvelope | null {
  return error instanceof RustAnalyzerReadinessError ? { ok: false, error: error.message } : null;
}

function assertRustAnalyzerReadinessBudget(deadlineMs: number, now: () => number, phase: string): void {
  if (deadlineMs - now() <= 0) {
    throw new RustAnalyzerReadinessError(`rust-analyzer readiness deadline expired ${phase}`);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
