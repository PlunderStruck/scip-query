import { describe, expect, it, vi } from 'vitest';
import { RustAnalyzerReadinessError, type RustAnalyzerServerStatus } from '../../../src/semantic/rust/lsp-client.js';
import {
  rustAnalyzerReadinessWorkerErrorEnvelope,
  waitForRustAnalyzerDiagnosticsWithinDeadline,
  waitForRustAnalyzerPostOpenReadiness,
  waitForRustAnalyzerReadiness,
  withRustAnalyzerReadinessInvalidation,
  type RustAnalyzerReadinessClient,
} from '../../../src/semantic/rust/lsp-session-readiness.js';
import { discardRustAnalyzerSession } from '../../../src/semantic/rust/lsp-session-worker.js';

type RustAnalyzerSessionState = Parameters<typeof discardRustAnalyzerSession>[1];

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

  it.each(['warning', 'error'] as const)('rejects a returned %s status from a structural client', async (health) => {
    const client = new FakeReadinessClient(async () => ({ health, quiescent: true }));

    const readiness = waitForRustAnalyzerReadiness(client, 0, 2_000, () => 1_000);

    await expect(readiness).rejects.toBeInstanceOf(RustAnalyzerReadinessError);
    await expect(readiness).rejects.toThrow(`reported ${health} health`);
  });

  it('rejects a healthy quiescent status returned after the absolute deadline', async () => {
    let nowMs = 1_000;
    const client = new FakeReadinessClient(async () => {
      nowMs = 1_251;
      return readyStatus;
    });

    const readiness = waitForRustAnalyzerReadiness(client, 0, 1_250, () => nowMs);

    await expect(readiness).rejects.toBeInstanceOf(RustAnalyzerReadinessError);
    await expect(readiness).rejects.toThrow('deadline expired during quiescence');
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

  it('rejects before starting a settle delay that would consume the remaining deadline', async () => {
    const client = new FakeReadinessClient();
    const settle = vi.fn(async () => undefined);

    const readiness = waitForRustAnalyzerPostOpenReadiness(client, 0, 1, 1_025, 25, () => 1_000, settle);

    await expect(readiness).rejects.toBeInstanceOf(RustAnalyzerReadinessError);
    expect(settle).not.toHaveBeenCalled();
  });

  it('rejects when a shorter settle delay nevertheless overruns the deadline', async () => {
    const client = new FakeReadinessClient();
    let nowMs = 1_000;
    const settle = vi.fn(async () => {
      nowMs = 1_100;
    });

    const readiness = waitForRustAnalyzerPostOpenReadiness(client, 0, 1, 1_100, 25, () => nowMs, settle);

    await expect(readiness).rejects.toBeInstanceOf(RustAnalyzerReadinessError);
    expect(settle).toHaveBeenCalledWith(25);
  });
});

describe('waitForRustAnalyzerDiagnosticsWithinDeadline', () => {
  it('caps diagnostics to the remaining absolute deadline', async () => {
    const waitForDiagnostics = vi.fn(async () => undefined);

    await waitForRustAnalyzerDiagnosticsWithinDeadline(waitForDiagnostics, 500, 1_250, () => 1_000);

    expect(waitForDiagnostics).toHaveBeenCalledWith(250);
  });

  it('rejects an expired deadline before starting diagnostics', async () => {
    const waitForDiagnostics = vi.fn(async () => undefined);

    const diagnostics = waitForRustAnalyzerDiagnosticsWithinDeadline(waitForDiagnostics, 500, 1_000, () => 1_000);

    await expect(diagnostics).rejects.toBeInstanceOf(RustAnalyzerReadinessError);
    expect(waitForDiagnostics).not.toHaveBeenCalled();
  });

  it('rejects when diagnostics consume the remaining deadline', async () => {
    let nowMs = 1_000;
    const waitForDiagnostics = vi.fn(async () => {
      nowMs = 1_250;
    });

    const diagnostics = waitForRustAnalyzerDiagnosticsWithinDeadline(waitForDiagnostics, 500, 1_250, () => nowMs);

    await expect(diagnostics).rejects.toBeInstanceOf(RustAnalyzerReadinessError);
    expect(waitForDiagnostics).toHaveBeenCalledWith(250);
  });
});

describe('readiness failure orchestration', () => {
  it('invalidates production state before rethrowing a typed readiness error', async () => {
    const invalidate = vi.fn(async () => undefined);
    const failure = new RustAnalyzerReadinessError('post-open readiness failed');

    const phase = withRustAnalyzerReadinessInvalidation(async () => {
      throw failure;
    }, invalidate);

    await expect(phase).rejects.toBe(failure);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('classifies only typed readiness failures as worker error envelopes', () => {
    expect(rustAnalyzerReadinessWorkerErrorEnvelope(new RustAnalyzerReadinessError('not ready'))).toEqual({
      ok: false,
      error: 'not ready',
    });
    expect(rustAnalyzerReadinessWorkerErrorEnvelope(new Error('ordinary semantic failure'))).toBeNull();
  });

  it('does not invalidate established state for an ordinary semantic failure', async () => {
    const invalidate = vi.fn(async () => undefined);
    const phase = withRustAnalyzerReadinessInvalidation(async () => {
      throw new Error('ordinary semantic failure');
    }, invalidate);

    await expect(phase).rejects.toThrow('ordinary semantic failure');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('evicts and shuts down a session whose post-open readiness fails before it can be reused', async () => {
    const shutdown = vi.fn(async () => undefined);
    const poisoned = {
      key: 'session-key',
      client: { shutdown } as unknown as RustAnalyzerSessionState['client'],
      capabilities: {},
      openedPaths: new Set(['src/lib.rs']),
    } satisfies RustAnalyzerSessionState;
    const sessions = new Map([[poisoned.key, poisoned]]);

    const postOpen = withRustAnalyzerReadinessInvalidation(
      async () => {
        throw new RustAnalyzerReadinessError('post-open readiness failed');
      },
      () => discardRustAnalyzerSession(sessions, poisoned, 2_000),
    );

    await expect(postOpen).rejects.toThrow('post-open readiness failed');
    expect(sessions.has(poisoned.key)).toBe(false);
    expect(shutdown).toHaveBeenCalledWith({ deadlineMs: 2_000 });

    const replacement = { ...poisoned, openedPaths: new Set<string>() };
    sessions.set(replacement.key, replacement);
    expect(sessions.get(replacement.key)).toBe(replacement);
    expect(sessions.get(replacement.key)).not.toBe(poisoned);
  });
});
