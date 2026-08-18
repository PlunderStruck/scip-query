import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { readProcessIdentity } from '../platform/process-identity.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import {
  TYPESCRIPT_INDEX_PROTOCOL_VERSION,
  parseTypeScriptIndexEnvelope,
  type TypeScriptIndexDocumentResponse,
  type TypeScriptIndexEnvelope,
  type TypeScriptIndexMailboxPaths,
  type TypeScriptIndexServiceStatus,
} from '../reindex/typescript-index-protocol.js';
import {
  TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
  parseTypeScriptSemanticEnvelope,
  type TypeScriptSemanticMailboxEnvelope,
  type TypeScriptSemanticMailboxPaths,
  type TypeScriptSemanticServiceStatus,
} from '../semantic/typescript/session-protocol.js';
import {
  completeBoundedMailboxClaim,
  inspectBoundedMailbox,
  pollBoundedMailboxRequests,
  readBoundedMailboxClaim,
  rejectBoundedMailboxClaim,
  type BoundedMailboxClaim,
  type BoundedMailboxLimits,
} from '../storage/bounded-mailbox.js';
import { WorkerRequestLane, type RequestWorkerLike } from './worker-request-lane.js';

/** Semantic query workers exit quickly; index workers retain a longer interactive warm window. */
const TYPESCRIPT_SEMANTIC_MAILBOX_WORKER_IDLE_MS = 60_000;
const TYPESCRIPT_INDEX_MAILBOX_WORKER_IDLE_MS = 10 * 60_000;

export interface TypeScriptMailboxWorkerLane<Status> {
  poll(): number;
  status(): Status;
  close(reason?: string): Promise<void>;
}

interface TypeScriptMailboxLaneCommonOptions {
  workerUrl?: URL;
  now?: () => number;
  limits?: Partial<BoundedMailboxLimits>;
  onBusy?(deadlineAtMs: number | undefined): void;
  onFatal(error: Error): void;
  createWorker?(data: unknown): RequestWorkerLike;
}

export interface TypeScriptIndexMailboxLaneOptions extends TypeScriptMailboxLaneCommonOptions {
  paths: TypeScriptIndexMailboxPaths;
  projectRoot: string;
  dbPath: string;
  maxActiveSessions?: number;
  workerIdleMs?: number;
  workerSoftMemoryMb?: number;
}

export interface TypeScriptSemanticMailboxLaneOptions extends TypeScriptMailboxLaneCommonOptions {
  paths: TypeScriptSemanticMailboxPaths;
  projectRoot: string;
}

export function createTypeScriptIndexMailboxLane(
  options: TypeScriptIndexMailboxLaneOptions,
): TypeScriptMailboxWorkerLane<TypeScriptIndexServiceStatus> {
  const maxActiveSessions = options.maxActiveSessions ?? 8;
  const softMemoryLimitMb = options.workerSoftMemoryMb ?? typescriptWorkerSoftMemoryMb();
  const initialStatus = (): TypeScriptIndexServiceStatus => ({
    protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
    state: 'idle',
    requests: 0,
    sessionsCreated: 0,
    sessionsReplaced: 0,
    sessionsEvicted: 0,
    activeSessions: 0,
    maxActiveSessions,
    softMemoryLimitBytes: softMemoryLimitMb * 1024 * 1024,
    retireRequested: false,
    initializations: 0,
    programUpdates: 0,
    documentsEmitted: 0,
    documentsRemoved: 0,
  });
  return createTypeScriptMailboxLane<
    TypeScriptIndexEnvelope,
    TypeScriptIndexDocumentResponse,
    TypeScriptIndexServiceStatus
  >({
    name: 'TypeScript index',
    paths: options.paths,
    now: options.now,
    limits: options.limits,
    initialStatus,
    parseEnvelope: parseTypeScriptIndexEnvelope,
    createWorker: () =>
      createWorker(options, {
        kind: 'index',
        projectRoot: options.projectRoot,
        dbPath: options.dbPath,
        maxActiveSessions,
        softMemoryLimitMb,
      }),
    complete(claim, envelope, response, nowMs) {
      completeBoundedMailboxClaim(
        options.paths,
        claim,
        {
          ok: true,
          protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
          id: envelope.id,
          baseGeneration: envelope.baseGeneration,
          response,
        },
        { nowMs, limits: options.limits },
      );
    },
    reject(claim, id, reason, nowMs) {
      rejectBoundedMailboxClaim(
        options.paths,
        claim,
        {
          ok: false,
          protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
          id,
          error: reason,
        },
        reason,
        { nowMs, limits: options.limits },
      );
    },
    idleTtlMs: options.workerIdleMs ?? TYPESCRIPT_INDEX_MAILBOX_WORKER_IDLE_MS,
    maxWorkerFailureRetries: 1,
    retireAfterResponse: (status) => status.retireRequested === true,
    statusWhenWorkerAbsent: (status) => ({
      ...status,
      state: 'idle',
      activeSessions: 0,
      heapUsedBytes: 0,
      retireRequested: false,
    }),
    onBusy: options.onBusy,
    onFatal: options.onFatal,
  });
}

export function createTypeScriptSemanticMailboxLane(
  options: TypeScriptSemanticMailboxLaneOptions,
): TypeScriptMailboxWorkerLane<TypeScriptSemanticServiceStatus> {
  const initialStatus = (): TypeScriptSemanticServiceStatus => ({
    protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
    state: 'idle',
    requests: 0,
    sessionsCreated: 0,
    sessionsReused: 0,
    sessionsRefreshed: 0,
    sessionsReplaced: 0,
    projectsCreated: 0,
  });
  return createTypeScriptMailboxLane<TypeScriptSemanticMailboxEnvelope, unknown, TypeScriptSemanticServiceStatus>({
    name: 'TypeScript semantic',
    paths: options.paths,
    now: options.now,
    limits: options.limits,
    initialStatus,
    parseEnvelope: parseTypeScriptSemanticEnvelope,
    createWorker: () => createWorker(options, { kind: 'semantic', projectRoot: options.projectRoot }),
    complete(claim, envelope, response, nowMs) {
      completeBoundedMailboxClaim(
        options.paths,
        claim,
        {
          ok: true,
          protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
          id: envelope.id,
          generation: envelope.generation,
          response,
        },
        { nowMs, limits: options.limits },
      );
    },
    reject(claim, id, reason, nowMs) {
      rejectBoundedMailboxClaim(
        options.paths,
        claim,
        {
          ok: false,
          protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
          id,
          error: reason,
        },
        reason,
        { nowMs, limits: options.limits },
      );
    },
    idleTtlMs: TYPESCRIPT_SEMANTIC_MAILBOX_WORKER_IDLE_MS,
    onBusy: options.onBusy,
    onFatal: options.onFatal,
  });
}

interface GenericMailboxLaneOptions<Envelope extends { id: string; deadlineAtMs: number }, Result, Status> {
  name: string;
  paths: TypeScriptIndexMailboxPaths | TypeScriptSemanticMailboxPaths;
  now?: () => number;
  limits?: Partial<BoundedMailboxLimits>;
  idleTtlMs?: number;
  maxWorkerFailureRetries?: number;
  retireAfterResponse?(status: Status): boolean;
  statusWhenWorkerAbsent?(status: Status): Status;
  initialStatus(): Status;
  parseEnvelope(value: string): Envelope;
  createWorker(): RequestWorkerLike;
  complete(claim: BoundedMailboxClaim, envelope: Envelope, result: Result, nowMs: number): void;
  reject(claim: BoundedMailboxClaim, id: string, reason: string, nowMs: number): void;
  onBusy?(deadlineAtMs: number | undefined): void;
  onFatal(error: Error): void;
}

function createTypeScriptMailboxLane<Envelope extends { id: string; deadlineAtMs: number }, Result, Status>(
  options: GenericMailboxLaneOptions<Envelope, Result, Status>,
): TypeScriptMailboxWorkerLane<Status> {
  const now = options.now ?? Date.now;
  const processIdentity = readProcessIdentity(process.pid);
  const owner = {
    pid: process.pid,
    ...(processIdentity ? { processIdentity } : {}),
  };
  const ownerId = `${options.name.toLowerCase().replaceAll(' ', '-')}-${process.pid}-${randomUUID()}`;
  const limits = { ...options.limits, maxBatch: 1 };
  let current: { claim: BoundedMailboxClaim; envelope: Envelope } | null = null;
  let serviceStatus = options.initialStatus();
  let fatal = false;

  const reportFatal = (error: Error): void => {
    fatal = true;
    options.onFatal(error);
  };

  const workerLane = new WorkerRequestLane<Envelope, Result, Status>({
    name: options.name,
    createWorker: options.createWorker,
    now,
    idleTtlMs: options.idleTtlMs,
    maxWorkerFailureRetries: options.maxWorkerFailureRetries,
    retireAfterResponse: options.retireAfterResponse,
    onComplete(request, result, status) {
      const claimed = requireCurrent(request.requestId);
      serviceStatus = status;
      options.complete(claimed.claim, claimed.envelope, result, now());
      releaseCurrent(claimed);
    },
    onReject(request, reason, status) {
      const claimed = requireCurrent(request.requestId);
      if (status !== undefined) serviceStatus = status;
      options.reject(claimed.claim, claimed.envelope.id, reason, now());
      releaseCurrent(claimed);
    },
    onStatus(status) {
      serviceStatus = status;
    },
    onFatal: reportFatal,
  });

  return {
    poll(): number {
      if (fatal || !workerLane.canAccept()) return 0;
      const claim = pollBoundedMailboxRequests(options.paths, {
        ownerId,
        nowMs: now(),
        limits,
        owner,
        liveness: { isProcessAlive, readProcessIdentity },
      })[0];
      if (!claim) return 0;
      let id = claim.requestId;
      try {
        const envelope = options.parseEnvelope(readBoundedMailboxClaim(claim, limits));
        id = envelope.id;
        if (envelope.id !== claim.requestId) {
          throw new Error(`${options.name} request identity does not match its mailbox path.`);
        }
        if (envelope.deadlineAtMs < now()) {
          throw new Error(`${options.name} request expired before processing.`);
        }
        current = { claim, envelope };
        options.onBusy?.(envelope.deadlineAtMs);
        if (!workerLane.start({ requestId: envelope.id, deadlineAtMs: envelope.deadlineAtMs, payload: envelope })) {
          throw new Error(`${options.name} worker lane closed admission after claiming a request.`);
        }
      } catch (error) {
        const reason = errorMessage(error);
        try {
          options.reject(claim, id, reason, now());
          if (current?.claim === claim) releaseCurrent(current);
        } catch (settlementError) {
          reportFatal(asError(settlementError));
        }
      }
      return 1;
    },
    status(): Status {
      return {
        ...((workerLane.hasWorker() || !options.statusWhenWorkerAbsent
          ? serviceStatus
          : options.statusWhenWorkerAbsent(serviceStatus)) as object),
        mailbox: inspectBoundedMailbox(options.paths),
      } as Status;
    },
    async close(reason): Promise<void> {
      await workerLane.close(reason);
    },
  };

  function requireCurrent(requestId: string): { claim: BoundedMailboxClaim; envelope: Envelope } {
    const claimed = current;
    if (!claimed || claimed.envelope.id !== requestId) {
      throw new Error(`${options.name} parent lost the active mailbox claim.`);
    }
    return claimed;
  }

  function releaseCurrent(claimed: { claim: BoundedMailboxClaim; envelope: Envelope }): void {
    if (current !== claimed) return;
    current = null;
    options.onBusy?.(undefined);
  }
}

/**
 * The incremental TypeScript index holds a whole-program type graph inside this
 * worker. Without an explicit limit the worker inherits V8's default old-space
 * cap (~4 GB), which large projects exhaust: the worker dies with "Worker
 * terminated due to reaching memory limit", `tryMaterializeTypeScriptIncrementalIndex`
 * reports it unavailable, and every watch trigger falls back to a whole-project
 * rebuild costing minutes instead of seconds. Match the full indexer's heap
 * budget (`maxHeapMb` in reindex/index.ts) so the incremental path survives the
 * projects it exists to serve.
 */
const DEFAULT_TYPESCRIPT_WORKER_HEAP_MB = 8192;

function typescriptWorkerHeapMb(): number {
  const configured = Number.parseInt(process.env['SCIP_TS_WORKER_HEAP_MB'] ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TYPESCRIPT_WORKER_HEAP_MB;
}

function typescriptWorkerSoftMemoryMb(): number {
  return Math.max(1, Math.floor(typescriptWorkerHeapMb() * 0.7));
}

function createWorker(options: TypeScriptMailboxLaneCommonOptions, workerData: unknown): RequestWorkerLike {
  if (options.createWorker) return options.createWorker(workerData);
  const workerUrl = options.workerUrl ?? new URL('./typescript-mailbox-worker.js', import.meta.url);
  return new Worker(workerUrl, {
    workerData,
    resourceLimits: { maxOldGenerationSizeMb: typescriptWorkerHeapMb() },
  }) as RequestWorkerLike;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
