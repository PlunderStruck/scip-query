import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { writeJsonAtomic } from '../../storage/atomic-json.js';
import {
  WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS,
  readWatchServiceState,
  watchServicePaths,
  type WatchServiceState,
} from '../../runtime/watch-service.js';
import { isProcessAlive } from '../../runtime/process-liveness.js';
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
  publishedGenerationIdentity,
  typeScriptSemanticMailboxPaths,
  type TypeScriptSemanticRequest,
} from './session-protocol.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_POLL_INTERVAL_MS = 5;

interface TypeScriptSemanticRequesterRuntime {
  now(): number;
  randomId(): string;
  sleep(durationMs: number): void;
  isProcessAlive(pid: number): boolean;
}

export interface TypeScriptSemanticRequesterOptions {
  timeoutMs?: number;
  runtime?: TypeScriptSemanticRequesterRuntime;
}

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
  const referencesForDefinitions = (definitions: readonly IndexedDefinition[]): Map<number, SemanticReference[]> =>
    request(
      { kind: 'references', definitions: [...definitions] },
      (response) => numericMap<SemanticReference[]>(response),
      () =>
        direct().referencesForDefinitions?.(definitions) ??
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

  constructor(
    private readonly db: ScipDatabase,
    opts: TypeScriptSemanticRequesterOptions = {},
  ) {
    this.runtime = opts.runtime ?? DEFAULT_RUNTIME;
    this.timeoutMs = opts.timeoutMs ?? configuredTimeoutMs();
    this.cacheDir = dirname(db.config.dbPath);
  }

  request(request: TypeScriptSemanticRequest): unknown {
    const servicePaths = watchServicePaths(this.cacheDir);
    const mailboxPaths = typeScriptSemanticMailboxPaths(this.cacheDir);
    const state = readWatchServiceState(servicePaths.statePath);
    if (!usableServiceState(state, this.db.config.projectRoot, this.runtime)) {
      throw new Error('Compatible TypeScript semantic service is not running.');
    }
    const generation = publishedGenerationIdentity(this.db.config.dbPath);
    if (!generation) throw new Error('Published TypeScript generation identity is unavailable.');

    const id = this.runtime.randomId();
    const requestPath = resolve(mailboxPaths.requestDir, `${id}.json`);
    const responsePath = resolve(mailboxPaths.responseDir, `${id}.json`);
    const deadlineAtMs = this.runtime.now() + this.timeoutMs;
    mkdirSync(mailboxPaths.requestDir, { recursive: true });
    mkdirSync(mailboxPaths.responseDir, { recursive: true });
    writeJsonAtomic(requestPath, {
      protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
      id,
      generation,
      deadlineAtMs,
      request,
    });

    try {
      while (this.runtime.now() <= deadlineAtMs) {
        if (existsSync(responsePath)) {
          return parseResponse(readFileSync(responsePath, 'utf8'), id, generation);
        }
        const liveState = readWatchServiceState(servicePaths.statePath);
        if (!usableServiceState(liveState, this.db.config.projectRoot, this.runtime)) {
          throw new Error('TypeScript semantic service stopped while processing a request.');
        }
        this.runtime.sleep(REQUEST_POLL_INTERVAL_MS);
      }
      throw new Error(`TypeScript semantic service timed out after ${this.timeoutMs}ms.`);
    } finally {
      rmSync(requestPath, { force: true });
      rmSync(responsePath, { force: true });
    }
  }
}

function usableServiceState(
  state: WatchServiceState | null,
  projectRoot: string,
  runtime: TypeScriptSemanticRequesterRuntime,
): state is WatchServiceState {
  const heartbeatIsCurrent =
    state !== null && runtime.now() - Date.parse(state.heartbeatAt) <= WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS;
  const requestIsBounded =
    state?.typescriptSemantic?.busyUntil !== undefined &&
    runtime.now() <= Date.parse(state.typescriptSemantic.busyUntil);
  return (
    state !== null &&
    state.projectRoot === resolve(projectRoot) &&
    state.typescriptSemantic?.protocolVersion === TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION &&
    runtime.isProcessAlive(state.pid) &&
    (heartbeatIsCurrent || requestIsBounded)
  );
}

function parseResponse(raw: string, id: string, generation: string): unknown {
  const response = JSON.parse(raw) as {
    ok?: unknown;
    protocolVersion?: unknown;
    id?: unknown;
    generation?: unknown;
    response?: unknown;
    error?: unknown;
  };
  if (
    response.protocolVersion !== TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION ||
    response.id !== id ||
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
  randomId: randomUUID,
  sleep(durationMs) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, durationMs);
  },
  isProcessAlive,
};
