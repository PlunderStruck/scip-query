import { parsePositiveInteger } from '../../domain/number-parsing.js';
import type { IndexedDefinition } from '../../domain/types.js';
import type { SemanticCallee, SemanticReference } from '../types.js';
import type { RustReferenceWorkerRequest, RustReferenceWorkerResponse } from './lsp-batch-worker.js';

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

export interface RustSignatureResolution {
  available: boolean;
  reason?: string;
  resolvedBinary?: string;
  signatures: Map<number, string | null>;
}

export interface RustSignatureResolver {
  signaturesForDefinitions(definitions: readonly IndexedDefinition[]): RustSignatureResolution;
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

export interface RustImportDefinitionResolver {
  importDefinitionsForFile(
    file: string,
    positions: readonly RustImportDefinitionPosition[],
  ): RustImportDefinitionResolution;
}

export interface RustAnalyzerSessionRequester {
  requestSemantic(request: RustReferenceWorkerRequest, timeoutMs: number): RustReferenceWorkerResponse;
  requestImportDefinitions(
    request: RustImportDefinitionWorkerRequest,
    timeoutMs: number,
  ): RustImportDefinitionWorkerResponse;
  shutdown(): void;
}

export function completeRustReferenceMap(
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

export function configuredRustBatchTimeoutMs(
  definitionCount: number,
  requestTimeoutMs: number,
  concurrency: number,
): number {
  const configured = parsePositiveInteger(process.env['SCIP_RUST_SEMANTIC_BATCH_TIMEOUT_MS']) ?? 0;
  if (configured > 0) return configured;
  const waves = Math.max(1, Math.ceil(definitionCount / Math.max(1, concurrency)));
  return Math.max(120_000, 30_000 + waves * requestTimeoutMs);
}
