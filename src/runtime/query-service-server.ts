import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { monotonicNowMs } from '../domain/time.js';
import { readProcessIdentity } from '../platform/process-identity.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import { tryAcquireProcessFileLock } from '../platform/process-file-lock.js';
import { searchSource } from '../queries/navigation/source-search.js';
import {
  boundedMailboxPaths,
  completeBoundedMailboxClaim,
  initializeBoundedMailbox,
  pollBoundedMailboxRequests,
  readBoundedMailboxClaim,
  rejectBoundedMailboxClaim,
  type BoundedMailboxLimits,
} from '../storage/bounded-mailbox.js';
import { writeJsonAtomic, writeJsonDurable } from '../storage/atomic-json.js';
import { openProjectDb } from './cli-context.js';
import { buildObservationReceipt } from './observation-receipt.js';
import {
  QUERY_SERVICE_PROTOCOL_VERSION,
  queryServiceSessionIdentity,
  type QueryServiceEnvelope,
  type QueryServiceServerState,
} from './query-service.js';

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const POLL_INTERVAL_MS = 5;
const MAX_IDLE_POLL_INTERVAL_MS = 100;
const MAILBOX_LIMITS: Partial<BoundedMailboxLimits> = {
  maxItems: 64,
  maxBytes: 128 * 1024 * 1024,
  maxItemBytes: 64 * 1024 * 1024,
  maxBatch: 1,
  responseRetentionMs: 60_000,
};

export async function runQueryServiceServer(sessionDir: string, projectRoot: string): Promise<void> {
  const paths = boundedMailboxPaths(sessionDir);
  initializeBoundedMailbox(paths);
  const lockResult = tryAcquireProcessFileLock(join(sessionDir, 'server.lock'), {
    kind: 'query-service-server',
    detail: { projectRoot: resolve(projectRoot) },
  });
  if (lockResult.kind !== 'acquired') return;

  let db: ReturnType<typeof openProjectDb>;
  try {
    db = openProjectDb(projectRoot);
  } catch (error) {
    lockResult.lock.release();
    throw error;
  }
  const statePath = join(sessionDir, 'server.json');
  const sessionIdentity = queryServiceSessionIdentity(sessionDir);
  const processIdentity = readProcessIdentity(process.pid);
  let stopping = false;
  let stopAfterRequest = false;
  let lastActivityAtMs = monotonicNowMs();
  let lastHeartbeatAtMs = Number.NEGATIVE_INFINITY;
  let consecutiveIdlePolls = 0;
  const stop = (): void => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const writeState = (durable = false): void => {
    const now = monotonicNowMs();
    if (!durable && now - lastHeartbeatAtMs < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeatAtMs = now;
    const state: QueryServiceServerState = {
      protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
      sessionIdentity,
      pid: process.pid,
      ...(processIdentity ? { processIdentity } : {}),
      generation: db.generation.identity,
      heartbeatAtMs: Date.now(),
    };
    if (durable) writeJsonDurable(statePath, state);
    else writeJsonAtomic(statePath, state);
  };

  try {
    writeState(true);
    const idleTimeoutMs = configuredIdleTimeoutMs();
    while (!stopping && !stopAfterRequest && monotonicNowMs() - lastActivityAtMs < idleTimeoutMs) {
      const processed = processRequests(paths, db, sessionIdentity, () => {
        stopAfterRequest = true;
      });
      if (processed > 0) {
        consecutiveIdlePolls = 0;
        lastActivityAtMs = monotonicNowMs();
        writeState();
      } else {
        consecutiveIdlePolls += 1;
        writeState();
      }
      await sleep(loopDelayMs(processed, consecutiveIdlePolls));
    }
  } finally {
    db.close();
    rmSync(statePath, { force: true });
    lockResult.lock.release();
  }
}

function processRequests(
  paths: ReturnType<typeof boundedMailboxPaths>,
  db: ReturnType<typeof openProjectDb>,
  sessionIdentity: string,
  onGenerationMismatch: () => void,
): number {
  const claims = pollBoundedMailboxRequests(paths, {
    ownerId: QUERY_SERVICE_MAILBOX_OWNER,
    nowMs: Date.now(),
    limits: MAILBOX_LIMITS,
    owner: QUERY_SERVICE_MAILBOX_PROCESS_OWNER,
    liveness: QUERY_SERVICE_MAILBOX_LIVENESS,
  });
  let processed = 0;
  for (const claim of claims) {
    let id = claim.requestId;
    try {
      const envelope = parseEnvelope(readBoundedMailboxClaim(claim, MAILBOX_LIMITS), sessionIdentity);
      id = envelope.id;
      if (
        envelope.id !== claim.requestId ||
        envelope.operationKey !== claim.operationKey ||
        envelope.clientId !== claim.clientId ||
        envelope.deadlineAtMs !== claim.deadlineAtMs
      ) {
        throw new Error('Query service request identity does not match its mailbox claim.');
      }
      if (envelope.deadlineAtMs < Date.now()) throw new Error('Query service request expired before processing.');
      if (envelope.request.expectedGeneration !== db.generation.identity) {
        completeBoundedMailboxClaim(
          paths,
          claim,
          {
            ok: false,
            protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
            id,
            generation: db.generation.identity,
            errorCode: 'generation-mismatch',
            error: 'Persistent query service opened a different generation.',
          },
          { nowMs: Date.now(), limits: MAILBOX_LIMITS },
        );
        onGenerationMismatch();
        processed += 1;
        continue;
      }
      const result = searchSource(db, envelope.request.pattern, envelope.request.options);
      const observationReceipt = buildObservationReceipt({
        projectRoot: db.config.projectRoot,
        db,
        observedSourceKinds: ['index-generation'],
      });
      const completedAtMs = Date.now();
      if (envelope.deadlineAtMs < completedAtMs) throw new Error('Query service request expired while processing.');
      completeBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: true,
          protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
          id,
          generation: db.generation.identity,
          result,
          observationReceipt,
        },
        { nowMs: completedAtMs, limits: MAILBOX_LIMITS },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      rejectBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: false,
          protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
          id,
          errorCode: 'request-failed',
          error: reason,
        },
        reason,
        { nowMs: Date.now(), limits: MAILBOX_LIMITS },
      );
    }
    processed += 1;
  }
  return processed;
}

function parseEnvelope(raw: string, expectedSessionIdentity: string): QueryServiceEnvelope {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid query service request.');
  const record = value as Record<string, unknown>;
  const request = record['request'];
  if (
    record['mailboxVersion'] !== 1 ||
    record['protocolVersion'] !== QUERY_SERVICE_PROTOCOL_VERSION ||
    typeof record['id'] !== 'string' ||
    record['id'].length === 0 ||
    typeof record['operationKey'] !== 'string' ||
    record['operationKey'].length === 0 ||
    typeof record['clientId'] !== 'string' ||
    record['clientId'].length === 0 ||
    typeof record['enqueuedAtMs'] !== 'number' ||
    !Number.isSafeInteger(record['enqueuedAtMs']) ||
    record['enqueuedAtMs'] < 0 ||
    typeof record['deadlineAtMs'] !== 'number' ||
    !Number.isSafeInteger(record['deadlineAtMs']) ||
    record['deadlineAtMs'] < record['enqueuedAtMs'] ||
    record['sessionIdentity'] !== expectedSessionIdentity ||
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request)
  ) {
    throw new Error('Invalid query service request envelope.');
  }
  const requestRecord = request as Record<string, unknown>;
  if (
    requestRecord['kind'] !== 'source-search' ||
    typeof requestRecord['expectedGeneration'] !== 'string' ||
    typeof requestRecord['pattern'] !== 'string' ||
    requestRecord['pattern'].length === 0 ||
    !requestRecord['options'] ||
    typeof requestRecord['options'] !== 'object' ||
    Array.isArray(requestRecord['options'])
  ) {
    throw new Error('Invalid query service source-search request.');
  }
  const optionsRecord = requestRecord['options'] as Record<string, unknown>;
  const options = {
    ...(optionsRecord['scope'] === undefined ? {} : { scope: requiredString(optionsRecord['scope'], 'scope') }),
    ...(optionsRecord['context'] === undefined
      ? {}
      : { context: requiredNonNegativeInteger(optionsRecord['context'], 'context') }),
    ...(optionsRecord['limit'] === undefined
      ? {}
      : { limit: requiredPositiveInteger(optionsRecord['limit'], 'limit') }),
    ...(optionsRecord['regexp'] === undefined ? {} : { regexp: requiredBoolean(optionsRecord['regexp'], 'regexp') }),
    ...(optionsRecord['ignoreCase'] === undefined
      ? {}
      : { ignoreCase: requiredBoolean(optionsRecord['ignoreCase'], 'ignoreCase') }),
    ...(optionsRecord['ranking'] === undefined ? {} : { ranking: requiredStructuralRanking(optionsRecord['ranking']) }),
  };
  return {
    mailboxVersion: 1,
    protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
    id: record['id'],
    operationKey: record['operationKey'],
    clientId: record['clientId'],
    enqueuedAtMs: record['enqueuedAtMs'],
    deadlineAtMs: record['deadlineAtMs'],
    sessionIdentity: expectedSessionIdentity,
    request: {
      kind: 'source-search',
      expectedGeneration: requestRecord['expectedGeneration'],
      pattern: requestRecord['pattern'],
      options,
    },
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Query service option ${name} must be a string.`);
  return value;
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Query service option ${name} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Query service option ${name} must be a positive safe integer.`);
  }
  return value as number;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Query service option ${name} must be a boolean.`);
  return value;
}

function requiredStructuralRanking(value: unknown): 'structural' {
  if (value !== 'structural') throw new Error('Query service option ranking must be structural.');
  return value;
}

function configuredIdleTimeoutMs(): number {
  const parsed = Number(process.env['SCIP_QUERY_QUERY_SERVICE_IDLE_MS']);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

function loopDelayMs(processedRequests: number, consecutiveIdlePolls: number): number {
  if (processedRequests > 0) return POLL_INTERVAL_MS;
  const exponent = Math.max(0, Math.min(5, consecutiveIdlePolls - 1));
  return Math.min(MAX_IDLE_POLL_INTERVAL_MS, POLL_INTERVAL_MS * 2 ** exponent);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
}

const QUERY_SERVICE_MAILBOX_OWNER = `query-service-${process.pid}-${randomUUID()}`;
const QUERY_SERVICE_PROCESS_IDENTITY = readProcessIdentity(process.pid);
const QUERY_SERVICE_MAILBOX_PROCESS_OWNER = {
  pid: process.pid,
  ...(QUERY_SERVICE_PROCESS_IDENTITY ? { processIdentity: QUERY_SERVICE_PROCESS_IDENTITY } : {}),
};
const QUERY_SERVICE_MAILBOX_LIVENESS = { isProcessAlive, readProcessIdentity };

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const sessionDir = process.argv[2];
  const projectRoot = process.argv[3];
  if (!sessionDir || !projectRoot) {
    console.error('query-service: expected <session-dir> <project-root>');
    process.exitCode = 1;
  } else {
    await runQueryServiceServer(sessionDir, projectRoot);
  }
}
