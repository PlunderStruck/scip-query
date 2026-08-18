import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { monotonicNowMs } from '../domain/time.js';
import {
  WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS,
  readWatchServiceState,
  watchServicePaths,
  type WatchServiceState,
} from '../platform/watch-service-state.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import { readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from '../platform/process-identity.js';
import { canonicalPath } from '../platform/git-worktree.js';
import { readTextFileWithinLimit } from '../platform/bounded-file.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxRequestId,
  enqueueBoundedMailboxRequest,
  type BoundedMailboxLimits,
} from '../storage/bounded-mailbox.js';
import type { TypeScriptDocumentFragment } from './typescript-document-emitter.js';
import {
  TYPESCRIPT_INDEX_PROTOCOL_VERSION,
  typeScriptIndexMailboxPaths,
  type TypeScriptIndexDocumentRequest,
  type TypeScriptIndexDocumentResponse,
} from './typescript-index-protocol.js';
import { TypeScriptIndexServiceHost } from './typescript-index-service.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_POLL_INTERVAL_MS = 5;

/** A Worker memory failure that must not be escalated into a more expensive full index. */
export class TypeScriptIndexMemoryPressureError extends Error {
  override readonly name = 'TypeScriptIndexMemoryPressureError';
}

export interface TypeScriptIndexRequesterRuntime {
  /** Civil time used only in persisted cross-process request records. */
  now(): number;
  /** Process-local elapsed clock; defaults to performance.now(). */
  monotonicNow?(): number;
  randomId(): string;
  sleep(durationMs: number): void;
  isProcessAlive(pid: number): boolean;
  readProcessIdentity?(pid: number): ProcessIdentity | null;
}

export interface TypeScriptIndexRequesterOptions {
  timeoutMs?: number;
  runtime?: TypeScriptIndexRequesterRuntime;
  mailboxLimits?: Partial<BoundedMailboxLimits>;
  emitLocally?: (request: TypeScriptIndexDocumentRequest) => RequestedTypeScriptDocuments;
}

export interface RequestedTypeScriptDocuments {
  producerIdentity: string;
  cold: boolean;
  durationMs: number;
  fragments: TypeScriptDocumentFragment[];
}

export class TypeScriptIndexRequester {
  private readonly projectRoot: string;
  private readonly cacheDir: string;
  private readonly baseGeneration: string;
  private readonly timeoutMs: number;
  private readonly runtime: TypeScriptIndexRequesterRuntime;
  private readonly mailboxLimits: Partial<BoundedMailboxLimits>;
  private readonly emitLocally?: (request: TypeScriptIndexDocumentRequest) => RequestedTypeScriptDocuments;
  private localHost: TypeScriptIndexServiceHost | null = null;

  constructor(
    input: { projectRoot: string; cacheDir: string; baseGeneration: string },
    opts: TypeScriptIndexRequesterOptions = {},
  ) {
    this.projectRoot = canonicalPath(input.projectRoot);
    this.cacheDir = input.cacheDir;
    this.baseGeneration = input.baseGeneration;
    this.timeoutMs = opts.timeoutMs ?? configuredTimeoutMs();
    this.runtime = opts.runtime ?? DEFAULT_RUNTIME;
    this.mailboxLimits = opts.mailboxLimits ?? {};
    this.emitLocally = opts.emitLocally;
  }

  // scip-query: ignore-twin — request clients target unrelated index, LSP, and semantic protocols.
  request(request: TypeScriptIndexDocumentRequest): RequestedTypeScriptDocuments {
    const servicePaths = watchServicePaths(this.cacheDir);
    const mailboxPaths = typeScriptIndexMailboxPaths(this.cacheDir);
    const state = readWatchServiceState(servicePaths.statePath);
    if (!usableServiceState(state, this.projectRoot, this.runtime)) {
      return this.requestLocally(request);
    }

    const enqueuedAtMs = this.runtime.now();
    const deadlineAtMs = enqueuedAtMs + this.timeoutMs;
    const monotonicDeadlineAtMs = (this.runtime.monotonicNow ?? monotonicNowMs)() + this.timeoutMs;
    const operationKey = boundedMailboxOperationKey('typescript-index-v4', {
      baseGeneration: this.baseGeneration,
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
        protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
        id,
        baseGeneration: this.baseGeneration,
        request,
      },
      { nowMs: enqueuedAtMs, limits: this.mailboxLimits },
    );

    while ((this.runtime.monotonicNow ?? monotonicNowMs)() <= monotonicDeadlineAtMs) {
      if (existsSync(admitted.responsePath)) {
        return parseResponse(
          readTextFileWithinLimit(admitted.responsePath, {
            maxBytes: this.mailboxLimits.maxItemBytes ?? 64 * 1024 * 1024,
            inputKind: 'TypeScript index mailbox response',
          }),
          id,
          operationKey,
          this.baseGeneration,
          request.producerIdentity,
          request.affectedFiles,
        );
      }
      const liveState = readWatchServiceState(servicePaths.statePath);
      if (!usableServiceState(liveState, this.projectRoot, this.runtime)) {
        return this.requestLocally(request);
      }
      this.runtime.sleep(REQUEST_POLL_INTERVAL_MS);
    }
    return this.requestLocally(request);
  }

  private requestLocally(request: TypeScriptIndexDocumentRequest): RequestedTypeScriptDocuments {
    if (this.emitLocally) {
      return documentsFromResponse(this.emitLocally(request), request.producerIdentity, request.affectedFiles);
    }
    this.localHost ??= new TypeScriptIndexServiceHost({
      projectRoot: this.projectRoot,
      currentGeneration: () => this.baseGeneration,
    });
    return documentsFromResponse(
      decodeDocumentResponse(this.localHost.handle(this.baseGeneration, request), request.producerIdentity),
      request.producerIdentity,
      request.affectedFiles,
    );
  }
}

// scip-query: ignore-twin — service-state validators enforce different protocol versions and payloads.
function usableServiceState(
  state: WatchServiceState | null,
  projectRoot: string,
  runtime: TypeScriptIndexRequesterRuntime,
): state is WatchServiceState {
  const actualIdentity = state?.processIdentity ? runtime.readProcessIdentity?.(state.pid) : null;
  const heartbeatAtMs = state ? Date.parse(state.heartbeatAt) : Number.NaN;
  return (
    state !== null &&
    state.projectRoot === projectRoot &&
    state.typescriptIndex?.protocolVersion === TYPESCRIPT_INDEX_PROTOCOL_VERSION &&
    runtime.isProcessAlive(state.pid) &&
    Number.isFinite(heartbeatAtMs) &&
    runtime.now() - heartbeatAtMs <= WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS &&
    (!state.processIdentity || (actualIdentity != null && sameProcessIdentity(state.processIdentity, actualIdentity)))
  );
}

// scip-query: ignore-twin — response parsers decode different mailbox protocols.
function parseResponse(
  raw: string,
  id: string,
  operationKey: string,
  baseGeneration: string,
  producerIdentity: string,
  affectedFiles: readonly string[],
): RequestedTypeScriptDocuments {
  const response = JSON.parse(raw) as {
    ok?: unknown;
    protocolVersion?: unknown;
    id?: unknown;
    operationKey?: unknown;
    baseGeneration?: unknown;
    response?: unknown;
    error?: unknown;
  };
  if (
    response.protocolVersion !== TYPESCRIPT_INDEX_PROTOCOL_VERSION ||
    response.id !== id ||
    response.operationKey !== operationKey ||
    (response.ok === true && response.baseGeneration !== baseGeneration)
  ) {
    throw new Error('TypeScript index service wrote an incompatible response.');
  }
  if (response.ok !== true) {
    const reason = typeof response.error === 'string' ? response.error : 'TypeScript index service request failed.';
    if (isMemoryPressureReason(reason)) throw new TypeScriptIndexMemoryPressureError(reason);
    throw new Error(reason);
  }
  return documentsFromResponse(
    decodeDocumentResponse(response.response, producerIdentity),
    producerIdentity,
    affectedFiles,
  );
}

function isMemoryPressureReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    normalized.includes('out of memory') ||
    normalized.includes('memory limit') ||
    normalized.includes('allocation failed') ||
    normalized.includes('err_worker_out_of_memory')
  );
}

function documentsFromResponse(
  decoded: RequestedTypeScriptDocuments,
  producerIdentity: string,
  affectedFiles: readonly string[],
): RequestedTypeScriptDocuments {
  if (decoded.producerIdentity !== producerIdentity) {
    throw new Error('TypeScript index service wrote an invalid response.');
  }
  const expected = [...new Set(affectedFiles)].sort();
  const actual = decoded.fragments.map((fragment) => fragment.relativePath).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('TypeScript index service omitted or added an affected document.');
  }
  return decoded;
}

function decodeDocumentResponse(value: unknown, producerIdentity: string): RequestedTypeScriptDocuments {
  if (!value || typeof value !== 'object') throw new Error('TypeScript index service wrote an invalid response.');
  const response = value as Partial<TypeScriptIndexDocumentResponse>;
  if (
    response.producerIdentity !== producerIdentity ||
    typeof response.cold !== 'boolean' ||
    typeof response.durationMs !== 'number' ||
    !Number.isFinite(response.durationMs) ||
    !Array.isArray(response.fragments)
  ) {
    throw new Error('TypeScript index service wrote an invalid response.');
  }
  const paths = new Set<string>();
  const fragments = response.fragments.map((fragment) => {
    if (
      !fragment ||
      typeof fragment.relativePath !== 'string' ||
      (fragment.bytesBase64 !== null && typeof fragment.bytesBase64 !== 'string') ||
      typeof fragment.occurrences !== 'number' ||
      !Number.isInteger(fragment.occurrences) ||
      fragment.occurrences < 0 ||
      typeof fragment.symbols !== 'number' ||
      !Number.isInteger(fragment.symbols) ||
      fragment.symbols < 0 ||
      !Array.isArray(fragment.referenceFragments) ||
      !fragment.referenceFragments.every(isReferenceFragment) ||
      paths.has(fragment.relativePath)
    ) {
      throw new Error('TypeScript index service wrote an invalid fragment.');
    }
    paths.add(fragment.relativePath);
    const bytes = fragment.bytesBase64 === null ? null : decodeBase64(fragment.bytesBase64);
    return {
      relativePath: fragment.relativePath,
      bytes,
      occurrences: fragment.occurrences,
      symbols: fragment.symbols,
      referenceFragments: fragment.referenceFragments,
    };
  });
  return {
    producerIdentity: response.producerIdentity,
    cold: response.cold,
    durationMs: response.durationMs,
    fragments,
  };
}

// scip-query: ignore-twin — wire-fragment validation and stored-fragment validation have different contracts.
function isReferenceFragment(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const fragment = value as { targetSymbol?: unknown; location?: Record<string, unknown> };
  return (
    typeof fragment.targetSymbol === 'string' &&
    !!fragment.location &&
    typeof fragment.location.file === 'string' &&
    Number.isInteger(fragment.location.line) &&
    Number.isInteger(fragment.location.column)
  );
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('TypeScript index service wrote invalid base64.');
  return bytes;
}

// scip-query: ignore-twin — timeout defaults belong to their individual transports.
function configuredTimeoutMs(): number {
  const parsed = Number(process.env['SCIP_TYPESCRIPT_INDEX_TIMEOUT_MS']);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

const DEFAULT_RUNTIME: TypeScriptIndexRequesterRuntime = {
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
