import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
import type {
  SemanticAvailability,
  SemanticCallee,
  SemanticImportUsage,
  SemanticProvider,
  SemanticReference,
  SemanticReferenceFragment,
} from '../types.js';
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
export function createServiceBackedTypeScriptProvider(
  db: ScipDatabase,
  relativePath?: string,
  opts: TypeScriptSemanticRequesterOptions = {},
): SemanticProvider {
  const requester = new TypeScriptSemanticRequester(db, opts);
  let directProvider: SemanticProvider | null = null;
  let cachedAvailability: SemanticAvailability | null = null;
  let remoteFailed = process.env['SCIP_QUERY_SKIP_WATCH_SERVICE'] === '1';
  const direct = (): SemanticProvider => {
    directProvider ??= createTsMorphProvider(db, relativePath);
    return directProvider;
  };
  const request = <T>(value: TypeScriptSemanticRequest, decode: (response: unknown) => T, fallback: () => T): T => {
    if (remoteFailed) return fallback();
    try {
      return decode(requester.request(value));
    } catch {
      remoteFailed = true;
      return fallback();
    }
  };
  const referencesForDefinitions = (
    definitions: readonly IndexedDefinition[],
    batchOpts?: { exact?: boolean },
  ): Map<number, SemanticReference[]> =>
    request(
      { kind: 'references', definitions: [...definitions], ...(batchOpts?.exact ? { exact: true } : {}) },
      (response) => numericMap<SemanticReference[]>(response),
      () =>
        direct().referencesForDefinitions?.(definitions, batchOpts) ??
        new Map(definitions.map((definition) => [definition.symbolId, direct().referencesFor(definition)])),
    );
  const calleesForDefinitions = (definitions: readonly IndexedDefinition[]): Map<number, SemanticCallee[]> =>
    request(
      { kind: 'callees', definitions: [...definitions] },
      (response) => numericMap<SemanticCallee[]>(response),
      () =>
        direct().calleesForDefinitions?.(definitions) ??
        new Map(definitions.map((definition) => [definition.symbolId, direct().calleesFor(definition)])),
    );

  return {
    language: 'typescript',
    availability: () => {
      cachedAvailability ??= request({ kind: 'availability' }, parseAvailability, () => direct().availability());
      return cachedAvailability;
    },
    importUsage: (file) =>
      request(
        { kind: 'import-usage', file },
        (response) => response as SemanticImportUsage[],
        () => direct().importUsage(file),
      ),
    referencesFor: (definition) => referencesForDefinitions([definition]).get(definition.symbolId) ?? [],
    referencesForDefinitions,
    referenceFragmentsForFiles: (files) =>
      request(
        { kind: 'reference-fragments', files: [...files] },
        (response) => stringMap<SemanticReferenceFragment[]>(response),
        () => direct().referenceFragmentsForFiles?.(files) ?? new Map(),
      ),
    calleesFor: (definition) => calleesForDefinitions([definition]).get(definition.symbolId) ?? [],
    calleesForDefinitions,
    signatureFor: (definition) =>
      request({ kind: 'signature', definition }, parseSignature, () => direct().signatureFor(definition)),
    dispose: () => directProvider?.dispose?.(),
  };
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
        return parseResponse(readFileSync(admitted.responsePath, 'utf8'), id, generation, operationKey);
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
  if (
    !response ||
    typeof response !== 'object' ||
    typeof (response as { available?: unknown }).available !== 'boolean'
  ) {
    throw new Error('TypeScript semantic service wrote invalid availability.');
  }
  return response as SemanticAvailability;
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
