import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parsePositiveInteger } from '../../domain/number-parsing.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { profileSpan } from '../../instrumentation/profile.js';
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

const DEFAULT_RUST_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RUST_CONCURRENCY = 8;

export class RustAnalyzerSessionResolver
  implements RustReferenceResolver, RustCalleeResolver, RustSignatureResolver, RustImportDefinitionResolver
{
  private readonly requester: RustAnalyzerSessionRequester;

  constructor(
    private readonly projectRoot: string,
    private readonly status: (projectRoot: string) => RustSemanticStatus,
    private readonly opts: RustAnalyzerSessionResolverOptions = {},
  ) {
    this.requester = opts.requester ?? createWorkerRustAnalyzerSessionRequester();
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
        references: completeReferenceMap(definitions, new Map(response.references)),
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
    flags: Pick<RustReferenceWorkerRequest, 'includeReferences' | 'includeCallees' | 'includeSignatures'>,
  ): RustReferenceWorkerResponse {
    const requestTimeoutMs = configuredPositiveInteger(
      process.env['SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS'],
      DEFAULT_RUST_REQUEST_TIMEOUT_MS,
    );
    const concurrency = configuredPositiveInteger(
      process.env['SCIP_RUST_SEMANTIC_CONCURRENCY'],
      DEFAULT_RUST_CONCURRENCY,
    );
    const diagnosticsTimeoutMs = configuredPositiveInteger(
      process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
      Math.min(requestTimeoutMs, 10_000),
    );
    const settleDelayMs = configuredPositiveInteger(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'], 5_000);
    const request: RustReferenceWorkerRequest = {
      projectRoot: this.projectRoot,
      rustAnalyzerBinary,
      definitions: [...definitions],
      requestTimeoutMs,
      diagnosticsTimeoutMs,
      settleDelayMs,
      concurrency,
      ...flags,
    };
    return profileSpan(
      'rust.semantic.session.request',
      () =>
        this.requester.requestSemantic(
          request,
          configuredBatchTimeoutMs(definitions.length, requestTimeoutMs, concurrency),
        ),
      () => ({
        definitions: definitions.length,
        references: request.includeReferences !== false,
        callees: request.includeCallees === true,
        signatures: request.includeSignatures === true,
      }),
    );
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
    const diagnosticsTimeoutMs = configuredPositiveInteger(
      process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
      Math.min(requestTimeoutMs, 10_000),
    );
    const settleDelayMs = configuredPositiveInteger(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'], 5_000);
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

function createWorkerRustAnalyzerSessionRequester(): RustAnalyzerSessionRequester {
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
    const workerUrl = rustSemanticSessionWorkerUrl();
    if (!existsSync(fileURLToPath(workerUrl))) {
      throw new Error(
        `Rust semantic session worker was not found at ${fileURLToPath(
          workerUrl,
        )}. Run npm run build before using built semantic Rust queries.`,
      );
    }
    resultDir = mkdtempSync(join(tmpdir(), 'scip-query-rust-session-'));
    worker = new Worker(workerUrl);
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
): Map<number, SemanticReference[]> {
  return new Map(definitions.map((definition) => [definition.symbolId, references.get(definition.symbolId) ?? []]));
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

function rustSemanticSessionWorkerUrl(): URL {
  return new URL('./rust-semantic-session-worker.js', import.meta.url);
}

function configuredPositiveInteger(value: string | undefined, fallback: number): number {
  return parsePositiveInteger(value) ?? fallback;
}

function configuredBatchTimeoutMs(definitionCount: number, requestTimeoutMs: number, concurrency: number): number {
  const configured = configuredPositiveInteger(process.env['SCIP_RUST_SEMANTIC_BATCH_TIMEOUT_MS'], 0);
  if (configured > 0) return configured;
  const waves = Math.max(1, Math.ceil(definitionCount / Math.max(1, concurrency)));
  return Math.max(120_000, 30_000 + waves * requestTimeoutMs);
}
