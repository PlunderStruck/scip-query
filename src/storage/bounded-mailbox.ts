import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { stableJson } from '../domain/stable-json.js';
import { createFileAtomicExclusive, syncDirectoryDurable } from './atomic-file.js';
import { writeJsonDurable } from './atomic-json.js';

export const BOUNDED_MAILBOX_VERSION = 1;

export interface BoundedMailboxPaths {
  rootDir: string;
  pendingDir: string;
  inflightDir: string;
  responseDir: string;
  deadLetterDir: string;
  /** Flat pre-v1 request directory read during the compatibility window. */
  legacyRequestDir: string;
}

export interface BoundedMailboxRequestIdentity {
  mailboxVersion: typeof BOUNDED_MAILBOX_VERSION;
  id: string;
  operationKey: string;
  clientId: string;
  enqueuedAtMs: number;
  deadlineAtMs: number;
}

export interface BoundedMailboxLimits {
  maxItems: number;
  maxBytes: number;
  maxItemBytes: number;
  maxBatch: number;
  claimLeaseMs: number;
  admissionCreationGraceMs: number;
  responseRetentionMs: number;
  deadLetterRetentionMs: number;
  temporaryRetentionMs: number;
  cleanupBatch: number;
}

export const DEFAULT_BOUNDED_MAILBOX_LIMITS: Readonly<BoundedMailboxLimits> = Object.freeze({
  maxItems: 1_024,
  maxBytes: 512 * 1024 * 1024,
  maxItemBytes: 64 * 1024 * 1024,
  maxBatch: 16,
  claimLeaseMs: 5 * 60_000,
  admissionCreationGraceMs: 5_000,
  responseRetentionMs: 10 * 60_000,
  deadLetterRetentionMs: 24 * 60 * 60_000,
  temporaryRetentionMs: 60_000,
  cleanupBatch: 64,
});

export type MailboxBackpressureCode = 'item-too-large' | 'item-capacity' | 'byte-capacity' | 'admission-busy';

export class MailboxBackpressureError extends Error {
  constructor(
    readonly code: MailboxBackpressureCode,
    readonly status: BoundedMailboxStatus,
    readonly limits: BoundedMailboxLimits,
    readonly attemptedBytes: number,
  ) {
    const detail =
      code === 'item-too-large'
        ? `request is ${attemptedBytes} bytes; per-item limit is ${limits.maxItemBytes}`
        : code === 'item-capacity'
          ? `mailbox has ${status.totalItems} retained items; limit is ${limits.maxItems}`
          : code === 'byte-capacity'
            ? `mailbox retains ${status.totalBytes} bytes and the request adds ${attemptedBytes}; limit is ${limits.maxBytes}`
            : 'another writer held the admission coordinator through the bounded wait';
    super(`Mailbox backpressure: ${detail}. Retry after the service drains or expires retained work.`);
    this.name = 'MailboxBackpressureError';
  }
}

export interface BoundedMailboxClaim {
  requestId: string;
  ownerId: string;
  path: string;
  originalFile: string;
  claimedAtMs: number;
  claimExpiresAtMs: number;
  byteLength: number;
  operationKey?: string;
  clientId?: string;
  enqueuedAtMs?: number;
  deadlineAtMs?: number;
  legacy: boolean;
}

export interface BoundedMailboxStatus {
  pending: number;
  inflight: number;
  responses: number;
  deadLetters: number;
  invalid: number;
  totalItems: number;
  totalBytes: number;
  oldestPendingAt?: string;
}

export interface MailboxMaintenanceResult {
  reclaimed: number;
  completedClaimsRemoved: number;
  responsesRemoved: number;
  deadLettersRemoved: number;
  temporaryFilesRemoved: number;
}

export type EnqueueBoundedMailboxResult =
  | { disposition: 'accepted'; requestId: string; responsePath: string }
  | { disposition: 'duplicate'; requestId: string; responsePath: string };

interface RequestHeader {
  id: string;
  operationKey?: string;
  clientId?: string;
  enqueuedAtMs?: number;
  deadlineAtMs?: number;
}

interface PendingCandidate {
  path: string;
  originalFile: string;
  header: RequestHeader;
  byteLength: number;
  orderAtMs: number;
  legacy: boolean;
}

export function boundedMailboxPaths(rootDir: string): BoundedMailboxPaths {
  return {
    rootDir,
    pendingDir: join(rootDir, 'pending'),
    inflightDir: join(rootDir, 'inflight'),
    responseDir: join(rootDir, 'responses'),
    deadLetterDir: join(rootDir, 'dead-letter'),
    legacyRequestDir: join(rootDir, 'requests'),
  };
}

export function resolveBoundedMailboxLimits(overrides: Partial<BoundedMailboxLimits> = {}): BoundedMailboxLimits {
  const limits = { ...DEFAULT_BOUNDED_MAILBOX_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`Mailbox limit ${key} must be a positive integer.`);
    }
  }
  return limits;
}

export function initializeBoundedMailbox(paths: BoundedMailboxPaths): void {
  for (const path of [
    paths.pendingDir,
    paths.inflightDir,
    paths.responseDir,
    paths.deadLetterDir,
    paths.legacyRequestDir,
  ]) {
    mkdirSync(path, { recursive: true });
  }
}

/**
 * Derives the stable identity of a logical operation. Equal namespace/payload
 * pairs converge on one request and one retained completion across retries.
 */
export function boundedMailboxOperationKey(namespace: string, payload: unknown): string {
  return createHash('sha256').update(stableJson({ namespace, payload })).digest('hex');
}

export function boundedMailboxRequestId(operationKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(operationKey)) {
    throw new Error('Mailbox operation keys must be lowercase SHA-256 identities.');
  }
  return `op-${operationKey}`;
}

/**
 * Publishes one immutable request after enforcing retained item and byte
 * quotas. A concurrent or retried publication of the same operation is a
 * duplicate, never a replacement.
 */
export function enqueueBoundedMailboxRequest(
  paths: BoundedMailboxPaths,
  request: BoundedMailboxRequestIdentity & Record<string, unknown>,
  options: {
    limits?: Partial<BoundedMailboxLimits>;
    nowMs?: number;
    onBeforePublish?: () => void;
    admissionLockTimeoutMs?: number;
  } = {},
): EnqueueBoundedMailboxResult {
  const limits = resolveBoundedMailboxLimits(options.limits);
  const nowMs = options.nowMs ?? Date.now();
  initializeBoundedMailbox(paths);
  validateRequestIdentity(request);
  return withMailboxAdmissionLock(paths, limits, options.admissionLockTimeoutMs ?? 2_000, () => {
    maintainBoundedMailboxUnlocked(paths, nowMs, limits);
    const requestPath = join(paths.pendingDir, `${request.id}.json`);
    const responsePath = join(paths.responseDir, `${request.id}.json`);
    const existing = existingOperation(paths, request.id);
    if (existing) {
      assertMatchingOperation(existing, request.operationKey, request.id);
      return { disposition: 'duplicate', requestId: request.id, responsePath };
    }
    const serialized = `${JSON.stringify(request)}\n`;
    const requestBytes = Buffer.byteLength(serialized);
    const status = inspectBoundedMailbox(paths);
    if (requestBytes > limits.maxItemBytes) {
      throw new MailboxBackpressureError('item-too-large', status, limits, requestBytes);
    }
    if (status.totalItems + 1 > limits.maxItems) {
      throw new MailboxBackpressureError('item-capacity', status, limits, requestBytes);
    }
    if (status.totalBytes + requestBytes > limits.maxBytes) {
      throw new MailboxBackpressureError('byte-capacity', status, limits, requestBytes);
    }
    options.onBeforePublish?.();
    try {
      createFileAtomicExclusive(requestPath, serialized, { durability: 'durable' });
      return { disposition: 'accepted', requestId: request.id, responsePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const competing = existingOperation(paths, request.id);
      if (!competing) throw error;
      assertMatchingOperation(competing, request.operationKey, request.id);
      return { disposition: 'duplicate', requestId: request.id, responsePath };
    }
  });
}

/**
 * Atomically transfers pending files into an owner-specific inflight
 * directory. Work is ordered by enqueue time and bounded so the outer service
 * loop always regains control for heartbeat and maintenance work.
 */
export function claimBoundedMailboxRequests(
  paths: BoundedMailboxPaths,
  options: {
    ownerId: string;
    nowMs?: number;
    limits?: Partial<BoundedMailboxLimits>;
  },
): BoundedMailboxClaim[] {
  if (!options.ownerId.trim()) throw new Error('Mailbox claim owner identity is required.');
  const nowMs = options.nowMs ?? Date.now();
  const limits = resolveBoundedMailboxLimits(options.limits);
  initializeBoundedMailbox(paths);
  try {
    return withMailboxAdmissionLock(paths, limits, 2_000, () =>
      claimBoundedMailboxRequestsUnlocked(paths, options.ownerId, nowMs, limits),
    );
  } catch (error) {
    if (error instanceof MailboxBackpressureError && error.code === 'admission-busy') return [];
    throw error;
  }
}

function claimBoundedMailboxRequestsUnlocked(
  paths: BoundedMailboxPaths,
  ownerId: string,
  nowMs: number,
  limits: BoundedMailboxLimits,
): BoundedMailboxClaim[] {
  maintainBoundedMailboxUnlocked(paths, nowMs, limits);
  const ownerDirectory = join(paths.inflightDir, encodeSegment(ownerId));
  mkdirSync(ownerDirectory, { recursive: true });
  const candidates = [
    ...pendingCandidates(paths.pendingDir, false),
    ...pendingCandidates(paths.legacyRequestDir, true),
  ].sort(
    (left, right) =>
      left.orderAtMs - right.orderAtMs ||
      left.header.id.localeCompare(right.header.id) ||
      left.path.localeCompare(right.path),
  );
  const claims: BoundedMailboxClaim[] = [];
  for (const candidate of candidates) {
    if (claims.length >= limits.maxBatch) break;
    const responsePath = join(paths.responseDir, `${candidate.header.id}.json`);
    if (existsSync(responsePath)) {
      rmSync(candidate.path, { force: true });
      continue;
    }
    const claimExpiresAtMs = Math.max(nowMs + limits.claimLeaseMs, (candidate.header.deadlineAtMs ?? nowMs) + 5_000);
    const claimFile = `${encodeSegment(candidate.originalFile)}.${claimExpiresAtMs}.claim`;
    const claimPath = join(ownerDirectory, claimFile);
    try {
      renameSync(candidate.path, claimPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EEXIST') continue;
      throw error;
    }
    syncDirectoryDurable(dirname(candidate.path));
    syncDirectoryDurable(ownerDirectory);
    claims.push({
      requestId: candidate.header.id,
      ownerId,
      path: claimPath,
      originalFile: candidate.originalFile,
      claimedAtMs: nowMs,
      claimExpiresAtMs,
      byteLength: candidate.byteLength,
      ...(candidate.header.operationKey ? { operationKey: candidate.header.operationKey } : {}),
      ...(candidate.header.clientId ? { clientId: candidate.header.clientId } : {}),
      ...(candidate.header.enqueuedAtMs === undefined ? {} : { enqueuedAtMs: candidate.header.enqueuedAtMs }),
      ...(candidate.header.deadlineAtMs === undefined ? {} : { deadlineAtMs: candidate.header.deadlineAtMs }),
      legacy: candidate.legacy,
    });
  }
  return claims;
}

export function readBoundedMailboxClaim(
  claim: BoundedMailboxClaim,
  limits: Partial<BoundedMailboxLimits> = {},
): string {
  const resolved = resolveBoundedMailboxLimits(limits);
  if (claim.byteLength > resolved.maxItemBytes) {
    throw new MailboxBackpressureError(
      'item-too-large',
      {
        pending: 0,
        inflight: 1,
        responses: 0,
        deadLetters: 0,
        invalid: 0,
        totalItems: 1,
        totalBytes: claim.byteLength,
      },
      resolved,
      claim.byteLength,
    );
  }
  return readFileSync(claim.path, 'utf8');
}

/**
 * Publishes a retained completion before releasing the claim. Exclusive
 * publication makes the first completion authoritative if an expired claim is
 * reclaimed while an old owner is still finishing.
 */
export function completeBoundedMailboxClaim(
  paths: BoundedMailboxPaths,
  claim: BoundedMailboxClaim,
  response: Record<string, unknown>,
  options: {
    nowMs?: number;
    limits?: Partial<BoundedMailboxLimits>;
    /** @internal deterministic crash-after-publication test boundary. */
    onAfterResponsePublished?: () => void;
  } = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  const limits = resolveBoundedMailboxLimits(options.limits);
  const value = {
    ...response,
    mailboxVersion: BOUNDED_MAILBOX_VERSION,
    operationKey: claim.operationKey ?? `legacy-${claim.requestId}`,
    clientId: claim.clientId ?? 'legacy',
    completedAtMs: nowMs,
    expiresAtMs: nowMs + limits.responseRetentionMs,
  };
  const responseBytes = Buffer.byteLength(`${JSON.stringify(value)}\n`);
  const status = inspectBoundedMailbox(paths);
  if (responseBytes > limits.maxItemBytes) {
    throw new MailboxBackpressureError('item-too-large', status, limits, responseBytes);
  }
  const nextTotalBytes = Math.max(0, status.totalBytes - claim.byteLength) + responseBytes;
  if (nextTotalBytes > limits.maxBytes && nextTotalBytes > status.totalBytes) {
    throw new MailboxBackpressureError('byte-capacity', status, limits, responseBytes);
  }
  publishCompletion(paths, claim, value);
  options.onAfterResponsePublished?.();
  rmSync(claim.path, { force: true });
  const claimDirectory = dirname(claim.path);
  syncDirectoryDurable(existsSync(claimDirectory) ? claimDirectory : paths.inflightDir);
}

/** Records an explicit rejection response and retains the rejected input. */
export function rejectBoundedMailboxClaim(
  paths: BoundedMailboxPaths,
  claim: BoundedMailboxClaim,
  response: Record<string, unknown>,
  reason: string,
  options: { nowMs?: number; limits?: Partial<BoundedMailboxLimits> } = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  const limits = resolveBoundedMailboxLimits(options.limits);
  completeBoundedMailboxClaim(paths, claim, response, { ...options, nowMs, limits });
  if (!existsSync(claim.path)) {
    // The explicit response is authoritative. A bounded diagnostic record
    // retains why the input entered the rejected state.
    const rejectionPath = join(
      paths.deadLetterDir,
      `${safeRequestId(claim.requestId)}.${nowMs}.${createHash('sha256').update(reason).digest('hex').slice(0, 12)}.json`,
    );
    const rejection = {
      mailboxVersion: BOUNDED_MAILBOX_VERSION,
      requestId: claim.requestId,
      ownerId: claim.ownerId,
      rejectedAtMs: nowMs,
      reason,
      originalFile: claim.originalFile,
    };
    const rejectionBytes = Buffer.byteLength(`${JSON.stringify(rejection, null, 2)}\n`);
    const status = inspectBoundedMailbox(paths);
    if (status.totalItems < limits.maxItems && status.totalBytes + rejectionBytes <= limits.maxBytes) {
      writeJsonDurable(rejectionPath, rejection, { spacing: 2, trailingNewline: true });
    }
  }
}

/**
 * Reclaims expired ownership, removes response-completed claims, and bounds
 * retained response/dead-letter/staging history. Each call has a cleanup cap.
 */
export function maintainBoundedMailbox(
  paths: BoundedMailboxPaths,
  options: {
    nowMs?: number;
    limits?: Partial<BoundedMailboxLimits> | BoundedMailboxLimits;
  } = {},
): MailboxMaintenanceResult {
  const nowMs = options.nowMs ?? Date.now();
  const limits = resolveBoundedMailboxLimits(options.limits);
  initializeBoundedMailbox(paths);
  return withMailboxAdmissionLock(paths, limits, 2_000, () => maintainBoundedMailboxUnlocked(paths, nowMs, limits));
}

function maintainBoundedMailboxUnlocked(
  paths: BoundedMailboxPaths,
  nowMs: number,
  limits: BoundedMailboxLimits,
): MailboxMaintenanceResult {
  const result: MailboxMaintenanceResult = {
    reclaimed: 0,
    completedClaimsRemoved: 0,
    responsesRemoved: 0,
    deadLettersRemoved: 0,
    temporaryFilesRemoved: 0,
  };
  let remaining = limits.cleanupBatch;
  for (const claim of inflightClaims(paths.inflightDir)) {
    if (remaining <= 0) break;
    const responsePath = join(paths.responseDir, `${claim.requestId}.json`);
    if (existsSync(responsePath)) {
      rmSync(claim.path, { force: true });
      result.completedClaimsRemoved++;
      remaining--;
      continue;
    }
    if (claim.claimExpiresAtMs > nowMs) continue;
    const target = join(paths.pendingDir, claim.originalFile);
    try {
      renameSync(claim.path, target);
      result.reclaimed++;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      rmSync(claim.path, { force: true });
    }
    syncDirectoryDurable(dirname(claim.path));
    syncDirectoryDurable(paths.pendingDir);
    remaining--;
  }
  remaining = removeExpiredFiles(
    paths.responseDir,
    remaining,
    (path, statMtimeMs) => responseExpiry(path) ?? statMtimeMs + limits.responseRetentionMs,
    nowMs,
    () => {
      result.responsesRemoved++;
    },
  );
  remaining = removeExpiredFiles(
    paths.deadLetterDir,
    remaining,
    (_path, statMtimeMs) => statMtimeMs + limits.deadLetterRetentionMs,
    nowMs,
    () => {
      result.deadLettersRemoved++;
    },
  );
  for (const directory of [
    paths.pendingDir,
    paths.inflightDir,
    paths.responseDir,
    paths.deadLetterDir,
    paths.legacyRequestDir,
  ]) {
    if (remaining <= 0) break;
    for (const path of regularFilesRecursive(directory)) {
      if (remaining <= 0) break;
      if (!basename(path).includes('.tmp-')) continue;
      if (lstatSync(path).mtimeMs + limits.temporaryRetentionMs > nowMs) continue;
      rmSync(path, { force: true });
      result.temporaryFilesRemoved++;
      remaining--;
    }
  }
  removeEmptyOwnerDirectories(paths.inflightDir);
  return result;
}

export function inspectBoundedMailbox(paths: BoundedMailboxPaths): BoundedMailboxStatus {
  initializeBoundedMailbox(paths);
  const pendingFiles = [
    ...regularFiles(paths.pendingDir).map((path) => ({ path, pending: true })),
    ...regularFiles(paths.legacyRequestDir).map((path) => ({ path, pending: true })),
  ];
  const inflightFiles = inflightClaims(paths.inflightDir).map((claim) => ({ path: claim.path, pending: false }));
  const responseFiles = regularFiles(paths.responseDir).map((path) => ({ path, pending: false }));
  const deadLetterFiles = regularFiles(paths.deadLetterDir).map((path) => ({ path, pending: false }));
  const all = [...pendingFiles, ...inflightFiles, ...responseFiles, ...deadLetterFiles];
  let invalid = 0;
  let oldestPendingMs: number | undefined;
  for (const file of pendingFiles) {
    const header = readRequestHeader(file.path);
    if (!header) {
      invalid++;
      continue;
    }
    const enqueuedAtMs = header.enqueuedAtMs ?? lstatSync(file.path).mtimeMs;
    oldestPendingMs = oldestPendingMs === undefined ? enqueuedAtMs : Math.min(oldestPendingMs, enqueuedAtMs);
  }
  return {
    pending: pendingFiles.length,
    inflight: inflightFiles.length,
    responses: responseFiles.length,
    deadLetters: deadLetterFiles.length,
    invalid,
    totalItems: all.length,
    totalBytes: all.reduce((sum, file) => sum + safeFileSize(file.path), 0),
    ...(oldestPendingMs === undefined ? {} : { oldestPendingAt: new Date(oldestPendingMs).toISOString() }),
  };
}

function publishCompletion(
  paths: BoundedMailboxPaths,
  claim: BoundedMailboxClaim,
  response: Record<string, unknown>,
): void {
  const path = join(paths.responseDir, `${claim.requestId}.json`);
  const serialized = `${JSON.stringify(response)}\n`;
  try {
    createFileAtomicExclusive(path, serialized, { durability: 'durable' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readRequestHeader(path);
    const expectedOperation = claim.operationKey ?? `legacy-${claim.requestId}`;
    if (existing?.operationKey !== expectedOperation) {
      throw new Error(`Mailbox completion ${claim.requestId} conflicts with an existing operation.`, {
        cause: error,
      });
    }
  }
}

function withMailboxAdmissionLock<T>(
  paths: BoundedMailboxPaths,
  limits: BoundedMailboxLimits,
  timeoutMs: number,
  operation: () => T,
): T {
  const lockDirectory = join(paths.rootDir, '.admission.lock');
  const ownerPath = join(lockDirectory, 'owner.json');
  const ownerToken = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      mkdirSync(lockDirectory);
      try {
        writeJsonDurable(ownerPath, { ownerToken, pid: process.pid, acquiredAtMs: Date.now() });
      } catch (error) {
        rmSync(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      reclaimAbandonedAdmissionLock(lockDirectory, limits.admissionCreationGraceMs);
      if (Date.now() >= deadline) {
        throw new MailboxBackpressureError('admission-busy', inspectBoundedMailbox(paths), limits, 0);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return operation();
  } finally {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { ownerToken?: unknown };
      if (owner.ownerToken === ownerToken) {
        rmSync(lockDirectory, { recursive: true, force: true });
        syncDirectoryDurable(paths.rootDir);
      }
    } catch {
      // A stale-lock reclaimer may have moved this owner's directory. Token
      // checking prevents the old owner from deleting a replacement lock.
    }
  }
}

function reclaimAbandonedAdmissionLock(lockDirectory: string, creationGraceMs: number): void {
  let modifiedAtMs: number;
  try {
    modifiedAtMs = lstatSync(lockDirectory).mtimeMs;
  } catch {
    return;
  }
  let ownerPid: number | null = null;
  try {
    const owner = JSON.parse(readFileSync(join(lockDirectory, 'owner.json'), 'utf8')) as {
      ownerToken?: unknown;
      pid?: unknown;
    };
    if (typeof owner.ownerToken === 'string' && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) {
      ownerPid = Number(owner.pid);
    }
  } catch {
    // An interrupted creator may leave only the directory. It receives a
    // conservative grace period before unchanged-name reclamation.
  }
  if (ownerPid !== null && processIsAlive(ownerPid)) return;
  if (ownerPid === null && modifiedAtMs + creationGraceMs > Date.now()) return;
  const stalePath = `${lockDirectory}.stale-${randomUUID()}`;
  try {
    renameSync(lockDirectory, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST') return;
    throw error;
  }
  rmSync(stalePath, { recursive: true, force: true });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code !== 'ESRCH';
  }
}

function existingOperation(paths: BoundedMailboxPaths, requestId: string): string | null {
  for (const path of [
    join(paths.pendingDir, `${requestId}.json`),
    join(paths.legacyRequestDir, `${requestId}.json`),
    join(paths.responseDir, `${requestId}.json`),
  ]) {
    if (existsSync(path)) return path;
  }
  for (const claim of inflightClaims(paths.inflightDir)) {
    if (claim.requestId === requestId) return claim.path;
  }
  return null;
}

function assertMatchingOperation(path: string, operationKey: string, requestId: string): void {
  const header = readRequestHeader(path);
  if (!header || header.operationKey !== operationKey) {
    throw new Error(`Mailbox operation ${requestId} conflicts with an existing retained record.`);
  }
}

function validateRequestIdentity(request: BoundedMailboxRequestIdentity): void {
  if (
    request.mailboxVersion !== BOUNDED_MAILBOX_VERSION ||
    request.id !== boundedMailboxRequestId(request.operationKey) ||
    !request.clientId.trim() ||
    !Number.isFinite(request.enqueuedAtMs) ||
    !Number.isFinite(request.deadlineAtMs) ||
    request.deadlineAtMs < request.enqueuedAtMs
  ) {
    throw new Error('Mailbox request has an invalid lifecycle identity.');
  }
}

function pendingCandidates(directory: string, legacy: boolean): PendingCandidate[] {
  return regularFiles(directory)
    .filter((path) => path.endsWith('.json'))
    .map((path) => {
      const stat = lstatSync(path);
      const fallbackId = basename(path, '.json');
      const header = readRequestHeader(path) ?? { id: fallbackId };
      return {
        path,
        originalFile: basename(path),
        header,
        byteLength: stat.size,
        orderAtMs: header.enqueuedAtMs ?? stat.mtimeMs,
        legacy,
      };
    });
}

function inflightClaims(directory: string): BoundedMailboxClaim[] {
  if (!existsSync(directory)) return [];
  const claims: BoundedMailboxClaim[] = [];
  for (const owner of readdirSync(directory, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    const ownerId = decodeSegment(owner.name);
    if (ownerId === null) continue;
    const ownerDirectory = join(directory, owner.name);
    for (const entry of readdirSync(ownerDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.claim')) continue;
      const match = /^(.*)\.(\d+)\.claim$/.exec(entry.name);
      if (!match) continue;
      const originalFile = decodeSegment(match[1]!);
      const claimExpiresAtMs = Number(match[2]);
      if (
        originalFile === null ||
        basename(originalFile) !== originalFile ||
        !originalFile.endsWith('.json') ||
        !Number.isSafeInteger(claimExpiresAtMs)
      ) {
        continue;
      }
      const path = join(ownerDirectory, entry.name);
      const header = readRequestHeader(path) ?? { id: basename(originalFile, '.json') };
      const stat = lstatSync(path);
      claims.push({
        requestId: header.id,
        ownerId,
        path,
        originalFile,
        claimedAtMs: stat.mtimeMs,
        claimExpiresAtMs,
        byteLength: stat.size,
        ...(header.operationKey ? { operationKey: header.operationKey } : {}),
        ...(header.clientId ? { clientId: header.clientId } : {}),
        ...(header.enqueuedAtMs === undefined ? {} : { enqueuedAtMs: header.enqueuedAtMs }),
        ...(header.deadlineAtMs === undefined ? {} : { deadlineAtMs: header.deadlineAtMs }),
        legacy: header.operationKey === undefined,
      });
    }
  }
  return claims.sort((left, right) => left.claimedAtMs - right.claimedAtMs || left.path.localeCompare(right.path));
}

function readRequestHeader(path: string): RequestHeader | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof parsed['id'] !== 'string' || !parsed['id']) return null;
    return {
      id: parsed['id'],
      ...(typeof parsed['operationKey'] === 'string' ? { operationKey: parsed['operationKey'] } : {}),
      ...(typeof parsed['clientId'] === 'string' ? { clientId: parsed['clientId'] } : {}),
      ...(typeof parsed['enqueuedAtMs'] === 'number' ? { enqueuedAtMs: parsed['enqueuedAtMs'] } : {}),
      ...(typeof parsed['deadlineAtMs'] === 'number' ? { deadlineAtMs: parsed['deadlineAtMs'] } : {}),
    };
  } catch {
    return null;
  }
}

function responseExpiry(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { expiresAtMs?: unknown };
    return typeof parsed.expiresAtMs === 'number' && Number.isFinite(parsed.expiresAtMs) ? parsed.expiresAtMs : null;
  } catch {
    return null;
  }
}

function removeExpiredFiles(
  directory: string,
  remaining: number,
  expiresAt: (path: string, statMtimeMs: number) => number,
  nowMs: number,
  removed: () => void,
): number {
  for (const path of regularFiles(directory)) {
    if (remaining <= 0) break;
    const stat = lstatSync(path);
    if (expiresAt(path, stat.mtimeMs) > nowMs) continue;
    rmSync(path, { force: true });
    removed();
    remaining--;
  }
  return remaining;
}

function regularFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name))
    .sort();
}

function regularFilesRecursive(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory()) files.push(...regularFilesRecursive(path));
  }
  return files.sort();
}

function removeEmptyOwnerDirectories(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
  }
}

function safeFileSize(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return encodeSegment(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function safeRequestId(value: string): string {
  return /^[a-z0-9][a-z0-9-]{0,127}$/i.test(value)
    ? value
    : `invalid-${createHash('sha256').update(value).digest('hex')}`;
}
