import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { monotonicNowMs } from '../../domain/time.js';
import type { RustReferenceWorkerRequest, RustReferenceWorkerResponse } from './lsp-batch-worker.js';
import type {
  RustAnalyzerSessionRequester,
  RustImportDefinitionWorkerRequest,
  RustImportDefinitionWorkerResponse,
} from './semantic-resolution.js';
import { stableJson } from '../../domain/stable-json.js';
import { profileEnabled, writeProfileEvent } from '../../instrumentation/profile.js';
import { isProcessAlive } from '../../platform/process-liveness.js';
import {
  parseProcessIdentity,
  readProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from '../../platform/process-identity.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxPaths,
  boundedMailboxRequestId,
  enqueueBoundedMailboxRequest,
  type BoundedMailboxLimits,
  type BoundedMailboxRequestIdentity,
  type BoundedMailboxStatus,
} from '../../storage/bounded-mailbox.js';
import { rustCompilerEngineIdentity, type RustCompilerEngineIdentity } from './engine-identity.js';
import { rustAnalyzerProjectFingerprint } from './project-fingerprint.js';

export const DURABLE_RUST_SESSION_PROTOCOL_VERSION = 3;
const DURABLE_RUST_SESSION_STARTUP_TIMEOUT_MS = 5_000;
const DURABLE_RUST_SESSION_POLL_INTERVAL_MS = 10;
const DEFAULT_DURABLE_RUST_REFERENCE_RETRY_TIMEOUT_MS = 30_000;

type RustSessionRequest = RustReferenceWorkerRequest | RustImportDefinitionWorkerRequest;

// scip-query: ignore-stale — reviewed S1 owned contract; this interface is the injectable session-identity boundary.
export interface DurableRustSessionIdentityRuntime {
  canonicalProjectRoot(projectRoot: string): string;
  projectFingerprint(projectRoot: string): string;
  engineIdentity(projectRoot: string): RustCompilerEngineIdentity;
  fileFingerprint(path: string): string;
  environment(): Record<string, string | null>;
}

export interface DurableRustSessionIdentity {
  key: string;
  protocolVersion: typeof DURABLE_RUST_SESSION_PROTOCOL_VERSION;
  projectRoot: string;
  projectFingerprint: string;
  engine: RustCompilerEngineIdentity;
  workerFingerprint: string;
  environment: Record<string, string | null>;
}

export type DurableRustSessionRequest =
  | {
      kind: 'semantic';
      identityKey: string;
      workerEnvironment?: Record<string, string | null>;
      request: RustReferenceWorkerRequest;
      timeoutMs: number;
    }
  | {
      kind: 'import-definitions';
      identityKey: string;
      workerEnvironment?: Record<string, string | null>;
      request: RustImportDefinitionWorkerRequest;
      timeoutMs: number;
    };

export type DurableRustSessionResponse =
  | {
      session: 'created' | 'reused' | 'invalidated';
      response: RustReferenceWorkerResponse;
    }
  | {
      session: 'created' | 'reused' | 'invalidated';
      response: RustImportDefinitionWorkerResponse;
    };

// scip-query: ignore-stale — reviewed S1 owned contract; durable-session lifecycle owns this server state.
export interface DurableRustSessionServerState {
  protocolVersion: number;
  pid: number;
  processIdentity?: ProcessIdentity;
  heartbeatAtMs: number;
  busyUntilMs?: number;
  mailbox?: BoundedMailboxStatus;
}

export interface DurableRustMailboxEnvelope extends BoundedMailboxRequestIdentity {
  protocolVersion: typeof DURABLE_RUST_SESSION_PROTOCOL_VERSION;
  request: DurableRustSessionRequest;
}

export interface DurableRustSessionRequesterRuntime {
  /** Civil time used only in persisted cross-process records. */
  now(): number;
  /** Process-local elapsed clock; defaults to performance.now(). */
  monotonicNow?(): number;
  randomId(): string;
  isProcessAlive(pid: number): boolean;
  readProcessIdentity?(pid: number): ProcessIdentity | null;
  spawnServer(serverPath: string, sessionDir: string, semanticWorkerPath: string): void;
  sleep(durationMs: number): void;
}

export interface DurableRustSessionRequesterOptions {
  serverPath: string;
  semanticWorkerPath: string;
  tempRoot?: string;
  identityRuntime?: DurableRustSessionIdentityRuntime;
  runtime?: DurableRustSessionRequesterRuntime;
  mailboxLimits?: Partial<BoundedMailboxLimits>;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function createDurableRustSessionIdentity(
  projectRoot: string,
  semanticWorkerPath: string,
  request: RustSessionRequest,
  runtime: DurableRustSessionIdentityRuntime = DEFAULT_IDENTITY_RUNTIME,
): DurableRustSessionIdentity {
  const engineIdentity = runtime.engineIdentity(projectRoot);
  const value: Omit<DurableRustSessionIdentity, 'key'> = {
    protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
    projectRoot: runtime.canonicalProjectRoot(projectRoot),
    projectFingerprint: runtime.projectFingerprint(projectRoot),
    engine: {
      engine: engineIdentity.engine,
      resolvedBinary: engineIdentity.resolvedBinary,
      version: engineIdentity.version,
    },
    workerFingerprint: runtime.fileFingerprint(semanticWorkerPath),
    environment: rustCompilerSessionEnvironment(runtime.environment()),
  };
  return {
    key: sha256(stableJson(value)),
    ...value,
  };
}

export class DurableRustSessionHost {
  private requester: RustAnalyzerSessionRequester | null = null;
  private identityKey: string | null = null;
  private semanticResponseCache: {
    identityKey: string;
    requestKey: string;
    response: RustReferenceWorkerResponse;
  } | null = null;

  constructor(
    private readonly createRequester: () => RustAnalyzerSessionRequester,
    private readonly applyEnvironment: (environment: Record<string, string | null>) => void = applyWorkerEnvironment,
  ) {}

  // scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
  handle(request: DurableRustSessionRequest): DurableRustSessionResponse {
    this.applyEnvironment(request.workerEnvironment ?? {});
    let session: DurableRustSessionResponse['session'];
    if (!this.requester) {
      this.requester = this.createRequester();
      this.identityKey = request.identityKey;
      session = 'created';
    } else if (this.identityKey !== request.identityKey) {
      this.semanticResponseCache = null;
      this.requester.shutdown();
      this.requester = this.createRequester();
      this.identityKey = request.identityKey;
      session = 'invalidated';
    } else {
      session = 'reused';
    }

    if (request.kind === 'semantic') {
      const requestKey = durableSemanticResponseCacheKey(request.request);
      const cached =
        session === 'reused' &&
        requestKey !== null &&
        this.semanticResponseCache?.identityKey === request.identityKey &&
        this.semanticResponseCache.requestKey === requestKey
          ? this.semanticResponseCache.response
          : null;
      if (cached) {
        writeDurableSemanticResponseCacheProfile(true, request.request.definitions.length);
        return { session, response: cached };
      }

      const response = this.requester.requestSemantic(request.request, request.timeoutMs);
      if (requestKey !== null && isCompleteDurableSemanticResponse(response)) {
        this.semanticResponseCache = { identityKey: request.identityKey, requestKey, response };
      }
      writeDurableSemanticResponseCacheProfile(false, request.request.definitions.length);
      return {
        session,
        response,
      };
    }
    return {
      session,
      response: this.requester.requestImportDefinitions(request.request, request.timeoutMs),
    };
  }

  shutdown(): void {
    this.requester?.shutdown();
    this.requester = null;
    this.identityKey = null;
    this.semanticResponseCache = null;
  }
}

function durableSemanticResponseCacheKey(request: RustReferenceWorkerRequest): string | null {
  if (request.includeReferences === false || request.includeCallees !== true || request.includeSignatures === true) {
    return null;
  }
  if ((request.referenceDefinitions?.length ?? 0) === 0 || (request.calleeDefinitions?.length ?? 0) === 0) {
    return null;
  }
  const { readinessDeadlineMs: _readinessDeadlineMs, ...stableRequest } = request;
  return sha256(stableJson(stableRequest));
}

function isCompleteDurableSemanticResponse(response: RustReferenceWorkerResponse): boolean {
  return (
    response.available && Array.isArray(response.callees) && (response.incompleteReferenceSymbolIds?.length ?? 0) === 0
  );
}

function writeDurableSemanticResponseCacheProfile(hit: boolean, definitions: number): void {
  if (!profileEnabled()) return;
  writeProfileEvent({
    type: 'span',
    name: 'rust.semantic.durable-session.response-cache',
    durationMs: 0,
    ok: true,
    hit,
    definitions,
  });
}

export function isDurableRustSessionStateLive(
  state: DurableRustSessionServerState,
  _nowMs: number,
  isProcessAlive: (pid: number) => boolean,
  readIdentity?: (pid: number) => ProcessIdentity | null,
): boolean {
  // A civil timestamp is useful to diagnose a silent helper, but clock age
  // cannot prove that a live process lost ownership. The caller's bounded
  // monotonic request/startup deadline remains the availability limit.
  if (state.protocolVersion !== DURABLE_RUST_SESSION_PROTOCOL_VERSION || !isProcessAlive(state.pid)) return false;
  if (!state.processIdentity) return true;
  const actualIdentity = readIdentity?.(state.pid);
  return (
    actualIdentity !== undefined &&
    actualIdentity !== null &&
    sameProcessIdentity(state.processIdentity, actualIdentity)
  );
}

export function durableRustSessionDirectory(projectRoot: string, serverPath: string, tempRoot: string): string {
  let serverFingerprint: string;
  try {
    serverFingerprint = sha256(readFileSync(serverPath));
  } catch {
    serverFingerprint = 'missing';
  }
  const namespace = sha256(
    stableJson({ projectRoot: resolve(projectRoot), serverPath: resolve(serverPath), serverFingerprint }),
  ).slice(0, 20);
  return resolve(tempRoot, `scip-query-rust-session-${namespace}`);
}

export function durableSettleDelayMs(configuredValue: string | undefined): number {
  const configured = configuredValue === undefined ? Number.NaN : Number(configuredValue);
  return Number.isInteger(configured) && configured >= 0 ? configured : 0;
}

export function rustCompilerSessionEnvironment(
  environment: Record<string, string | null | undefined>,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(([key]) => isCompilerSessionEnvironmentKey(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value ?? null]),
  );
}

// scip-query: ignore-extract — reviewed E1 workflow owner; durable server identity, startup, request, and fallback stay together.
export function createDurableRustAnalyzerSessionRequester(
  projectRoot: string,
  opts: DurableRustSessionRequesterOptions,
): RustAnalyzerSessionRequester {
  const runtime = opts.runtime ?? DEFAULT_REQUESTER_RUNTIME;
  const identityRuntime = opts.identityRuntime ?? DEFAULT_IDENTITY_RUNTIME;
  const sessionDir = durableRustSessionDirectory(projectRoot, opts.serverPath, opts.tempRoot ?? tmpdir());
  let disposed = false;

  const dispatch = <Response extends RustReferenceWorkerResponse | RustImportDefinitionWorkerResponse>(
    request: DurableRustSessionRequest,
    timeoutMs: number,
  ): Response => {
    if (disposed) throw new Error('Durable Rust semantic session was already disposed.');
    return dispatchDurableRustSessionRequest<Response>(
      sessionDir,
      opts.serverPath,
      opts.semanticWorkerPath,
      request,
      timeoutMs,
      runtime,
      opts.mailboxLimits,
    );
  };

  return {
    requestSemantic(request, timeoutMs) {
      const identity = createDurableRustSessionIdentity(projectRoot, opts.semanticWorkerPath, request, identityRuntime);
      const { readinessDeadlineMs: _callerDeadline, ...portableRequest } = request;
      return dispatch<RustReferenceWorkerResponse>(
        {
          kind: 'semantic',
          identityKey: identity.key,
          workerEnvironment: currentWorkerEnvironment(),
          request: {
            ...portableRequest,
            referenceRetryTimeoutMs: durableReferenceRetryTimeoutMs(
              process.env['SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS'],
              request.referenceRetryTimeoutMs,
            ),
            settleDelayMs:
              process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'] === undefined
                ? request.settleDelayMs
                : durableSettleDelayMs(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS']),
          },
          timeoutMs,
        },
        timeoutMs,
      );
    },
    requestImportDefinitions(request, timeoutMs) {
      const identity = createDurableRustSessionIdentity(projectRoot, opts.semanticWorkerPath, request, identityRuntime);
      const { readinessDeadlineMs: _callerDeadline, ...portableRequest } = request;
      return dispatch<RustImportDefinitionWorkerResponse>(
        {
          kind: 'import-definitions',
          identityKey: identity.key,
          workerEnvironment: currentWorkerEnvironment(),
          request: {
            ...portableRequest,
            settleDelayMs:
              process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'] === undefined
                ? request.settleDelayMs
                : durableSettleDelayMs(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS']),
          },
          timeoutMs,
        },
        timeoutMs,
      );
    },
    shutdown() {
      disposed = true;
    },
  };
}

export function applyWorkerEnvironment(environment: Record<string, string | null>): void {
  for (const key of Object.keys(process.env)) {
    if (isManagedWorkerEnvironmentKey(key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value !== null) process.env[key] = value;
  }
}

function durableReferenceRetryTimeoutMs(
  configuredValue: string | undefined,
  requestValue: number | undefined,
): number | undefined {
  if (requestValue !== undefined) return requestValue;
  return configuredValue === undefined ? DEFAULT_DURABLE_RUST_REFERENCE_RETRY_TIMEOUT_MS : undefined;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function dispatchDurableRustSessionRequest<Response>(
  sessionDir: string,
  serverPath: string,
  semanticWorkerPath: string,
  request: DurableRustSessionRequest,
  timeoutMs: number,
  runtime: DurableRustSessionRequesterRuntime,
  mailboxLimits: Partial<BoundedMailboxLimits> = {},
): Response {
  const startedAtMs = runtime.now();
  const deadline = startedAtMs + timeoutMs;
  const monotonicStartedAtMs = (runtime.monotonicNow ?? monotonicNowMs)();
  const monotonicDeadline = monotonicStartedAtMs + timeoutMs;
  const operationKey = boundedMailboxOperationKey('rust-semantic-v3', request);
  const requestId = boundedMailboxRequestId(operationKey);
  const mailboxPaths = boundedMailboxPaths(sessionDir);
  const admitted = enqueueBoundedMailboxRequest(
    mailboxPaths,
    {
      mailboxVersion: BOUNDED_MAILBOX_VERSION,
      protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
      id: requestId,
      operationKey,
      clientId: runtime.randomId(),
      enqueuedAtMs: startedAtMs,
      deadlineAtMs: deadline,
      request,
    } satisfies DurableRustMailboxEnvelope,
    { nowMs: startedAtMs, limits: mailboxLimits },
  );

  ensureDurableRustSessionServer(sessionDir, serverPath, semanticWorkerPath, monotonicDeadline, runtime);
  while ((runtime.monotonicNow ?? monotonicNowMs)() <= monotonicDeadline) {
    if (existsSync(admitted.responsePath)) {
      const payload = parseDurableResponse(readFileSync(admitted.responsePath, 'utf8'), requestId, operationKey);
      if (!payload.ok) throw new Error(payload.error);
      if (profileEnabled()) {
        writeProfileEvent({
          type: 'span',
          name: 'rust.semantic.durable-session.request',
          durationMs: (runtime.monotonicNow ?? monotonicNowMs)() - monotonicStartedAtMs,
          ok: true,
          session: payload.session,
          kind: request.kind,
        });
      }
      return payload.response as Response;
    }
    const state = readDurableRustSessionServerState(sessionDir);
    if (
      !state ||
      !isDurableRustSessionStateLive(state, runtime.now(), runtime.isProcessAlive, runtime.readProcessIdentity)
    ) {
      ensureDurableRustSessionServer(sessionDir, serverPath, semanticWorkerPath, monotonicDeadline, runtime);
    }
    runtime.sleep(DURABLE_RUST_SESSION_POLL_INTERVAL_MS);
  }
  throw new Error(`Durable Rust semantic session timed out after ${(timeoutMs / 1000).toFixed(0)}s.`);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function ensureDurableRustSessionServer(
  sessionDir: string,
  serverPath: string,
  semanticWorkerPath: string,
  requestMonotonicDeadline: number,
  runtime: DurableRustSessionRequesterRuntime,
): void {
  const current = readDurableRustSessionServerState(sessionDir);
  if (
    current &&
    isDurableRustSessionStateLive(current, runtime.now(), runtime.isProcessAlive, runtime.readProcessIdentity)
  ) {
    return;
  }

  rmSync(resolve(sessionDir, 'server.json'), { force: true });
  runtime.spawnServer(serverPath, sessionDir, semanticWorkerPath);
  const monotonicNow = runtime.monotonicNow ?? monotonicNowMs;
  const startupDeadline = Math.min(requestMonotonicDeadline, monotonicNow() + DURABLE_RUST_SESSION_STARTUP_TIMEOUT_MS);
  while (monotonicNow() <= startupDeadline) {
    const state = readDurableRustSessionServerState(sessionDir);
    if (
      state &&
      isDurableRustSessionStateLive(state, runtime.now(), runtime.isProcessAlive, runtime.readProcessIdentity)
    ) {
      return;
    }
    runtime.sleep(DURABLE_RUST_SESSION_POLL_INTERVAL_MS);
  }
  throw new Error('Durable Rust semantic session helper did not become ready within 5s.');
}

export function readDurableRustSessionServerState(sessionDir: string): DurableRustSessionServerState | null {
  try {
    const parsed = JSON.parse(
      readFileSync(resolve(sessionDir, 'server.json'), 'utf8'),
    ) as Partial<DurableRustSessionServerState>;
    if (
      typeof parsed.protocolVersion !== 'number' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.heartbeatAtMs !== 'number' ||
      (parsed.busyUntilMs !== undefined && typeof parsed.busyUntilMs !== 'number') ||
      (parsed.mailbox !== undefined && !isBoundedMailboxStatus(parsed.mailbox))
    ) {
      return null;
    }
    const processIdentity = parsed.processIdentity === undefined ? null : parseProcessIdentity(parsed.processIdentity);
    if (parsed.processIdentity !== undefined && (!processIdentity || processIdentity.pid !== parsed.pid)) return null;
    return {
      protocolVersion: parsed.protocolVersion,
      pid: parsed.pid,
      ...(processIdentity ? { processIdentity } : {}),
      heartbeatAtMs: parsed.heartbeatAtMs,
      ...(parsed.busyUntilMs === undefined ? {} : { busyUntilMs: parsed.busyUntilMs }),
      ...(parsed.mailbox === undefined ? {} : { mailbox: parsed.mailbox }),
    };
  } catch {
    return null;
  }
}

function parseDurableResponse(
  raw: string,
  requestId: string,
  operationKey: string,
):
  | {
      ok: true;
      session: DurableRustSessionResponse['session'];
      response: RustReferenceWorkerResponse | RustImportDefinitionWorkerResponse;
    }
  | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: unknown;
      protocolVersion?: unknown;
      id?: unknown;
      operationKey?: unknown;
      session?: unknown;
      response?: unknown;
      error?: unknown;
    };
    if (
      parsed.protocolVersion !== DURABLE_RUST_SESSION_PROTOCOL_VERSION ||
      parsed.id !== requestId ||
      parsed.operationKey !== operationKey
    ) {
      return { ok: false, error: 'helper wrote an incompatible response identity' };
    }
    if (
      parsed.ok === true &&
      (parsed.session === 'created' || parsed.session === 'reused' || parsed.session === 'invalidated') &&
      parsed.response &&
      typeof parsed.response === 'object'
    ) {
      return {
        ok: true,
        session: parsed.session,
        response: parsed.response as RustReferenceWorkerResponse | RustImportDefinitionWorkerResponse,
      };
    }
    return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : 'helper wrote an invalid response' };
  } catch (error) {
    return {
      ok: false,
      error: `helper wrote malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isBoundedMailboxStatus(value: unknown): value is BoundedMailboxStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<BoundedMailboxStatus>;
  return (
    nonNegativeInteger(status.pending) &&
    nonNegativeInteger(status.inflight) &&
    nonNegativeInteger(status.responses) &&
    nonNegativeInteger(status.deadLetters) &&
    nonNegativeInteger(status.invalid) &&
    nonNegativeInteger(status.totalItems) &&
    typeof status.totalBytes === 'number' &&
    Number.isFinite(status.totalBytes) &&
    status.totalBytes >= 0 &&
    (status.oldestPendingAt === undefined || Number.isFinite(Date.parse(status.oldestPendingAt)))
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function currentWorkerEnvironment(): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => isManagedWorkerEnvironmentKey(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value ?? null]),
  );
}

function isCompilerSessionEnvironmentKey(key: string): boolean {
  return (
    key === 'HOME' || key === 'PATH' || key.startsWith('CARGO_') || key.startsWith('RA_') || key.startsWith('RUST')
  );
}

function isManagedWorkerEnvironmentKey(key: string): boolean {
  return (
    isCompilerSessionEnvironmentKey(key) ||
    key.startsWith('SCIP_RUST_') ||
    key === 'SCIP_QUERY_PROFILE' ||
    key === 'SCIP_QUERY_PROFILE_CACHE_STATE' ||
    key === 'SCIP_QUERY_PROFILE_COMMAND' ||
    key === 'SCIP_QUERY_PROFILE_OUT' ||
    key === 'SCIP_QUERY_PROFILE_RUN_ID' ||
    key === 'SCIP_QUERY_PROFILE_WORKLOAD_IDENTITY' ||
    key === 'SCIP_QUERY_PROFILE_WORKLOAD_IDENTITY_KIND' ||
    key === 'SCIP_QUERY_PROFILE_MIN_MS'
  );
}

const DEFAULT_IDENTITY_RUNTIME: DurableRustSessionIdentityRuntime = {
  canonicalProjectRoot(projectRoot) {
    try {
      return realpathSync(projectRoot);
    } catch {
      return resolve(projectRoot);
    }
  },
  projectFingerprint(projectRoot) {
    return rustAnalyzerProjectFingerprint(projectRoot);
  },
  engineIdentity: rustCompilerEngineIdentity,
  fileFingerprint(path) {
    return sha256(readFileSync(path));
  },
  environment() {
    return rustCompilerSessionEnvironment(process.env);
  },
};

const DEFAULT_REQUESTER_RUNTIME: DurableRustSessionRequesterRuntime = {
  now: Date.now,
  monotonicNow: monotonicNowMs,
  randomId: randomUUID,
  isProcessAlive,
  readProcessIdentity,
  spawnServer(serverPath, sessionDir, semanticWorkerPath) {
    if (!existsSync(serverPath)) {
      throw new Error(`Durable Rust semantic session helper was not found at ${serverPath}. Run npm run build first.`);
    }
    // scip-query: process-lifetime-reviewed -- this detached durable session is
    // owned by its lease, heartbeat, stop protocol, and per-request deadlines.
    const child = spawn(process.execPath, [serverPath, sessionDir, semanticWorkerPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  },
  sleep(durationMs) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, durationMs);
  },
};

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex');
}
