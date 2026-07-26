import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monotonicNowMs } from '../../domain/time.js';
import {
  DURABLE_RUST_SESSION_PROTOCOL_VERSION,
  DurableRustSessionHost,
  type DurableRustMailboxEnvelope,
  type DurableRustSessionRequest,
  type DurableRustSessionServerState,
} from './durable-session.js';
import { createWorkerRustAnalyzerSessionRequester } from './lsp-session.js';
import { writeJsonDurable } from '../../storage/atomic-json.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxPaths,
  boundedMailboxRequestId,
  claimBoundedMailboxRequests,
  completeBoundedMailboxClaim,
  initializeBoundedMailbox,
  inspectBoundedMailbox,
  readBoundedMailboxClaim,
  rejectBoundedMailboxClaim,
  type BoundedMailboxLimits,
} from '../../storage/bounded-mailbox.js';
import {
  type LegacyProcessLockDecoder,
  type ProcessFileLock,
  tryAcquireProcessFileLock,
} from '../../platform/process-file-lock.js';
import { readProcessIdentity } from '../../platform/process-identity.js';
import { isProcessAlive } from '../../platform/process-liveness.js';

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 10;
const HEARTBEAT_INTERVAL_MS = 1_000;

export function processDurableRustSessionRequests(
  sessionDir: string,
  host: DurableRustSessionHost,
  opts: {
    beforeRequest?: (request: DurableRustSessionRequest) => void;
    nowMs?: number;
    monotonicNowMs?: number;
    ownerId?: string;
    limits?: Partial<BoundedMailboxLimits>;
  } = {},
): number {
  const paths = boundedMailboxPaths(sessionDir);
  initializeBoundedMailbox(paths);
  const nowMs = opts.nowMs ?? Date.now();
  const claims = claimBoundedMailboxRequests(paths, {
    ownerId: opts.ownerId ?? DURABLE_RUST_MAILBOX_OWNER,
    nowMs,
    limits: opts.limits,
    owner: DURABLE_RUST_MAILBOX_PROCESS_OWNER,
    liveness: DURABLE_RUST_MAILBOX_LIVENESS,
  });
  let processed = 0;
  for (const claim of claims) {
    let message: DurableRustMailboxEnvelope | null = null;
    try {
      message = parseMailboxRequest(readBoundedMailboxClaim(claim, opts.limits), nowMs);
      if (message.id !== claim.requestId) {
        throw new Error('Durable Rust semantic request identity does not match its mailbox path.');
      }
      if (message.deadlineAtMs < nowMs) {
        throw new Error('Durable Rust semantic request expired before processing.');
      }
      const localRequest = withLocalReadinessDeadline(message.request, opts.monotonicNowMs ?? monotonicNowMs());
      opts.beforeRequest?.(localRequest);
      const result = host.handle(localRequest);
      completeBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: true,
          protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
          id: message.id,
          ...result,
        },
        { nowMs, limits: opts.limits },
      );
    } catch (error) {
      const id = message?.id ?? claim.requestId;
      const reason = error instanceof Error ? error.message : String(error);
      rejectBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: false,
          protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
          id,
          error: reason,
        },
        reason,
        { nowMs, limits: opts.limits },
      );
    }
    processed += 1;
  }
  return processed;
}

function withLocalReadinessDeadline(
  request: DurableRustSessionRequest,
  nowMonotonicMs: number,
): DurableRustSessionRequest {
  const readinessDeadlineMs = nowMonotonicMs + Math.max(1, request.timeoutMs - 1_000);
  return {
    ...request,
    request: {
      ...request.request,
      readinessDeadlineMs,
    },
  } as DurableRustSessionRequest;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
async function runDurableRustSessionServer(sessionDir: string, semanticWorkerPath: string): Promise<void> {
  const mailboxPaths = boundedMailboxPaths(sessionDir);
  initializeBoundedMailbox(mailboxPaths);
  const lockPath = resolve(sessionDir, 'server.lock');
  const serverLock = acquireDurableRustSessionServerLock(lockPath);
  if (!serverLock) return;

  const host = new DurableRustSessionHost(() =>
    createWorkerRustAnalyzerSessionRequester({ semanticWorkerPath, shareEnvironment: true }),
  );
  let stopping = false;
  let lastActivityAtMonotonicMs = monotonicNowMs();
  let lastHeartbeatAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let busyUntilMs: number | undefined;
  const processIdentity = readProcessIdentity(process.pid);
  const stop = (): void => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const writeState = (force = false): void => {
    const now = Date.now();
    const nowMonotonic = monotonicNowMs();
    if (!force && nowMonotonic - lastHeartbeatAtMonotonicMs < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeatAtMonotonicMs = nowMonotonic;
    writeJsonDurable(resolve(sessionDir, 'server.json'), {
      protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
      pid: process.pid,
      ...(processIdentity ? { processIdentity } : {}),
      heartbeatAtMs: now,
      ...(busyUntilMs === undefined ? {} : { busyUntilMs }),
      mailbox: inspectBoundedMailbox(mailboxPaths),
    } satisfies DurableRustSessionServerState);
  };

  try {
    writeState(true);
    const idleTimeoutMs = configuredIdleTimeoutMs();
    while (!stopping && monotonicNowMs() - lastActivityAtMonotonicMs < idleTimeoutMs) {
      const processed = processDurableRustSessionRequests(sessionDir, host, {
        beforeRequest(request) {
          busyUntilMs = Date.now() + request.timeoutMs + 5_000;
          writeState(true);
        },
      });
      if (processed > 0) {
        lastActivityAtMonotonicMs = monotonicNowMs();
        busyUntilMs = undefined;
        writeState(true);
      } else {
        writeState();
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    host.shutdown();
    rmSync(resolve(sessionDir, 'server.json'), { force: true });
    serverLock.release();
  }
}

const decodeLegacyRustServerLock: LegacyProcessLockDecoder = (value) => {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? { pid } : null;
};

export function acquireDurableRustSessionServerLock(lockPath: string): ProcessFileLock | null {
  const result = tryAcquireProcessFileLock(lockPath, {
    kind: 'rust-durable-session-server',
    parseLegacy: decodeLegacyRustServerLock,
  });
  return result.kind === 'acquired' ? result.lock : null;
}

function parseMailboxRequest(raw: string, nowMs: number): DurableRustMailboxEnvelope {
  const parsed = JSON.parse(raw) as Partial<DurableRustMailboxEnvelope> & { protocolVersion?: unknown };
  if (typeof parsed.id !== 'string' || !parsed.request || typeof parsed.request !== 'object') {
    throw new Error('Durable Rust semantic helper received an invalid mailbox request.');
  }
  if (parsed.protocolVersion === DURABLE_RUST_SESSION_PROTOCOL_VERSION) {
    if (
      parsed.mailboxVersion !== BOUNDED_MAILBOX_VERSION ||
      typeof parsed.operationKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.operationKey) ||
      parsed.id !== boundedMailboxRequestId(parsed.operationKey) ||
      typeof parsed.clientId !== 'string' ||
      !parsed.clientId ||
      typeof parsed.enqueuedAtMs !== 'number' ||
      !Number.isFinite(parsed.enqueuedAtMs) ||
      typeof parsed.deadlineAtMs !== 'number' ||
      !Number.isFinite(parsed.deadlineAtMs) ||
      parsed.deadlineAtMs < parsed.enqueuedAtMs
    ) {
      throw new Error('Durable Rust semantic helper received an invalid mailbox lifecycle.');
    }
    const current = parsed as DurableRustMailboxEnvelope;
    if (current.operationKey !== boundedMailboxOperationKey('rust-semantic-v3', current.request)) {
      throw new Error('Durable Rust semantic helper received a mismatched mailbox operation identity.');
    }
    return current;
  }
  if (parsed.protocolVersion !== undefined) {
    throw new Error(
      `Durable Rust semantic helper does not support mailbox protocol ${String(parsed.protocolVersion)}.`,
    );
  }
  const request = parsed.request as DurableRustSessionRequest;
  return {
    mailboxVersion: BOUNDED_MAILBOX_VERSION,
    protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
    id: parsed.id,
    operationKey: boundedMailboxOperationKey('rust-semantic-v2', { id: parsed.id, request }),
    clientId: 'legacy-v2',
    enqueuedAtMs: nowMs,
    deadlineAtMs: nowMs + Math.max(1, request.timeoutMs ?? 120_000),
    request,
  };
}

function configuredIdleTimeoutMs(): number {
  const parsed = Number(process.env['SCIP_RUST_SEMANTIC_DURABLE_IDLE_MS']);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const sessionDir = process.argv[2];
  const semanticWorkerPath = process.argv[3];
  if (!sessionDir || !semanticWorkerPath) {
    console.error('durable-rust-session: expected <session-dir> <semantic-worker-path>');
    process.exitCode = 1;
  } else {
    await runDurableRustSessionServer(sessionDir, semanticWorkerPath);
  }
}

const DURABLE_RUST_MAILBOX_OWNER = `rust-semantic-${process.pid}-${randomUUID()}`;
const DURABLE_RUST_PROCESS_IDENTITY = readProcessIdentity(process.pid);
const DURABLE_RUST_MAILBOX_PROCESS_OWNER = {
  pid: process.pid,
  ...(DURABLE_RUST_PROCESS_IDENTITY ? { processIdentity: DURABLE_RUST_PROCESS_IDENTITY } : {}),
};
const DURABLE_RUST_MAILBOX_LIVENESS = { isProcessAlive, readProcessIdentity };
