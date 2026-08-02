import { randomUUID } from 'node:crypto';
import { monotonicNowMs } from '../domain/time.js';
import { readProcessIdentity } from '../platform/process-identity.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import { resolve } from 'node:path';
import {
  completeBoundedMailboxClaim,
  initializeBoundedMailbox,
  pollBoundedMailboxRequests,
  readBoundedMailboxClaim,
  rejectBoundedMailboxClaim,
  type BoundedMailboxLimits,
  type BoundedMailboxStatus,
} from '../storage/bounded-mailbox.js';
import {
  createTypeScriptDocumentEmitter,
  type TypeScriptDocumentEmitter,
  type TypeScriptDocumentEmitterCreation,
  type TypeScriptDocumentEmitterOptions,
} from './typescript-document-emitter.js';
import {
  TYPESCRIPT_INDEX_PROTOCOL_VERSION,
  parseTypeScriptIndexEnvelope,
  type TypeScriptIndexDocumentRequest,
  type TypeScriptIndexDocumentResponse,
  type TypeScriptIndexMailboxPaths,
  type TypeScriptIndexServiceStatus,
} from './typescript-index-protocol.js';

export interface TypeScriptIndexServiceHostOptions {
  projectRoot: string;
  currentGeneration: () => string | null;
  createEmitter?: (opts: TypeScriptDocumentEmitterOptions) => TypeScriptDocumentEmitterCreation;
  /** @deprecated Use wallNow and monotonicNow to test the clock domains independently. */
  now?: () => number;
  wallNow?: () => number;
  monotonicNow?: () => number;
}

interface ActiveEmitter {
  sessionKey: string;
  projectIdentity: string;
  emitter: TypeScriptDocumentEmitter;
}

export class TypeScriptIndexServiceHost {
  private readonly projectRoot: string;
  private readonly currentGeneration: () => string | null;
  private readonly createEmitter: (opts: TypeScriptDocumentEmitterOptions) => TypeScriptDocumentEmitterCreation;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private active: ActiveEmitter | null = null;
  private requests = 0;
  private sessionsCreated = 0;
  private sessionsReplaced = 0;
  private lastRequestAtMs: number | null = null;
  private lastDurationMs: number | null = null;
  private lastError: string | null = null;
  private unavailable = false;

  constructor(opts: TypeScriptIndexServiceHostOptions) {
    this.projectRoot = resolve(opts.projectRoot);
    this.currentGeneration = opts.currentGeneration;
    this.createEmitter = opts.createEmitter ?? createTypeScriptDocumentEmitter;
    this.wallNow = opts.wallNow ?? opts.now ?? Date.now;
    this.monotonicNow = opts.monotonicNow ?? opts.now ?? monotonicNowMs;
  }

  // scip-query: ignore-twin — protocol hosts share lifecycle names but serve different request schemas.
  handle(baseGeneration: string, request: TypeScriptIndexDocumentRequest): TypeScriptIndexDocumentResponse {
    const startedAt = this.monotonicNow();
    try {
      if (this.currentGeneration() !== baseGeneration) {
        throw new Error('TypeScript index request does not match the currently published generation.');
      }
      const active = this.emitterFor(request);
      if (active.emitter.producerIdentity !== request.producerIdentity) {
        throw new Error('TypeScript index producer identity changed.');
      }
      const before = active.emitter.snapshotStats();
      const result = active.emitter.advance({
        modifiedFiles: request.modifiedFiles,
        affectedFiles: request.affectedFiles,
      });
      const durationMs = this.monotonicNow() - startedAt;
      this.requests += 1;
      this.lastRequestAtMs = this.wallNow();
      this.lastDurationMs = durationMs;
      this.lastError = null;
      this.unavailable = false;
      return {
        producerIdentity: result.producerIdentity,
        cold: result.stats.initializations > before.initializations,
        durationMs,
        fragments: result.fragments.map((fragment) => ({
          relativePath: fragment.relativePath,
          bytesBase64: fragment.bytes === null ? null : Buffer.from(fragment.bytes).toString('base64'),
          occurrences: fragment.occurrences,
          symbols: fragment.symbols,
          referenceFragments: fragment.referenceFragments,
        })),
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  // scip-query: ignore-twin — each service reports its own protocol-specific status envelope.
  status(mailbox?: BoundedMailboxStatus): TypeScriptIndexServiceStatus {
    const stats = this.active?.emitter.snapshotStats();
    return {
      protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
      state: this.unavailable ? 'unavailable' : this.lastError ? 'error' : this.active ? 'ready' : 'idle',
      requests: this.requests,
      sessionsCreated: this.sessionsCreated,
      sessionsReplaced: this.sessionsReplaced,
      initializations: stats?.initializations ?? 0,
      programUpdates: stats?.programUpdates ?? 0,
      documentsEmitted: stats?.documentsEmitted ?? 0,
      documentsRemoved: stats?.documentsRemoved ?? 0,
      ...(this.lastRequestAtMs === null ? {} : { lastRequestAt: new Date(this.lastRequestAtMs).toISOString() }),
      ...(this.lastDurationMs === null ? {} : { lastDurationMs: this.lastDurationMs }),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(mailbox ? { mailbox } : {}),
    };
  }

  // scip-query: ignore-twin — lifecycle name is conventional; owned resources differ by service.
  close(): void {
    this.active = null;
  }

  private emitterFor(request: TypeScriptIndexDocumentRequest): ActiveEmitter {
    const sessionKey = `${request.tsconfigPath}\0${request.projectArgument}`;
    if (
      this.active &&
      this.active.sessionKey === sessionKey &&
      this.active.projectIdentity === request.projectIdentity
    ) {
      return this.active;
    }
    const created = this.createEmitter({
      workspaceRoot: this.projectRoot,
      tsconfigPath: request.tsconfigPath,
      projectRoot: request.projectArgument,
    });
    if (!created.available) {
      this.unavailable = true;
      throw new Error(created.reason);
    }
    if (this.active) this.sessionsReplaced += 1;
    this.active = { sessionKey, projectIdentity: request.projectIdentity, emitter: created.emitter };
    this.sessionsCreated += 1;
    return this.active;
  }
}

export function initializeTypeScriptIndexMailbox(paths: TypeScriptIndexMailboxPaths): void {
  initializeBoundedMailbox(paths);
}

export function processTypeScriptIndexMailbox(
  paths: TypeScriptIndexMailboxPaths,
  host: TypeScriptIndexServiceHost,
  opts: {
    nowMs?: number;
    now?: () => number;
    beforeRequest?: (deadlineAtMs: number) => void;
    afterRequest?: () => void;
    ownerId?: string;
    limits?: Partial<BoundedMailboxLimits>;
  } = {},
): number {
  const now = opts.now ?? (opts.nowMs === undefined ? Date.now : () => opts.nowMs as number);
  const claimNowMs = now();
  const claims = pollBoundedMailboxRequests(paths, {
    ownerId: opts.ownerId ?? TYPESCRIPT_INDEX_MAILBOX_OWNER,
    nowMs: claimNowMs,
    limits: opts.limits,
    owner: TYPESCRIPT_INDEX_MAILBOX_PROCESS_OWNER,
    liveness: TYPESCRIPT_INDEX_MAILBOX_LIVENESS,
  });
  let processed = 0;
  for (const claim of claims) {
    let id = claim.requestId;
    try {
      const envelope = parseTypeScriptIndexEnvelope(readBoundedMailboxClaim(claim, opts.limits));
      id = envelope.id;
      if (id !== claim.requestId) {
        throw new Error('TypeScript index request identity does not match its mailbox path.');
      }
      if (envelope.deadlineAtMs < now()) {
        throw new Error('TypeScript index request expired before processing.');
      }
      opts.beforeRequest?.(envelope.deadlineAtMs);
      const response = host.handle(envelope.baseGeneration, envelope.request);
      const completedAtMs = now();
      if (envelope.deadlineAtMs < completedAtMs) {
        throw new Error('TypeScript index request expired while the service was processing it.');
      }
      completeBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: true,
          protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
          id,
          baseGeneration: envelope.baseGeneration,
          response,
        },
        { nowMs: completedAtMs, limits: opts.limits },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejectBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: false,
          protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
          id,
          error: message,
        },
        message,
        { nowMs: now(), limits: opts.limits },
      );
    } finally {
      opts.afterRequest?.();
      processed += 1;
    }
  }
  return processed;
}

const TYPESCRIPT_INDEX_MAILBOX_OWNER = `typescript-index-${process.pid}-${randomUUID()}`;
const TYPESCRIPT_INDEX_PROCESS_IDENTITY = readProcessIdentity(process.pid);
const TYPESCRIPT_INDEX_MAILBOX_PROCESS_OWNER = {
  pid: process.pid,
  ...(TYPESCRIPT_INDEX_PROCESS_IDENTITY ? { processIdentity: TYPESCRIPT_INDEX_PROCESS_IDENTITY } : {}),
};
const TYPESCRIPT_INDEX_MAILBOX_LIVENESS = { isProcessAlive, readProcessIdentity };
