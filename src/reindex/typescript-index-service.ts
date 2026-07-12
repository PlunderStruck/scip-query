import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJsonAtomic } from '../storage/atomic-json.js';
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
  now?: () => number;
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
  private readonly now: () => number;
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
    this.now = opts.now ?? Date.now;
  }

  // scip-query: ignore-twin — protocol hosts share lifecycle names but serve different request schemas.
  handle(baseGeneration: string, request: TypeScriptIndexDocumentRequest): TypeScriptIndexDocumentResponse {
    const startedAt = this.now();
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
      const durationMs = this.now() - startedAt;
      this.requests += 1;
      this.lastRequestAtMs = this.now();
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
  status(): TypeScriptIndexServiceStatus {
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
  mkdirSync(paths.requestDir, { recursive: true });
  mkdirSync(paths.responseDir, { recursive: true });
}

export function processTypeScriptIndexMailbox(
  paths: TypeScriptIndexMailboxPaths,
  host: TypeScriptIndexServiceHost,
  opts: {
    nowMs?: number;
    beforeRequest?: (deadlineAtMs: number) => void;
    afterRequest?: () => void;
  } = {},
): number {
  initializeTypeScriptIndexMailbox(paths);
  let processed = 0;
  for (const file of readdirSync(paths.requestDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    const requestPath = resolve(paths.requestDir, file);
    let id = file.slice(0, -'.json'.length);
    try {
      const envelope = parseTypeScriptIndexEnvelope(readFileSync(requestPath, 'utf8'));
      id = envelope.id;
      if (envelope.deadlineAtMs < (opts.nowMs ?? Date.now())) {
        throw new Error('TypeScript index request expired before processing.');
      }
      opts.beforeRequest?.(envelope.deadlineAtMs);
      const response = host.handle(envelope.baseGeneration, envelope.request);
      writeJsonAtomic(resolve(paths.responseDir, `${id}.json`), {
        ok: true,
        protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
        id,
        baseGeneration: envelope.baseGeneration,
        response,
      });
    } catch (error) {
      writeJsonAtomic(resolve(paths.responseDir, `${id}.json`), {
        ok: false,
        protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      opts.afterRequest?.();
      rmSync(requestPath, { force: true });
      processed += 1;
    }
  }
  return processed;
}
