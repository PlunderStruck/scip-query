import { RustAnalyzerReadinessError, type RustAnalyzerServerStatus } from './lsp-client.js';

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
    await client.waitForQuiescence(afterGeneration, remainingMs);
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
  if (settleDelayMs > 0) await settle(settleDelayMs);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
