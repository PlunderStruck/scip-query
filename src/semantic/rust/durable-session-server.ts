import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monotonicNowMs } from '../../domain/time.js';
import {
  DURABLE_RUST_SESSION_PROTOCOL_VERSION,
  DurableRustSessionHost,
  decodeDurableRustMailboxRequest,
  durableRustMailboxSessionIdentity,
  type DurableRustMailboxEnvelope,
  type DurableRustMailboxErrorCode,
  type DurableRustMailboxResponseIdentity,
  type DurableRustSessionRequest,
  type DurableRustSessionServerState,
} from './durable-session.js';
import { createWorkerRustAnalyzerSessionRequester } from './lsp-session.js';
import { writeJsonDurable } from '../../storage/atomic-json.js';
import {
  boundedMailboxPaths,
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
    now?: () => number;
    nowMs?: number;
    monotonicNowMs?: number;
    ownerId?: string;
    limits?: Partial<BoundedMailboxLimits>;
  } = {},
): number {
  const paths = boundedMailboxPaths(sessionDir);
  initializeBoundedMailbox(paths);
  const now = opts.now ?? (opts.nowMs === undefined ? Date.now : () => opts.nowMs as number);
  const claimNowMs = now();
  const sessionIdentity = durableRustMailboxSessionIdentity(sessionDir);
  const claims = claimBoundedMailboxRequests(paths, {
    ownerId: opts.ownerId ?? DURABLE_RUST_MAILBOX_OWNER,
    nowMs: claimNowMs,
    limits: opts.limits,
    owner: DURABLE_RUST_MAILBOX_PROCESS_OWNER,
    liveness: DURABLE_RUST_MAILBOX_LIVENESS,
  });
  let processed = 0;
  for (const claim of claims) {
    let message: DurableRustMailboxEnvelope | null = null;
    let responseIdentity: DurableRustMailboxResponseIdentity | undefined;
    let errorCode: DurableRustMailboxErrorCode = 'handler-error';
    try {
      const raw = readBoundedMailboxClaim(claim, opts.limits);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        errorCode = 'malformed-request';
        throw new Error('Durable Rust semantic helper received malformed request JSON.');
      }
      const decoded = decodeDurableRustMailboxRequest(parsed, {
        claimRequestId: claim.requestId,
        sessionIdentity,
        nowMs: now(),
      });
      if (!decoded.ok) {
        errorCode = decoded.code;
        responseIdentity = decoded.responseIdentity;
        throw new Error(decoded.error);
      }
      message = decoded.value;
      responseIdentity = {
        id: message.id,
        sessionIdentity: message.sessionIdentity,
        deadlineAtMs: message.deadlineAtMs,
      };
      const localRequest = withLocalReadinessDeadline(message.request, opts.monotonicNowMs ?? monotonicNowMs());
      opts.beforeRequest?.(localRequest);
      const result = host.handle(localRequest);
      const completedAtMs = now();
      if (message.deadlineAtMs < completedAtMs) {
        errorCode = 'expired-request';
        throw new Error('Durable Rust semantic request expired while the helper was processing it.');
      }
      completeBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: true,
          protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
          id: message.id,
          sessionIdentity: message.sessionIdentity,
          deadlineAtMs: message.deadlineAtMs,
          ...result,
        },
        { nowMs: completedAtMs, limits: opts.limits },
      );
    } catch (error) {
      const completedAtMs = now();
      const identity =
        responseIdentity ??
        (message
          ? {
              id: message.id,
              sessionIdentity: message.sessionIdentity,
              deadlineAtMs: message.deadlineAtMs,
            }
          : undefined);
      const reason = error instanceof Error ? error.message : String(error);
      rejectBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: false,
          protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
          id: identity?.id ?? claim.requestId,
          ...(identity
            ? {
                sessionIdentity: identity.sessionIdentity,
                deadlineAtMs: identity.deadlineAtMs,
              }
            : {}),
          errorCode,
          error: reason,
        },
        reason,
        { nowMs: completedAtMs, limits: opts.limits },
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
  const sessionIdentity = durableRustMailboxSessionIdentity(sessionDir);
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
      sessionIdentity,
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
