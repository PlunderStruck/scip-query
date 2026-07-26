import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { syncDirectoryDurable } from './atomic-file.js';
import { writeJsonDurable } from './atomic-json.js';
import { isValidRecordTimestamp } from '../domain/record-validation.js';

export const WATCH_REFRESH_REQUEST_PROTOCOL_VERSION = 1;
export const WATCH_REFRESH_REQUEST_DEFAULT_TTL_MS = 10 * 60_000;
export const WATCH_REFRESH_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;

const REQUESTS_DIRECTORY = 'requests';
const CLAIMS_DIRECTORY = 'claims';
const COMPLETIONS_DIRECTORY = 'completions';
const STAGING_DIRECTORY = 'staging';

export interface WatchRefreshRequest {
  version: typeof WATCH_REFRESH_REQUEST_PROTOCOL_VERSION;
  requestId: string;
  idempotencyKey?: string;
  createdAt: string;
  deadlineAt: string;
  detail: string;
}

export interface WatchRefreshClaim {
  version: typeof WATCH_REFRESH_REQUEST_PROTOCOL_VERSION;
  requestId: string;
  claimId: string;
  claimedAt: string;
}

export interface WatchRefreshCompletion {
  version: typeof WATCH_REFRESH_REQUEST_PROTOCOL_VERSION;
  requestId: string;
  claimId?: string;
  outcome: 'completed' | 'expired';
  completedAt: string;
}

export interface WatchRefreshClaimBatch {
  claimId: string;
  requests: WatchRefreshRequest[];
}

export interface WatchRefreshRequestStatus {
  pending: number;
  claimed: number;
  completed: number;
  expired: number;
  invalid: number;
  oldestPendingAt?: string;
}

export interface EnqueueWatchRefreshRequestOptions {
  idempotencyKey?: string;
  ttlMs?: number;
  now?: () => Date;
  randomId?: () => string;
  onStage?: (stage: 'after-staged' | 'after-published') => void;
}

export type EnqueueWatchRefreshRequestResult =
  | { disposition: 'accepted'; request: WatchRefreshRequest }
  | { disposition: 'duplicate'; request: WatchRefreshRequest };

/**
 * Admits one immutable refresh intent. The stable request path is never moved:
 * that makes its identity an idempotency anchor while separate claim and
 * completion records describe processing progress.
 */
export function enqueueWatchRefreshRequest(
  root: string,
  detail: string,
  options: EnqueueWatchRefreshRequestOptions = {},
): EnqueueWatchRefreshRequestResult {
  const now = options.now?.() ?? new Date();
  const ttlMs = normalizeTtl(options.ttlMs);
  const idempotencyKey = normalizedOptionalString(options.idempotencyKey);
  const requestId = idempotencyKey
    ? `key-${createHash('sha256').update(idempotencyKey).digest('hex')}`
    : `request-${(options.randomId ?? randomUUID)()}`;
  const request: WatchRefreshRequest = {
    version: WATCH_REFRESH_REQUEST_PROTOCOL_VERSION,
    requestId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    createdAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + ttlMs).toISOString(),
    detail: detail.trim().slice(0, 2_048) || 'stale index observed by a command',
  };
  const path = requestPath(root, requestId);
  const published = publishImmutableJson(root, path, request, options.onStage);
  if (published) return { disposition: 'accepted', request };
  const existing = readWatchRefreshRequest(path);
  if (!existing) {
    throw new Error(`Watch refresh request identity ${requestId} exists but is malformed.`);
  }
  return { disposition: 'duplicate', request: existing };
}

/**
 * Claims pending requests with one batch identity. Each exclusive claim file
 * is an atomic compare-and-set; another consumer can claim neither the same
 * request nor a completed request.
 */
export function claimWatchRefreshRequests(
  root: string,
  options: { now?: () => Date; randomId?: () => string; limit?: number } = {},
): WatchRefreshClaimBatch {
  const now = options.now?.() ?? new Date();
  const claimId = `claim-${(options.randomId ?? randomUUID)()}`;
  const limit = Math.max(1, Math.floor(options.limit ?? 64));
  const requests = listRequests(root).sort(compareRequests);
  const claimed: WatchRefreshRequest[] = [];
  for (const request of requests) {
    if (claimed.length >= limit) break;
    if (completionExists(root, request.requestId)) continue;
    if (Date.parse(request.deadlineAt) <= now.getTime()) {
      publishCompletion(root, {
        version: WATCH_REFRESH_REQUEST_PROTOCOL_VERSION,
        requestId: request.requestId,
        outcome: 'expired',
        completedAt: now.toISOString(),
      });
      continue;
    }
    const claim: WatchRefreshClaim = {
      version: WATCH_REFRESH_REQUEST_PROTOCOL_VERSION,
      requestId: request.requestId,
      claimId,
      claimedAt: now.toISOString(),
    };
    if (!publishImmutableJson(root, claimPath(root, request.requestId), claim)) continue;
    if (completionExists(root, request.requestId)) {
      removeClaim(root, request.requestId, claimId);
      continue;
    }
    claimed.push(request);
  }
  return { claimId, requests: claimed };
}

/** Acknowledges a successful refresh before releasing the corresponding claims. */
export function completeWatchRefreshClaim(
  root: string,
  batch: WatchRefreshClaimBatch,
  now: () => Date = () => new Date(),
  onStage?: (stage: 'after-completion' | 'after-claim-release') => void,
): void {
  const completedAt = now().toISOString();
  for (const request of batch.requests) {
    publishCompletion(root, {
      version: WATCH_REFRESH_REQUEST_PROTOCOL_VERSION,
      requestId: request.requestId,
      claimId: batch.claimId,
      outcome: 'completed',
      completedAt,
    });
  }
  onStage?.('after-completion');
  releaseWatchRefreshClaim(root, batch);
  onStage?.('after-claim-release');
}

/** Releases a failed attempt without acknowledging its durable requests. */
export function releaseWatchRefreshClaim(root: string, batch: WatchRefreshClaimBatch): void {
  for (const request of batch.requests) removeClaim(root, request.requestId, batch.claimId);
}

/**
 * Called only after the new watch owner holds the service lock. Claims left by
 * its predecessor are removed; completed requests remain acknowledged and
 * uncompleted requests become pending again.
 */
export function recoverWatchRefreshClaims(root: string): number {
  let recovered = 0;
  for (const path of jsonFiles(join(root, CLAIMS_DIRECTORY))) {
    rmSync(path, { force: true });
    recovered++;
  }
  if (recovered > 0) syncDirectoryDurable(join(root, CLAIMS_DIRECTORY));
  cleanupStaging(root);
  return recovered;
}

export function inspectWatchRefreshRequests(root: string): WatchRefreshRequestStatus {
  const requests = listRequests(root);
  const completions = new Map<string, WatchRefreshCompletion>();
  let invalid = invalidJsonCount(join(root, REQUESTS_DIRECTORY), readWatchRefreshRequest);
  for (const path of jsonFiles(join(root, COMPLETIONS_DIRECTORY))) {
    const completion = readWatchRefreshCompletion(path);
    if (!completion) {
      invalid++;
      continue;
    }
    completions.set(completion.requestId, completion);
  }
  const claims = new Set<string>();
  for (const path of jsonFiles(join(root, CLAIMS_DIRECTORY))) {
    const claim = readWatchRefreshClaim(path);
    if (!claim) {
      invalid++;
      continue;
    }
    claims.add(claim.requestId);
  }
  const pendingRequests = requests.filter(
    (request) => !completions.has(request.requestId) && !claims.has(request.requestId),
  );
  const completed = [...completions.values()].filter((completion) => completion.outcome === 'completed').length;
  const expired = [...completions.values()].filter((completion) => completion.outcome === 'expired').length;
  return {
    pending: pendingRequests.length,
    claimed: requests.filter((request) => !completions.has(request.requestId) && claims.has(request.requestId)).length,
    completed,
    expired,
    invalid,
    ...(pendingRequests.length > 0
      ? {
          oldestPendingAt: pendingRequests
            .map((request) => request.createdAt)
            .reduce((oldest, createdAt) => minTimestamp(oldest, createdAt)),
        }
      : {}),
  };
}

/**
 * Bounds operational history while preserving every pending or claimed
 * request. Idempotency keys remain authoritative for the retention window.
 */
export function pruneWatchRefreshHistory(
  root: string,
  options: { now?: () => Date; retentionMs?: number } = {},
): number {
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const retentionMs = Math.max(0, options.retentionMs ?? WATCH_REFRESH_HISTORY_RETENTION_MS);
  let removed = 0;
  for (const path of jsonFiles(join(root, COMPLETIONS_DIRECTORY))) {
    const completion = readWatchRefreshCompletion(path);
    if (!completion || nowMs - Date.parse(completion.completedAt) < retentionMs) continue;
    rmSync(path, { force: true });
    rmSync(requestPath(root, completion.requestId), { force: true });
    removed++;
  }
  if (removed > 0) {
    syncDirectoryDurable(join(root, COMPLETIONS_DIRECTORY));
    syncDirectoryDurable(join(root, REQUESTS_DIRECTORY));
  }
  cleanupStaging(root);
  return removed;
}

export function readWatchRefreshRequest(path: string): WatchRefreshRequest | null {
  return parseJson(path, (value): value is WatchRefreshRequest => {
    const request = value as Partial<WatchRefreshRequest>;
    return (
      request.version === WATCH_REFRESH_REQUEST_PROTOCOL_VERSION &&
      validId(request.requestId) &&
      (request.idempotencyKey === undefined || typeof request.idempotencyKey === 'string') &&
      isValidRecordTimestamp(request.createdAt) &&
      isValidRecordTimestamp(request.deadlineAt) &&
      Date.parse(request.deadlineAt) >= Date.parse(request.createdAt) &&
      typeof request.detail === 'string' &&
      request.detail.length > 0
    );
  });
}

function readWatchRefreshClaim(path: string): WatchRefreshClaim | null {
  return parseJson(path, (value): value is WatchRefreshClaim => {
    const claim = value as Partial<WatchRefreshClaim>;
    return (
      claim.version === WATCH_REFRESH_REQUEST_PROTOCOL_VERSION &&
      validId(claim.requestId) &&
      validId(claim.claimId) &&
      isValidRecordTimestamp(claim.claimedAt)
    );
  });
}

function readWatchRefreshCompletion(path: string): WatchRefreshCompletion | null {
  return parseJson(path, (value): value is WatchRefreshCompletion => {
    const completion = value as Partial<WatchRefreshCompletion>;
    return (
      completion.version === WATCH_REFRESH_REQUEST_PROTOCOL_VERSION &&
      validId(completion.requestId) &&
      (completion.claimId === undefined || validId(completion.claimId)) &&
      (completion.outcome === 'completed' || completion.outcome === 'expired') &&
      isValidRecordTimestamp(completion.completedAt)
    );
  });
}

function publishCompletion(root: string, completion: WatchRefreshCompletion): void {
  const path = completionPath(root, completion.requestId);
  if (publishImmutableJson(root, path, completion)) return;
  const existing = readWatchRefreshCompletion(path);
  if (!existing || existing.requestId !== completion.requestId || existing.outcome !== completion.outcome) {
    throw new Error(`Watch refresh completion ${completion.requestId} conflicts with an existing record.`);
  }
}

function publishImmutableJson(
  root: string,
  targetPath: string,
  value: unknown,
  onStage?: (stage: 'after-staged' | 'after-published') => void,
): boolean {
  const staging = join(root, STAGING_DIRECTORY);
  const parent = dirname(targetPath);
  mkdirSync(staging, { recursive: true });
  mkdirSync(parent, { recursive: true });
  const temporaryPath = join(staging, `${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeJsonDurable(temporaryPath, value, { spacing: 2, trailingNewline: true });
    onStage?.('after-staged');
    try {
      linkSync(temporaryPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    syncDirectoryDurable(parent);
    onStage?.('after-published');
    return true;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function listRequests(root: string): WatchRefreshRequest[] {
  const requests: WatchRefreshRequest[] = [];
  for (const path of jsonFiles(join(root, REQUESTS_DIRECTORY))) {
    const request = readWatchRefreshRequest(path);
    if (request) requests.push(request);
  }
  return requests;
}

function removeClaim(root: string, requestId: string, expectedClaimId: string): void {
  const path = claimPath(root, requestId);
  const claim = readWatchRefreshClaim(path);
  if (!claim || claim.claimId !== expectedClaimId) return;
  rmSync(path, { force: true });
  syncDirectoryDurable(join(root, CLAIMS_DIRECTORY));
}

function cleanupStaging(root: string): void {
  for (const path of jsonFiles(join(root, STAGING_DIRECTORY), '.tmp')) rmSync(path, { force: true });
}

function invalidJsonCount<T>(directory: string, reader: (path: string) => T | null): number {
  return jsonFiles(directory).filter((path) => !reader(path)).length;
}

function jsonFiles(directory: string, suffix = '.json'): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function parseJson<T>(path: string, valid: (value: unknown) => value is T): T | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}

function requestPath(root: string, requestId: string): string {
  return join(root, REQUESTS_DIRECTORY, `${requestId}.json`);
}

function claimPath(root: string, requestId: string): string {
  return join(root, CLAIMS_DIRECTORY, `${requestId}.json`);
}

function completionPath(root: string, requestId: string): string {
  return join(root, COMPLETIONS_DIRECTORY, `${requestId}.json`);
}

function completionExists(root: string, requestId: string): boolean {
  return readWatchRefreshCompletion(completionPath(root, requestId)) !== null;
}

function normalizeTtl(value: number | undefined): number {
  if (value === undefined) return WATCH_REFRESH_REQUEST_DEFAULT_TTL_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error('Watch refresh request ttlMs must be positive.');
  return Math.floor(value);
}

function normalizedOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 512) : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/i.test(value);
}

function compareRequests(left: WatchRefreshRequest, right: WatchRefreshRequest): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.requestId.localeCompare(right.requestId);
}

function minTimestamp(current: string, candidate: string): string {
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}
