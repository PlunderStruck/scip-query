import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BOUNDED_MAILBOX_VERSION,
  MailboxBackpressureError,
  boundedMailboxOperationKey,
  boundedMailboxPaths,
  boundedMailboxRequestId,
  claimBoundedMailboxRequests,
  completeBoundedMailboxClaim,
  enqueueBoundedMailboxRequest,
  initializeBoundedMailbox,
  inspectBoundedMailbox,
  maintainBoundedMailbox,
  pollBoundedMailboxRequests,
  readBoundedMailboxClaim,
  rejectBoundedMailboxClaim,
  type BoundedMailboxPaths,
  type BoundedMailboxClaimStage,
  type BoundedMailboxRequestIdentity,
} from '../../src/storage/bounded-mailbox.js';

const NOW = Date.parse('2026-07-25T20:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded filesystem mailbox', () => {
  it('retains client work, atomically claims it, reclaims an orphan, and deduplicates the retained completion', () => {
    const paths = fixture();
    const request = operation('alpha', NOW, NOW + 10_000);

    expect(enqueueBoundedMailboxRequest(paths, request, { nowMs: NOW })).toEqual(
      expect.objectContaining({
        disposition: 'accepted',
        authoritativeDeadlineAtMs: NOW + 10_000,
        achievedDurability: 'directory-durable',
        directorySync: 'synced',
      }),
    );
    expect(
      enqueueBoundedMailboxRequest(paths, operation('alpha', NOW + 1, NOW + 10_001), {
        nowMs: NOW + 1,
      }),
    ).toEqual(
      expect.objectContaining({
        disposition: 'duplicate',
        authoritativeDeadlineAtMs: NOW + 10_000,
      }),
    );
    expect(inspectBoundedMailbox(paths)).toEqual(expect.objectContaining({ pending: 1, inflight: 0, responses: 0 }));

    const [abandoned] = claimBoundedMailboxRequests(paths, {
      ownerId: 'server-a',
      nowMs: NOW,
      limits: { claimLeaseMs: 100 },
    });
    expect(abandoned).toEqual(
      expect.objectContaining({ requestId: request.id, ownerId: 'server-a', directorySync: 'synced' }),
    );
    expect(
      enqueueBoundedMailboxRequest(paths, operation('alpha', NOW + 2, NOW + 10_002), {
        nowMs: NOW + 2,
      }).disposition,
    ).toBe('duplicate');
    expect(
      claimBoundedMailboxRequests(paths, {
        ownerId: 'server-b',
        nowMs: NOW + 365 * 86_400_000,
        limits: { claimLeaseMs: 100 },
        liveness: {
          isProcessAlive: () => true,
          readProcessIdentity: () => null,
        },
      }),
    ).toEqual([]);

    const [reclaimed] = claimBoundedMailboxRequests(paths, {
      ownerId: 'server-b',
      nowMs: NOW + 15_001,
      limits: { claimLeaseMs: 100 },
      liveness: {
        isProcessAlive: () => false,
        readProcessIdentity: () => null,
      },
    });
    expect(reclaimed).toEqual(expect.objectContaining({ requestId: request.id, ownerId: 'server-b', legacy: false }));

    expect(() =>
      completeBoundedMailboxClaim(
        paths,
        reclaimed!,
        { ok: true, id: request.id },
        {
          nowMs: NOW + 15_002,
          onAfterResponsePublished() {
            throw new Error('simulated crash after response publication');
          },
        },
      ),
    ).toThrow('simulated crash');
    expect(existsSync(reclaimed!.path)).toBe(true);
    expect(existsSync(join(paths.responseDir, `${request.id}.json`))).toBe(true);

    expect(
      claimBoundedMailboxRequests(paths, {
        ownerId: 'server-c',
        nowMs: NOW + 15_003,
      }),
    ).toEqual([]);
    expect(inspectBoundedMailbox(paths)).toEqual(expect.objectContaining({ pending: 0, inflight: 0, responses: 1 }));
    expect(
      enqueueBoundedMailboxRequest(paths, operation('alpha', NOW + 20_000, NOW + 30_000), {
        nowMs: NOW + 20_000,
      }),
    ).toEqual(
      expect.objectContaining({
        disposition: 'duplicate',
        authoritativeDeadlineAtMs: NOW + 10_000,
      }),
    );
  });

  it('keeps the first completion authoritative when an expired owner finishes late', () => {
    const paths = fixture();
    const request = operation('race', NOW, NOW + 100);
    enqueueBoundedMailboxRequest(paths, request, { nowMs: NOW });
    const [oldOwner] = claimBoundedMailboxRequests(paths, {
      ownerId: 'old-owner',
      nowMs: NOW,
      limits: { claimLeaseMs: 10 },
    });
    const [newOwner] = claimBoundedMailboxRequests(paths, {
      ownerId: 'new-owner',
      nowMs: NOW + 5_101,
      limits: { claimLeaseMs: 10 },
      liveness: {
        isProcessAlive: () => false,
        readProcessIdentity: () => null,
      },
    });

    completeBoundedMailboxClaim(
      paths,
      newOwner!,
      { ok: true, id: request.id, result: 'new-owner' },
      { nowMs: NOW + 5_102 },
    );
    completeBoundedMailboxClaim(
      paths,
      oldOwner!,
      { ok: true, id: request.id, result: 'old-owner' },
      { nowMs: NOW + 5_103 },
    );
    expect(JSON.parse(readFileSync(join(paths.responseDir, `${request.id}.json`), 'utf8'))).toEqual(
      expect.objectContaining({ result: 'new-owner' }),
    );
  });

  it.each<BoundedMailboxClaimStage>([
    'after-owner-directory-durable',
    'after-owner-record-published',
    'after-claim-renamed',
    'after-source-directory-synced',
    'after-destination-directory-synced',
  ])('retains exactly one reclaimable request after a claim crash at %s', (crashStage) => {
    const paths = fixture();
    const request = operation(`claim-crash-${crashStage}`, NOW, NOW + 100);
    enqueueBoundedMailboxRequest(paths, request, { nowMs: NOW });

    expect(() =>
      claimBoundedMailboxRequests(paths, {
        ownerId: 'crashed-owner',
        owner: { pid: 2_147_483_647 },
        nowMs: NOW,
        limits: { claimLeaseMs: 10 },
        onClaimStage(stage) {
          if (stage === crashStage) throw new Error(`simulated claim crash at ${stage}`);
        },
      }),
    ).toThrow(`simulated claim crash at ${crashStage}`);
    expect(inspectBoundedMailbox(paths).totalItems).toBe(1);

    const recovered = claimBoundedMailboxRequests(paths, {
      ownerId: 'recovery-owner',
      nowMs: NOW + 6_000,
      limits: { claimLeaseMs: 10 },
      liveness: {
        isProcessAlive: () => false,
        readProcessIdentity: () => null,
      },
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual(expect.objectContaining({ requestId: request.id, ownerId: 'recovery-owner' }));
  });

  it('serializes admission and reports typed item, byte, and per-item backpressure', () => {
    const paths = fixture();
    const first = operation('first', NOW, NOW + 10_000);
    let nestedError: unknown;
    enqueueBoundedMailboxRequest(paths, first, {
      nowMs: NOW,
      limits: { maxItems: 1 },
      onBeforePublish() {
        try {
          enqueueBoundedMailboxRequest(paths, operation('racing', NOW, NOW + 10_000), {
            nowMs: NOW,
            limits: { maxItems: 1 },
            admissionLockTimeoutMs: 0,
          });
        } catch (error) {
          nestedError = error;
        }
      },
    });
    expect(nestedError).toEqual(expect.objectContaining({ code: 'admission-busy' }));

    expect(
      enqueueBoundedMailboxRequest(paths, operation('first', NOW + 1, NOW + 10_001), {
        nowMs: NOW + 1,
        limits: { maxItems: 1 },
      }).disposition,
    ).toBe('duplicate');
    expect(() =>
      enqueueBoundedMailboxRequest(paths, operation('second', NOW + 1, NOW + 10_001), {
        nowMs: NOW + 1,
        limits: { maxItems: 1 },
      }),
    ).toThrow(expect.objectContaining({ code: 'item-capacity' }));

    const oversizedPaths = fixture();
    expect(() =>
      enqueueBoundedMailboxRequest(oversizedPaths, operation('large', NOW, NOW + 1_000, 'x'.repeat(2_000)), {
        nowMs: NOW,
        limits: { maxItemBytes: 256 },
      }),
    ).toThrow(expect.objectContaining({ code: 'item-too-large' }));

    const bytePaths = fixture();
    enqueueBoundedMailboxRequest(bytePaths, operation('one', NOW, NOW + 1_000), { nowMs: NOW });
    const occupied = inspectBoundedMailbox(bytePaths).totalBytes;
    expect(() =>
      enqueueBoundedMailboxRequest(bytePaths, operation('two', NOW + 1, NOW + 1_001), {
        nowMs: NOW + 1,
        limits: { maxBytes: occupied + 1 },
      }),
    ).toThrow(expect.objectContaining({ code: 'byte-capacity' }));

    const abandonedPaths = fixture();
    const abandonedLock = join(abandonedPaths.rootDir, '.admission.lock');
    mkdirSync(abandonedLock, { recursive: true });
    writeFileSync(
      join(abandonedLock, 'owner.json'),
      JSON.stringify({ ownerToken: 'dead-owner', pid: 2_147_483_647, acquiredAtMs: NOW }),
    );
    expect(
      enqueueBoundedMailboxRequest(abandonedPaths, operation('after-crash', NOW, NOW + 1_000), {
        nowMs: NOW,
      }).disposition,
    ).toBe('accepted');
  });

  it('bounds admission contention with monotonic time', () => {
    const paths = fixture();
    initializeBoundedMailbox(paths);
    const lockPath = join(paths.rootDir, '.admission.lock');
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ ownerToken: 'live-owner', pid: process.pid, acquiredAtMs: NOW }),
    );
    let monotonicNow = 0;

    expect(() =>
      enqueueBoundedMailboxRequest(paths, operation('blocked', NOW, NOW + 1_000), {
        nowMs: NOW + 86_400_000,
        admissionLockTimeoutMs: 15,
        monotonicNow: () => {
          const observed = monotonicNow;
          monotonicNow += 10;
          return observed;
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'admission-busy' }));
    expect(monotonicNow).toBeGreaterThan(15);
  });

  it('keeps idle polling independent from retained response bodies and maintenance', () => {
    const paths = fixture();
    initializeBoundedMailbox(paths);
    const response = join(paths.responseDir, 'retained.json');
    writeFileSync(response, JSON.stringify({ expiresAtMs: 0, payload: 'x'.repeat(2 * 1024 * 1024) }));
    const published = new Date(NOW);
    utimesSync(response, published, published);

    expect(
      pollBoundedMailboxRequests(paths, {
        ownerId: 'idle-service',
        nowMs: NOW + 50,
        limits: { responseRetentionMs: 100 },
      }),
    ).toEqual([]);
    expect(existsSync(response)).toBe(true);

    expect(
      maintainBoundedMailbox(paths, {
        nowMs: NOW + 101,
        limits: { responseRetentionMs: 100 },
      }),
    ).toEqual(expect.objectContaining({ responsesRemoved: 1 }));
    expect(existsSync(response)).toBe(false);
  });

  it('does not reclaim an ownerless public lock from civil-clock age alone', () => {
    const paths = fixture();
    initializeBoundedMailbox(paths);
    const lockPath = join(paths.rootDir, '.admission.lock');
    writeFileSync(lockPath, '');
    const old = new Date(0);
    utimesSync(lockPath, old, old);

    expect(() =>
      enqueueBoundedMailboxRequest(paths, operation('ownerless', NOW, NOW + 1_000), {
        nowMs: NOW + 365 * 24 * 60 * 60_000,
        admissionLockTimeoutMs: 0,
        monotonicNow: () => 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'admission-busy' }));
    expect(existsSync(lockPath)).toBe(true);
  });

  it('orders by enqueue time, bounds each batch, and leaves later work pending for heartbeat fairness', () => {
    const paths = fixture();
    enqueueBoundedMailboxRequest(paths, operation('late', NOW + 30, NOW + 10_000), { nowMs: NOW });
    enqueueBoundedMailboxRequest(paths, operation('early', NOW + 10, NOW + 10_000), { nowMs: NOW });
    enqueueBoundedMailboxRequest(paths, operation('middle', NOW + 20, NOW + 10_000), { nowMs: NOW });

    const firstBatch = claimBoundedMailboxRequests(paths, {
      ownerId: 'bounded-owner',
      nowMs: NOW + 40,
      limits: { maxBatch: 2 },
    });
    expect(firstBatch.map((claim) => requestName(readBoundedMailboxClaim(claim)))).toEqual(['early', 'middle']);
    expect(inspectBoundedMailbox(paths)).toEqual(expect.objectContaining({ pending: 1, inflight: 2 }));

    const secondBatch = claimBoundedMailboxRequests(paths, {
      ownerId: 'bounded-owner',
      nowMs: NOW + 41,
      limits: { maxBatch: 2 },
    });
    expect(secondBatch.map((claim) => requestName(readBoundedMailboxClaim(claim)))).toEqual(['late']);
  });

  it('rejects oversized legacy input without reading it and bounds dead-letter, response, and staging retention', () => {
    const paths = fixture();
    initializeBoundedMailbox(paths);
    writeFileSync(join(paths.legacyRequestDir, 'oversized.json'), 'x'.repeat(2_000));
    const [claim] = claimBoundedMailboxRequests(paths, {
      ownerId: 'server',
      nowMs: NOW,
      limits: { maxItemBytes: 256 },
    });
    expect(() => readBoundedMailboxClaim(claim!, { maxItemBytes: 256 })).toThrow(MailboxBackpressureError);
    rejectBoundedMailboxClaim(
      paths,
      claim!,
      { ok: false, id: 'oversized', error: 'request exceeds the per-item limit' },
      'request exceeds the per-item limit',
      { nowMs: NOW, limits: { responseRetentionMs: 100, deadLetterRetentionMs: 100 } },
    );
    expect(inspectBoundedMailbox(paths)).toEqual(
      expect.objectContaining({ inflight: 0, responses: 1, deadLetters: 1 }),
    );

    const temporary = join(paths.pendingDir, 'orphan.json.tmp-crashed');
    writeFileSync(temporary, 'partial');
    const cleanupAt = NOW + 2 * 24 * 60 * 60_000;
    const old = new Date(NOW);
    for (const directory of [paths.responseDir, paths.deadLetterDir]) {
      for (const entry of readdirSync(directory)) {
        utimesSync(join(directory, entry), old, old);
      }
    }
    utimesSync(temporary, old, old);
    const maintenance = maintainBoundedMailbox(paths, {
      nowMs: cleanupAt,
      limits: {
        responseRetentionMs: 100,
        deadLetterRetentionMs: 100,
        temporaryRetentionMs: 100,
      },
    });
    expect(maintenance).toEqual(
      expect.objectContaining({
        responsesRemoved: 1,
        deadLettersRemoved: 1,
        temporaryFilesRemoved: 1,
      }),
    );
    expect(inspectBoundedMailbox(paths).totalItems).toBe(0);
  });
});

function fixture(): BoundedMailboxPaths {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-bounded-mailbox-'));
  roots.push(root);
  return boundedMailboxPaths(root);
}

function operation(
  name: string,
  enqueuedAtMs: number,
  deadlineAtMs: number,
  data = '',
): BoundedMailboxRequestIdentity & Record<string, unknown> {
  const operationKey = boundedMailboxOperationKey('test-operation', { name, data });
  return {
    mailboxVersion: BOUNDED_MAILBOX_VERSION,
    id: boundedMailboxRequestId(operationKey),
    operationKey,
    clientId: `client-${name}`,
    enqueuedAtMs,
    deadlineAtMs,
    name,
    data,
  };
}

function requestName(raw: string): string {
  return (JSON.parse(raw) as { name: string }).name;
}
