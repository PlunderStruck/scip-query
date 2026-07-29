import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claimWatchRefreshRequests,
  completeWatchRefreshClaim,
  enqueueWatchRefreshRequest,
  inspectWatchRefreshRequests,
  pruneWatchRefreshHistory,
  recoverWatchRefreshClaims,
  releaseWatchRefreshClaim,
} from '../../src/storage/watch-refresh-requests.js';

const roots = new Set<string>();
const NOW = Date.parse('2026-07-25T20:00:00.000Z');

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('watch refresh request store', () => {
  it('admits immutable intent and leaves activity-like unrelated writes unable to erase it', () => {
    const root = fixtureRoot();
    const accepted = enqueue(root, 'first');
    expect(accepted).toEqual(
      expect.objectContaining({
        disposition: 'accepted',
        achievedDurability: 'directory-durable',
        directorySync: 'synced',
      }),
    );

    const unrelated = join(root, '..', 'watch-activity.json');
    // Simulates arbitrary last-writer-wins activity replacements after admission.
    writeFileSync(unrelated, '{"version":1,"at":"2026-07-25T20:00:01.000Z"}\n');
    writeFileSync(unrelated, '{"version":1,"at":"2026-07-25T20:00:02.000Z"}\n');

    const batch = claimWatchRefreshRequests(root, { now: at(1_000), randomId: () => 'claim-a' });
    expect(batch.requests.map((request) => request.detail)).toEqual(['first']);
    expect(inspectWatchRefreshRequests(root)).toMatchObject({ pending: 0, claimed: 1, completed: 0 });
  });

  it('deduplicates retries by stable idempotency key while retaining the first request', () => {
    const root = fixtureRoot();
    const first = enqueueWatchRefreshRequest(root, 'first detail', {
      now: at(0),
      idempotencyKey: 'hook:session-1',
    });
    const retry = enqueueWatchRefreshRequest(root, 'changed retry detail', {
      now: at(5_000),
      idempotencyKey: 'hook:session-1',
    });

    expect(first.disposition).toBe('accepted');
    expect(retry).toEqual({ disposition: 'duplicate', request: first.request });
    expect(inspectWatchRefreshRequests(root).pending).toBe(1);
  });

  it('preserves distinct concurrent logical requests and claims them in one deliberate batch', () => {
    const root = fixtureRoot();
    enqueueWatchRefreshRequest(root, 'second', {
      now: at(1_000),
      idempotencyKey: 'second',
    });
    enqueueWatchRefreshRequest(root, 'first', {
      now: at(0),
      idempotencyKey: 'first',
    });

    const batch = claimWatchRefreshRequests(root, { now: at(2_000), randomId: () => 'batch' });

    expect(batch.requests.map((request) => request.detail)).toEqual(['first', 'second']);
    expect(inspectWatchRefreshRequests(root)).toMatchObject({ pending: 0, claimed: 2 });
  });

  it('makes the claim exclusive across competing consumers', () => {
    const root = fixtureRoot();
    enqueue(root, 'one');

    const first = claimWatchRefreshRequests(root, { now: at(1_000), randomId: () => 'first' });
    const second = claimWatchRefreshRequests(root, { now: at(1_001), randomId: () => 'second' });

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(0);
  });

  it('releases a failed attempt so the same request can be retried', () => {
    const root = fixtureRoot();
    enqueue(root, 'retry me');
    const failed = claimWatchRefreshRequests(root, { now: at(1_000), randomId: () => 'failed' });

    releaseWatchRefreshClaim(root, failed);
    const retry = claimWatchRefreshRequests(root, { now: at(2_000), randomId: () => 'retry' });

    expect(retry.requests.map((request) => request.requestId)).toEqual(
      failed.requests.map((request) => request.requestId),
    );
  });

  it('recovers a predecessor crash after claim without losing or duplicating admission', () => {
    const root = fixtureRoot();
    enqueue(root, 'recover me');
    claimWatchRefreshRequests(root, { now: at(1_000), randomId: () => 'dead-owner' });

    expect(recoverWatchRefreshClaims(root)).toBe(1);
    const recovered = claimWatchRefreshRequests(root, { now: at(2_000), randomId: () => 'successor' });

    expect(recovered.requests).toHaveLength(1);
    expect(inspectWatchRefreshRequests(root)).toMatchObject({ pending: 0, claimed: 1 });
  });

  it('writes completion before claim release and does not replay after either crash boundary', () => {
    const root = fixtureRoot();
    enqueue(root, 'complete me');
    const batch = claimWatchRefreshRequests(root, { now: at(1_000), randomId: () => 'worker' });

    expect(() =>
      completeWatchRefreshClaim(root, batch, at(2_000), (stage) => {
        if (stage === 'after-completion') throw new Error('crash after durable completion');
      }),
    ).toThrow('crash after durable completion');

    expect(inspectWatchRefreshRequests(root)).toMatchObject({ pending: 0, claimed: 0, completed: 1 });
    recoverWatchRefreshClaims(root);
    expect(claimWatchRefreshRequests(root, { now: at(3_000) }).requests).toHaveLength(0);
  });

  it('records an expired request instead of executing or silently deleting it', () => {
    const root = fixtureRoot();
    enqueueWatchRefreshRequest(root, 'too late', { now: at(0), ttlMs: 500, randomId: () => 'expired' });

    const batch = claimWatchRefreshRequests(root, { now: at(501), randomId: () => 'claim' });

    expect(batch.requests).toHaveLength(0);
    expect(inspectWatchRefreshRequests(root)).toMatchObject({
      pending: 0,
      claimed: 0,
      completed: 0,
      expired: 1,
    });
  });

  it('makes post-publication admission crashes retry-safe with an idempotency key', () => {
    const root = fixtureRoot();
    expect(() =>
      enqueueWatchRefreshRequest(root, 'published', {
        now: at(0),
        idempotencyKey: 'stable-key',
        onStage(stage) {
          if (stage === 'after-published') throw new Error('caller lost acknowledgement');
        },
      }),
    ).toThrow('caller lost acknowledgement');

    const retry = enqueueWatchRefreshRequest(root, 'retry', {
      now: at(1_000),
      idempotencyKey: 'stable-key',
    });
    expect(retry.disposition).toBe('duplicate');
    expect(retry.request.detail).toBe('published');
  });

  it('prunes only acknowledged history after the retention boundary', () => {
    const root = fixtureRoot();
    const pending = enqueue(root, 'keep pending').request;
    const completed = enqueueWatchRefreshRequest(root, 'remove completed', {
      now: at(1),
      randomId: () => 'completed',
    }).request;
    const batch = claimWatchRefreshRequests(root, { now: at(2), randomId: () => 'worker', limit: 2 });
    const completedOnly = {
      ...batch,
      requests: batch.requests.filter((request) => request.requestId === completed.requestId),
    };
    releaseWatchRefreshClaim(root, {
      ...batch,
      requests: batch.requests.filter((request) => request.requestId === pending.requestId),
    });
    completeWatchRefreshClaim(root, completedOnly, at(3));

    expect(pruneWatchRefreshHistory(root, { now: at(10), retentionMs: 7 })).toBe(1);
    expect(inspectWatchRefreshRequests(root)).toMatchObject({ pending: 1, completed: 0 });
    expect(readFileSync(join(root, 'requests', `${pending.requestId}.json`), 'utf8')).toContain('keep pending');
    expect(existsSync(join(root, 'requests', `${completed.requestId}.json`))).toBe(false);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'watch-refresh-requests-'));
  roots.add(root);
  return root;
}

function at(offsetMs: number): () => Date {
  return () => new Date(NOW + offsetMs);
}

function enqueue(root: string, detail: string) {
  return enqueueWatchRefreshRequest(root, detail, {
    now: at(0),
    randomId: () => detail.replaceAll(' ', '-'),
  });
}
