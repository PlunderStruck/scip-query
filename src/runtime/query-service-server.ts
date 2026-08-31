import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { boundedExponentialLoopDelayMs, monotonicNowMs } from '../domain/time.js';
import { createPathChangeWake } from '../platform/path-change-wake.js';
import { readProcessIdentity } from '../platform/process-identity.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import { tryAcquireProcessFileLock } from '../platform/process-file-lock.js';
import { outline } from '../queries/navigation/outline.js';
import { searchSource } from '../queries/navigation/source-search.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../domain/source-inspection-limits.js';
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
import { isLargeCommandIndex } from './cli-support.js';
import { buildObservationReceipt } from './observation-receipt.js';
import {
  QUERY_SERVICE_HEARTBEAT_INTERVAL_MS,
  QUERY_SERVICE_PROTOCOL_VERSION,
  queryServiceSessionIdentity,
  type QueryServiceEnvelope,
  type QueryServiceSerializedResult,
  type QueryServiceServerState,
} from './query-service.js';

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5;
const MAX_IDLE_POLL_INTERVAL_MS = 100;
const SERIALIZED_RESULT_CACHE_MAX_BYTES = 1024 * 1024;
const TRACE_SERIALIZED_RESULT_CACHE_MAX_BYTES = 1280 * 1024;
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
  const mailboxWake = createPathChangeWake([paths.pendingDir, paths.legacyRequestDir]);
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
    if (!durable && now - lastHeartbeatAtMs < QUERY_SERVICE_HEARTBEAT_INTERVAL_MS) return;
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
      const processed = await processRequests(paths, db, sessionIdentity, () => {
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
      await mailboxWake.wait(loopDelayMs(processed, consecutiveIdlePolls));
    }
  } finally {
    mailboxWake.close();
    db.close();
    rmSync(statePath, { force: true });
    lockResult.lock.release();
  }
}

async function processRequests(
  paths: ReturnType<typeof boundedMailboxPaths>,
  db: ReturnType<typeof openProjectDb>,
  sessionIdentity: string,
  onGenerationMismatch: () => void,
): Promise<number> {
  const claims = pollBoundedMailboxRequests(paths, {
    ownerId: QUERY_SERVICE_MAILBOX_OWNER,
    nowMs: Date.now(),
    limits: MAILBOX_LIMITS,
    owner: QUERY_SERVICE_MAILBOX_PROCESS_OWNER,
    liveness: QUERY_SERVICE_MAILBOX_LIVENESS,
    durability: 'visibility',
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
          { nowMs: Date.now(), limits: MAILBOX_LIMITS, durability: 'visibility' },
        );
        onGenerationMismatch();
        processed += 1;
        continue;
      }
      const result = await executeRequest(db, envelope.request);
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
        { nowMs: completedAtMs, limits: MAILBOX_LIMITS, durability: 'visibility' },
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

async function executeRequest(
  db: ReturnType<typeof openProjectDb>,
  request: QueryServiceEnvelope['request'],
): Promise<unknown> {
  if (request.kind === 'source-search') return searchSource(db, request.pattern, request.options);
  if (request.kind === 'outline') return outline(db, request.filePattern);
  if (request.kind === 'entrypoints') {
    const { entryPoints } = await import('../queries/graph/entry-map.js');
    return entryPoints(db, request.options);
  }
  if (request.kind === 'files') {
    const { files } = await import('../queries/navigation/files.js');
    return files(db, request.pattern);
  }
  if (request.kind === 'stats') {
    const { stats } = await import('../queries/navigation/stats.js');
    return stats(db);
  }
  if (request.kind === 'members') {
    const [{ members }, { symbolResolutionJson }] = await Promise.all([
      import('../queries/navigation/members.js'),
      import('../queries/navigation/code-result-json.js'),
    ]);
    return { ...symbolResolutionJson(db, request.symbolPattern), members: members(db, request.symbolPattern) };
  }
  if (request.kind === 'methods') {
    const { resolveMethods } = await import('../queries/navigation/methods.js');
    return resolveMethods(db, { className: request.className });
  }
  if (request.kind === 'file-dependencies') {
    const { deps, rdeps } = await import('../queries/navigation/deps.js');
    return request.direction === 'outgoing' ? deps(db, request.filePattern) : rdeps(db, request.filePattern);
  }
  if (request.kind === 'imported-by') {
    const { importedBy } = await import('../queries/navigation/imports.js');
    return importedBy(db, request.symbolPattern);
  }
  if (request.kind === 'hierarchy') {
    const [{ hierarchy }, { withSymbolResolutionJson }] = await Promise.all([
      import('../queries/navigation/hierarchy.js'),
      import('./query-commands/symbol-resolution.js'),
    ]);
    return withSymbolResolutionJson(db, request.symbolPattern, hierarchy(db, request.symbolPattern), 'hierarchy');
  }
  if (request.kind === 'by-kind' || request.kind === 'kind-counts') {
    const { byKind, kindCounts } = await import('../queries/navigation/by-kind.js');
    return request.kind === 'by-kind' ? byKind(db, request.kindQuery) : kindCounts(db);
  }
  if (request.kind === 'refs') {
    const [{ refs }, { compareReferenceKey }, { withSymbolResolutionJson }] = await Promise.all([
      import('../queries/navigation/refs.js'),
      import('./refs-pagination.js'),
      import('./query-commands/symbol-resolution.js'),
    ]);
    const semantic = defaultSemanticEnrichment(db);
    const rows = refs(db, request.symbolPattern, { semantic }).sort(compareReferenceKey);
    return {
      ...withSymbolResolutionJson(db, request.symbolPattern, rows, 'references'),
      pagination: { cursorVersion: 2, producer: 'complete-only', semanticEnrichment: semantic },
    };
  }
  if (request.kind === 'trace') {
    const semantic = defaultSemanticEnrichment(db);
    if (!semantic) {
      const cached = cachedSerializedResult(db, request.kind, request.symbolPattern);
      if (cached) return cached;
    }
    const [{ qualifiedTraceEvidence }, { symbolResolutionJson }] = await Promise.all([
      import('../queries/navigation/trace.js'),
      import('./query-commands/symbol-resolution.js'),
    ]);
    const serializedJson = JSON.stringify({
      ...symbolResolutionJson(db, request.symbolPattern),
      ...qualifiedTraceEvidence(db, request.symbolPattern, { semantic }),
    });
    const result = {
      serializedJson,
      sha256: createHash('sha256').update(serializedJson).digest('hex'),
    };
    if (!semantic) {
      retainSerializedResult(db, request.kind, request.symbolPattern, result, TRACE_SERIALIZED_RESULT_CACHE_MAX_BYTES);
    }
    return result;
  }
  if (request.kind === 'value-flow') {
    const cached = cachedSerializedResult(db, request.kind, request.symbolPattern);
    if (cached) return cached;
    const { valueFlow } = await import('../queries/graph/value-flow.js');
    const serializedJson = JSON.stringify(
      valueFlow(db, { symbols: [request.symbolPattern] }, { maxDepth: 2, maxEdges: 48 }),
    );
    const result = {
      serializedJson,
      sha256: createHash('sha256').update(serializedJson).digest('hex'),
    };
    retainSerializedResult(db, request.kind, request.symbolPattern, result);
    return result;
  }
  if (request.kind === 'dependence-slice') {
    const cached = cachedSerializedResult(db, request.kind, request.criterion);
    if (cached) return cached;
    const { dependenceSlice } = await import('../queries/graph/dependence-slice.js');
    const serializedJson = JSON.stringify(dependenceSlice(db, request.criterion));
    const result = {
      serializedJson,
      sha256: createHash('sha256').update(serializedJson).digest('hex'),
    };
    retainSerializedResult(db, request.kind, request.criterion, result);
    return result;
  }
  if (request.kind === 'call-graph') {
    const [{ callGraph }, { symbolResolutionJson }] = await Promise.all([
      import('../queries/navigation/call-graph.js'),
      import('./query-commands/symbol-resolution.js'),
    ]);
    const serializedJson = JSON.stringify({
      ...symbolResolutionJson(db, request.symbolPattern),
      callGraph: callGraph(db, request.symbolPattern, { semantic: defaultSemanticEnrichment(db) }),
    });
    return {
      serializedJson,
      sha256: createHash('sha256').update(serializedJson).digest('hex'),
    };
  }
  if (request.kind === 'reference-neighborhood' || request.kind === 'dataflow') {
    const semantic = defaultSemanticEnrichment(db);
    const cacheable = request.kind === 'reference-neighborhood' && !semantic;
    if (cacheable) {
      const cached = cachedSerializedResult(db, request.kind, request.symbolPattern);
      if (cached) return cached;
    }
    const [{ dataflow, referenceNeighborhood }, { symbolResolutionJson }] = await Promise.all([
      import('../queries/navigation/dataflow.js'),
      import('./query-commands/symbol-resolution.js'),
    ]);
    const payload =
      request.kind === 'dataflow'
        ? dataflow(db, request.symbolPattern, { semantic })
        : referenceNeighborhood(db, request.symbolPattern, { semantic });
    const serializedJson = JSON.stringify({
      ...symbolResolutionJson(db, request.symbolPattern),
      [request.kind]: payload,
    });
    const result = {
      serializedJson,
      sha256: createHash('sha256').update(serializedJson).digest('hex'),
    };
    if (cacheable) retainSerializedResult(db, request.kind, request.symbolPattern, result);
    return result;
  }
  if (request.kind === 'reference-reachability' || request.kind === 'slice') {
    const semantic = defaultSemanticEnrichment(db);
    if (!semantic) {
      const cached = cachedSerializedResult(db, request.kind, request.symbolPattern);
      if (cached) return cached;
    }
    const [{ referenceReachability }, { symbolResolutionJson }] = await Promise.all([
      import('../queries/navigation/slice.js'),
      import('./query-commands/symbol-resolution.js'),
    ]);
    const serializedJson = JSON.stringify({
      ...symbolResolutionJson(db, request.symbolPattern),
      [request.kind]: referenceReachability(db, request.symbolPattern, {
        semantic,
      }),
    });
    const result = {
      serializedJson,
      sha256: createHash('sha256').update(serializedJson).digest('hex'),
    };
    if (!semantic) retainSerializedResult(db, request.kind, request.symbolPattern, result);
    return result;
  }
  if (request.kind === 'imports') {
    const { imports } = await import('../queries/navigation/imports.js');
    return imports(db, request.filePattern, { semantic: defaultSemanticEnrichment(db) });
  }
  if (request.kind === 'unused-imports') {
    const { unusedImports } = await import('../queries/navigation/imports.js');
    return unusedImports(db, request.filePattern, { semantic: defaultSemanticEnrichment(db) });
  }
  if (request.kind === 'system') {
    const cached = cachedSerializedResult(db, request.kind, request.modulePattern);
    if (cached) return cached;
    const { system } = await import('../queries/navigation/system.js');
    const serializedJson = JSON.stringify(system(db, request.modulePattern));
    const result = {
      serializedJson,
      sha256: createHash('sha256').update(serializedJson).digest('hex'),
    };
    retainSerializedResult(db, request.kind, request.modulePattern, result);
    return result;
  }
  if (request.kind === 'surface') {
    const { consumerSurface } = await import('../queries/navigation/surface.js');
    return consumerSurface(db, request.modulePattern);
  }
  const [{ codeBatch }, { codeBatchResultOnlyJsonForSelectors }] = await Promise.all([
    import('../queries/navigation/code.js'),
    import('../queries/navigation/code-result-json.js'),
  ]);
  const result = codeBatch(db, request.selectors, request.options);
  const serializedJson = JSON.stringify(codeBatchResultOnlyJsonForSelectors(db, request.selectors, result));
  return {
    serializedJson,
    sha256: createHash('sha256').update(serializedJson).digest('hex'),
  };
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
  if (typeof requestRecord['expectedGeneration'] !== 'string') {
    throw new Error('Invalid query service request generation.');
  }
  const envelope = {
    mailboxVersion: 1,
    protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
    id: record['id'],
    operationKey: record['operationKey'],
    clientId: record['clientId'],
    enqueuedAtMs: record['enqueuedAtMs'],
    deadlineAtMs: record['deadlineAtMs'],
    sessionIdentity: expectedSessionIdentity,
  } as const;
  if (requestRecord['kind'] === 'outline') {
    if (typeof requestRecord['filePattern'] !== 'string') {
      throw new Error('Invalid query service outline request.');
    }
    return {
      ...envelope,
      request: {
        kind: 'outline',
        expectedGeneration: requestRecord['expectedGeneration'],
        filePattern: requestRecord['filePattern'],
      },
    };
  }
  if (requestRecord['kind'] === 'files') {
    if (typeof requestRecord['pattern'] !== 'string') {
      throw new Error('Invalid query service files request.');
    }
    return {
      ...envelope,
      request: {
        kind: 'files',
        expectedGeneration: requestRecord['expectedGeneration'],
        pattern: requestRecord['pattern'],
      },
    };
  }
  if (requestRecord['kind'] === 'stats') {
    return {
      ...envelope,
      request: {
        kind: 'stats',
        expectedGeneration: requestRecord['expectedGeneration'],
      },
    };
  }
  if (requestRecord['kind'] === 'members') {
    if (typeof requestRecord['symbolPattern'] !== 'string') {
      throw new Error('Invalid query service members request.');
    }
    return {
      ...envelope,
      request: {
        kind: 'members',
        expectedGeneration: requestRecord['expectedGeneration'],
        symbolPattern: requestRecord['symbolPattern'],
      },
    };
  }
  if (requestRecord['kind'] === 'methods') {
    if (typeof requestRecord['className'] !== 'string') {
      throw new Error('Invalid query service methods request.');
    }
    return {
      ...envelope,
      request: {
        kind: 'methods',
        expectedGeneration: requestRecord['expectedGeneration'],
        className: requestRecord['className'],
      },
    };
  }
  if (requestRecord['kind'] === 'file-dependencies') {
    if (
      (requestRecord['direction'] !== 'outgoing' && requestRecord['direction'] !== 'incoming') ||
      typeof requestRecord['filePattern'] !== 'string'
    ) {
      throw new Error('Invalid query service file dependencies request.');
    }
    return {
      ...envelope,
      request: {
        kind: 'file-dependencies',
        expectedGeneration: requestRecord['expectedGeneration'],
        direction: requestRecord['direction'],
        filePattern: requestRecord['filePattern'],
      },
    };
  }
  if (
    requestRecord['kind'] === 'imported-by' ||
    requestRecord['kind'] === 'hierarchy' ||
    requestRecord['kind'] === 'refs' ||
    requestRecord['kind'] === 'trace' ||
    requestRecord['kind'] === 'value-flow' ||
    requestRecord['kind'] === 'call-graph' ||
    requestRecord['kind'] === 'reference-neighborhood' ||
    requestRecord['kind'] === 'reference-reachability' ||
    requestRecord['kind'] === 'slice' ||
    requestRecord['kind'] === 'dataflow'
  ) {
    if (typeof requestRecord['symbolPattern'] !== 'string') {
      throw new Error(`Invalid query service ${requestRecord['kind']} request.`);
    }
    return {
      ...envelope,
      request: {
        kind: requestRecord['kind'],
        expectedGeneration: requestRecord['expectedGeneration'],
        symbolPattern: requestRecord['symbolPattern'],
      },
    };
  }
  if (requestRecord['kind'] === 'dependence-slice') {
    if (typeof requestRecord['criterion'] !== 'string') {
      throw new Error('Invalid query service dependence-slice request.');
    }
    return {
      ...envelope,
      request: {
        kind: 'dependence-slice',
        expectedGeneration: requestRecord['expectedGeneration'],
        criterion: requestRecord['criterion'],
      },
    };
  }
  if (requestRecord['kind'] === 'by-kind') {
    if (typeof requestRecord['kindQuery'] !== 'string') {
      throw new Error('Invalid query service by-kind request.');
    }
    return {
      ...envelope,
      request: {
        kind: 'by-kind',
        expectedGeneration: requestRecord['expectedGeneration'],
        kindQuery: requestRecord['kindQuery'],
      },
    };
  }
  if (requestRecord['kind'] === 'kind-counts') {
    return {
      ...envelope,
      request: { kind: 'kind-counts', expectedGeneration: requestRecord['expectedGeneration'] },
    };
  }
  if (requestRecord['kind'] === 'imports' || requestRecord['kind'] === 'unused-imports') {
    if (typeof requestRecord['filePattern'] !== 'string') {
      throw new Error(`Invalid query service ${requestRecord['kind']} request.`);
    }
    return {
      ...envelope,
      request: {
        kind: requestRecord['kind'],
        expectedGeneration: requestRecord['expectedGeneration'],
        filePattern: requestRecord['filePattern'],
      },
    };
  }
  if (requestRecord['kind'] === 'system' || requestRecord['kind'] === 'surface') {
    if (typeof requestRecord['modulePattern'] !== 'string') {
      throw new Error(`Invalid query service ${requestRecord['kind']} request.`);
    }
    return {
      ...envelope,
      request: {
        kind: requestRecord['kind'],
        expectedGeneration: requestRecord['expectedGeneration'],
        modulePattern: requestRecord['modulePattern'],
      },
    };
  }
  if (requestRecord['kind'] === 'code') {
    if (
      !Array.isArray(requestRecord['selectors']) ||
      requestRecord['selectors'].length < 1 ||
      requestRecord['selectors'].length > SOURCE_INSPECTION_MAX_SELECTORS ||
      requestRecord['selectors'].some((selector) => typeof selector !== 'string' || selector.length === 0) ||
      !requestRecord['options'] ||
      typeof requestRecord['options'] !== 'object' ||
      Array.isArray(requestRecord['options'])
    ) {
      throw new Error('Invalid query service code request.');
    }
    const optionsRecord = requestRecord['options'] as Record<string, unknown>;
    const members = optionsRecord['members'];
    if (members !== 'exported' && members !== 'all') {
      throw new Error('Query service code members must be exported or all.');
    }
    return {
      ...envelope,
      request: {
        kind: 'code',
        expectedGeneration: requestRecord['expectedGeneration'],
        selectors: requestRecord['selectors'] as string[],
        options: {
          context: requiredNonNegativeInteger(optionsRecord['context'], 'context'),
          members,
        },
      },
    };
  }
  if (requestRecord['kind'] === 'entrypoints') {
    if (
      !requestRecord['options'] ||
      typeof requestRecord['options'] !== 'object' ||
      Array.isArray(requestRecord['options'])
    ) {
      throw new Error('Invalid query service entrypoints request.');
    }
    const optionsRecord = requestRecord['options'] as Record<string, unknown>;
    return {
      ...envelope,
      request: {
        kind: 'entrypoints',
        expectedGeneration: requestRecord['expectedGeneration'],
        options: {
          ...(optionsRecord['search'] === undefined
            ? {}
            : { search: requiredString(optionsRecord['search'], 'search') }),
          ...(optionsRecord['scope'] === undefined ? {} : { scope: requiredString(optionsRecord['scope'], 'scope') }),
        },
      },
    };
  }
  if (
    requestRecord['kind'] !== 'source-search' ||
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
    ...envelope,
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

const semanticEnrichmentByDb = new WeakMap<object, boolean>();
type SerializedResultCacheKind =
  | 'dependence-slice'
  | 'reference-neighborhood'
  | 'reference-reachability'
  | 'slice'
  | 'system'
  | 'trace'
  | 'value-flow';
const serializedResultByDb = new WeakMap<
  object,
  {
    kind: SerializedResultCacheKind;
    operand: string;
    result: QueryServiceSerializedResult;
  }
>();

function cachedSerializedResult(
  db: ReturnType<typeof openProjectDb>,
  kind: SerializedResultCacheKind,
  operand: string,
): QueryServiceSerializedResult | null {
  const cached = serializedResultByDb.get(db);
  return cached?.kind === kind && cached.operand === operand ? cached.result : null;
}

function retainSerializedResult(
  db: ReturnType<typeof openProjectDb>,
  kind: SerializedResultCacheKind,
  operand: string,
  result: QueryServiceSerializedResult,
  maxBytes = SERIALIZED_RESULT_CACHE_MAX_BYTES,
): void {
  if (Buffer.byteLength(result.serializedJson) <= maxBytes) {
    serializedResultByDb.set(db, { kind, operand, result });
  }
}

function defaultSemanticEnrichment(db: ReturnType<typeof openProjectDb>): boolean {
  const cached = semanticEnrichmentByDb.get(db);
  if (cached !== undefined) return cached;
  const semantic = !isLargeCommandIndex(db);
  semanticEnrichmentByDb.set(db, semantic);
  return semantic;
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
  return boundedExponentialLoopDelayMs(
    processedRequests,
    consecutiveIdlePolls,
    POLL_INTERVAL_MS,
    POLL_INTERVAL_MS,
    MAX_IDLE_POLL_INTERVAL_MS,
    5,
  );
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
