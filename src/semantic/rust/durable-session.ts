import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { RustReferenceWorkerRequest, RustReferenceWorkerResponse } from './lsp-batch-worker.js';
import type {
  RustAnalyzerSessionRequester,
  RustImportDefinitionWorkerRequest,
  RustImportDefinitionWorkerResponse,
} from './lsp-session.js';
import { profileEnabled, writeProfileEvent } from '../../instrumentation/profile.js';
import { isProcessAlive } from '../../runtime/process-liveness.js';
import { writeJsonAtomic } from '../../storage/atomic-json.js';
import { rustCompilerEngineIdentity, type RustCompilerEngineIdentity } from './engine-identity.js';
import { rustAnalyzerProjectFingerprint } from './project-fingerprint.js';

export const DURABLE_RUST_SESSION_PROTOCOL_VERSION = 2;
const DURABLE_RUST_SESSION_MAX_HEARTBEAT_AGE_MS = 5_000;
const DURABLE_RUST_SESSION_STARTUP_TIMEOUT_MS = 5_000;
const DURABLE_RUST_SESSION_POLL_INTERVAL_MS = 10;
const DEFAULT_DURABLE_RUST_REFERENCE_RETRY_TIMEOUT_MS = 30_000;

type RustSessionRequest = RustReferenceWorkerRequest | RustImportDefinitionWorkerRequest;

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

export interface DurableRustSessionServerState {
  protocolVersion: number;
  pid: number;
  heartbeatAtMs: number;
  busyUntilMs?: number;
}

export interface DurableRustSessionRequesterRuntime {
  now(): number;
  randomId(): string;
  isProcessAlive(pid: number): boolean;
  spawnServer(serverPath: string, sessionDir: string, semanticWorkerPath: string): void;
  sleep(durationMs: number): void;
}

export interface DurableRustSessionRequesterOptions {
  serverPath: string;
  semanticWorkerPath: string;
  tempRoot?: string;
  identityRuntime?: DurableRustSessionIdentityRuntime;
  runtime?: DurableRustSessionRequesterRuntime;
}

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
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  return (
    state.protocolVersion === DURABLE_RUST_SESSION_PROTOCOL_VERSION &&
    (nowMs - state.heartbeatAtMs <= DURABLE_RUST_SESSION_MAX_HEARTBEAT_AGE_MS ||
      (state.busyUntilMs !== undefined && nowMs <= state.busyUntilMs)) &&
    isProcessAlive(state.pid)
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
    );
  };

  return {
    requestSemantic(request, timeoutMs) {
      const identity = createDurableRustSessionIdentity(projectRoot, opts.semanticWorkerPath, request, identityRuntime);
      const readinessDeadlineMs = runtime.now() + Math.max(1, timeoutMs - 1_000);
      return dispatch<RustReferenceWorkerResponse>(
        {
          kind: 'semantic',
          identityKey: identity.key,
          workerEnvironment: currentWorkerEnvironment(),
          request: {
            ...request,
            readinessDeadlineMs,
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
      const readinessDeadlineMs = runtime.now() + Math.max(1, timeoutMs - 1_000);
      return dispatch<RustImportDefinitionWorkerResponse>(
        {
          kind: 'import-definitions',
          identityKey: identity.key,
          workerEnvironment: currentWorkerEnvironment(),
          request: {
            ...request,
            readinessDeadlineMs,
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

function dispatchDurableRustSessionRequest<Response>(
  sessionDir: string,
  serverPath: string,
  semanticWorkerPath: string,
  request: DurableRustSessionRequest,
  timeoutMs: number,
  runtime: DurableRustSessionRequesterRuntime,
): Response {
  const requestId = runtime.randomId();
  const startedAtMs = runtime.now();
  const requestDir = resolve(sessionDir, 'requests');
  const responseDir = resolve(sessionDir, 'responses');
  const requestPath = resolve(requestDir, `${requestId}.json`);
  const responsePath = resolve(responseDir, `${requestId}.json`);
  mkdirSync(requestDir, { recursive: true });
  mkdirSync(responseDir, { recursive: true });
  writeJsonAtomic(requestPath, { id: requestId, request });

  const deadline = runtime.now() + timeoutMs;
  try {
    ensureDurableRustSessionServer(sessionDir, serverPath, semanticWorkerPath, deadline, runtime);
    while (runtime.now() <= deadline) {
      if (existsSync(responsePath)) {
        const payload = parseDurableResponse(readFileSync(responsePath, 'utf8'));
        if (!payload.ok) throw new Error(payload.error);
        if (profileEnabled()) {
          writeProfileEvent({
            type: 'span',
            name: 'rust.semantic.durable-session.request',
            durationMs: runtime.now() - startedAtMs,
            ok: true,
            session: payload.session,
            kind: request.kind,
          });
        }
        return payload.response as Response;
      }
      const state = readDurableRustSessionServerState(sessionDir);
      if (!state || !isDurableRustSessionStateLive(state, runtime.now(), runtime.isProcessAlive)) {
        ensureDurableRustSessionServer(sessionDir, serverPath, semanticWorkerPath, deadline, runtime);
      }
      runtime.sleep(DURABLE_RUST_SESSION_POLL_INTERVAL_MS);
    }
    throw new Error(`Durable Rust semantic session timed out after ${(timeoutMs / 1000).toFixed(0)}s.`);
  } finally {
    rmSync(requestPath, { force: true });
    rmSync(responsePath, { force: true });
  }
}

function ensureDurableRustSessionServer(
  sessionDir: string,
  serverPath: string,
  semanticWorkerPath: string,
  requestDeadline: number,
  runtime: DurableRustSessionRequesterRuntime,
): void {
  const current = readDurableRustSessionServerState(sessionDir);
  if (current && isDurableRustSessionStateLive(current, runtime.now(), runtime.isProcessAlive)) return;

  rmSync(resolve(sessionDir, 'server.json'), { force: true });
  runtime.spawnServer(serverPath, sessionDir, semanticWorkerPath);
  const startupDeadline = Math.min(requestDeadline, runtime.now() + DURABLE_RUST_SESSION_STARTUP_TIMEOUT_MS);
  while (runtime.now() <= startupDeadline) {
    const state = readDurableRustSessionServerState(sessionDir);
    if (state && isDurableRustSessionStateLive(state, runtime.now(), runtime.isProcessAlive)) return;
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
      (parsed.busyUntilMs !== undefined && typeof parsed.busyUntilMs !== 'number')
    ) {
      return null;
    }
    return {
      protocolVersion: parsed.protocolVersion,
      pid: parsed.pid,
      heartbeatAtMs: parsed.heartbeatAtMs,
      ...(parsed.busyUntilMs === undefined ? {} : { busyUntilMs: parsed.busyUntilMs }),
    };
  } catch {
    return null;
  }
}

function parseDurableResponse(raw: string):
  | {
      ok: true;
      session: DurableRustSessionResponse['session'];
      response: RustReferenceWorkerResponse | RustImportDefinitionWorkerResponse;
    }
  | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw) as { ok?: unknown; session?: unknown; response?: unknown; error?: unknown };
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
  randomId: randomUUID,
  isProcessAlive,
  spawnServer(serverPath, sessionDir, semanticWorkerPath) {
    if (!existsSync(serverPath)) {
      throw new Error(`Durable Rust semantic session helper was not found at ${serverPath}. Run npm run build first.`);
    }
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex');
}
