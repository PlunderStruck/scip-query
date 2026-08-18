import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { monotonicNowMs } from '../domain/time.js';
import { stableJson } from '../domain/stable-json.js';
import { decodeObservationReceipt, type ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { readTextFileWithinLimit } from '../platform/bounded-file.js';
import { resolveGitWorktreeContext } from '../platform/git-worktree.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import {
  parseProcessIdentity,
  readProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from '../platform/process-identity.js';
import type { OutlineNode } from '../queries/navigation/outline.js';
import type { CodeFileMemberMode } from '../queries/navigation/code.js';
import type { SourceSearchOptions, SourceSearchResult } from '../queries/navigation/source-search.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxPaths,
  boundedMailboxRequestId,
  enqueueBoundedMailboxRequest,
  type BoundedMailboxLimits,
} from '../storage/bounded-mailbox.js';
import { publishedSqliteGenerationIdentity } from '../storage/sqlite-generation.js';
import { resolveCliProjectContext } from './cli-context.js';
import { cliVersion } from './cli-support.js';
import { inspectWatchService, trustedWatchServiceIndexGeneration } from './watch-service.js';

export const QUERY_SERVICE_PROTOCOL_VERSION = 3;

const QUERY_SERVICE_POOL_SIZE = 6;
const QUERY_SERVICE_MAX_POOL_SIZE = 8;
const QUERY_SERVICE_TIMEOUT_MS = 30_000;
const QUERY_SERVICE_STARTUP_TIMEOUT_MS = 5_000;
const QUERY_SERVICE_POLL_INTERVAL_MS = 5;
const QUERY_SERVICE_MAX_ITEM_BYTES = 64 * 1024 * 1024;
const QUERY_SERVICE_MAILBOX_LIMITS: Partial<BoundedMailboxLimits> = {
  maxItems: 64,
  maxBytes: 128 * 1024 * 1024,
  maxItemBytes: QUERY_SERVICE_MAX_ITEM_BYTES,
  maxBatch: 1,
  responseRetentionMs: 60_000,
};

export interface QueryServiceSourceSearchRequest {
  kind: 'source-search';
  expectedGeneration: string;
  pattern: string;
  options: SourceSearchOptions;
}

export interface QueryServiceOutlineRequest {
  kind: 'outline';
  expectedGeneration: string;
  filePattern: string;
}

export interface QueryServiceCodeRequest {
  kind: 'code';
  expectedGeneration: string;
  selectors: string[];
  options: {
    context: number;
    members: CodeFileMemberMode;
  };
}

export type QueryServiceRequest =
  | QueryServiceSourceSearchRequest
  | QueryServiceOutlineRequest
  | QueryServiceCodeRequest;

export interface QueryServiceEnvelope {
  mailboxVersion: typeof BOUNDED_MAILBOX_VERSION;
  protocolVersion: typeof QUERY_SERVICE_PROTOCOL_VERSION;
  id: string;
  operationKey: string;
  clientId: string;
  enqueuedAtMs: number;
  deadlineAtMs: number;
  sessionIdentity: string;
  request: QueryServiceRequest;
}

export interface QueryServiceServerState {
  protocolVersion: typeof QUERY_SERVICE_PROTOCOL_VERSION;
  sessionIdentity: string;
  pid: number;
  processIdentity?: ProcessIdentity;
  generation: string;
  heartbeatAtMs: number;
}

interface QueryServiceResponse<Result> {
  ok: true;
  protocolVersion: typeof QUERY_SERVICE_PROTOCOL_VERSION;
  id: string;
  generation: string;
  result: Result;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceSearchResult {
  result: SourceSearchResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceOutlineResult {
  result: OutlineNode[];
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceSerializedResult {
  serializedJson: string;
  sha256: string;
}

export interface QueryServiceCodeResult {
  result: QueryServiceSerializedResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export function trySearchSourceWithQueryService(
  projectRoot: string,
  pattern: string,
  options: SourceSearchOptions = {},
  policy: { allowDefault?: boolean } = {},
): QueryServiceSearchResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'source-search', expectedGeneration, pattern, options }),
    isSourceSearchResult,
    'search result',
    policy,
  );
}

export function tryOutlineWithQueryService(
  projectRoot: string,
  filePattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceOutlineResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'outline', expectedGeneration, filePattern }),
    isOutlineResult,
    'outline result',
    policy,
  );
}

export function tryCodeWithQueryService(
  projectRoot: string,
  selectors: readonly string[],
  options: { context: number; members: CodeFileMemberMode },
  policy: { allowDefault?: boolean } = {},
): QueryServiceCodeResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'code', expectedGeneration, selectors: [...selectors], options }),
    isSerializedJsonResult,
    'serialized code result',
    policy,
  );
}

function tryQueryWithService<Result>(
  projectRoot: string,
  requestForGeneration: (expectedGeneration: string) => QueryServiceRequest,
  isResult: (value: unknown) => value is Result,
  resultName: string,
  policy: { allowDefault?: boolean },
): { result: Result; generationIdentity: string; observationReceipt: ObservationReceiptV2 } | null {
  if (!queryServiceEnabled(policy.allowDefault === true)) return null;
  try {
    const gitContext = resolveGitWorktreeContext(projectRoot);
    const project = resolveCliProjectContext(projectRoot, gitContext);
    if (!existsSync(project.dbPath)) return null;
    const generationIdentity = publishedSqliteGenerationIdentity(project.dbPath);
    if (!generationIdentity) return null;
    if (
      policy.allowDefault === true &&
      process.env['SCIP_QUERY_QUERY_SERVICE'] !== '1' &&
      !hasTrustedWatchGeneration(project, gitContext, generationIdentity)
    ) {
      return null;
    }
    const response = requestQuery(
      {
        projectRoot: project.projectRoot,
        dbPath: project.dbPath,
        generationIdentity,
      },
      requestForGeneration(generationIdentity),
      isResult,
      resultName,
    );
    return {
      result: response.result,
      generationIdentity,
      observationReceipt: response.observationReceipt,
    };
  } catch (error) {
    if (queryServiceDebugEnabled()) {
      console.error(`query-service fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

function hasTrustedWatchGeneration(
  project: ReturnType<typeof resolveCliProjectContext>,
  gitContext: ReturnType<typeof resolveGitWorktreeContext>,
  generationIdentity: string,
): boolean {
  if (project.config.watch?.enabled !== true) return false;
  try {
    return (
      trustedWatchServiceIndexGeneration(
        inspectWatchService({
          projectRoot: project.projectRoot,
          cacheDir: project.paths.cacheDir,
          cliVersion,
          gitContext,
        }),
      ) === generationIdentity
    );
  } catch {
    return false;
  }
}

export function queryServiceSessionIdentity(sessionDir: string): string {
  return createHash('sha256')
    .update(
      stableJson({
        kind: 'scip-query-service-mailbox',
        protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
        sessionDir: resolve(sessionDir),
      }),
    )
    .digest('hex');
}

export function readQueryServiceServerState(sessionDir: string): QueryServiceServerState | null {
  const statePath = join(sessionDir, 'server.json');
  try {
    const value = JSON.parse(
      readTextFileWithinLimit(statePath, { maxBytes: 64 * 1024, inputKind: 'query service state' }),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const processIdentity =
      record['processIdentity'] === undefined ? undefined : parseProcessIdentity(record['processIdentity']);
    if (
      record['protocolVersion'] !== QUERY_SERVICE_PROTOCOL_VERSION ||
      typeof record['sessionIdentity'] !== 'string' ||
      record['sessionIdentity'] !== queryServiceSessionIdentity(sessionDir) ||
      typeof record['pid'] !== 'number' ||
      !Number.isSafeInteger(record['pid']) ||
      record['pid'] <= 0 ||
      (record['processIdentity'] !== undefined && (!processIdentity || processIdentity.pid !== record['pid'])) ||
      typeof record['generation'] !== 'string' ||
      typeof record['heartbeatAtMs'] !== 'number' ||
      !Number.isFinite(record['heartbeatAtMs'])
    ) {
      return null;
    }
    return {
      protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
      sessionIdentity: record['sessionIdentity'],
      pid: record['pid'],
      ...(processIdentity ? { processIdentity } : {}),
      generation: record['generation'],
      heartbeatAtMs: record['heartbeatAtMs'],
    };
  } catch {
    return null;
  }
}

export function isQueryServiceServerStateLive(state: QueryServiceServerState): boolean {
  if (!isProcessAlive(state.pid)) return false;
  if (!state.processIdentity) return true;
  const actual = readProcessIdentity(state.pid);
  return actual !== null && sameProcessIdentity(state.processIdentity, actual);
}

function requestQuery<Result>(
  context: { projectRoot: string; dbPath: string; generationIdentity: string },
  request: QueryServiceRequest,
  isResult: (value: unknown) => value is Result,
  resultName: string,
): QueryServiceResponse<Result> {
  const serverPath = queryServiceServerPath();
  if (!existsSync(serverPath)) throw new Error('Query service server executable is unavailable.');

  const lane = Math.abs(process.pid) % configuredPoolSize();
  const sessionDir = queryServiceSessionDirectory(context, serverPath, lane);
  const paths = boundedMailboxPaths(sessionDir);
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + QUERY_SERVICE_TIMEOUT_MS;
  const monotonicDeadlineAtMs = monotonicNowMs() + QUERY_SERVICE_TIMEOUT_MS;
  const clientId = randomUUID();
  const operationKey = boundedMailboxOperationKey('query-service-v3', { clientId, request });
  const id = boundedMailboxRequestId(operationKey);
  const sessionIdentity = queryServiceSessionIdentity(sessionDir);
  const admitted = enqueueBoundedMailboxRequest(
    paths,
    {
      mailboxVersion: BOUNDED_MAILBOX_VERSION,
      protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
      id,
      operationKey,
      clientId,
      enqueuedAtMs: startedAtMs,
      deadlineAtMs,
      sessionIdentity,
      request,
    } satisfies QueryServiceEnvelope,
    { nowMs: startedAtMs, limits: QUERY_SERVICE_MAILBOX_LIMITS },
  );

  ensureQueryServiceServer(sessionDir, context.projectRoot, serverPath, monotonicDeadlineAtMs);
  while (monotonicNowMs() <= monotonicDeadlineAtMs) {
    if (existsSync(admitted.responsePath)) {
      return parseQueryServiceResponse(
        readTextFileWithinLimit(admitted.responsePath, {
          maxBytes: QUERY_SERVICE_MAX_ITEM_BYTES,
          inputKind: 'query service response',
        }),
        {
          id,
          operationKey,
          clientId,
          deadlineAtMs: admitted.authoritativeDeadlineAtMs,
          generation: context.generationIdentity,
        },
        isResult,
        resultName,
      );
    }
    const state = readQueryServiceServerState(sessionDir);
    if (!state || !isQueryServiceServerStateLive(state)) {
      ensureQueryServiceServer(sessionDir, context.projectRoot, serverPath, monotonicDeadlineAtMs);
    }
    sleepSync(QUERY_SERVICE_POLL_INTERVAL_MS);
  }
  throw new Error('Persistent query service timed out.');
}

function ensureQueryServiceServer(
  sessionDir: string,
  projectRoot: string,
  serverPath: string,
  requestDeadlineAtMs: number,
): void {
  const current = readQueryServiceServerState(sessionDir);
  if (current && isQueryServiceServerStateLive(current)) return;

  const debug = queryServiceDebugEnabled();
  // scip-query: process-lifetime-reviewed -- the detached service is owned by
  // its process identity, heartbeat, file lock, idle timeout, and request deadlines.
  spawn(process.execPath, [serverPath, sessionDir, projectRoot], {
    cwd: projectRoot,
    detached: !debug,
    stdio: debug ? ['ignore', 'ignore', 'inherit'] : 'ignore',
    env: { ...process.env, SCIP_QUERY_QUERY_SERVICE_SERVER: '1' },
  }).unref();

  const startupDeadlineAtMs = Math.min(requestDeadlineAtMs, monotonicNowMs() + QUERY_SERVICE_STARTUP_TIMEOUT_MS);
  while (monotonicNowMs() <= startupDeadlineAtMs) {
    const state = readQueryServiceServerState(sessionDir);
    if (state && isQueryServiceServerStateLive(state)) return;
    sleepSync(QUERY_SERVICE_POLL_INTERVAL_MS);
  }
  throw new Error('Persistent query service did not become ready within 5s.');
}

function parseQueryServiceResponse<Result>(
  raw: string,
  expected: { id: string; operationKey: string; clientId: string; deadlineAtMs: number; generation: string },
  isResult: (value: unknown) => value is Result,
  resultName: string,
): QueryServiceResponse<Result> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid query service response.');
  const record = value as Record<string, unknown>;
  if (
    record['mailboxVersion'] !== BOUNDED_MAILBOX_VERSION ||
    record['protocolVersion'] !== QUERY_SERVICE_PROTOCOL_VERSION ||
    record['id'] !== expected.id ||
    record['operationKey'] !== expected.operationKey ||
    record['clientId'] !== expected.clientId ||
    record['deadlineAtMs'] !== expected.deadlineAtMs
  ) {
    throw new Error('Query service response identity does not match the request.');
  }
  if (record['ok'] !== true) {
    throw new Error(
      typeof record['error'] === 'string' ? record['error'] : 'Persistent query service rejected the request.',
    );
  }
  if (record['generation'] !== expected.generation) throw new Error('Persistent query service generation changed.');
  if (!isResult(record['result'])) throw new Error(`Persistent query service returned an invalid ${resultName}.`);
  const receipt = decodeObservationReceipt(record['observationReceipt']);
  if (receipt.kind !== 'supported')
    throw new Error('Persistent query service returned an invalid observation receipt.');
  return {
    ok: true,
    protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
    id: expected.id,
    generation: expected.generation,
    result: record['result'],
    observationReceipt: receipt.receipt,
  };
}

function isOutlineResult(value: unknown): value is OutlineNode[] {
  if (!Array.isArray(value)) return false;
  const pending: unknown[] = [...value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const record = node as Record<string, unknown>;
    if (
      typeof record['symbol'] !== 'string' ||
      typeof record['shortName'] !== 'string' ||
      !Number.isSafeInteger(record['startLine']) ||
      (record['startLine'] as number) < 0 ||
      !Number.isSafeInteger(record['endLine']) ||
      (record['endLine'] as number) < (record['startLine'] as number) ||
      (record['signature'] !== null && typeof record['signature'] !== 'string') ||
      !Array.isArray(record['children'])
    ) {
      return false;
    }
    pending.push(...record['children']);
  }
  return true;
}

function isSourceSearchResult(value: unknown): value is SourceSearchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['pattern'] === 'string' &&
    (record['mode'] === 'literal' || record['mode'] === 'regexp') &&
    Array.isArray(record['matches']) &&
    typeof record['matchingLines'] === 'number' &&
    Number.isSafeInteger(record['matchingLines']) &&
    record['matchingLines'] >= 0 &&
    typeof record['omittedMatches'] === 'number' &&
    Number.isSafeInteger(record['omittedMatches']) &&
    record['omittedMatches'] >= 0 &&
    typeof record['scannedFiles'] === 'number' &&
    Number.isSafeInteger(record['scannedFiles']) &&
    record['scannedFiles'] >= 0
  );
}

function isSerializedJsonResult(value: unknown): value is QueryServiceSerializedResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['serializedJson'] !== 'string' || typeof record['sha256'] !== 'string') return false;
  if (record['serializedJson'].length > QUERY_SERVICE_MAX_ITEM_BYTES) return false;
  if (createHash('sha256').update(record['serializedJson']).digest('hex') !== record['sha256']) return false;
  try {
    const parsed = JSON.parse(record['serializedJson']) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function queryServiceSessionDirectory(
  context: { projectRoot: string; dbPath: string },
  serverPath: string,
  lane: number,
): string {
  const projectRoot = canonicalPath(context.projectRoot);
  const identity = createHash('sha256')
    .update(
      stableJson({
        protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
        projectRoot,
        dbPath: resolve(context.dbPath),
        serverPath: resolve(serverPath),
        lane,
      }),
    )
    .digest('hex');
  return join(tmpdir(), 'scip-query-query-service', identity);
}

function queryServiceServerPath(): string {
  return (
    process.env['SCIP_QUERY_QUERY_SERVICE_SERVER_PATH'] ??
    fileURLToPath(new URL('./query-service-server.js', import.meta.url))
  );
}

function queryServiceEnabled(allowDefault: boolean): boolean {
  const configured = process.env['SCIP_QUERY_QUERY_SERVICE'];
  return (
    process.env['SCIP_QUERY_QUERY_SERVICE_SERVER'] !== '1' && configured !== '0' && (configured === '1' || allowDefault)
  );
}

function queryServiceDebugEnabled(): boolean {
  return process.env['SCIP_QUERY_QUERY_SERVICE_DEBUG'] === '1';
}

function configuredPoolSize(): number {
  const parsed = Number(process.env['SCIP_QUERY_QUERY_SERVICE_POOL_SIZE']);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= QUERY_SERVICE_MAX_POOL_SIZE
    ? parsed
    : QUERY_SERVICE_POOL_SIZE;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function sleepSync(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}
