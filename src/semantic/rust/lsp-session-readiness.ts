import {
  RustAnalyzerReadinessError,
  rustAnalyzerOperationBudget,
  type RustAnalyzerRequestOptions,
  type RustAnalyzerServerStatus,
  type RustAnalyzerServerStatusSnapshot,
} from './lsp-client.js';

export type RustAnalyzerReadinessWorkerErrorEnvelope = { ok: false; error: string };

export interface RustAnalyzerReadinessClient {
  serverStatusGeneration(): number;
  serverStatusSnapshot(): RustAnalyzerServerStatusSnapshot | null;
  readinessBarrier(opts?: RustAnalyzerRequestOptions): Promise<void>;
  waitForQuiescence(afterGeneration: number, timeoutMs: number): Promise<RustAnalyzerServerStatus>;
}

export async function waitForRustAnalyzerReadiness(
  client: RustAnalyzerReadinessClient,
  afterGeneration: number,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<RustAnalyzerServerStatus> {
  const remainingMs = deadlineMs - now();
  if (remainingMs <= 0) {
    throw new RustAnalyzerReadinessError('rust-analyzer readiness deadline expired before quiescence');
  }
  try {
    const status = await client.waitForQuiescence(afterGeneration, remainingMs);
    assertRustAnalyzerReadinessBudget(deadlineMs, now, 'during quiescence');
    if (status.health === 'error') {
      throw new RustAnalyzerReadinessError('rust-analyzer reported error health before reaching readiness');
    }
    if (!status.quiescent) {
      throw new RustAnalyzerReadinessError('rust-analyzer did not report quiescence before reaching readiness');
    }
    return status;
  } catch (error) {
    if (error instanceof RustAnalyzerReadinessError) throw error;
    throw new RustAnalyzerReadinessError(error instanceof Error ? error.message : String(error));
  }
}

export async function waitForRustAnalyzerInitialPostOpenReadiness(
  client: RustAnalyzerReadinessClient,
  initializationGeneration: number,
  openedDocumentCount: number,
  deadlineMs: number,
  settleDelayMs: number,
  now: () => number = Date.now,
  settle: (delayMs: number) => Promise<void> = sleep,
): Promise<RustAnalyzerServerStatus> {
  const initialStatus = await waitForRustAnalyzerReadiness(client, initializationGeneration, deadlineMs, now);
  if (openedDocumentCount === 0) return initialStatus;
  const checkpoint = client.serverStatusSnapshot();
  if (!checkpoint) {
    throw new RustAnalyzerReadinessError('rust-analyzer status is unavailable after initial document open');
  }
  const postOpenStatus = await waitForRustAnalyzerPostOpenReadiness(
    client,
    checkpoint,
    openedDocumentCount,
    deadlineMs,
    settleDelayMs,
    now,
    settle,
  );
  return postOpenStatus ?? initialStatus;
}

export async function waitForRustAnalyzerPostOpenReadiness(
  client: RustAnalyzerReadinessClient,
  checkpoint: RustAnalyzerServerStatusSnapshot | null,
  openedDocumentCount: number,
  deadlineMs: number,
  settleDelayMs: number,
  now: () => number = Date.now,
  settle: (delayMs: number) => Promise<void> = sleep,
): Promise<RustAnalyzerServerStatus | null> {
  if (openedDocumentCount === 0) return null;
  if (!checkpoint) {
    throw new RustAnalyzerReadinessError('rust-analyzer status is unavailable before document open');
  }
  assertUsableQuiescentStatus(checkpoint.status, 'before document open');
  try {
    await client.readinessBarrier({ deadlineMs });
    assertRustAnalyzerReadinessBudget(deadlineMs, now, 'during post-open synchronization');
  } catch (error) {
    if (error instanceof RustAnalyzerReadinessError) throw error;
    throw new RustAnalyzerReadinessError(error instanceof Error ? error.message : String(error));
  }

  const latest = client.serverStatusSnapshot();
  if (!latest || latest.generation < checkpoint.generation) {
    throw new RustAnalyzerReadinessError('rust-analyzer status is unavailable after document open');
  }
  let readyStatus: RustAnalyzerServerStatus;
  if (latest.generation === checkpoint.generation) {
    assertUsableQuiescentStatus(latest.status, 'after document open');
    readyStatus = latest.status;
  } else {
    readyStatus = await waitForRustAnalyzerReadiness(client, checkpoint.generation, deadlineMs, now);
  }
  await waitForRustAnalyzerDelayWithinDeadline(settleDelayMs, deadlineMs, now, settle);
  return readyStatus;
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

function assertUsableQuiescentStatus(status: RustAnalyzerServerStatus, phase: string): void {
  if (status.health === 'error') {
    throw new RustAnalyzerReadinessError(`rust-analyzer reported error health ${phase}`);
  }
  if (!status.quiescent) {
    throw new RustAnalyzerReadinessError(`rust-analyzer did not report quiescence ${phase}`);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
