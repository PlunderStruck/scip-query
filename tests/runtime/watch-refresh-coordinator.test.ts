import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WatchRefreshCoordinator } from '../../src/runtime/watch-refresh-coordinator.js';
import { enqueueWatchRefreshRequest } from '../../src/storage/watch-refresh-requests.js';

const roots = new Set<string>();
const START = Date.parse('2026-07-25T20:00:00.000Z');

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('watch refresh coordinator', () => {
  it('claims only while idle and acknowledges only the corresponding completed attempt', () => {
    const root = fixtureRoot();
    let now = START;
    enqueueWatchRefreshRequest(root, 'refresh A', { now: () => new Date(now), randomId: () => 'a' });
    const coordinator = new WatchRefreshCoordinator(root, { now: () => now, randomId: () => 'claim' });
    coordinator.initializeAfterOwnershipAcquired();
    const request = vi.fn();

    expect(coordinator.poll({ state: 'indexing', startedAt: now }, request)).toBe(false);
    expect(coordinator.status()).toMatchObject({ pending: 1, claimed: 0, completed: 0 });
    expect(coordinator.poll({ state: 'idle' }, request)).toBe(true);
    expect(request).toHaveBeenCalledWith('refresh A');
    expect(coordinator.status()).toMatchObject({ pending: 0, claimed: 1, completed: 0 });

    now += 1_000;
    expect(coordinator.completeActive()).toBe(true);
    expect(coordinator.status()).toMatchObject({ pending: 0, claimed: 0, completed: 1 });
    expect(coordinator.poll({ state: 'idle' }, request)).toBe(false);
  });

  it('releases a failed attempt, observes backoff, and retries the same request', () => {
    const root = fixtureRoot();
    let now = START;
    enqueueWatchRefreshRequest(root, 'retry A', { now: () => new Date(now), randomId: () => 'a' });
    const coordinator = new WatchRefreshCoordinator(root, {
      now: () => now,
      randomId: () => `claim-${now}`,
      retryDelayMs: 500,
    });
    coordinator.initializeAfterOwnershipAcquired();
    const request = vi.fn();

    expect(coordinator.poll({ state: 'idle' }, request)).toBe(true);
    expect(coordinator.failActive()).toBe(true);
    expect(coordinator.status()).toMatchObject({ pending: 1, claimed: 0 });
    expect(coordinator.poll({ state: 'idle' }, request)).toBe(false);

    now += 500;
    expect(coordinator.poll({ state: 'idle' }, request)).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('restores an unacknowledged predecessor claim and coalesces distinct requests deliberately', () => {
    const root = fixtureRoot();
    let now = START;
    enqueueWatchRefreshRequest(root, 'first', { now: () => new Date(now), randomId: () => 'first' });
    now += 1;
    enqueueWatchRefreshRequest(root, 'second', { now: () => new Date(now), randomId: () => 'second' });
    const predecessor = new WatchRefreshCoordinator(root, { now: () => now, randomId: () => 'predecessor' });
    predecessor.poll({ state: 'idle' }, () => undefined);

    const successor = new WatchRefreshCoordinator(root, { now: () => now, randomId: () => 'successor' });
    expect(successor.initializeAfterOwnershipAcquired()).toMatchObject({ recoveredClaims: 2 });
    const request = vi.fn();
    expect(successor.poll({ state: 'idle' }, request)).toBe(true);
    expect(request).toHaveBeenCalledWith('2 coalesced refresh requests: first; second');
  });

  it('turns a legacy timestamp into a deduplicated durable request', () => {
    const root = fixtureRoot();
    const coordinator = new WatchRefreshCoordinator(root, { now: () => START });
    coordinator.initializeAfterOwnershipAcquired();

    coordinator.observeLegacyRequest(START, 'legacy');
    coordinator.observeLegacyRequest(START, 'legacy retry');

    expect(coordinator.status()).toMatchObject({ pending: 1, claimed: 0 });
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'watch-refresh-coordinator-'));
  roots.add(root);
  return root;
}
