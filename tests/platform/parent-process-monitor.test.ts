import { describe, expect, it, vi } from 'vitest';

import { monitorParentProcess, type ParentProcessMonitorRuntime } from '../../src/platform/parent-process-monitor.js';
import type { ProcessIdentity } from '../../src/platform/process-identity.js';

const OWNER: ProcessIdentity = {
  version: 1,
  pid: 42,
  platform: 'darwin',
  startToken: 'Wed Jul 29 12:00:00 2026',
};

describe('monitorParentProcess', () => {
  it('fires once when the exact owner exits', () => {
    const harness = monitorHarness(OWNER);
    const lost = vi.fn();
    const monitor = monitorParentProcess(OWNER, lost, { runtime: harness.runtime });

    harness.identity = null;
    harness.tick();
    harness.tick();

    expect(lost).toHaveBeenCalledOnce();
    expect(lost).toHaveBeenCalledWith('parent process 42 exited');
    expect(harness.clear).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('treats PID reuse as owner loss', () => {
    const harness = monitorHarness({ ...OWNER, startToken: 'new process' });
    const lost = vi.fn();

    monitorParentProcess(OWNER, lost, { runtime: harness.runtime });

    expect(lost).toHaveBeenCalledWith('parent process 42 changed identity');
    expect(harness.set).not.toHaveBeenCalled();
  });

  it('stops observing a healthy owner when disposed', () => {
    const harness = monitorHarness(OWNER);
    const lost = vi.fn();
    const monitor = monitorParentProcess(OWNER, lost, { runtime: harness.runtime });

    monitor.stop();
    harness.identity = null;
    harness.tick();

    expect(lost).not.toHaveBeenCalled();
    expect(harness.clear).toHaveBeenCalledOnce();
  });
});

function monitorHarness(initialIdentity: ProcessIdentity | null): {
  runtime: ParentProcessMonitorRuntime;
  identity: ProcessIdentity | null;
  tick(): void;
  set: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  let callback: (() => void) | undefined;
  const timer = setTimeout(() => undefined, 60_000);
  clearTimeout(timer);
  const set = vi.fn((next: () => void) => {
    callback = next;
    return timer;
  });
  const clear = vi.fn();
  const harness: {
    runtime: ParentProcessMonitorRuntime;
    identity: ProcessIdentity | null;
    tick(): void;
    set: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  } = {
    identity: initialIdentity,
    tick: () => callback?.(),
    set,
    clear,
    runtime: undefined as unknown as ParentProcessMonitorRuntime,
  };
  harness.runtime = {
    readIdentity: () => harness.identity,
    setInterval: set,
    clearInterval: clear,
  };
  return harness;
}
