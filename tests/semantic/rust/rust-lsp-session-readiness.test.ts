import { describe, expect, it, vi } from 'vitest';
import { RustAnalyzerReadinessError, type RustAnalyzerServerStatus } from '../../../src/semantic/rust/lsp-client.js';
import {
  waitForRustAnalyzerPostOpenReadiness,
  waitForRustAnalyzerReadiness,
  type RustAnalyzerReadinessClient,
} from '../../../src/semantic/rust/lsp-session-readiness.js';

const readyStatus: RustAnalyzerServerStatus = { health: 'ok', quiescent: true };

class FakeReadinessClient implements RustAnalyzerReadinessClient {
  generation = 0;
  readonly waits: Array<{ afterGeneration: number; timeoutMs: number }> = [];

  constructor(
    private readonly wait: (
      afterGeneration: number,
      timeoutMs: number,
    ) => Promise<RustAnalyzerServerStatus> = async () => readyStatus,
  ) {}

  serverStatusGeneration(): number {
    return this.generation;
  }

  waitForQuiescence(afterGeneration: number, timeoutMs: number): Promise<RustAnalyzerServerStatus> {
    this.waits.push({ afterGeneration, timeoutMs });
    return this.wait(afterGeneration, timeoutMs);
  }
}

describe('waitForRustAnalyzerReadiness', () => {
  it('passes the remaining absolute-deadline budget to the client', async () => {
    const client = new FakeReadinessClient();

    await waitForRustAnalyzerReadiness(client, 7, 1_250, () => 1_000);

    expect(client.waits).toEqual([{ afterGeneration: 7, timeoutMs: 250 }]);
  });

  it.each([1_000, 999])('rejects an expired budget at now=%s without starting a wait', async (deadlineMs) => {
    const client = new FakeReadinessClient();

    await expect(waitForRustAnalyzerReadiness(client, 0, deadlineMs, () => 1_000)).rejects.toBeInstanceOf(
      RustAnalyzerReadinessError,
    );
    expect(client.waits).toEqual([]);
  });

  it('waits after initialization from the generation checkpoint taken before initialize', async () => {
    const events: string[] = [];
    const client = new FakeReadinessClient(async (afterGeneration) => {
      events.push(`wait:${afterGeneration}`);
      return readyStatus;
    });
    client.generation = 3;
    const checkpoint = client.serverStatusGeneration();
    events.push('initialize');
    client.generation = 4;

    await waitForRustAnalyzerReadiness(client, checkpoint, 2_000, () => 1_000);

    expect(events).toEqual(['initialize', 'wait:3']);
  });

  it.each([
    new Error('rust-analyzer readiness timed out'),
    new Error('rust-analyzer reported warning health'),
    new Error('rust-analyzer reported error health'),
    new Error('rust-analyzer transport closed'),
  ])('normalizes client failure %s to a typed readiness error', async (failure) => {
    const client = new FakeReadinessClient(async () => {
      throw failure;
    });

    const readiness = waitForRustAnalyzerReadiness(client, 0, 2_000, () => 1_000);

    await expect(readiness).rejects.toBeInstanceOf(RustAnalyzerReadinessError);
    await expect(readiness).rejects.toThrow(failure.message);
  });
});

describe('waitForRustAnalyzerPostOpenReadiness', () => {
  it('waits from the generation checkpoint taken before didOpen', async () => {
    const events: string[] = [];
    const client = new FakeReadinessClient(async (afterGeneration) => {
      events.push(`wait:${afterGeneration}`);
      return readyStatus;
    });
    client.generation = 8;
    const checkpoint = client.serverStatusGeneration();
    events.push('didOpen');
    client.generation = 9;

    await waitForRustAnalyzerPostOpenReadiness(client, checkpoint, 1, 2_000, 0, () => 1_000, vi.fn());

    expect(events).toEqual(['didOpen', 'wait:8']);
  });

  it('skips the readiness barrier and settle delay when no documents opened', async () => {
    const client = new FakeReadinessClient();
    const settle = vi.fn(async () => undefined);

    await waitForRustAnalyzerPostOpenReadiness(client, 0, 0, 2_000, 25, () => 1_000, settle);

    expect(client.waits).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
  });

  it('runs an explicit settle delay only after observed quiescence', async () => {
    const events: string[] = [];
    let resolveReadiness: ((status: RustAnalyzerServerStatus) => void) | undefined;
    const client = new FakeReadinessClient(
      () =>
        new Promise((resolve) => {
          events.push('wait');
          resolveReadiness = resolve;
        }),
    );
    const settle = vi.fn(async (delayMs: number) => {
      events.push(`settle:${delayMs}`);
    });

    const readiness = waitForRustAnalyzerPostOpenReadiness(client, 0, 1, 2_000, 25, () => 1_000, settle);
    await Promise.resolve();
    expect(events).toEqual(['wait']);

    resolveReadiness?.(readyStatus);
    await readiness;

    expect(events).toEqual(['wait', 'settle:25']);
  });

  it('does not call the settle dependency when the explicit delay is zero', async () => {
    const client = new FakeReadinessClient();
    const settle = vi.fn(async () => undefined);

    await waitForRustAnalyzerPostOpenReadiness(client, 0, 1, 2_000, 0, () => 1_000, settle);

    expect(client.waits).toHaveLength(1);
    expect(settle).not.toHaveBeenCalled();
  });
});
