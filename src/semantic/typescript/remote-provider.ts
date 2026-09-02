import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { monotonicNowMs } from '../../domain/time.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { captureProfileEnvironment } from '../../instrumentation/profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxRequestId,
  enqueueBoundedMailboxRequest,
  type BoundedMailboxLimits,
} from '../../storage/bounded-mailbox.js';
import {
  readWatchServiceState,
  watchServicePaths,
  type WatchServiceState,
} from '../../platform/watch-service-state.js';
import { isProcessAlive } from '../../platform/process-liveness.js';
import { readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from '../../platform/process-identity.js';
import { canonicalPath } from '../../platform/git-worktree.js';
import { readTextFileWithinLimit } from '../../platform/bounded-file.js';
import type {
  SemanticAvailability,
  SemanticCallee,
  SemanticImportUsage,
  SemanticProvider,
  SemanticReference,
  SemanticReferenceFragment,
  SemanticCalleeCoverage,
} from '../types.js';
import { decodeSemanticAvailability } from '../types.js';
import { createTsMorphProvider } from './ts-morph-provider.js';
import {
  TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
  typeScriptSemanticMailboxPaths,
  type TypeScriptSemanticRequest,
} from './session-protocol.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_POLL_INTERVAL_MS = 5;

interface TypeScriptSemanticRequesterRuntime {
  /** Civil time used only in persisted cross-process request records. */
  now(): number;
  /** Process-local elapsed clock; defaults to performance.now(). */
  monotonicNow?(): number;
  randomId(): string;
  sleep(durationMs: number): void;
  isProcessAlive(pid: number): boolean;
  readProcessIdentity?(pid: number): ProcessIdentity | null;
}

export interface TypeScriptSemanticRequesterOptions {
  timeoutMs?: number;
  runtime?: TypeScriptSemanticRequesterRuntime;
  mailboxLimits?: Partial<BoundedMailboxLimits>;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export interface ServiceBackedTypeScriptProviderOptions extends TypeScriptSemanticRequesterOptions {
  /** Test seam: the transport that carries requests to the service. */
  requester?: { request(request: TypeScriptSemanticRequest): unknown };
}

export function createServiceBackedTypeScriptProvider(
  db: ScipDatabase,
  relativePath?: string,
  opts: ServiceBackedTypeScriptProviderOptions = {},
): SemanticProvider {
  const requester = opts.requester ?? new TypeScriptSemanticRequester(db, opts);
  let directProvider: SemanticProvider | null = null;
  let cachedAvailability: SemanticAvailability | null = null;
  let remoteFailed = process.env['SCIP_QUERY_SKIP_WATCH_SERVICE'] === '1';
  // A service failure on a large index must not become an in-process
  // compiler load: that is the same work the service's bounded worker just
  // could not finish, now inside a command process with a smaller heap.
  let serviceDeclined: string | null = null;
  const direct = (): SemanticProvider => {
    directProvider ??= createTsMorphProvider(db, relativePath);
    return directProvider;
  };
  const failClosed = <T>(error: unknown, fallback: () => T, unavailable: () => T): T => {
    remoteFailed = true;
    if (!inProcessCompilerAllowed(db)) {
      serviceDeclined = error instanceof Error ? error.message : String(error);
      console.error(
        `TypeScript semantic service request failed (${serviceDeclined}); semantic enrichment is disabled for the rest of this run because the index is too large for an in-process compiler.`,
      );
      return unavailable();
    }
    return fallback();
  };
  const request = <T>(
    value: TypeScriptSemanticRequest,
    decode: (response: unknown) => T,
    fallback: () => T,
    unavailable: () => T = fallback,
  ): T => {
    if (serviceDeclined !== null) return unavailable();
    if (remoteFailed) return fallback();
    try {
      return decode(requester.request(value));
    } catch (error) {
      // A service that does not know this request kind is healthy for every
      // other kind; answer this one as unavailable and keep using it.
      if (isUnsupportedRequestError(error)) return unavailable();
      return failClosed(error, fallback, unavailable);
    }
  };
  /**
   * A definition batch whose worker died of memory is retried as two halves
   * split by file, down to single files, before the service counts as failed:
   * the restarted worker loads only the projects the smaller batch needs.
   */
  const requestBatched = <T>(
    definitions: readonly IndexedDefinition[],
    build: (batch: readonly IndexedDefinition[]) => TypeScriptSemanticRequest,
    decode: (response: unknown) => Map<number, T>,
    fallback: () => Map<number, T>,
  ): Map<number, T> => {
    if (serviceDeclined !== null) return new Map();
    if (remoteFailed) return fallback();
    const run = (batch: readonly IndexedDefinition[]): Map<number, T> => {
      try {
        return decode(requester.request(build(batch)));
      } catch (error) {
        if (!isWorkerMemoryFailure(error)) throw error;
        const halves = splitByFile(batch);
        if (!halves) throw error;
        return new Map([...run(halves[0]), ...run(halves[1])]);
      }
    };
    try {
      return run(definitions);
    } catch (error) {
      if (isUnsupportedRequestError(error)) return new Map();
      return failClosed(error, fallback, () => new Map());
    }
  };
  const referencesForDefinitions = (
    definitions: readonly IndexedDefinition[],
    batchOpts?: { exact?: boolean },
  ): Map<number, SemanticReference[]> =>
    requestBatched(
      definitions,
      (batch) => ({ kind: 'references', definitions: [...batch], ...(batchOpts?.exact ? { exact: true } : {}) }),
      (response) => numericMap<SemanticReference[]>(response),
      () =>
        direct().referencesForDefinitions?.(definitions, batchOpts) ??
        new Map(definitions.map((definition) => [definition.symbolId, direct().referencesFor(definition)])),
    );
  const calleesForDefinitions = (definitions: readonly IndexedDefinition[]): Map<number, SemanticCallee[]> =>
    requestBatched(
      definitions,
      (batch) => ({ kind: 'callees', definitions: [...batch] }),
      (response) => numericMap<SemanticCallee[]>(response),
      () =>
        direct().calleesForDefinitions?.(definitions) ??
        new Map(definitions.map((definition) => [definition.symbolId, direct().calleesFor(definition)])),
    );

  return {
    language: 'typescript',
    availability: () => {
      cachedAvailability ??= request(
        { kind: 'availability' },
        parseAvailability,
        () => direct().availability(),
        () => ({
          available: false,
          reason: `TypeScript semantic service declined: ${serviceDeclined ?? 'unknown'}`,
        }),
      );
      return cachedAvailability;
    },
    importUsage: (file) =>
      request(
        { kind: 'import-usage', file },
        (response) => response as SemanticImportUsage[],
        () => direct().importUsage(file),
        () => [],
      ),
    referencesFor: (definition) => referencesForDefinitions([definition]).get(definition.symbolId) ?? [],
    referencesForDefinitions,
    referenceFragmentsForFiles: (files) =>
      request(
        { kind: 'reference-fragments', files: [...files] },
        (response) => stringMap<SemanticReferenceFragment[]>(response),
        () => direct().referenceFragmentsForFiles?.(files) ?? new Map(),
        () => new Map(),
      ),
    calleesFor: (definition) => calleesForDefinitions([definition]).get(definition.symbolId) ?? [],
    calleesForDefinitions,
    calleeCoverageForDefinitions: (definitions) =>
      requestBatched(
        definitions,
        (batch) => ({ kind: 'callee-coverage', definitions: [...batch] }),
        (response) => numericMap<SemanticCalleeCoverage>(response),
        () => direct().calleeCoverageForDefinitions?.(definitions) ?? new Map(),
      ),
    signatureFor: (definition) =>
      request(
        { kind: 'signature', definition },
        parseSignature,
        () => direct().signatureFor(definition),
        () => null,
      ),
    dispose: () => directProvider?.dispose?.(),
  };
}

function isWorkerMemoryFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /memory limit|heap out of memory|worker terminated|worker failed/iu.test(message);
}

/** Two halves that never split a file, or null when the batch is already a single file. */
function splitByFile(definitions: readonly IndexedDefinition[]): [IndexedDefinition[], IndexedDefinition[]] | null {
  const files = [...new Set(definitions.map((definition) => definition.relativePath))].sort();
  if (files.length < 2) return null;
  const left = new Set(files.slice(0, Math.ceil(files.length / 2)));
  return [
    definitions.filter((definition) => left.has(definition.relativePath)),
    definitions.filter((definition) => !left.has(definition.relativePath)),
  ];
}

function isUnsupportedRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('invalid mailbox request') || message.includes('Unhandled TypeScript semantic request');
}

/** Mirrors the CLI's large-index thresholds: above them a command process must not host the compiler itself. */
const IN_PROCESS_COMPILER_MAX_DOCUMENTS = 2_500;
const IN_PROCESS_COMPILER_MAX_SYMBOLS = 25_000;
const IN_PROCESS_COMPILER_ALLOWED = new WeakMap<ScipDatabase, boolean>();

function inProcessCompilerAllowed(db: ScipDatabase): boolean {
  const cached = IN_PROCESS_COMPILER_ALLOWED.get(db);
  if (cached !== undefined) return cached;
  const allowed = indexFitsInProcessCompiler(db);
  IN_PROCESS_COMPILER_ALLOWED.set(db, allowed);
  return allowed;
}

function indexFitsInProcessCompiler(db: ScipDatabase): boolean {
  try {
    const row = db.get<{ documents: number; symbols: number }>(
      'SELECT (SELECT count(*) FROM documents) AS documents, (SELECT count(*) FROM global_symbols) AS symbols',
    );
    return !row || (row.documents < IN_PROCESS_COMPILER_MAX_DOCUMENTS && row.symbols < IN_PROCESS_COMPILER_MAX_SYMBOLS);
  } catch {
    return true;
  }
}

export class TypeScriptSemanticRequester {
  private readonly runtime: TypeScriptSemanticRequesterRuntime;
  private readonly timeoutMs: number;
  private readonly cacheDir: string;
  private readonly projectRoot: string;
  private readonly mailboxLimits: Partial<BoundedMailboxLimits>;

  constructor(
    private readonly db: ScipDatabase,
    opts: TypeScriptSemanticRequesterOptions = {},
  ) {
    this.runtime = opts.runtime ?? DEFAULT_RUNTIME;
    this.timeoutMs = opts.timeoutMs ?? configuredTimeoutMs();
    this.mailboxLimits = opts.mailboxLimits ?? {};
    this.cacheDir = dirname(db.config.dbPath);
    this.projectRoot = canonicalPath(db.config.projectRoot);
  }

  request(request: TypeScriptSemanticRequest): unknown {
    const servicePaths = watchServicePaths(this.cacheDir);
    const mailboxPaths = typeScriptSemanticMailboxPaths(this.cacheDir);
    const state = readWatchServiceState(servicePaths.statePath);
    if (!usableServiceState(state, this.projectRoot, this.runtime)) {
      throw new Error('Compatible TypeScript semantic service is not running.');
    }
    const generation = this.db.generation.identity;
    if (!generation) throw new Error('Published TypeScript generation identity is unavailable.');

    const enqueuedAtMs = this.runtime.now();
    const deadlineAtMs = enqueuedAtMs + this.timeoutMs;
    const monotonicDeadlineAtMs = (this.runtime.monotonicNow ?? monotonicNowMs)() + this.timeoutMs;
    const profileEnvironment = captureProfileEnvironment();
    const operationKey = boundedMailboxOperationKey('typescript-semantic-v3', {
      generation,
      profileEnvironment,
      request,
    });
    const id = boundedMailboxRequestId(operationKey);
    const admitted = enqueueBoundedMailboxRequest(
      mailboxPaths,
      {
        mailboxVersion: BOUNDED_MAILBOX_VERSION,
        operationKey,
        clientId: this.runtime.randomId(),
        enqueuedAtMs,
        deadlineAtMs,
        protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
        id,
        generation,
        profileEnvironment,
        request,
      },
      { nowMs: enqueuedAtMs, limits: this.mailboxLimits },
    );

    while ((this.runtime.monotonicNow ?? monotonicNowMs)() <= monotonicDeadlineAtMs) {
      if (existsSync(admitted.responsePath)) {
        return parseResponse(
          readTextFileWithinLimit(admitted.responsePath, {
            maxBytes: this.mailboxLimits.maxItemBytes ?? 64 * 1024 * 1024,
            inputKind: 'TypeScript semantic mailbox response',
          }),
          id,
          generation,
          operationKey,
        );
      }
      const liveState = readWatchServiceState(servicePaths.statePath);
      if (!usableServiceState(liveState, this.projectRoot, this.runtime)) {
        throw new Error('TypeScript semantic service stopped while processing a request.');
      }
      this.runtime.sleep(REQUEST_POLL_INTERVAL_MS);
    }
    throw new Error(`TypeScript semantic service timed out after ${this.timeoutMs}ms.`);
  }
}

/**
 * Whether a live watch service can serve TypeScript semantic requests for this
 * project, so that whole-project compiler work can be delegated instead of
 * hosted by the calling process.
 */
export function typeScriptSemanticServiceAvailable(db: ScipDatabase): boolean {
  if (process.env['SCIP_QUERY_SKIP_WATCH_SERVICE'] === '1') return false;
  try {
    const state = readWatchServiceState(watchServicePaths(dirname(db.config.dbPath)).statePath);
    return usableServiceState(state, canonicalPath(db.config.projectRoot), DEFAULT_RUNTIME);
  } catch {
    return false;
  }
}

function usableServiceState(
  state: WatchServiceState | null,
  projectRoot: string,
  runtime: TypeScriptSemanticRequesterRuntime,
): state is WatchServiceState {
  const actualIdentity = state?.processIdentity ? runtime.readProcessIdentity?.(state.pid) : null;
  return (
    state !== null &&
    state.projectRoot === projectRoot &&
    state.typescriptSemantic?.protocolVersion === TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION &&
    runtime.isProcessAlive(state.pid) &&
    (!state.processIdentity || (actualIdentity != null && sameProcessIdentity(state.processIdentity, actualIdentity)))
  );
}

function parseResponse(raw: string, id: string, generation: string, operationKey: string): unknown {
  const response = JSON.parse(raw) as {
    ok?: unknown;
    protocolVersion?: unknown;
    id?: unknown;
    generation?: unknown;
    operationKey?: unknown;
    response?: unknown;
    error?: unknown;
  };
  if (
    response.protocolVersion !== TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION ||
    response.id !== id ||
    response.operationKey !== operationKey ||
    (response.ok === true && response.generation !== generation)
  ) {
    throw new Error('TypeScript semantic service wrote an incompatible response.');
  }
  if (response.ok === true) return response.response;
  throw new Error(typeof response.error === 'string' ? response.error : 'TypeScript semantic service request failed.');
}

function numericMap<T>(response: unknown): Map<number, T> {
  if (!Array.isArray(response)) throw new Error('TypeScript semantic service wrote an invalid numeric map.');
  return new Map(response as Array<[number, T]>);
}

function stringMap<T>(response: unknown): Map<string, T> {
  if (!Array.isArray(response)) throw new Error('TypeScript semantic service wrote an invalid string map.');
  return new Map(response as Array<[string, T]>);
}

function parseAvailability(response: unknown): SemanticAvailability {
  const availability = decodeSemanticAvailability(response);
  if (!availability) throw new Error('TypeScript semantic service wrote invalid availability.');
  return availability;
}

function parseSignature(response: unknown): string | null {
  if (response !== null && typeof response !== 'string') {
    throw new Error('TypeScript semantic service wrote an invalid signature.');
  }
  return response;
}

function configuredTimeoutMs(): number {
  const parsed = Number(process.env['SCIP_TYPESCRIPT_SEMANTIC_TIMEOUT_MS']);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

const DEFAULT_RUNTIME: TypeScriptSemanticRequesterRuntime = {
  now: Date.now,
  monotonicNow: monotonicNowMs,
  randomId: randomUUID,
  sleep(durationMs) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, durationMs);
  },
  isProcessAlive,
  readProcessIdentity,
};
