import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { parsePositiveInteger } from '../../domain/number-parsing.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { profileEnabled, profileSpan, writeProfileEvent } from '../../instrumentation/profile.js';
import { isProcessAlive } from '../../platform/process-liveness.js';
import { readProcessIdentity } from '../../platform/process-identity.js';
import { readTextFileWithinLimit, SOURCE_ARTIFACT_MAX_BYTES } from '../../platform/bounded-file.js';
import type { SemanticCallee, SemanticReference } from '../types.js';
import type {
  RustAnalyzerSessionRequester,
  RustCalleeResolution,
  RustCalleeResolver,
  RustImportDefinitionPosition,
  RustImportDefinitionResolution,
  RustImportDefinitionResolver,
  RustImportDefinitionWorkerRequest,
  RustImportDefinitionWorkerResponse,
  RustReferenceResolution,
  RustReferenceResolver,
  RustSignatureResolution,
  RustSignatureResolver,
} from './semantic-resolution.js';
import { completeRustReferenceMap, configuredRustBatchTimeoutMs } from './semantic-resolution.js';
import type { RustSemanticStatus } from './status.js';
import type { RustReferenceWorkerRequest, RustReferenceWorkerResponse } from './lsp-batch-worker.js';
import {
  createDurableRustAnalyzerSessionRequester,
  durableRustSessionDirectory,
  isDurableRustSessionStateLive,
  readDurableRustSessionServerState,
} from './durable-session.js';
import { terminateRegisteredRustAnalyzerProcessTrees } from './process-ownership.js';

export type {
  RustAnalyzerSessionRequester,
  RustImportDefinitionPosition,
  RustImportDefinitionResolution,
  RustImportDefinitionWorkerRequest,
  RustImportDefinitionWorkerResponse,
} from './semantic-resolution.js';

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

  // scip-query: ignore-twin — Rust and TypeScript providers implement different compiler protocols.
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
        references: completeRustReferenceMap(
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

  // scip-query: ignore-similar — primary dispatch and fallback recovery share outputs but not control flow.
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
        references: completeRustReferenceMap(
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

  // scip-query: ignore-twin — lifecycle name is shared while transport ownership differs by provider.
  // scip-query: ignore-passthrough — lifecycle method fulfills the semantic
  // resolver contract while the requester owns transport shutdown mechanics.
  dispose(): void {
    this.requester.shutdown();
  }

  // scip-query: ignore-similar — general dispatch and import lookup carry different protocol payloads.
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
          configuredRustBatchTimeoutMs(
            operationDefinitionCount,
            rustSemanticRequestTimeoutBudgetMs(requestTimeoutMs, request.referenceRetryTimeoutMs),
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

  // scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
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
        references: completeRustReferenceMap(referenceDefinitions, referenceResolution.references),
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
          configuredRustBatchTimeoutMs(positions.length, requestTimeoutMs, concurrency),
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

export interface RustSemanticSessionSelection {
  transport: 'worker' | 'durable';
  source: 'default' | 'environment';
  fallback: 'worker';
  valid: boolean;
  optOut: 'SCIP_RUST_SEMANTIC_DURABLE_SESSION=0';
}

// scip-query: ignore-stale — reviewed S1 owned contract; this status is the session selection plus live readiness.
export type RustSemanticSessionStatus = RustSemanticSessionSelection &
  (
    | { state: 'per-command' | 'stopped' }
    | {
        state: 'live' | 'stale';
        pid: number;
        heartbeatAtMs: number;
        busyUntilMs?: number;
      }
  );

export function rustSemanticSessionSelection(configuredValue: string | undefined): RustSemanticSessionSelection {
  const normalized = configuredValue?.trim().toLowerCase();
  const explicitWorker =
    normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'worker';
  const explicitDurable =
    normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'durable';
  const usesDefault = normalized === undefined || normalized === '';
  return {
    transport: explicitWorker || (!usesDefault && !explicitDurable) ? 'worker' : 'durable',
    source: usesDefault ? 'default' : 'environment',
    fallback: 'worker',
    valid: usesDefault || explicitWorker || explicitDurable,
    optOut: 'SCIP_RUST_SEMANTIC_DURABLE_SESSION=0',
  };
}

export function rustSemanticSessionTransport(configuredValue: string | undefined): 'worker' | 'durable' {
  return rustSemanticSessionSelection(configuredValue).transport;
}

export function rustSemanticSessionStatus(
  projectRoot: string,
  configuredValue: string | undefined,
): RustSemanticSessionStatus {
  const selection = rustSemanticSessionSelection(configuredValue);
  if (selection.transport === 'worker') return { ...selection, state: 'per-command' };
  const serverPath = fileURLToPath(rustSemanticSessionServerUrl());
  const sessionDir = durableRustSessionDirectory(projectRoot, serverPath, tmpdir());
  const state = readDurableRustSessionServerState(sessionDir);
  if (!state) return { ...selection, state: 'stopped' };
  return {
    ...selection,
    state: isDurableRustSessionStateLive(state, Date.now(), isProcessAlive, readProcessIdentity) ? 'live' : 'stale',
    pid: state.pid,
    heartbeatAtMs: state.heartbeatAtMs,
    ...(state.busyUntilMs === undefined ? {} : { busyUntilMs: state.busyUntilMs }),
  };
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

    const startedAtMs = performance.now();
    try {
      return requestPrimary(primary);
    } catch (error) {
      activateFailover(error, kind, performance.now() - startedAtMs);
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
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

// scip-query: ignore-extract — reviewed E1 workflow owner; worker lifetime, request routing, and recovery stay together.
export function createWorkerRustAnalyzerSessionRequester(
  opts: { semanticWorkerPath?: string; shareEnvironment?: boolean } = {},
): RustAnalyzerSessionRequester {
  let worker: Worker | null = null;
  let resultDir: string | null = null;
  let nextRequestId = 1;
  let disposed = false;
  let termination: Promise<void> | null = null;
  let terminationFailure: Error | null = null;

  const cleanupResultDir = (directory: string | null): void => {
    if (!directory) return;
    rmSync(directory, { recursive: true, force: true });
  };

  const terminate = (): void => {
    if (termination) return;
    const currentWorker = worker;
    const currentResultDir = resultDir;
    worker = null;
    resultDir = null;
    const workerTermination = currentWorker ? currentWorker.terminate() : Promise.resolve(0);
    termination = Promise.allSettled([
      workerTermination,
      terminateRegisteredRustAnalyzerProcessTrees(currentResultDir, { gracefulMs: 1_000, forceMs: 1_000 }),
    ])
      .then(([workerResult, processTreeResult]) => {
        const processTrees =
          processTreeResult.status === 'fulfilled'
            ? processTreeResult.value
            : [{ reaped: false, detail: String(processTreeResult.reason) }];
        const unreaped = processTrees.filter((result) => !result.reaped);
        if (workerResult.status === 'rejected' || unreaped.length > 0) {
          terminationFailure = new Error(
            `Rust semantic worker cleanup did not complete; ownership evidence remains at ${currentResultDir ?? 'unknown'}.`,
          );
          return;
        }
        cleanupResultDir(currentResultDir);
      })
      .finally(() => {
        termination = null;
      });
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    if (termination) {
      throw new Error('The previous Rust semantic session worker is still terminating; retry the request.');
    }
    if (terminationFailure) throw terminationFailure;
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
        const payload = parseWorkerPayload(
          readTextFileWithinLimit(responsePath, {
            maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
            inputKind: 'Rust semantic worker response',
          }),
        );
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
        const payload = parseImportDefinitionWorkerPayload(
          readTextFileWithinLimit(responsePath, {
            maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
            inputKind: 'Rust import-definition worker response',
          }),
        );
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
        cleanupResultDir(resultDir);
        resultDir = null;
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

// scip-query: ignore-twin — typed empty maps are local protocol response constructors.
function emptyReferenceMap(definitions: readonly IndexedDefinition[]): Map<number, SemanticReference[]> {
  return new Map(definitions.map((definition) => [definition.symbolId, []]));
}

// scip-query: ignore-twin — typed empty maps are local protocol response constructors.
function emptyCalleeMap(definitions: readonly IndexedDefinition[]): Map<number, SemanticCallee[]> {
  return new Map(definitions.map((definition) => [definition.symbolId, []]));
}

// scip-query: ignore-twin — typed empty maps are local protocol response constructors.
function emptySignatureMap(definitions: readonly IndexedDefinition[]): Map<number, string | null> {
  return new Map(definitions.map((definition) => [definition.symbolId, null]));
}

// scip-query: ignore-twin — session and worker completion preserve different response ownership.
function completeCalleeMap(
  definitions: readonly IndexedDefinition[],
  callees: ReadonlyMap<number, SemanticCallee[]>,
): Map<number, SemanticCallee[]> {
  return new Map(definitions.map((definition) => [definition.symbolId, callees.get(definition.symbolId) ?? []]));
}

// scip-query: ignore-twin — typed completion is intentionally local to signature responses.
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

export function rustSemanticRequestTimeoutBudgetMs(
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

// scip-query: ignore-twin — environment parsing remains beside each transport's defaults.
function configuredPositiveInteger(value: string | undefined, fallback: number): number {
  return parsePositiveInteger(value) ?? fallback;
}

// scip-query: ignore-twin — provider and session values have different absence semantics.
function configuredNonNegativeInteger(value: string | undefined, fallback: number): number {
  return parseNonNegativeInteger(value) ?? fallback;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
