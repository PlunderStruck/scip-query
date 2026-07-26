import process from 'node:process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DURABLE_RUST_SESSION_PROTOCOL_VERSION,
  DurableRustSessionHost,
  type DurableRustSessionRequest,
  type DurableRustSessionServerState,
} from './durable-session.js';
import { createWorkerRustAnalyzerSessionRequester } from './lsp-session.js';
import { writeJsonAtomic, writeJsonDurable } from '../../storage/atomic-json.js';
import {
  type LegacyProcessLockDecoder,
  type ProcessFileLock,
  tryAcquireProcessFileLock,
} from '../../platform/process-file-lock.js';

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 10;
const HEARTBEAT_INTERVAL_MS = 1_000;

interface DurableMailboxRequest {
  id: string;
  request: DurableRustSessionRequest;
}

export function processDurableRustSessionRequests(
  sessionDir: string,
  host: DurableRustSessionHost,
  opts: { beforeRequest?: (request: DurableRustSessionRequest) => void } = {},
): number {
  const requestDir = resolve(sessionDir, 'requests');
  const responseDir = resolve(sessionDir, 'responses');
  mkdirSync(requestDir, { recursive: true });
  mkdirSync(responseDir, { recursive: true });
  let processed = 0;
  for (const file of readdirSync(requestDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    const requestPath = resolve(requestDir, file);
    let message: DurableMailboxRequest | null = null;
    try {
      message = parseMailboxRequest(readFileSync(requestPath, 'utf8'));
      opts.beforeRequest?.(message.request);
      const result = host.handle(message.request);
      writeJsonAtomic(resolve(responseDir, `${message.id}.json`), { ok: true, ...result });
    } catch (error) {
      const id = message?.id ?? file.slice(0, -'.json'.length);
      writeJsonAtomic(resolve(responseDir, `${id}.json`), {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      rmSync(requestPath, { force: true });
      processed += 1;
    }
  }
  return processed;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
async function runDurableRustSessionServer(sessionDir: string, semanticWorkerPath: string): Promise<void> {
  mkdirSync(resolve(sessionDir, 'requests'), { recursive: true });
  mkdirSync(resolve(sessionDir, 'responses'), { recursive: true });
  const lockPath = resolve(sessionDir, 'server.lock');
  const serverLock = acquireDurableRustSessionServerLock(lockPath);
  if (!serverLock) return;

  const host = new DurableRustSessionHost(() =>
    createWorkerRustAnalyzerSessionRequester({ semanticWorkerPath, shareEnvironment: true }),
  );
  let stopping = false;
  let lastActivityAtMs = Date.now();
  let lastHeartbeatAtMs = 0;
  let busyUntilMs: number | undefined;
  const stop = (): void => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const writeState = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAtMs < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeatAtMs = now;
    writeJsonDurable(resolve(sessionDir, 'server.json'), {
      protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
      pid: process.pid,
      heartbeatAtMs: now,
      ...(busyUntilMs === undefined ? {} : { busyUntilMs }),
    } satisfies DurableRustSessionServerState);
  };

  try {
    writeState(true);
    const idleTimeoutMs = configuredIdleTimeoutMs();
    while (!stopping && Date.now() - lastActivityAtMs < idleTimeoutMs) {
      const processed = processDurableRustSessionRequests(sessionDir, host, {
        beforeRequest(request) {
          busyUntilMs = Date.now() + request.timeoutMs + 5_000;
          writeState(true);
        },
      });
      if (processed > 0) {
        lastActivityAtMs = Date.now();
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

function parseMailboxRequest(raw: string): DurableMailboxRequest {
  const parsed = JSON.parse(raw) as Partial<DurableMailboxRequest>;
  if (typeof parsed.id !== 'string' || !parsed.request || typeof parsed.request !== 'object') {
    throw new Error('Durable Rust semantic helper received an invalid mailbox request.');
  }
  return { id: parsed.id, request: parsed.request } as DurableMailboxRequest;
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
