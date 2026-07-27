import { describe, expect, it } from 'vitest';
import {
  createOwnedProcessTree,
  terminateOwnedProcessTree,
  type ProcessTreeRuntime,
} from '../../src/platform/process-tree.js';
import type { ProcessIdentity } from '../../src/platform/process-identity.js';

function identity(pid: number, startToken: string): ProcessIdentity {
  return { version: 1, pid, platform: 'linux', startToken };
}

function fakeRuntime(overrides: Partial<ProcessTreeRuntime> = {}): ProcessTreeRuntime & { elapsed: number } {
  const runtime: ProcessTreeRuntime & { elapsed: number } = {
    platform: 'linux',
    elapsed: 0,
    now() {
      return runtime.elapsed;
    },
    readIdentity() {
      return null;
    },
    isProcessAlive() {
      return false;
    },
    isProcessGroupAlive() {
      return false;
    },
    listDescendantPids() {
      return [];
    },
    signal() {},
    terminateWindowsTree() {},
    async sleep(ms) {
      runtime.elapsed += ms;
    },
    ...overrides,
  };
  return runtime;
}

describe('owned process-tree termination', () => {
  it('settles unreaped at a finite deadline when birth identity is unavailable', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const runtime = fakeRuntime({
      isProcessAlive: () => true,
      signal(pid, signal) {
        signals.push({ pid, signal });
      },
    });
    const tree = createOwnedProcessTree(41, true, runtime);

    await expect(terminateOwnedProcessTree(tree, { gracefulMs: 10, forceMs: 15 }, runtime)).resolves.toMatchObject({
      reaped: false,
      reason: 'identity-unavailable',
    });
    expect(runtime.elapsed).toBe(25);
    expect(signals).toEqual([]);
  });

  it('does not signal a reused root identity', async () => {
    let currentIdentity = identity(41, 'original');
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const runtime = fakeRuntime({
      readIdentity: () => currentIdentity,
      isProcessAlive: () => true,
      signal(pid, signal) {
        signals.push({ pid, signal });
      },
    });
    const tree = createOwnedProcessTree(41, true, runtime);
    currentIdentity = identity(41, 'replacement');

    await expect(terminateOwnedProcessTree(tree, { gracefulMs: 10, forceMs: 15 }, runtime)).resolves.toMatchObject({
      reaped: false,
      reason: 'identity-mismatch',
    });
    expect(signals).toEqual([]);
  });

  it('revalidates a known descendant before force signaling it', async () => {
    const originalRoot = identity(41, 'root');
    const originalChild = identity(42, 'child');
    let rootAlive = true;
    let childIdentity = originalChild;
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const runtime = fakeRuntime({
      readIdentity(pid) {
        if (pid === 41) return rootAlive ? originalRoot : null;
        return pid === 42 ? childIdentity : null;
      },
      isProcessAlive: () => true,
      listDescendantPids: () => [42],
      signal(pid, signal) {
        signals.push({ pid, signal });
        if (signal === 'SIGTERM') {
          rootAlive = false;
          childIdentity = identity(42, 'replacement-child');
        }
      },
    });
    const tree = createOwnedProcessTree(41, false, runtime);

    const result = await terminateOwnedProcessTree(tree, { gracefulMs: 10, forceMs: 10 }, runtime);

    expect(result).toMatchObject({ reaped: true, reason: 'terminated' });
    expect(signals).toEqual([{ pid: 41, signal: 'SIGTERM' }]);
  });

  it('uses the Windows tree primitive only after root identity validation', async () => {
    const rootIdentity = identity(41, 'root');
    let alive = true;
    const terminated: number[] = [];
    const runtime = fakeRuntime({
      platform: 'win32',
      readIdentity: () => (alive ? rootIdentity : null),
      isProcessAlive: () => alive,
      terminateWindowsTree(pid) {
        terminated.push(pid);
        alive = false;
      },
    });
    const tree = createOwnedProcessTree(41, false, runtime);

    await expect(terminateOwnedProcessTree(tree, { gracefulMs: 10, forceMs: 15 }, runtime)).resolves.toMatchObject({
      reaped: true,
      reason: 'terminated',
    });
    expect(terminated).toEqual([41]);
  });
});
