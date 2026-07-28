import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePositiveInteger } from '../../domain/number-parsing.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { isFunctionLikeSymbol, leafName } from '../../symbols/symbol-parser.js';
import type {
  SemanticAvailabilityState,
  SemanticCallee,
  SemanticImportUsage,
  SemanticProvider,
  SemanticReference,
  SemanticReferenceAndCalleeMaps,
} from '../types.js';
import { getRustSemanticStatus, type RustSemanticStatus } from './status.js';
import type { RustReferenceWorkerRequest, RustReferenceWorkerResponse } from './lsp-batch-worker.js';
import {
  createRustAnalyzerSessionResolver,
  rustSemanticRequestTimeoutBudgetMs,
  rustSemanticSettleDelayMs,
} from './lsp-session.js';
import {
  createRustSemanticImportUsageResolver,
  type RustImportDefinitionResolver,
  type RustSourceImportUsageResolver,
} from './import-usage.js';
import type {
  RustCalleeResolution,
  RustCalleeResolver,
  RustReferenceResolution,
  RustReferenceResolver,
  RustSignatureResolution,
  RustSignatureResolver,
} from './semantic-resolution.js';
import { completeRustReferenceMap, configuredRustBatchTimeoutMs } from './semantic-resolution.js';

export type {
  RustCalleeResolution,
  RustCalleeResolver,
  RustReferenceResolution,
  RustReferenceResolver,
  RustSignatureResolution,
  RustSignatureResolver,
} from './semantic-resolution.js';

export type RustCalleeSymbolResolver = (callee: SemanticCallee) => string;
export type RustScipOccurrenceCalleeOracle = (
  definitions: readonly IndexedDefinition[],
) => Map<number, SemanticCallee[]>;

export interface RustImportUsageResolver {
  importUsage(file: string): SemanticImportUsage[];
}

export type RustSourceZeroCalleeOracle = (definition: IndexedDefinition) => boolean;

export interface RustSemanticProviderOptions {
  status?: (projectRoot: string) => RustSemanticStatus;
  importUsageResolver?: RustImportUsageResolver;
  sourceImportUsageResolver?: RustSourceImportUsageResolver;
  importDefinitionResolver?: RustImportDefinitionResolver;
  referenceResolver?: RustReferenceResolver;
  calleeResolver?: RustCalleeResolver;
  calleeSymbolResolver?: RustCalleeSymbolResolver;
  sourceZeroCalleeOracle?: RustSourceZeroCalleeOracle;
  scipOccurrenceCalleeOracle?: RustScipOccurrenceCalleeOracle;
  signatureResolver?: RustSignatureResolver;
  usePersistentSession?: boolean;
}

const DEFAULT_RUST_REFERENCE_TIMEOUT_MS = 15_000;
const DEFAULT_RUST_REFERENCE_CONCURRENCY = 8;

// scip-query: ignore-extract — reviewed E1 workflow owner; provider capability, worker transport, cache, and fallback policy stay together.
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
  const sourceZeroCalleeOracle = opts.sourceZeroCalleeOracle;
  const scipOccurrenceCalleeOracle = opts.scipOccurrenceCalleeOracle;
  const importUsageCache = new Map<string, SemanticImportUsage[]>();
  const prefetchedCallees = new Map<number, SemanticCallee[]>();
  let baseAvailability: RustSemanticStatus | null = null;
  let lastAvailability: RustSemanticStatus | null = null;

  const currentBaseAvailability = (): RustSemanticStatus => {
    baseAvailability ??= status(projectRoot);
    return baseAvailability;
  };

  const currentAvailability = (): RustSemanticStatus => {
    const base = currentBaseAvailability();
    if (!base.dependencyAvailable) return base;
    return lastAvailability ?? base;
  };

  const referencesForDefinitions = (definitions: readonly IndexedDefinition[]): Map<number, SemanticReference[]> => {
    if (definitions.length === 0) return new Map();
    const rustDefinitions = hydrateRustDefinitions(definitions);
    try {
      const resolution = referenceResolver.referencesForDefinitions(rustDefinitions);
      const baseAvailability = currentBaseAvailability();
      lastAvailability = statusFromResolution(baseAvailability, resolution);
      return resolution.available
        ? new Map(resolution.references)
        : completeRustReferenceMap(rustDefinitions, resolution.references);
    } catch (error) {
      const baseAvailability = currentBaseAvailability();
      lastAvailability = failedSemanticStatus(baseAvailability, error);
      return emptyReferenceMap(rustDefinitions);
    }
  };

  const calleesForDefinitions = (definitions: readonly IndexedDefinition[]): Map<number, SemanticCallee[]> => {
    if (definitions.length === 0) return new Map();
    const rustDefinitions = hydrateRustDefinitions(definitions);
    const calleeCapableDefinitions = rustDefinitions.filter(isRustCalleeCapableDefinition);
    if (calleeCapableDefinitions.length === 0) return emptyCalleeMap(rustDefinitions);
    const resolvedCallees = new Map<number, SemanticCallee[]>();
    const scipOccurrenceCallees = rustScipOccurrenceCallees(calleeCapableDefinitions, scipOccurrenceCalleeOracle);
    const pendingDefinitions: IndexedDefinition[] = [];
    for (const definition of calleeCapableDefinitions) {
      if (prefetchedCallees.has(definition.symbolId)) {
        resolvedCallees.set(definition.symbolId, prefetchedCallees.get(definition.symbolId) ?? []);
      } else if (scipOccurrenceCallees.has(definition.symbolId)) {
        resolvedCallees.set(definition.symbolId, scipOccurrenceCallees.get(definition.symbolId) ?? []);
      } else if (rustSourceProvesZeroCallees(definition, sourceZeroCalleeOracle)) {
        resolvedCallees.set(definition.symbolId, []);
      } else {
        pendingDefinitions.push(definition);
      }
    }
    if (pendingDefinitions.length === 0) return completeCalleeMap(rustDefinitions, resolvedCallees, undefined);
    try {
      const resolution = calleeResolver.calleesForDefinitions(pendingDefinitions);
      const baseAvailability = currentBaseAvailability();
      lastAvailability = statusFromResolution(baseAvailability, resolution);
      const completedPending = completeCalleeMap(pendingDefinitions, resolution.callees, calleeSymbolResolver);
      for (const [symbolId, callees] of completedPending) resolvedCallees.set(symbolId, callees);
      return completeCalleeMap(rustDefinitions, resolvedCallees, undefined);
    } catch (error) {
      const baseAvailability = currentBaseAvailability();
      lastAvailability = failedSemanticStatus(baseAvailability, error);
      return emptyCalleeMap(rustDefinitions);
    }
  };

  const referencesAndCalleesForDefinitions = (
    referenceDefinitions: readonly IndexedDefinition[],
    calleeDefinitions: readonly IndexedDefinition[],
  ): SemanticReferenceAndCalleeMaps => {
    const rustReferenceDefinitions = hydrateRustDefinitions(referenceDefinitions);
    const rustCalleeDefinitions = hydrateRustDefinitions(calleeDefinitions);
    const calleeCapableDefinitions = rustCalleeDefinitions.filter(isRustCalleeCapableDefinition);
    const resolvedCallees = new Map<number, SemanticCallee[]>();
    const scipOccurrenceCallees = rustScipOccurrenceCallees(calleeCapableDefinitions, scipOccurrenceCalleeOracle);
    const pendingCalleeDefinitions: IndexedDefinition[] = [];
    for (const definition of calleeCapableDefinitions) {
      if (scipOccurrenceCallees.has(definition.symbolId)) {
        resolvedCallees.set(definition.symbolId, scipOccurrenceCallees.get(definition.symbolId) ?? []);
      } else if (rustSourceProvesZeroCallees(definition, sourceZeroCalleeOracle)) {
        resolvedCallees.set(definition.symbolId, []);
      } else {
        pendingCalleeDefinitions.push(definition);
      }
    }
    if (rustReferenceDefinitions.length === 0 && pendingCalleeDefinitions.length === 0) {
      return {
        references: emptyReferenceMap(rustReferenceDefinitions),
        callees: completeCalleeMap(rustCalleeDefinitions, resolvedCallees, undefined),
      };
    }
    try {
      const resolution = sessionResolver
        ? sessionResolver.referencesAndCalleesForDefinitions(rustReferenceDefinitions, pendingCalleeDefinitions)
        : resolveReferencesAndCalleesSeparately(referenceResolver, calleeResolver, {
            referenceDefinitions: rustReferenceDefinitions,
            calleeDefinitions: pendingCalleeDefinitions,
          });
      const baseAvailability = currentBaseAvailability();
      lastAvailability = statusFromResolution(baseAvailability, resolution);
      const references = resolution.available
        ? new Map(resolution.references)
        : completeRustReferenceMap(rustReferenceDefinitions, resolution.references);
      for (const [symbolId, rows] of resolution.callees) resolvedCallees.set(symbolId, rows);
      const callees = completeCalleeMap(rustCalleeDefinitions, resolvedCallees, calleeSymbolResolver);
      for (const [symbolId, rows] of callees) prefetchedCallees.set(symbolId, rows);
      return { references, callees };
    } catch (error) {
      const baseAvailability = currentBaseAvailability();
      lastAvailability = failedSemanticStatus(baseAvailability, error);
      return {
        references: emptyReferenceMap(rustReferenceDefinitions),
        callees: emptyCalleeMap(rustCalleeDefinitions),
      };
    }
  };

  const signaturesForDefinitions = (definitions: readonly IndexedDefinition[]): Map<number, string | null> => {
    if (definitions.length === 0) return new Map();
    const rustDefinitions = hydrateRustDefinitions(definitions);
    try {
      const resolution = signatureResolver.signaturesForDefinitions(rustDefinitions);
      const baseAvailability = currentBaseAvailability();
      lastAvailability = statusFromResolution(baseAvailability, resolution);
      return completeSignatureMap(rustDefinitions, resolution.signatures);
    } catch (error) {
      const baseAvailability = currentBaseAvailability();
      lastAvailability = failedSemanticStatus(baseAvailability, error);
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
        const baseAvailability = currentBaseAvailability();
        lastAvailability = failedSemanticStatus(baseAvailability, error);
        return [];
      }
    },
    referencesFor: (definition: IndexedDefinition): SemanticReference[] =>
      referencesForDefinitions([definition]).get(definition.symbolId) ?? [],
    referencesForDefinitions,
    referencesAndCalleesForDefinitions,
    calleesFor: (definition: IndexedDefinition): SemanticCallee[] =>
      calleesForDefinitions([definition]).get(definition.symbolId) ?? [],
    calleesForDefinitions,
    signatureFor: (definition: IndexedDefinition): string | null =>
      signaturesForDefinitions([definition]).get(definition.symbolId) ?? null,
  };
}

function statusFromResolution(
  base: RustSemanticStatus,
  resolution: SemanticAvailabilityState & { resolvedBinary?: string },
): RustSemanticStatus {
  const common = {
    dependencyAvailable: base.dependencyAvailable,
    resolvedBinary: resolution.resolvedBinary ?? base.resolvedBinary,
    ...(base.note ? { note: base.note } : {}),
  };
  return resolution.available
    ? { available: true, ...common }
    : { available: false, reason: resolution.reason, ...common };
}

function failedSemanticStatus(base: RustSemanticStatus, error: unknown): RustSemanticStatus {
  return {
    available: false,
    dependencyAvailable: base.dependencyAvailable,
    resolvedBinary: base.resolvedBinary,
    ...(base.note ? { note: base.note } : {}),
    reason: error instanceof Error ? error.message : String(error),
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
      isFunctionLike:
        typeof partial.isFunctionLike === 'boolean' ? partial.isFunctionLike : isFunctionLikeSymbol(definition.symbol),
      isTypeLike: partial.isTypeLike ?? false,
      kind: partial.kind ?? null,
      documentation: partial.documentation ?? null,
      enclosingSymbol: partial.enclosingSymbol ?? null,
    };
  });
}

function isRustCalleeCapableDefinition(definition: IndexedDefinition): boolean {
  return definition.isFunctionLike;
}

function rustSourceProvesZeroCallees(
  definition: IndexedDefinition,
  oracle: RustSourceZeroCalleeOracle | undefined,
): boolean {
  if (!oracle) return false;
  try {
    return oracle(definition);
  } catch {
    return false;
  }
}

function rustScipOccurrenceCallees(
  definitions: readonly IndexedDefinition[],
  oracle: RustScipOccurrenceCalleeOracle | undefined,
): Map<number, SemanticCallee[]> {
  if (!oracle || definitions.length === 0) return new Map();
  try {
    return oracle(definitions);
  } catch {
    return new Map();
  }
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

// scip-query: ignore-similar — worker operations share transport scaffolding but decode different evidence.
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
      reason: unavailableBaseStatusReason(baseStatus),
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
  const referenceRetryTimeoutMs = configuredNonNegativeInteger(
    process.env['SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS'],
    0,
  );
  const concurrency = configuredPositiveInteger(
    process.env['SCIP_RUST_SEMANTIC_CONCURRENCY'],
    DEFAULT_RUST_REFERENCE_CONCURRENCY,
  );
  const diagnosticsTimeoutMs = configuredNonNegativeInteger(
    process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
    Math.min(requestTimeoutMs, 10_000),
  );
  const settleDelayMs = rustSemanticSettleDelayMs(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'], {
    definitionCount: definitions.length,
    includeReferences: true,
  });
  const request: RustReferenceWorkerRequest = {
    projectRoot,
    rustAnalyzerBinary: baseStatus.resolvedBinary,
    definitions: [...definitions],
    requestTimeoutMs,
    ...(referenceRetryTimeoutMs > 0 ? { referenceRetryTimeoutMs } : {}),
    diagnosticsTimeoutMs,
    settleDelayMs,
    concurrency,
  };
  const result = spawnSync(process.execPath, [workerPath], {
    cwd: projectRoot,
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: configuredRustBatchTimeoutMs(
      definitions.length,
      rustSemanticRequestTimeoutBudgetMs(requestTimeoutMs, request.referenceRetryTimeoutMs),
      concurrency,
    ),
  });

  const parsed = parseWorkerResponse(result.stdout);
  if (parsed) {
    return {
      ...semanticAvailabilityState(parsed),
      resolvedBinary: baseStatus.resolvedBinary,
      references: completeRustReferenceMap(
        definitions,
        new Map(parsed.references),
        new Set(parsed.incompleteReferenceSymbolIds ?? []),
      ),
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

// scip-query: ignore-similar — worker operations share transport scaffolding but decode different evidence.
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
      reason: unavailableBaseStatusReason(baseStatus),
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
  const diagnosticsTimeoutMs = configuredNonNegativeInteger(
    process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
    Math.min(requestTimeoutMs, 10_000),
  );
  const settleDelayMs = rustSemanticSettleDelayMs(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'], {
    definitionCount: definitions.length,
    includeReferences: false,
    includeCallees: true,
  });
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
    timeout: configuredRustBatchTimeoutMs(definitions.length, requestTimeoutMs, concurrency),
  });

  const parsed = parseWorkerResponse(result.stdout);
  if (parsed) {
    return {
      ...semanticAvailabilityState(parsed),
      resolvedBinary: baseStatus.resolvedBinary,
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

// scip-query: ignore-extract — reviewed E1 workflow owner; worker request, decoding, and fallback signature resolution stay together.
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
      reason: unavailableBaseStatusReason(baseStatus),
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
  const diagnosticsTimeoutMs = configuredNonNegativeInteger(
    process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'],
    Math.min(requestTimeoutMs, 10_000),
  );
  const settleDelayMs = rustSemanticSettleDelayMs(process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'], {
    definitionCount: definitions.length,
    includeReferences: false,
    includeCallees: false,
    includeSignatures: true,
  });
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
    timeout: configuredRustBatchTimeoutMs(definitions.length, requestTimeoutMs, concurrency),
  });

  const parsed = parseWorkerResponse(result.stdout);
  if (parsed) {
    return {
      ...semanticAvailabilityState(parsed),
      resolvedBinary: baseStatus.resolvedBinary,
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

function resolveReferencesAndCalleesSeparately(
  referenceResolver: RustReferenceResolver,
  calleeResolver: RustCalleeResolver,
  definitions: {
    referenceDefinitions: readonly IndexedDefinition[];
    calleeDefinitions: readonly IndexedDefinition[];
  },
): RustReferenceResolution & RustCalleeResolution {
  const referenceResolution: RustReferenceResolution =
    definitions.referenceDefinitions.length > 0
      ? referenceResolver.referencesForDefinitions(definitions.referenceDefinitions)
      : {
          available: true,
          references: emptyReferenceMap(definitions.referenceDefinitions),
        };
  const calleeResolution: RustCalleeResolution =
    definitions.calleeDefinitions.length > 0
      ? calleeResolver.calleesForDefinitions(definitions.calleeDefinitions)
      : {
          available: true,
          callees: emptyCalleeMap(definitions.calleeDefinitions),
        };
  const payload = {
    resolvedBinary: referenceResolution.resolvedBinary ?? calleeResolution.resolvedBinary,
    references: referenceResolution.references,
    callees: calleeResolution.callees,
  };
  return referenceResolution.available && calleeResolution.available
    ? { available: true, ...payload }
    : {
        available: false,
        reason:
          (!referenceResolution.available ? referenceResolution.reason : undefined) ??
          (!calleeResolution.available ? calleeResolution.reason : undefined) ??
          'Rust semantic resolution was unavailable.',
        ...payload,
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

function completeCalleeMap(
  definitions: readonly IndexedDefinition[],
  callees: ReadonlyMap<number, SemanticCallee[]>,
  resolveSymbol: RustCalleeSymbolResolver | undefined,
): Map<number, SemanticCallee[]> {
  let rows = 0;
  let calleeCount = 0;
  return profileSpan(
    'rust.semantic.callees.complete-map',
    () => {
      const result = new Map<number, SemanticCallee[]>();
      for (const definition of definitions) {
        const rawCallees = callees.get(definition.symbolId) ?? [];
        if (rawCallees.length > 0) rows += 1;
        calleeCount += rawCallees.length;
        result.set(
          definition.symbolId,
          rawCallees.map((callee) => ({
            ...callee,
            symbol: resolveSymbol ? resolveSymbol(callee) : callee.symbol,
          })),
        );
      }
      return result;
    },
    () => ({
      definitions: definitions.length,
      rows,
      callees: calleeCount,
      resolveSymbols: Boolean(resolveSymbol),
    }),
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

function semanticAvailabilityState(value: SemanticAvailabilityState): SemanticAvailabilityState {
  return value.available ? { available: true } : { available: false, reason: value.reason };
}

function unavailableBaseStatusReason(status: RustSemanticStatus): string {
  return status.available ? 'rust-analyzer binary path is unavailable.' : status.reason;
}

function parseWorkerResponse(stdout: string): RustReferenceWorkerResponse | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record['available'] !== 'boolean' || !Array.isArray(record['references'])) return null;
    if (
      (record['available'] === false && typeof record['reason'] !== 'string') ||
      (record['available'] === true && record['reason'] !== undefined)
    ) {
      return null;
    }
    const payload = {
      references: record.references,
      incompleteReferenceSymbolIds: Array.isArray(record['incompleteReferenceSymbolIds'])
        ? record['incompleteReferenceSymbolIds'].filter((value): value is number => typeof value === 'number')
        : undefined,
      callees: Array.isArray(record['callees']) ? record['callees'] : undefined,
      signatures: Array.isArray(record['signatures']) ? record['signatures'] : undefined,
    };
    return record['available'] === true
      ? { available: true, ...payload }
      : { available: false, reason: String(record['reason']), ...payload };
  } catch {
    return null;
  }
}

function configuredPositiveInteger(value: string | undefined, fallback: number): number {
  return parsePositiveInteger(value) ?? fallback;
}

function configuredNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
