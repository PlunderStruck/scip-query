import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { parsePositiveInteger } from '../../domain/number-parsing.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { profileEnabled, profileSpan, writeProfileEvent } from '../../instrumentation/profile.js';
import type { SemanticCallee, SemanticReference } from '../types.js';
import type { RustImportDefinitionResolver } from './import-usage.js';
import type {
  RustCalleeResolution,
  RustCalleeResolver,
  RustReferenceResolution,
  RustReferenceResolver,
  RustSignatureResolution,
  RustSignatureResolver,
} from './provider.js';
import type { RustSemanticStatus } from './status.js';
import type { RustReferenceWorkerRequest, RustReferenceWorkerResponse } from './lsp-batch-worker.js';
import { createDurableRustAnalyzerSessionRequester } from './durable-session.js';

export interface RustAnalyzerSessionRequester {
  requestSemantic(request: RustReferenceWorkerRequest, timeoutMs: number): RustReferenceWorkerResponse;
  requestImportDefinitions(
    request: RustImportDefinitionWorkerRequest,
    timeoutMs: number,
  ): RustImportDefinitionWorkerResponse;
  shutdown(): void;
}

export interface RustImportDefinitionPosition {
  id: string;
  file: string;
  line: number;
  column: number;
}

export interface RustImportDefinitionWorkerRequest {
  projectRoot: string;
  rustAnalyzerBinary: string;
  file: string;
  positions: RustImportDefinitionPosition[];
  requestTimeoutMs?: number;
  readinessDeadlineMs?: number;
  diagnosticsTimeoutMs?: number;
  settleDelayMs?: number;
  concurrency?: number;
}

export interface RustImportDefinitionWorkerResponse {
  available: boolean;
  reason?: string;
  sourcePaths: Array<[string, string | null]>;
}

export interface RustImportDefinitionResolution {
  available: boolean;
  reason?: string;
  resolvedBinary?: string;
  sourcePaths: Map<string, string | null>;
}

export interface RustAnalyzerSessionResolverOptions {
  requester?: RustAnalyzerSessionRequester;
  fallbackReferenceResolver?: RustReferenceResolver;
  fallbackCalleeResolver?: RustCalleeResolver;
  fallbackSignatureResolver?: RustSignatureResolver;
}

export interface RustCombinedSemanticResolution {
  available: boolean;
  reason?: string;
  resolvedBinary?: string;
  references: Map<number, SemanticReference[]>;
  callees: Map<number, SemanticCallee[]>;
}

const DEFAULT_RUST_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RUST_CONCURRENCY = 8;
const DEFAULT_RUST_SETTLE_DELAY_MS = 5_000;
const SMALL_REFERENCE_BATCH_SETTLE_THRESHOLD = 64;
const SMALL_COMBINED_REFERENCE_BATCH_SETTLE_THRESHOLD = 96;

interface RustSemanticSettleDelayRequest {
  definitionCount: number;
  includeReferences?: boolean;
  includeCallees?: boolean;
  includeSignatures?: boolean;
}

type RustSessionRequestFlags = Pick<
  RustReferenceWorkerRequest,
  'includeReferences' | 'includeCallees' | 'includeSignatures'
> & {
  referenceDefinitions?: readonly IndexedDefinition[];
  calleeDefinitions?: readonly IndexedDefinition[];
  signatureDefinitions?: readonly IndexedDefinition[];
};

export class RustAnalyzerSessionResolver
  implements RustReferenceResolver, RustCalleeResolver, RustSignatureResolver, RustImportDefinitionResolver
{
  private readonly requester: RustAnalyzerSessionRequester;

  constructor(
    private readonly projectRoot: string,
    private readonly status: (projectRoot: string) => RustSemanticStatus,
    private readonly opts: RustAnalyzerSessionResolverOptions = {},
  ) {
    this.requester =
      opts.requester ??
      createConfiguredRustAnalyzerSessionRequester(projectRoot, process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION']);
  }

  referencesForDefinitions(definitions: readonly IndexedDefinition[]): RustReferenceResolution {
    const baseStatus = this.status(this.projectRoot);
    if (!baseStatus.available || !baseStatus.resolvedBinary) {
      return {
        available: false,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: baseStatus.reason,
        references: emptyReferenceMap(definitions),
      };
    }

    try {
      const response = this.requestSession(baseStatus.resolvedBinary, definitions, {
        includeReferences: true,
      });
      return {
        available: response.available,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: response.reason,
        references: completeReferenceMap(
          definitions,
          new Map(response.references),
          new Set(response.incompleteReferenceSymbolIds ?? []),
        ),
      };
    } catch (error) {
      return (
        this.opts.fallbackReferenceResolver?.referencesForDefinitions(definitions) ?? {
          available: false,
          resolvedBinary: baseStatus.resolvedBinary,
          reason: error instanceof Error ? error.message : String(error),
          references: emptyReferenceMap(definitions),
        }
      );
    }
  }

  calleesForDefinitions(definitions: readonly IndexedDefinition[]): RustCalleeResolution {
    const baseStatus = this.status(this.projectRoot);
    if (!baseStatus.available || !baseStatus.resolvedBinary) {
      return {
        available: false,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: baseStatus.reason,
        callees: emptyCalleeMap(definitions),
      };
    }

    try {
      const response = this.requestSession(baseStatus.resolvedBinary, definitions, {
        includeReferences: false,
        includeCallees: true,
      });
      return {
        available: response.available,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: response.reason,
        callees: completeCalleeMap(definitions, new Map(response.callees ?? [])),
      };
    } catch (error) {
      return (
        this.opts.fallbackCalleeResolver?.calleesForDefinitions(definitions) ?? {
          available: false,
          resolvedBinary: baseStatus.resolvedBinary,
          reason: error instanceof Error ? error.message : String(error),
          callees: emptyCalleeMap(definitions),
        }
      );
    }
  }

  referencesAndCalleesForDefinitions(
    referenceDefinitions: readonly IndexedDefinition[],
    calleeDefinitions: readonly IndexedDefinition[],
  ): RustCombinedSemanticResolution {
    const baseStatus = this.status(this.projectRoot);
    if (!baseStatus.available || !baseStatus.resolvedBinary) {
      return {
        available: false,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: baseStatus.reason,
        references: emptyReferenceMap(referenceDefinitions),
        callees: emptyCalleeMap(calleeDefinitions),
      };
    }

    const sessionDefinitions = [...referenceDefinitions, ...calleeDefinitions];
    try {
      const response = this.requestSession(baseStatus.resolvedBinary, sessionDefinitions, {
        includeReferences: referenceDefinitions.length > 0,
        includeCallees: calleeDefinitions.length > 0,
        referenceDefinitions,
        calleeDefinitions,
      });
      return {
        available: response.available,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: response.reason,
        references: completeReferenceMap(
          referenceDefinitions,
          new Map(response.references),
          new Set(response.incompleteReferenceSymbolIds ?? []),
        ),
        callees: completeCalleeMap(calleeDefinitions, new Map(response.callees ?? [])),
      };
    } catch (error) {
      return this.fallbackReferencesAndCallees(baseStatus, referenceDefinitions, calleeDefinitions, error);
    }
  }

  signaturesForDefinitions(definitions: readonly IndexedDefinition[]): RustSignatureResolution {
    const baseStatus = this.status(this.projectRoot);
    if (!baseStatus.available || !baseStatus.resolvedBinary) {
      return {
        available: false,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: baseStatus.reason,
        signatures: emptySignatureMap(definitions),
      };
    }

    try {
      const response = this.requestSession(baseStatus.resolvedBinary, definitions, {
        includeReferences: false,
        includeCallees: false,
        includeSignatures: true,
      });
      return {
        available: response.available,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: response.reason,
        signatures: completeSignatureMap(definitions, new Map(response.signatures ?? [])),
      };
    } catch (error) {
      return (
        this.opts.fallbackSignatureResolver?.signaturesForDefinitions(definitions) ?? {
          available: false,
          resolvedBinary: baseStatus.resolvedBinary,
          reason: error instanceof Error ? error.message : String(error),
          signatures: emptySignatureMap(definitions),
        }
      );
    }
  }

  importDefinitionsForFile(
    file: string,
    positions: readonly RustImportDefinitionPosition[],
  ): RustImportDefinitionResolution {
    const baseStatus = this.status(this.projectRoot);
    if (positions.length === 0) {
      return {
        available: baseStatus.available,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: baseStatus.reason,
        sourcePaths: new Map(),
      };
    }
    if (!baseStatus.available || !baseStatus.resolvedBinary) {
      return {
        available: false,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: baseStatus.reason,
        sourcePaths: new Map(positions.map((position) => [position.id, null])),
      };
    }

    try {
      const response = this.requestImportDefinitions(baseStatus.resolvedBinary, file, positions);
      return {
        available: response.available,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: response.reason,
        sourcePaths: new Map(response.sourcePaths),
      };
    } catch (error) {
      return {
        available: false,
        resolvedBinary: baseStatus.resolvedBinary,
        reason: error instanceof Error ? error.message : String(error),
        sourcePaths: new Map(positions.map((position) => [position.id, null])),
      };
    }
  }

  dispose(): void {
    this.requester.shutdown();
  }

  private requestSession(
    rustAnalyzerBinary: string,
    definitions: readonly IndexedDefinition[],
    flags: RustSessionRequestFlags,
  ): RustReferenceWorkerResponse {
    const requestTimeoutMs = configuredPositiveInteger(
      process.env['SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS'],
      DEFAULT_RUST_REQUEST_TIMEOUT_MS,
    );
    const referenceRetryTimeoutMs = configuredNonNegativeInteger(
      process.env['SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS'],
      0,
    );
    const concurrency = configuredPositiveInteger(
      process.env['SCIP_RUST_SEMANTIC_CONCURRENCY'],
      DEFAULT_RUST_CONCURRENCY,
    );
    const diagnosticsTimeoutMs = configuredNonNegativeInteger(
      process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
      Math.min(requestTimeoutMs, 10_000),
    );
    const referenceDefinitions = flags.referenceDefinitions ? [...flags.referenceDefinitions] : undefined;
    const calleeDefinitions = flags.calleeDefinitions ? [...flags.calleeDefinitions] : undefined;
    const signatureDefinitions = flags.signatureDefinitions ? [...flags.signatureDefinitions] : undefined;
    const settleDelayMs = rustSemanticSettleDelayMs(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'], {
      definitionCount: definitions.length,
      ...flags,
    });
    const request: RustReferenceWorkerRequest = {
      projectRoot: this.projectRoot,
      rustAnalyzerBinary,
      definitions: [...definitions],
      ...(referenceDefinitions ? { referenceDefinitions } : {}),
      ...(calleeDefinitions ? { calleeDefinitions } : {}),
      ...(signatureDefinitions ? { signatureDefinitions } : {}),
      requestTimeoutMs,
      ...(flags.includeReferences !== false && referenceRetryTimeoutMs > 0 ? { referenceRetryTimeoutMs } : {}),
      diagnosticsTimeoutMs,
      settleDelayMs,
      concurrency,
      includeReferences: flags.includeReferences,
      includeCallees: flags.includeCallees,
      includeSignatures: flags.includeSignatures,
    };
    const operationDefinitionCount = rustSessionOperationDefinitionCount(request);
    return profileSpan(
      'rust.semantic.session.request',
      () =>
        this.requester.requestSemantic(
          request,
          configuredBatchTimeoutMs(
            operationDefinitionCount,
            rustSessionRequestTimeoutBudgetMs(requestTimeoutMs, request.referenceRetryTimeoutMs),
            concurrency,
          ),
        ),
      () => ({
        definitions: definitions.length,
        operationDefinitions: operationDefinitionCount,
        referenceDefinitions: request.referenceDefinitions?.length,
        calleeDefinitions: request.calleeDefinitions?.length,
        signatureDefinitions: request.signatureDefinitions?.length,
        references: request.includeReferences !== false,
        callees: request.includeCallees === true,
        signatures: request.includeSignatures === true,
        referenceRetryTimeoutMs: request.referenceRetryTimeoutMs,
      }),
    );
  }

  private fallbackReferencesAndCallees(
    baseStatus: RustSemanticStatus,
    referenceDefinitions: readonly IndexedDefinition[],
    calleeDefinitions: readonly IndexedDefinition[],
    error: unknown,
  ): RustCombinedSemanticResolution {
    const referenceResolution =
      referenceDefinitions.length === 0
        ? { available: true, references: emptyReferenceMap(referenceDefinitions) }
        : this.opts.fallbackReferenceResolver?.referencesForDefinitions(referenceDefinitions);
    const calleeResolution =
      calleeDefinitions.length === 0
        ? { available: true, callees: emptyCalleeMap(calleeDefinitions) }
        : this.opts.fallbackCalleeResolver?.calleesForDefinitions(calleeDefinitions);
    if (referenceResolution && calleeResolution) {
      return {
        available: referenceResolution.available && calleeResolution.available,
        resolvedBinary:
          referenceResolution.resolvedBinary ?? calleeResolution.resolvedBinary ?? baseStatus.resolvedBinary,
        reason: referenceResolution.reason ?? calleeResolution.reason,
        references: completeReferenceMap(referenceDefinitions, referenceResolution.references),
        callees: completeCalleeMap(calleeDefinitions, calleeResolution.callees),
      };
    }
    return {
      available: false,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: error instanceof Error ? error.message : String(error),
      references: emptyReferenceMap(referenceDefinitions),
      callees: emptyCalleeMap(calleeDefinitions),
    };
  }

  private requestImportDefinitions(
    rustAnalyzerBinary: string,
    file: string,
    positions: readonly RustImportDefinitionPosition[],
  ): RustImportDefinitionWorkerResponse {
    const requestTimeoutMs = configuredPositiveInteger(
      process.env['SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS'],
      DEFAULT_RUST_REQUEST_TIMEOUT_MS,
    );
    const concurrency = configuredPositiveInteger(
      process.env['SCIP_RUST_SEMANTIC_CONCURRENCY'],
      DEFAULT_RUST_CONCURRENCY,
    );
    const diagnosticsTimeoutMs = configuredNonNegativeInteger(
      process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
      Math.min(requestTimeoutMs, 10_000),
    );
    const settleDelayMs = configuredNonNegativeInteger(
      process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'],
      DEFAULT_RUST_SETTLE_DELAY_MS,
    );
    const request: RustImportDefinitionWorkerRequest = {
      projectRoot: this.projectRoot,
      rustAnalyzerBinary,
      file,
      positions: [...positions],
      requestTimeoutMs,
      diagnosticsTimeoutMs,
      settleDelayMs,
      concurrency,
    };
    return profileSpan(
      'rust.semantic.import-definitions.session.request',
      () =>
        this.requester.requestImportDefinitions(
          request,
          configuredBatchTimeoutMs(positions.length, requestTimeoutMs, concurrency),
        ),
      () => ({
        file,
        positions: positions.length,
      }),
    );
  }
}

export function createRustAnalyzerSessionResolver(
  projectRoot: string,
  status: (projectRoot: string) => RustSemanticStatus,
  opts: RustAnalyzerSessionResolverOptions = {},
): RustAnalyzerSessionResolver {
  return new RustAnalyzerSessionResolver(projectRoot, status, opts);
}

export function rustSemanticSettleDelayMs(
  configuredValue: string | undefined,
  request: RustSemanticSettleDelayRequest,
): number {
  const configured = parseNonNegativeInteger(configuredValue);
  if (configured !== null) return configured;

  const includeReferences = request.includeReferences !== false;
  const referenceOnly = includeReferences && request.includeCallees !== true && request.includeSignatures !== true;
  if (referenceOnly && request.definitionCount <= SMALL_REFERENCE_BATCH_SETTLE_THRESHOLD) return 0;

  const combinedReferenceAndCallee =
    includeReferences && request.includeCallees === true && request.includeSignatures !== true;
  if (combinedReferenceAndCallee && request.definitionCount <= SMALL_COMBINED_REFERENCE_BATCH_SETTLE_THRESHOLD) {
    return 0;
  }
  return DEFAULT_RUST_SETTLE_DELAY_MS;
}

export function rustSemanticSessionTransport(configuredValue: string | undefined): 'worker' | 'durable' {
  return configuredValue === '1' || configuredValue === 'true' ? 'durable' : 'worker';
}

type RustSessionFailoverReason = 'readiness' | 'timeout' | 'helper' | 'request';
type RustSessionRequestKind = 'semantic' | 'import-definitions';

export function createFailoverRustAnalyzerSessionRequester(
  primary: RustAnalyzerSessionRequester,
  fallbackFactory: () => RustAnalyzerSessionRequester,
): RustAnalyzerSessionRequester {
  let fallback: RustAnalyzerSessionRequester | null = null;
  let failedOver = false;
  let primaryShutdown = false;
  let disposed = false;

  const currentFallback = (): RustAnalyzerSessionRequester => (fallback ??= fallbackFactory());
  const shutdownPrimary = (): void => {
    if (primaryShutdown) return;
    primary.shutdown();
    primaryShutdown = true;
  };
  const activateFailover = (error: unknown, kind: RustSessionRequestKind, durationMs: number): void => {
    const reason = rustSessionFailoverReason(error);
    failedOver = true;
    try {
      shutdownPrimary();
    } catch {
      // Cleanup failure must not prevent the latched fallback from serving the request.
    }
    if (profileEnabled()) {
      writeProfileEvent({
        type: 'span',
        name: 'rust.semantic.durable-session.request',
        durationMs,
        ok: false,
        kind,
        session: 'worker-fallback',
        reason,
      });
    }
  };
  const request = <Response>(
    kind: RustSessionRequestKind,
    requestPrimary: (requester: RustAnalyzerSessionRequester) => Response,
    requestFallback: (requester: RustAnalyzerSessionRequester) => Response,
  ): Response => {
    if (disposed) throw new Error('Rust semantic failover session was already disposed.');
    if (failedOver) return requestFallback(currentFallback());

    const startedAtMs = Date.now();
    try {
      return requestPrimary(primary);
    } catch (error) {
      activateFailover(error, kind, Date.now() - startedAtMs);
    }
    return requestFallback(currentFallback());
  };

  return {
    requestSemantic(semanticRequest, timeoutMs) {
      return request(
        'semantic',
        (requester) => requester.requestSemantic(semanticRequest, timeoutMs),
        (requester) => requester.requestSemantic(semanticRequest, timeoutMs),
      );
    },
    requestImportDefinitions(importRequest, timeoutMs) {
      return request(
        'import-definitions',
        (requester) => requester.requestImportDefinitions(importRequest, timeoutMs),
        (requester) => requester.requestImportDefinitions(importRequest, timeoutMs),
      );
    },
    shutdown() {
      if (disposed) return;
      disposed = true;
      const cleanupErrors: unknown[] = [];
      try {
        shutdownPrimary();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        fallback?.shutdown();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) throw cleanupErrors[0];
    },
  };
}

export function createConfiguredRustAnalyzerSessionRequester(
  projectRoot: string,
  configuredValue: string | undefined,
  factories: {
    worker(): RustAnalyzerSessionRequester;
    durable(): RustAnalyzerSessionRequester;
  } = {
    worker: () => createWorkerRustAnalyzerSessionRequester(),
    durable: () =>
      createDurableRustAnalyzerSessionRequester(projectRoot, {
        serverPath: fileURLToPath(rustSemanticSessionServerUrl()),
        semanticWorkerPath: fileURLToPath(rustSemanticSessionWorkerUrl()),
      }),
  },
): RustAnalyzerSessionRequester {
  return rustSemanticSessionTransport(configuredValue) === 'durable'
    ? createFailoverRustAnalyzerSessionRequester(factories.durable(), factories.worker)
    : factories.worker();
}

export function createWorkerRustAnalyzerSessionRequester(
  opts: { semanticWorkerPath?: string; shareEnvironment?: boolean } = {},
): RustAnalyzerSessionRequester {
  let worker: Worker | null = null;
  let resultDir: string | null = null;
  let nextRequestId = 1;
  let disposed = false;

  const cleanupResultDir = (): void => {
    if (!resultDir) return;
    rmSync(resultDir, { recursive: true, force: true });
    resultDir = null;
  };

  const terminate = (): void => {
    const currentWorker = worker;
    worker = null;
    if (currentWorker) void currentWorker.terminate();
    cleanupResultDir();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const workerUrl = opts.semanticWorkerPath ? pathToFileURL(opts.semanticWorkerPath) : rustSemanticSessionWorkerUrl();
    if (!existsSync(fileURLToPath(workerUrl))) {
      throw new Error(
        `Rust semantic session worker was not found at ${fileURLToPath(
          workerUrl,
        )}. Run npm run build before using built semantic Rust queries.`,
      );
    }
    resultDir = mkdtempSync(join(tmpdir(), 'scip-query-rust-session-'));
    worker = new Worker(workerUrl, opts.shareEnvironment ? { env: SHARE_ENV } : undefined);
    worker.unref();
    return worker;
  };

  const nextResponsePath = (): string => {
    const currentResultDir = resultDir ?? mkdtempSync(join(tmpdir(), 'scip-query-rust-session-'));
    resultDir = currentResultDir;
    return join(currentResultDir, `${nextRequestId++}.json`);
  };

  return {
    requestSemantic(request, timeoutMs) {
      if (disposed) {
        throw new Error('Rust semantic session was already disposed.');
      }
      const currentWorker = ensureWorker();
      const responsePath = nextResponsePath();
      const sharedBuffer = new SharedArrayBuffer(4);
      const signal = new Int32Array(sharedBuffer);

      currentWorker.postMessage({
        kind: 'semantic',
        request,
        responsePath,
        sharedBuffer,
      });

      const waitResult = Atomics.wait(signal, 0, 0, timeoutMs);
      if (waitResult === 'timed-out') {
        terminate();
        throw new Error(`Rust semantic session worker timed out after ${(timeoutMs / 1000).toFixed(0)}s`);
      }

      try {
        const payload = parseWorkerPayload(readFileSync(responsePath, 'utf8'));
        if (!payload.ok) throw new Error(payload.error);
        return payload.response;
      } finally {
        rmSync(responsePath, { force: true });
      }
    },
    requestImportDefinitions(request, timeoutMs) {
      if (disposed) {
        throw new Error('Rust semantic session was already disposed.');
      }
      const currentWorker = ensureWorker();
      const responsePath = nextResponsePath();
      const sharedBuffer = new SharedArrayBuffer(4);
      const signal = new Int32Array(sharedBuffer);

      currentWorker.postMessage({
        kind: 'import-definitions',
        request,
        responsePath,
        sharedBuffer,
      });

      const waitResult = Atomics.wait(signal, 0, 0, timeoutMs);
      if (waitResult === 'timed-out') {
        terminate();
        throw new Error(
          `Rust semantic import-definition session worker timed out after ${(timeoutMs / 1000).toFixed(0)}s`,
        );
      }

      try {
        const payload = parseImportDefinitionWorkerPayload(readFileSync(responsePath, 'utf8'));
        if (!payload.ok) throw new Error(payload.error);
        return payload.response;
      } finally {
        rmSync(responsePath, { force: true });
      }
    },
    shutdown() {
      if (disposed) return;
      disposed = true;
      if (!worker) {
        cleanupResultDir();
        return;
      }

      const responsePath = nextResponsePath();
      const sharedBuffer = new SharedArrayBuffer(4);
      const signal = new Int32Array(sharedBuffer);
      worker.postMessage({ kind: 'shutdown', responsePath, sharedBuffer });
      Atomics.wait(signal, 0, 0, 5_000);
      terminate();
    },
  };
}

type WorkerPayload = { ok: true; response: RustReferenceWorkerResponse } | { ok: false; error: string };
type ImportDefinitionWorkerPayload =
  | { ok: true; response: RustImportDefinitionWorkerResponse }
  | { ok: false; error: string };

function parseWorkerPayload(raw: string): WorkerPayload {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Rust semantic session worker wrote a non-object response.' };
  }
  const record = parsed as Partial<WorkerPayload>;
  if (record.ok === true && 'response' in record) {
    return { ok: true, response: record.response as RustReferenceWorkerResponse };
  }
  return {
    ok: false,
    error:
      typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : 'Rust semantic session worker failed.',
  };
}

function parseImportDefinitionWorkerPayload(raw: string): ImportDefinitionWorkerPayload {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Rust semantic session worker wrote a non-object response.' };
  }
  const record = parsed as Partial<ImportDefinitionWorkerPayload>;
  if (record.ok === true && 'response' in record) {
    return { ok: true, response: record.response as RustImportDefinitionWorkerResponse };
  }
  return {
    ok: false,
    error:
      typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : 'Rust semantic session worker failed.',
  };
}

function rustSessionFailoverReason(error: unknown): RustSessionFailoverReason {
  const description =
    error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : String(error).toLowerCase();
  if (description.includes('readiness')) return 'readiness';
  if (description.includes('timeout') || description.includes('timed out')) return 'timeout';
  if (description.includes('helper')) return 'helper';
  return 'request';
}

function emptyReferenceMap(definitions: readonly IndexedDefinition[]): Map<number, SemanticReference[]> {
  return new Map(definitions.map((definition) => [definition.symbolId, []]));
}

function emptyCalleeMap(definitions: readonly IndexedDefinition[]): Map<number, SemanticCallee[]> {
  return new Map(definitions.map((definition) => [definition.symbolId, []]));
}

function emptySignatureMap(definitions: readonly IndexedDefinition[]): Map<number, string | null> {
  return new Map(definitions.map((definition) => [definition.symbolId, null]));
}

function completeReferenceMap(
  definitions: readonly IndexedDefinition[],
  references: ReadonlyMap<number, SemanticReference[]>,
  incompleteSymbolIds: ReadonlySet<number> = new Set(),
): Map<number, SemanticReference[]> {
  const result = new Map<number, SemanticReference[]>();
  for (const definition of definitions) {
    if (incompleteSymbolIds.has(definition.symbolId)) continue;
    result.set(definition.symbolId, references.get(definition.symbolId) ?? []);
  }
  return result;
}

function completeCalleeMap(
  definitions: readonly IndexedDefinition[],
  callees: ReadonlyMap<number, SemanticCallee[]>,
): Map<number, SemanticCallee[]> {
  return new Map(definitions.map((definition) => [definition.symbolId, callees.get(definition.symbolId) ?? []]));
}

function completeSignatureMap(
  definitions: readonly IndexedDefinition[],
  signatures: ReadonlyMap<number, string | null>,
): Map<number, string | null> {
  return new Map(definitions.map((definition) => [definition.symbolId, signatures.get(definition.symbolId) ?? null]));
}

function rustSessionOperationDefinitionCount(request: RustReferenceWorkerRequest): number {
  let count = 0;
  if (request.includeReferences !== false) count += (request.referenceDefinitions ?? request.definitions).length;
  if (request.includeCallees === true) count += (request.calleeDefinitions ?? request.definitions).length;
  if (request.includeSignatures === true) count += (request.signatureDefinitions ?? request.definitions).length;
  return Math.max(1, count);
}

function rustSessionRequestTimeoutBudgetMs(
  requestTimeoutMs: number,
  referenceRetryTimeoutMs: number | undefined,
): number {
  return referenceRetryTimeoutMs && referenceRetryTimeoutMs > 0
    ? Math.max(requestTimeoutMs, referenceRetryTimeoutMs)
    : requestTimeoutMs;
}

function rustSemanticSessionWorkerUrl(): URL {
  return new URL('./rust-semantic-session-worker.js', import.meta.url);
}

function rustSemanticSessionServerUrl(): URL {
  return new URL('./rust-semantic-session-server.js', import.meta.url);
}

function configuredPositiveInteger(value: string | undefined, fallback: number): number {
  return parsePositiveInteger(value) ?? fallback;
}

function configuredNonNegativeInteger(value: string | undefined, fallback: number): number {
  return parseNonNegativeInteger(value) ?? fallback;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function configuredBatchTimeoutMs(definitionCount: number, requestTimeoutMs: number, concurrency: number): number {
  const configured = configuredPositiveInteger(process.env['SCIP_RUST_SEMANTIC_BATCH_TIMEOUT_MS'], 0);
  if (configured > 0) return configured;
  const waves = Math.max(1, Math.ceil(definitionCount / Math.max(1, concurrency)));
  return Math.max(120_000, 30_000 + waves * requestTimeoutMs);
}
