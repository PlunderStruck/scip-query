import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { monotonicNowMs } from '../domain/time.js';
import { codeUnitStableJson } from '../domain/stable-json.js';
import { decodeObservationReceipt, type ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { readTextFileWithinLimit } from '../platform/bounded-file.js';
import { cliVersion } from '../platform/cli-version.js';
import { resolveGitWorktreeContext } from '../platform/git-worktree.js';
import { tryAcquireProcessFileLock } from '../platform/process-file-lock.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import {
  parseProcessIdentity,
  readProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from '../platform/process-identity.js';
import type { OutlineNode } from '../queries/navigation/outline.js';
import type { CodeFileMemberMode } from '../queries/navigation/code.js';
import type { SymbolResolutionJson } from '../queries/navigation/code-result-json.js';
import type { DepResult } from '../queries/navigation/deps.js';
import type { ByKindResult } from '../queries/navigation/by-kind.js';
import type { HierarchyNode } from '../queries/navigation/hierarchy.js';
import type { ImportResult, UnusedImportResult } from '../queries/navigation/imports.js';
import type { RefResult } from '../queries/navigation/refs.js';
import type { ConsumerSurfaceResult } from '../queries/navigation/surface.js';
import type { MemberResult } from '../queries/navigation/members.js';
import type { MethodsResolution } from '../queries/navigation/methods.js';
import type { SourceSearchOptions, SourceSearchResult } from '../queries/navigation/source-search.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxPaths,
  boundedMailboxRequestId,
  enqueueBoundedMailboxRequest,
  type BoundedMailboxLimits,
} from '../storage/bounded-mailbox.js';
import { publishedSqliteGenerationIdentity } from '../storage/sqlite-generation.js';
import { resolveCliProjectContext } from './cli-context.js';
import { inspectWatchService, trustedWatchServiceIndexGeneration } from './watch-service.js';

export const QUERY_SERVICE_PROTOCOL_VERSION = 18;
export const QUERY_SERVICE_HEARTBEAT_INTERVAL_MS = 1_000;
const QUERY_SERVICE_FRESH_HEARTBEAT_MAX_AGE_MS = 2 * QUERY_SERVICE_HEARTBEAT_INTERVAL_MS;

const QUERY_SERVICE_POOL_SIZE = 4;
const QUERY_SERVICE_CATALOG_POOL_SIZE = 4;
const QUERY_SERVICE_SEMANTIC_NAVIGATION_POOL_SIZE = 5;
const QUERY_SERVICE_CALL_GRAPH_POOL_SIZE = 3;
const QUERY_SERVICE_REFERENCE_REACHABILITY_POOL_SIZE = 3;
const QUERY_SERVICE_SYSTEM_POOL_SIZE = 4;
const QUERY_SERVICE_VALUE_FLOW_POOL_SIZE = 3;
const QUERY_SERVICE_DEPENDENCE_SLICE_POOL_SIZE = 3;
const QUERY_SERVICE_MAX_POOL_SIZE = 8;
const QUERY_SERVICE_TIMEOUT_MS = 30_000;
const QUERY_SERVICE_STARTUP_TIMEOUT_MS = 5_000;
const QUERY_SERVICE_POLL_INTERVAL_MS = 5;
const QUERY_SERVICE_FAST_RESPONSE_POLL_ATTEMPTS = 10;
const QUERY_SERVICE_FAST_RESPONSE_POLL_INTERVAL_MS = 1;
const QUERY_SERVICE_FAST_RESPONSE_HEALTH_CHECK_ATTEMPTS = 5;
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

export interface QueryServiceEntryPointsRequest {
  kind: 'entrypoints';
  expectedGeneration: string;
  options: QueryServiceEntryPointsOptions;
}

export interface QueryServiceFilesRequest {
  kind: 'files';
  expectedGeneration: string;
  pattern: string;
}

export interface QueryServiceStatsRequest {
  kind: 'stats';
  expectedGeneration: string;
}

export interface QueryServiceMembersRequest {
  kind: 'members';
  expectedGeneration: string;
  symbolPattern: string;
}

export interface QueryServiceMethodsRequest {
  kind: 'methods';
  expectedGeneration: string;
  className: string;
}

export interface QueryServiceFileDependenciesRequest {
  kind: 'file-dependencies';
  expectedGeneration: string;
  direction: 'outgoing' | 'incoming';
  filePattern: string;
}

export interface QueryServiceImportedByRequest {
  kind: 'imported-by';
  expectedGeneration: string;
  symbolPattern: string;
}

export interface QueryServiceHierarchyRequest {
  kind: 'hierarchy';
  expectedGeneration: string;
  symbolPattern: string;
}

export interface QueryServiceByKindRequest {
  kind: 'by-kind';
  expectedGeneration: string;
  kindQuery: string;
}

export interface QueryServiceKindCountsRequest {
  kind: 'kind-counts';
  expectedGeneration: string;
}

export interface QueryServiceRefsRequest {
  kind: 'refs';
  expectedGeneration: string;
  symbolPattern: string;
}

export interface QueryServiceTraceRequest {
  kind: 'trace';
  expectedGeneration: string;
  symbolPattern: string;
}

export interface QueryServiceValueFlowRequest {
  kind: 'value-flow';
  expectedGeneration: string;
  symbolPattern: string;
}

export interface QueryServiceDependenceSliceRequest {
  kind: 'dependence-slice';
  expectedGeneration: string;
  criterion: string;
}

export type QueryServiceSemanticNeighborhoodRequest =
  | { kind: 'call-graph'; expectedGeneration: string; symbolPattern: string }
  | { kind: 'reference-neighborhood'; expectedGeneration: string; symbolPattern: string }
  | { kind: 'reference-reachability'; expectedGeneration: string; symbolPattern: string }
  | { kind: 'slice'; expectedGeneration: string; symbolPattern: string }
  | { kind: 'dataflow'; expectedGeneration: string; symbolPattern: string };

export interface QueryServiceImportsRequest {
  kind: 'imports';
  expectedGeneration: string;
  filePattern: string;
}

export interface QueryServiceUnusedImportsRequest {
  kind: 'unused-imports';
  expectedGeneration: string;
  filePattern: string;
}

export interface QueryServiceSurfaceRequest {
  kind: 'surface';
  expectedGeneration: string;
  modulePattern: string;
}

export interface QueryServiceSystemRequest {
  kind: 'system';
  expectedGeneration: string;
  modulePattern: string;
}

export interface QueryServiceEntryPointsOptions {
  search?: string;
  scope?: string;
}

export interface QueryServiceEntryPointResult {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  documentation: string | null;
  confidence: 'root' | 'candidate';
  evidence: string[];
  indexedCallerCount: number;
}

export interface QueryServiceFileResult {
  relativePath: string;
}

export interface QueryServiceStatsTransportResult {
  documents: number;
  symbols: number;
  definitions: number;
  references: number;
  indexSizeBytes: number;
  lastBuilt: string | null;
}

export type QueryServiceMembersTransportResult = SymbolResolutionJson & { members: MemberResult[] };
export type QueryServiceHierarchyTransportResult = SymbolResolutionJson & { hierarchy: HierarchyNode[] };
export type QueryServiceRefsTransportResult = SymbolResolutionJson & {
  references: RefResult[];
  pagination: { cursorVersion: 2; producer: 'complete-only'; semanticEnrichment: boolean };
};
export type QueryServiceKindCountTransportResult = { kind: number; kindName: string; count: number };

export type QueryServiceRequest =
  | QueryServiceSourceSearchRequest
  | QueryServiceOutlineRequest
  | QueryServiceCodeRequest
  | QueryServiceEntryPointsRequest
  | QueryServiceFilesRequest
  | QueryServiceStatsRequest
  | QueryServiceMembersRequest
  | QueryServiceMethodsRequest
  | QueryServiceFileDependenciesRequest
  | QueryServiceImportedByRequest
  | QueryServiceHierarchyRequest
  | QueryServiceByKindRequest
  | QueryServiceKindCountsRequest
  | QueryServiceRefsRequest
  | QueryServiceTraceRequest
  | QueryServiceValueFlowRequest
  | QueryServiceDependenceSliceRequest
  | QueryServiceSemanticNeighborhoodRequest
  | QueryServiceImportsRequest
  | QueryServiceUnusedImportsRequest
  | QueryServiceSystemRequest
  | QueryServiceSurfaceRequest;

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

export interface QueryServiceSystemResult {
  result: QueryServiceSerializedResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceEntryPointsResult {
  result: QueryServiceEntryPointResult[];
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceFilesResult {
  result: QueryServiceFileResult[];
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceStatsResult {
  result: QueryServiceStatsTransportResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceMembersResult {
  result: QueryServiceMembersTransportResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceMethodsResult {
  result: MethodsResolution;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceFileDependenciesResult {
  result: DepResult[];
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceImportedByResult {
  result: ImportResult[];
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceHierarchyResult {
  result: QueryServiceHierarchyTransportResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceByKindResult {
  result: ByKindResult[];
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceKindCountsResult {
  result: QueryServiceKindCountTransportResult[];
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceRefsResult {
  result: QueryServiceRefsTransportResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceTraceResult {
  result: QueryServiceSerializedResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceValueFlowResult {
  result: QueryServiceSerializedResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceDependenceSliceResult {
  result: QueryServiceSerializedResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceSemanticNeighborhoodResult {
  result: QueryServiceSerializedResult;
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceImportsResult {
  result: ImportResult[];
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceUnusedImportsResult {
  result: UnusedImportResult[];
  generationIdentity: string;
  observationReceipt: ObservationReceiptV2;
}

export interface QueryServiceSurfaceResult {
  result: ConsumerSurfaceResult[];
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

export function tryEntryPointsWithQueryService(
  projectRoot: string,
  options: QueryServiceEntryPointsOptions = {},
  policy: { allowDefault?: boolean } = {},
): QueryServiceEntryPointsResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'entrypoints', expectedGeneration, options }),
    isEntryPointResult,
    'entrypoints result',
    policy,
  );
}

export function tryFilesWithQueryService(
  projectRoot: string,
  pattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceFilesResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'files', expectedGeneration, pattern }),
    isFilesResult,
    'files result',
    policy,
  );
}

export function tryStatsWithQueryService(
  projectRoot: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceStatsResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'stats', expectedGeneration }),
    isStatsResult,
    'stats result',
    policy,
  );
}

export function tryMembersWithQueryService(
  projectRoot: string,
  symbolPattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceMembersResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'members', expectedGeneration, symbolPattern }),
    isMembersResult,
    'members result',
    policy,
  );
}

export function tryMethodsWithQueryService(
  projectRoot: string,
  className: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceMethodsResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'methods', expectedGeneration, className }),
    isMethodsResult,
    'methods result',
    policy,
  );
}

export function tryFileDependenciesWithQueryService(
  projectRoot: string,
  direction: 'outgoing' | 'incoming',
  filePattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceFileDependenciesResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'file-dependencies', expectedGeneration, direction, filePattern }),
    isFileDependenciesResult,
    'file dependencies result',
    policy,
  );
}

export function tryImportedByWithQueryService(
  projectRoot: string,
  symbolPattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceImportedByResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'imported-by', expectedGeneration, symbolPattern }),
    isImportedByResult,
    'imported-by result',
    policy,
  );
}

export function tryHierarchyWithQueryService(
  projectRoot: string,
  symbolPattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceHierarchyResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'hierarchy', expectedGeneration, symbolPattern }),
    isHierarchyResult,
    'hierarchy result',
    policy,
  );
}

export function tryByKindWithQueryService(
  projectRoot: string,
  kindQuery: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceByKindResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'by-kind', expectedGeneration, kindQuery }),
    isByKindResult,
    'by-kind result',
    policy,
  );
}

export function tryKindCountsWithQueryService(
  projectRoot: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceKindCountsResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'kind-counts', expectedGeneration }),
    isKindCountsResult,
    'kind-counts result',
    policy,
  );
}

export function tryRefsWithQueryService(
  projectRoot: string,
  symbolPattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceRefsResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'refs', expectedGeneration, symbolPattern }),
    isRefsResult,
    'refs result',
    policy,
  );
}

export function tryTraceWithQueryService(
  projectRoot: string,
  symbolPattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceTraceResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'trace', expectedGeneration, symbolPattern }),
    isSerializedJsonResult,
    'trace result',
    policy,
  );
}

export function tryValueFlowWithQueryService(
  projectRoot: string,
  symbolPattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceValueFlowResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'value-flow', expectedGeneration, symbolPattern }),
    isSerializedJsonResult,
    'value-flow result',
    policy,
  );
}

export function tryDependenceSliceWithQueryService(
  projectRoot: string,
  criterion: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceDependenceSliceResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'dependence-slice', expectedGeneration, criterion }),
    isSerializedJsonResult,
    'dependence-slice result',
    policy,
  );
}

export function trySemanticNeighborhoodWithQueryService(
  projectRoot: string,
  kind: QueryServiceSemanticNeighborhoodRequest['kind'],
  symbolPattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceSemanticNeighborhoodResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind, expectedGeneration, symbolPattern }),
    isSerializedJsonResult,
    `${kind} result`,
    policy,
  );
}

export function trySystemWithQueryService(
  projectRoot: string,
  modulePattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceSystemResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'system', expectedGeneration, modulePattern }),
    isSerializedJsonResult,
    'system result',
    policy,
  );
}

export function tryImportsWithQueryService(
  projectRoot: string,
  filePattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceImportsResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'imports', expectedGeneration, filePattern }),
    isImportedByResult,
    'imports result',
    policy,
  );
}

export function tryUnusedImportsWithQueryService(
  projectRoot: string,
  filePattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceUnusedImportsResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'unused-imports', expectedGeneration, filePattern }),
    isUnusedImportsResult,
    'unused imports result',
    policy,
  );
}

export function trySurfaceWithQueryService(
  projectRoot: string,
  modulePattern: string,
  policy: { allowDefault?: boolean } = {},
): QueryServiceSurfaceResult | null {
  return tryQueryWithService(
    projectRoot,
    (expectedGeneration) => ({ kind: 'surface', expectedGeneration, modulePattern }),
    isSurfaceResult,
    'surface result',
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
    const requiresTrustedWatchGeneration =
      policy.allowDefault === true && process.env['SCIP_QUERY_QUERY_SERVICE'] !== '1';
    const gitContext = requiresTrustedWatchGeneration ? resolveGitWorktreeContext(projectRoot) : undefined;
    const project = resolveCliProjectContext(projectRoot, gitContext);
    if (!existsSync(project.dbPath)) return null;
    const generationIdentity = publishedSqliteGenerationIdentity(project.dbPath);
    if (!generationIdentity) return null;
    if (requiresTrustedWatchGeneration && !hasTrustedWatchGeneration(project, gitContext, generationIdentity)) {
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
      codeUnitStableJson({
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

export function isQueryServiceServerStateUsable(state: QueryServiceServerState, nowMs = Date.now()): boolean {
  if (!isProcessAlive(state.pid)) return false;
  const heartbeatAgeMs = nowMs - state.heartbeatAtMs;
  if (heartbeatAgeMs >= 0 && heartbeatAgeMs <= QUERY_SERVICE_FRESH_HEARTBEAT_MAX_AGE_MS) return true;
  if (!state.processIdentity) return true;
  const actual = readProcessIdentity(state.pid);
  return actual !== null && sameProcessIdentity(state.processIdentity, actual);
}

export function queryServiceResponsePollPlan(attempt: number): {
  intervalMs: number;
  checkServerState: boolean;
} {
  const fast = attempt < QUERY_SERVICE_FAST_RESPONSE_POLL_ATTEMPTS;
  return {
    intervalMs: fast ? QUERY_SERVICE_FAST_RESPONSE_POLL_INTERVAL_MS : QUERY_SERVICE_POLL_INTERVAL_MS,
    checkServerState: !fast || attempt % QUERY_SERVICE_FAST_RESPONSE_HEALTH_CHECK_ATTEMPTS === 0,
  };
}

function requestQuery<Result>(
  context: { projectRoot: string; dbPath: string; generationIdentity: string },
  request: QueryServiceRequest,
  isResult: (value: unknown) => value is Result,
  resultName: string,
): QueryServiceResponse<Result> {
  const serverPath = queryServiceServerPath();
  if (!existsSync(serverPath)) throw new Error('Query service server executable is unavailable.');

  const lane = Math.abs(process.pid) % requestPoolSize(request);
  const sessionDir = queryServiceSessionDirectory(context, serverPath, lane);
  const paths = boundedMailboxPaths(sessionDir);
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + QUERY_SERVICE_TIMEOUT_MS;
  const monotonicDeadlineAtMs = monotonicNowMs() + QUERY_SERVICE_TIMEOUT_MS;
  const clientId = randomUUID();
  const operationKey = queryServiceOperationKey(clientId, request);
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
    {
      nowMs: startedAtMs,
      limits: QUERY_SERVICE_MAILBOX_LIMITS,
      durability: 'visibility',
    },
  );

  ensureQueryServiceServer(sessionDir, context.projectRoot, serverPath, monotonicDeadlineAtMs);
  let responsePollAttempt = 0;
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
    const pollPlan = queryServiceResponsePollPlan(responsePollAttempt);
    if (pollPlan.checkServerState) {
      const state = readQueryServiceServerState(sessionDir);
      if (!state || !isQueryServiceServerStateUsable(state)) {
        ensureQueryServiceServer(sessionDir, context.projectRoot, serverPath, monotonicDeadlineAtMs);
      }
    }
    sleepSync(pollPlan.intervalMs);
    responsePollAttempt += 1;
  }
  throw new Error('Persistent query service timed out.');
}

function queryServiceOperationKey(clientId: string, request: QueryServiceRequest): string {
  return createHash('sha256')
    .update(codeUnitStableJson({ namespace: 'query-service-v18', payload: { clientId, request } }))
    .digest('hex');
}

function ensureQueryServiceServer(
  sessionDir: string,
  projectRoot: string,
  serverPath: string,
  requestDeadlineAtMs: number,
): void {
  const current = readQueryServiceServerState(sessionDir);
  if (current && isQueryServiceServerStateUsable(current)) return;

  const startupDeadlineAtMs = Math.min(requestDeadlineAtMs, monotonicNowMs() + QUERY_SERVICE_STARTUP_TIMEOUT_MS);
  const startupLock = tryAcquireProcessFileLock(join(sessionDir, 'startup.lock'), {
    kind: 'query-service-startup',
    detail: { projectRoot: resolve(projectRoot) },
    directoryDurability: 'recoverable',
  });
  try {
    if (startupLock.kind === 'acquired') {
      const stateAfterLock = readQueryServiceServerState(sessionDir);
      if (!stateAfterLock || !isQueryServiceServerStateUsable(stateAfterLock)) {
        const debug = queryServiceDebugEnabled();
        // scip-query: process-lifetime-reviewed -- the detached service is owned by
        // its process identity, heartbeat, file lock, idle timeout, and request deadlines.
        spawn(process.execPath, [serverPath, sessionDir, projectRoot], {
          cwd: projectRoot,
          detached: !debug,
          stdio: debug ? ['ignore', 'ignore', 'inherit'] : 'ignore',
          env: { ...process.env, SCIP_QUERY_QUERY_SERVICE_SERVER: '1' },
        }).unref();
      }
    }

    while (monotonicNowMs() <= startupDeadlineAtMs) {
      const state = readQueryServiceServerState(sessionDir);
      if (state && isQueryServiceServerStateUsable(state)) return;
      sleepSync(QUERY_SERVICE_POLL_INTERVAL_MS);
    }
  } finally {
    if (startupLock.kind === 'acquired') startupLock.lock.release();
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

function isEntryPointResult(value: unknown): value is QueryServiceEntryPointResult[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return (
      typeof record['symbol'] === 'string' &&
      typeof record['shortName'] === 'string' &&
      typeof record['file'] === 'string' &&
      Number.isSafeInteger(record['startLine']) &&
      (record['startLine'] as number) >= 0 &&
      Number.isSafeInteger(record['endLine']) &&
      (record['endLine'] as number) >= (record['startLine'] as number) &&
      (record['documentation'] === null || typeof record['documentation'] === 'string') &&
      (record['confidence'] === 'root' || record['confidence'] === 'candidate') &&
      Array.isArray(record['evidence']) &&
      record['evidence'].every((item) => typeof item === 'string') &&
      Number.isSafeInteger(record['indexedCallerCount']) &&
      (record['indexedCallerCount'] as number) >= 0
    );
  });
}

function isFilesResult(value: unknown): value is QueryServiceFileResult[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return typeof (entry as Record<string, unknown>)['relativePath'] === 'string';
  });
}

function isStatsResult(value: unknown): value is QueryServiceStatsTransportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isNonNegativeSafeInteger(record['documents']) &&
    isNonNegativeSafeInteger(record['symbols']) &&
    isNonNegativeSafeInteger(record['definitions']) &&
    isNonNegativeSafeInteger(record['references']) &&
    isNonNegativeSafeInteger(record['indexSizeBytes']) &&
    (record['lastBuilt'] === null || typeof record['lastBuilt'] === 'string')
  );
}

function isMembersResult(value: unknown): value is QueryServiceMembersTransportResult {
  if (!isSymbolResolutionResult(value)) return false;
  const members = (value as unknown as Record<string, unknown>)['members'];
  return Array.isArray(members) && members.every(isMemberResult);
}

function isSymbolResolutionResult(value: unknown): value is SymbolResolutionJson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record['matched'] === false) {
    return (
      record['resolved'] === undefined &&
      record['otherMatches'] === undefined &&
      record['totalMatches'] === undefined &&
      Array.isArray(record['suggestions']) &&
      record['suggestions'].every((suggestion) => typeof suggestion === 'string')
    );
  }
  return (
    record['matched'] === true &&
    isResolvedSymbol(record['resolved']) &&
    Array.isArray(record['otherMatches']) &&
    record['otherMatches'].every(isSymbolResolutionAlternative) &&
    isNonNegativeSafeInteger(record['totalMatches']) &&
    (record['totalMatches'] as number) >= 1 &&
    record['suggestions'] === undefined
  );
}

function isMethodsResult(value: unknown): value is MethodsResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['query'] !== 'string') return false;
  if (record['kind'] === 'missing') {
    return Array.isArray(record['suggestions']) && record['suggestions'].every((item) => typeof item === 'string');
  }
  if (record['kind'] === 'ambiguous') {
    return (
      isNonNegativeSafeInteger(record['total']) &&
      (record['total'] as number) > 1 &&
      Array.isArray(record['candidates']) &&
      record['candidates'].every(isMethodsCandidate)
    );
  }
  return (
    record['kind'] === 'matched' &&
    isMethodsOwner(record['owner']) &&
    Array.isArray(record['methods']) &&
    record['methods'].every(isMethodResult)
  );
}

function isFileDependenciesResult(value: unknown): value is DepResult[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return (
      typeof record['relativePath'] === 'string' &&
      (record['edgeBasis'] === undefined || record['edgeBasis'] === 'symbol-references') &&
      (record['evidence'] === undefined ||
        record['evidence'] === 'cross-file SCIP references plus resolved source imports')
    );
  });
}

function isImportedByResult(value: unknown): value is ImportResult[] {
  return Array.isArray(value) && value.every(isImportResult);
}

function isUnusedImportsResult(value: unknown): value is UnusedImportResult[] {
  return Array.isArray(value) && value.every(isUnusedImportResult);
}

function isUnusedImportResult(value: unknown): value is UnusedImportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['symbol'] === 'string' &&
    typeof record['shortName'] === 'string' &&
    typeof record['importedIn'] === 'string'
  );
}

function isImportResult(value: unknown): value is ImportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['symbol'] === 'string' &&
    typeof record['shortName'] === 'string' &&
    typeof record['fromFile'] === 'string'
  );
}

function isHierarchyResult(value: unknown): value is QueryServiceHierarchyTransportResult {
  if (!isSymbolResolutionResult(value)) return false;
  const hierarchy = (value as unknown as Record<string, unknown>)['hierarchy'];
  return Array.isArray(hierarchy) && hierarchy.every(isHierarchyNode);
}

function isHierarchyNode(value: unknown): value is HierarchyNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['symbol'] === 'string' &&
    typeof record['shortName'] === 'string' &&
    isNonNegativeSafeInteger(record['depth'])
  );
}

function isByKindResult(value: unknown): value is ByKindResult[] {
  return Array.isArray(value) && value.every(isByKindRow);
}

function isByKindRow(value: unknown): value is ByKindResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['symbol'] === 'string' &&
    typeof record['shortName'] === 'string' &&
    isNonNegativeSafeInteger(record['kind']) &&
    typeof record['kindName'] === 'string' &&
    typeof record['relativePath'] === 'string' &&
    isSourceRange(record)
  );
}

function isKindCountsResult(value: unknown): value is QueryServiceKindCountTransportResult[] {
  return Array.isArray(value) && value.every(isKindCountRow);
}

function isKindCountRow(value: unknown): value is QueryServiceKindCountTransportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isNonNegativeSafeInteger(record['kind']) &&
    typeof record['kindName'] === 'string' &&
    isNonNegativeSafeInteger(record['count'])
  );
}

function isRefsResult(value: unknown): value is QueryServiceRefsTransportResult {
  if (!isSymbolResolutionResult(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  const references = record['references'];
  const pagination = record['pagination'];
  if (!Array.isArray(references) || !references.every(isRefResult)) return false;
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) return false;
  const page = pagination as Record<string, unknown>;
  return (
    page['cursorVersion'] === 2 &&
    page['producer'] === 'complete-only' &&
    typeof page['semanticEnrichment'] === 'boolean'
  );
}

function isRefResult(value: unknown): value is RefResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record['relativePath'] === 'string' && isNonNegativeSafeInteger(record['line']);
}

function isSurfaceResult(value: unknown): value is ConsumerSurfaceResult[] {
  return Array.isArray(value) && value.every(isConsumerSurfaceResult);
}

function isConsumerSurfaceResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['consumer'] === 'string' &&
    typeof record['symbol'] === 'string' &&
    typeof record['shortName'] === 'string' &&
    record['basis'] === 'external-reference'
  );
}

function isMemberResult(value: unknown): value is MemberResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['symbol'] === 'string' &&
    typeof record['shortName'] === 'string' &&
    typeof record['kind'] === 'string' &&
    isSourceRange(record)
  );
}

function isMethodResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record['name'] === 'string' && isSourceRange(record);
}

function isMethodsOwner(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['symbol'] === 'string' &&
    typeof record['shortName'] === 'string' &&
    typeof record['relativePath'] === 'string' &&
    isSourceRange(record)
  );
}

function isResolvedSymbol(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['symbol'] === 'string' &&
    typeof record['shortName'] === 'string' &&
    typeof record['relativePath'] === 'string'
  );
}

function isSymbolResolutionAlternative(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['shortName'] === 'string' &&
    typeof record['relativePath'] === 'string' &&
    isNonNegativeSafeInteger(record['startLine']) &&
    record['symbol'] === undefined
  );
}

function isMethodsCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['symbol'] === 'string' &&
    typeof record['shortName'] === 'string' &&
    typeof record['relativePath'] === 'string' &&
    isNonNegativeSafeInteger(record['startLine'])
  );
}

function isSourceRange(record: Record<string, unknown>): boolean {
  return (
    isNonNegativeSafeInteger(record['startLine']) &&
    isNonNegativeSafeInteger(record['endLine']) &&
    (record['endLine'] as number) >= (record['startLine'] as number)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
      codeUnitStableJson({
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

function requestPoolSize(request: QueryServiceRequest): number {
  const configured = configuredPoolSize();
  if (request.kind === 'value-flow') return Math.min(configured, QUERY_SERVICE_VALUE_FLOW_POOL_SIZE);
  if (request.kind === 'dependence-slice') return Math.min(configured, QUERY_SERVICE_DEPENDENCE_SLICE_POOL_SIZE);
  if (request.kind === 'call-graph') return Math.min(configured, QUERY_SERVICE_CALL_GRAPH_POOL_SIZE);
  if (request.kind === 'system') return Math.min(configured, QUERY_SERVICE_SYSTEM_POOL_SIZE);
  if (request.kind === 'reference-reachability' || request.kind === 'slice') {
    return Math.min(configured, QUERY_SERVICE_REFERENCE_REACHABILITY_POOL_SIZE);
  }
  if (
    request.kind === 'refs' ||
    request.kind === 'trace' ||
    request.kind === 'reference-neighborhood' ||
    request.kind === 'dataflow' ||
    request.kind === 'imports' ||
    request.kind === 'unused-imports'
  ) {
    return Math.min(configured, QUERY_SERVICE_SEMANTIC_NAVIGATION_POOL_SIZE);
  }
  return request.kind === 'imported-by' ||
    request.kind === 'hierarchy' ||
    request.kind === 'by-kind' ||
    request.kind === 'kind-counts'
    ? Math.min(configured, QUERY_SERVICE_CATALOG_POOL_SIZE)
    : configured;
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
