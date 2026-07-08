import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePositiveInteger } from '../../domain/number-parsing.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { leafName } from '../../symbols/symbol-parser.js';
import type { SemanticCallee, SemanticImportUsage, SemanticProvider, SemanticReference } from '../types.js';
import { getRustSemanticStatus, type RustSemanticStatus } from './status.js';
import type { RustReferenceWorkerRequest, RustReferenceWorkerResponse } from './lsp-batch-worker.js';
import { createRustAnalyzerSessionResolver } from './lsp-session.js';
import {
  createRustSemanticImportUsageResolver,
  type RustImportDefinitionResolver,
  type RustSourceImportUsageResolver,
} from './import-usage.js';

export interface RustReferenceResolution {
  available: boolean;
  reason?: string;
  resolvedBinary?: string;
  references: Map<number, SemanticReference[]>;
}

export interface RustReferenceResolver {
  referencesForDefinitions(definitions: readonly IndexedDefinition[]): RustReferenceResolution;
}

export interface RustCalleeResolution {
  available: boolean;
  reason?: string;
  resolvedBinary?: string;
  callees: Map<number, SemanticCallee[]>;
}

export interface RustCalleeResolver {
  calleesForDefinitions(definitions: readonly IndexedDefinition[]): RustCalleeResolution;
}

export type RustCalleeSymbolResolver = (callee: SemanticCallee) => string;

export interface RustSignatureResolution {
  available: boolean;
  reason?: string;
  resolvedBinary?: string;
  signatures: Map<number, string | null>;
}

export interface RustSignatureResolver {
  signaturesForDefinitions(definitions: readonly IndexedDefinition[]): RustSignatureResolution;
}

export interface RustImportUsageResolver {
  importUsage(file: string): SemanticImportUsage[];
}

export interface RustSemanticProviderOptions {
  status?: (projectRoot: string) => RustSemanticStatus;
  importUsageResolver?: RustImportUsageResolver;
  sourceImportUsageResolver?: RustSourceImportUsageResolver;
  importDefinitionResolver?: RustImportDefinitionResolver;
  referenceResolver?: RustReferenceResolver;
  calleeResolver?: RustCalleeResolver;
  calleeSymbolResolver?: RustCalleeSymbolResolver;
  signatureResolver?: RustSignatureResolver;
  usePersistentSession?: boolean;
}

const DEFAULT_RUST_REFERENCE_TIMEOUT_MS = 15_000;
const DEFAULT_RUST_REFERENCE_CONCURRENCY = 8;

export function createRustSemanticProvider(
  projectRoot: string,
  opts: RustSemanticProviderOptions = {},
): SemanticProvider {
  const status = opts.status ?? getRustSemanticStatus;
  const workerReferenceResolver = createWorkerRustReferenceResolver(projectRoot, status);
  const workerCalleeResolver = createWorkerRustCalleeResolver(projectRoot, status);
  const workerSignatureResolver = createWorkerRustSignatureResolver(projectRoot, status);
  const sessionResolver =
    opts.referenceResolver || opts.calleeResolver || opts.signatureResolver || !shouldUsePersistentRustSession(opts)
      ? null
      : createRustAnalyzerSessionResolver(projectRoot, status, {
          fallbackReferenceResolver: workerReferenceResolver,
          fallbackCalleeResolver: workerCalleeResolver,
          fallbackSignatureResolver: workerSignatureResolver,
        });
  const referenceResolver = opts.referenceResolver ?? sessionResolver ?? workerReferenceResolver;
  const calleeResolver = opts.calleeResolver ?? sessionResolver ?? workerCalleeResolver;
  const signatureResolver = opts.signatureResolver ?? sessionResolver ?? workerSignatureResolver;
  const importUsageResolver =
    opts.importUsageResolver ??
    createRustSemanticImportUsageResolver(
      opts.sourceImportUsageResolver ?? emptyRustSourceImportUsageResolver(),
      opts.importDefinitionResolver ?? sessionResolver,
    );
  const calleeSymbolResolver = opts.calleeSymbolResolver;
  const importUsageCache = new Map<string, SemanticImportUsage[]>();
  let lastAvailability: RustSemanticStatus | null = null;

  const currentAvailability = (): RustSemanticStatus => {
    const base = status(projectRoot);
    if (!base.dependencyAvailable) return base;
    return lastAvailability ?? base;
  };

  const referencesForDefinitions = (definitions: readonly IndexedDefinition[]): Map<number, SemanticReference[]> => {
    if (definitions.length === 0) return new Map();
    const rustDefinitions = hydrateRustDefinitions(definitions);
    try {
      const resolution = referenceResolver.referencesForDefinitions(rustDefinitions);
      lastAvailability = {
        ...status(projectRoot),
        available: resolution.available,
        resolvedBinary: resolution.resolvedBinary ?? status(projectRoot).resolvedBinary,
        reason: resolution.reason ?? status(projectRoot).reason,
      };
      return completeReferenceMap(rustDefinitions, resolution.references);
    } catch (error) {
      lastAvailability = {
        ...status(projectRoot),
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
      return emptyReferenceMap(rustDefinitions);
    }
  };

  const calleesForDefinitions = (definitions: readonly IndexedDefinition[]): Map<number, SemanticCallee[]> => {
    if (definitions.length === 0) return new Map();
    const rustDefinitions = hydrateRustDefinitions(definitions);
    try {
      const resolution = calleeResolver.calleesForDefinitions(rustDefinitions);
      lastAvailability = {
        ...status(projectRoot),
        available: resolution.available,
        resolvedBinary: resolution.resolvedBinary ?? status(projectRoot).resolvedBinary,
        reason: resolution.reason ?? status(projectRoot).reason,
      };
      return completeCalleeMap(rustDefinitions, resolution.callees, calleeSymbolResolver);
    } catch (error) {
      lastAvailability = {
        ...status(projectRoot),
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
      return emptyCalleeMap(rustDefinitions);
    }
  };

  const signaturesForDefinitions = (definitions: readonly IndexedDefinition[]): Map<number, string | null> => {
    if (definitions.length === 0) return new Map();
    const rustDefinitions = hydrateRustDefinitions(definitions);
    try {
      const resolution = signatureResolver.signaturesForDefinitions(rustDefinitions);
      lastAvailability = {
        ...status(projectRoot),
        available: resolution.available,
        resolvedBinary: resolution.resolvedBinary ?? status(projectRoot).resolvedBinary,
        reason: resolution.reason ?? status(projectRoot).reason,
      };
      return completeSignatureMap(rustDefinitions, resolution.signatures);
    } catch (error) {
      lastAvailability = {
        ...status(projectRoot),
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
      return emptySignatureMap(rustDefinitions);
    }
  };

  return {
    language: 'rust',
    availability: currentAvailability,
    dispose: () => {
      sessionResolver?.dispose();
    },
    importUsage: (file: string): SemanticImportUsage[] => {
      const cached = importUsageCache.get(file);
      if (cached) return cached;
      try {
        const usage = importUsageResolver.importUsage(file);
        importUsageCache.set(file, usage);
        return usage;
      } catch (error) {
        lastAvailability = {
          ...status(projectRoot),
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
        return [];
      }
    },
    referencesFor: (definition: IndexedDefinition): SemanticReference[] =>
      referencesForDefinitions([definition]).get(definition.symbolId) ?? [],
    referencesForDefinitions,
    calleesFor: (definition: IndexedDefinition): SemanticCallee[] =>
      calleesForDefinitions([definition]).get(definition.symbolId) ?? [],
    calleesForDefinitions,
    signatureFor: (definition: IndexedDefinition): string | null =>
      signaturesForDefinitions([definition]).get(definition.symbolId) ?? null,
  };
}

function shouldUsePersistentRustSession(opts: RustSemanticProviderOptions): boolean {
  if (opts.usePersistentSession !== undefined) return opts.usePersistentSession;
  const configured = process.env['SCIP_RUST_SEMANTIC_SESSION'];
  return configured !== '0' && configured !== 'false';
}

function emptyRustSourceImportUsageResolver(): RustSourceImportUsageResolver {
  return {
    importUsageFacts: () => ({
      usage: [],
      positions: [],
    }),
  };
}

function hydrateRustDefinitions(definitions: readonly IndexedDefinition[]): IndexedDefinition[] {
  return definitions.map((definition) => {
    const partial = definition as Partial<IndexedDefinition>;
    return {
      ...definition,
      leaf: typeof partial.leaf === 'string' ? partial.leaf : leafName(definition.symbol),
      parentTypeName: partial.parentTypeName ?? null,
      isFunctionLike: partial.isFunctionLike ?? false,
      isTypeLike: partial.isTypeLike ?? false,
      kind: partial.kind ?? null,
      documentation: partial.documentation ?? null,
      enclosingSymbol: partial.enclosingSymbol ?? null,
    };
  });
}

function createWorkerRustReferenceResolver(
  projectRoot: string,
  status: (projectRoot: string) => RustSemanticStatus,
): RustReferenceResolver {
  return {
    referencesForDefinitions: (definitions) => resolveReferencesWithWorker(projectRoot, status, definitions),
  };
}

function createWorkerRustCalleeResolver(
  projectRoot: string,
  status: (projectRoot: string) => RustSemanticStatus,
): RustCalleeResolver {
  return {
    calleesForDefinitions: (definitions) => resolveCalleesWithWorker(projectRoot, status, definitions),
  };
}

function createWorkerRustSignatureResolver(
  projectRoot: string,
  status: (projectRoot: string) => RustSemanticStatus,
): RustSignatureResolver {
  return {
    signaturesForDefinitions: (definitions) => resolveSignaturesWithWorker(projectRoot, status, definitions),
  };
}

function resolveReferencesWithWorker(
  projectRoot: string,
  status: (projectRoot: string) => RustSemanticStatus,
  definitions: readonly IndexedDefinition[],
): RustReferenceResolution {
  const baseStatus = status(projectRoot);
  if (!baseStatus.available || !baseStatus.resolvedBinary) {
    return {
      available: false,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: baseStatus.reason,
      references: emptyReferenceMap(definitions),
    };
  }

  const workerPath = rustSemanticWorkerPath();
  if (!existsSync(workerPath)) {
    return {
      available: false,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: `Rust semantic worker was not found at ${workerPath}. Run npm run build before using built semantic Rust queries.`,
      references: emptyReferenceMap(definitions),
    };
  }

  const requestTimeoutMs = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS'],
    DEFAULT_RUST_REFERENCE_TIMEOUT_MS,
  );
  const concurrency = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_CONCURRENCY'],
    DEFAULT_RUST_REFERENCE_CONCURRENCY,
  );
  const diagnosticsTimeoutMs = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
    Math.min(requestTimeoutMs, 10_000),
  );
  const settleDelayMs = configuredPositiveInteger(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'], 5_000);
  const request: RustReferenceWorkerRequest = {
    projectRoot,
    rustAnalyzerBinary: baseStatus.resolvedBinary,
    definitions: [...definitions],
    requestTimeoutMs,
    diagnosticsTimeoutMs,
    settleDelayMs,
    concurrency,
  };
  const result = spawnSync(process.execPath, [workerPath], {
    cwd: projectRoot,
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: configuredBatchTimeoutMs(definitions.length, requestTimeoutMs, concurrency),
  });

  const parsed = parseWorkerResponse(result.stdout);
  if (parsed) {
    return {
      available: parsed.available,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: parsed.reason,
      references: completeReferenceMap(definitions, new Map(parsed.references)),
    };
  }

  const reason =
    result.error instanceof Error
      ? result.error.message
      : result.stderr.trim() || `Rust semantic worker exited with status ${result.status ?? 'unknown'}.`;
  return {
    available: false,
    resolvedBinary: baseStatus.resolvedBinary,
    reason,
    references: emptyReferenceMap(definitions),
  };
}

function resolveCalleesWithWorker(
  projectRoot: string,
  status: (projectRoot: string) => RustSemanticStatus,
  definitions: readonly IndexedDefinition[],
): RustCalleeResolution {
  const baseStatus = status(projectRoot);
  if (!baseStatus.available || !baseStatus.resolvedBinary) {
    return {
      available: false,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: baseStatus.reason,
      callees: emptyCalleeMap(definitions),
    };
  }

  const workerPath = rustSemanticWorkerPath();
  if (!existsSync(workerPath)) {
    return {
      available: false,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: `Rust semantic worker was not found at ${workerPath}. Run npm run build before using built semantic Rust queries.`,
      callees: emptyCalleeMap(definitions),
    };
  }

  const requestTimeoutMs = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS'],
    DEFAULT_RUST_REFERENCE_TIMEOUT_MS,
  );
  const concurrency = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_CONCURRENCY'],
    DEFAULT_RUST_REFERENCE_CONCURRENCY,
  );
  const diagnosticsTimeoutMs = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
    Math.min(requestTimeoutMs, 10_000),
  );
  const settleDelayMs = configuredPositiveInteger(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'], 5_000);
  const request: RustReferenceWorkerRequest = {
    projectRoot,
    rustAnalyzerBinary: baseStatus.resolvedBinary,
    definitions: [...definitions],
    requestTimeoutMs,
    diagnosticsTimeoutMs,
    settleDelayMs,
    concurrency,
    includeReferences: false,
    includeCallees: true,
  };
  const result = spawnSync(process.execPath, [workerPath], {
    cwd: projectRoot,
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: configuredBatchTimeoutMs(definitions.length, requestTimeoutMs, concurrency),
  });

  const parsed = parseWorkerResponse(result.stdout);
  if (parsed) {
    return {
      available: parsed.available,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: parsed.reason,
      callees: completeCalleeMap(definitions, new Map(parsed.callees ?? []), undefined),
    };
  }

  const reason =
    result.error instanceof Error
      ? result.error.message
      : result.stderr.trim() || `Rust semantic worker exited with status ${result.status ?? 'unknown'}.`;
  return {
    available: false,
    resolvedBinary: baseStatus.resolvedBinary,
    reason,
    callees: emptyCalleeMap(definitions),
  };
}

function resolveSignaturesWithWorker(
  projectRoot: string,
  status: (projectRoot: string) => RustSemanticStatus,
  definitions: readonly IndexedDefinition[],
): RustSignatureResolution {
  const baseStatus = status(projectRoot);
  if (!baseStatus.available || !baseStatus.resolvedBinary) {
    return {
      available: false,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: baseStatus.reason,
      signatures: emptySignatureMap(definitions),
    };
  }

  const workerPath = rustSemanticWorkerPath();
  if (!existsSync(workerPath)) {
    return {
      available: false,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: `Rust semantic worker was not found at ${workerPath}. Run npm run build before using built semantic Rust queries.`,
      signatures: emptySignatureMap(definitions),
    };
  }

  const requestTimeoutMs = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS'],
    DEFAULT_RUST_REFERENCE_TIMEOUT_MS,
  );
  const concurrency = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_CONCURRENCY'],
    DEFAULT_RUST_REFERENCE_CONCURRENCY,
  );
  const diagnosticsTimeoutMs = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
    Math.min(requestTimeoutMs, 10_000),
  );
  const settleDelayMs = configuredPositiveInteger(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'], 5_000);
  const request: RustReferenceWorkerRequest = {
    projectRoot,
    rustAnalyzerBinary: baseStatus.resolvedBinary,
    definitions: [...definitions],
    requestTimeoutMs,
    diagnosticsTimeoutMs,
    settleDelayMs,
    concurrency,
    includeReferences: false,
    includeCallees: false,
    includeSignatures: true,
  };
  const result = spawnSync(process.execPath, [workerPath], {
    cwd: projectRoot,
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: configuredBatchTimeoutMs(definitions.length, requestTimeoutMs, concurrency),
  });

  const parsed = parseWorkerResponse(result.stdout);
  if (parsed) {
    return {
      available: parsed.available,
      resolvedBinary: baseStatus.resolvedBinary,
      reason: parsed.reason,
      signatures: completeSignatureMap(definitions, new Map(parsed.signatures ?? [])),
    };
  }

  const reason =
    result.error instanceof Error
      ? result.error.message
      : result.stderr.trim() || `Rust semantic worker exited with status ${result.status ?? 'unknown'}.`;
  return {
    available: false,
    resolvedBinary: baseStatus.resolvedBinary,
    reason,
    signatures: emptySignatureMap(definitions),
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
  resolveSymbol: RustCalleeSymbolResolver | undefined,
): Map<number, SemanticCallee[]> {
  return new Map(
    definitions.map((definition) => [
      definition.symbolId,
      (callees.get(definition.symbolId) ?? []).map((callee) => ({
        ...callee,
        symbol: resolveSymbol ? resolveSymbol(callee) : callee.symbol,
      })),
    ]),
  );
}

function completeSignatureMap(
  definitions: readonly IndexedDefinition[],
  signatures: ReadonlyMap<number, string | null>,
): Map<number, string | null> {
  return new Map(definitions.map((definition) => [definition.symbolId, signatures.get(definition.symbolId) ?? null]));
}

function rustSemanticWorkerPath(): string {
  return fileURLToPath(new URL('./rust-semantic-worker.js', import.meta.url));
}

function parseWorkerResponse(stdout: string): RustReferenceWorkerResponse | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<RustReferenceWorkerResponse>;
    if (typeof record.available !== 'boolean' || !Array.isArray(record.references)) return null;
    return {
      available: record.available,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
      references: record.references,
      callees: Array.isArray(record.callees) ? record.callees : undefined,
      signatures: Array.isArray(record.signatures) ? record.signatures : undefined,
    };
  } catch {
    return null;
  }
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
