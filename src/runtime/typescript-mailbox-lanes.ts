import { totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { readTextFileWithinLimit, SMALL_ARTIFACT_MAX_BYTES } from '../filesystem/bounded-file.js';
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
  MailboxBackpressureError,
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
  workerHeapMb?: number;
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
  workerSoftMemoryMb?: number;
}

export function createTypeScriptIndexMailboxLane(
  options: TypeScriptIndexMailboxLaneOptions,
): TypeScriptMailboxWorkerLane<TypeScriptIndexServiceStatus> {
  const maxActiveSessions = options.maxActiveSessions ?? 8;
  const softMemoryLimitMb = options.workerSoftMemoryMb ?? typescriptWorkerSoftMemoryMb(options.workerHeapMb);
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

// scip-query: ignore-similar — semantic and index lanes share the generic executor but own distinct protocols and status state.
export function createTypeScriptSemanticMailboxLane(
  options: TypeScriptSemanticMailboxLaneOptions,
): TypeScriptMailboxWorkerLane<TypeScriptSemanticServiceStatus> {
  const softMemoryLimitMb = options.workerSoftMemoryMb ?? typescriptWorkerSoftMemoryMb(options.workerHeapMb);
  const initialStatus = (): TypeScriptSemanticServiceStatus => ({
    protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
    state: 'idle',
    requests: 0,
    sessionsCreated: 0,
    sessionsReused: 0,
    sessionsRefreshed: 0,
    sessionsReplaced: 0,
    projectsCreated: 0,
    softMemoryLimitBytes: softMemoryLimitMb * 1024 * 1024,
    retireRequested: false,
  });
  return createTypeScriptMailboxLane<TypeScriptSemanticMailboxEnvelope, unknown, TypeScriptSemanticServiceStatus>({
    name: 'TypeScript semantic',
    paths: options.paths,
    now: options.now,
    limits: options.limits,
    initialStatus,
    parseEnvelope: parseTypeScriptSemanticEnvelope,
    createWorker: () =>
      createWorker(options, { kind: 'semantic', projectRoot: options.projectRoot, softMemoryLimitMb }),
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
    // A worker that died mid-request restarts once for the next request; with
    // lazily loaded compiler projects it comes back holding only what that
    // request needs. Above the soft mark the worker is retired after its
    // response for the same reason.
    maxWorkerFailureRetries: 1,
    retireAfterResponse: (status) => status.retireRequested === true,
    statusWhenWorkerAbsent: (status) => ({ ...status, state: 'idle', heapUsedBytes: 0, retireRequested: false }),
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
      const completedAtMs = now();
      try {
        options.complete(claimed.claim, claimed.envelope, result, completedAtMs);
      } catch (error) {
        if (!(error instanceof MailboxBackpressureError)) throw error;
        // Backpressure on one completion sheds that response, never the
        // service: publish a small terminal rejection so a live requester
        // fails fast, and when even that cannot be written, drop the claim —
        // the requester times out at its own deadline and retries.
        try {
          options.reject(claimed.claim, claimed.envelope.id, error.message, completedAtMs);
        } catch (rejectError) {
          if (!(rejectError instanceof MailboxBackpressureError)) throw rejectError;
          rmSync(claimed.claim.path, { force: true });
        }
      }
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
 * A large repository can need more than 4 GB just to retain one compiler
 * graph. This is a ceiling, not a reservation; the 90% soft mark retires the
 * worker before the 6 GB hard limit, still below the full indexer's 8+ GB path.
 */
const DEFAULT_TYPESCRIPT_WORKER_HEAP_MB = 6144;

function typescriptWorkerHeapMb(): number {
  const configured = Number.parseInt(process.env['SCIP_TS_WORKER_HEAP_MB'] ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TYPESCRIPT_WORKER_HEAP_MB;
}

/** Retaining one compiler graph costs about this much per indexed document on top of a fixed base. */
const TYPESCRIPT_WORKER_HEAP_BASE_MB = 2_560;
const TYPESCRIPT_WORKER_HEAP_PER_DOCUMENT_MB = 1.25;
/** Never hand a worker more than this share of the machine, whatever the project size. */
const TYPESCRIPT_WORKER_HEAP_MACHINE_SHARE = 0.6;

/**
 * A heap ceiling sized to the project: the default fits a few thousand
 * documents, and a larger repository dies mid-request at the default instead
 * of answering. The environment override and the project configuration still
 * win over this estimate.
 */
export function recommendedTypeScriptWorkerHeapMb(
  documents: number,
  totalMemoryBytes = availableMemoryBytes(),
): number {
  const configured = Number.parseInt(process.env['SCIP_TS_WORKER_HEAP_MB'] ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const estimate = Math.ceil(TYPESCRIPT_WORKER_HEAP_BASE_MB + documents * TYPESCRIPT_WORKER_HEAP_PER_DOCUMENT_MB);
  const machineCeiling = Math.floor((totalMemoryBytes * TYPESCRIPT_WORKER_HEAP_MACHINE_SHARE) / (1024 * 1024));
  return Math.max(DEFAULT_TYPESCRIPT_WORKER_HEAP_MB, Math.min(estimate, machineCeiling));
}

/**
 * The memory this process may actually use: physical memory, lowered to the
 * cgroup limit when the process runs inside a container. A worker sized to
 * the host alone is killed by the kernel instead of reporting a heap limit.
 */
export function availableMemoryBytes(
  readFile: (path: string) => string | null = readCgroupFile,
  physicalBytes = totalmem(),
): number {
  const limits = [readFile('/sys/fs/cgroup/memory.max'), readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes')]
    .map((raw) => (raw === null ? Number.NaN : Number.parseInt(raw.trim(), 10)))
    // "max" (v2) parses to NaN; the v1 unlimited sentinel is far above any real machine.
    .filter((value) => Number.isFinite(value) && value > 0 && value < physicalBytes);
  return limits.length > 0 ? Math.min(...limits) : physicalBytes;
}

function readCgroupFile(path: string): string | null {
  try {
    return readTextFileWithinLimit(path, { maxBytes: SMALL_ARTIFACT_MAX_BYTES, inputKind: 'cgroup memory limit' });
  } catch {
    return null;
  }
}

function typescriptWorkerSoftMemoryMb(configuredHeapMb?: number): number {
  return Math.max(1, Math.floor((configuredHeapMb ?? typescriptWorkerHeapMb()) * 0.9));
}

function createWorker(options: TypeScriptMailboxLaneCommonOptions, workerData: unknown): RequestWorkerLike {
  if (options.createWorker) return options.createWorker(workerData);
  const workerUrl = options.workerUrl ?? new URL('./typescript-mailbox-worker.js', import.meta.url);
  return new Worker(workerUrl, {
    workerData,
    resourceLimits: { maxOldGenerationSizeMb: options.workerHeapMb ?? typescriptWorkerHeapMb() },
  }) as RequestWorkerLike;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
