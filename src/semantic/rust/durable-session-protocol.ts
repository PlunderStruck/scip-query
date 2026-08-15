import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import {
  isNonNegativeFiniteNumber,
  isNonNegativeInteger,
  isNonEmptyString,
    isPositiveInteger,
    isRecordObject,
    isSha256Hex,
    isStringOrNullRecord,
} from '../../domain/record-validation.js';
import { stableJson } from '../../domain/stable-json.js';
import type { IndexedDefinition } from '../../domain/types.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxRequestId,
  type BoundedMailboxRequestIdentity,
} from '../../storage/bounded-mailbox.js';
import type { RustReferenceWorkerRequest, RustReferenceWorkerResponse } from './lsp-batch-worker.js';
import type { RustImportDefinitionWorkerRequest, RustImportDefinitionWorkerResponse } from './semantic-resolution.js';
import type { SemanticCallee, SemanticReference } from '../types.js';

export const DURABLE_RUST_SESSION_PROTOCOL_VERSION = 3;

export type DurableRustSessionRequest =
  | {
      kind: 'semantic';
      identityKey: string;
      workerEnvironment?: Record<string, string | null>;
      request: RustReferenceWorkerRequest;
      timeoutMs: number;
    }
  | {
      kind: 'import-definitions';
      identityKey: string;
      workerEnvironment?: Record<string, string | null>;
      request: RustImportDefinitionWorkerRequest;
      timeoutMs: number;
    };

export type DurableRustSessionResponse =
  | {
      session: 'created' | 'reused' | 'invalidated';
      response: RustReferenceWorkerResponse;
    }
  | {
      session: 'created' | 'reused' | 'invalidated';
      response: RustImportDefinitionWorkerResponse;
    };

export interface DurableRustMailboxEnvelope extends BoundedMailboxRequestIdentity {
  protocolVersion: typeof DURABLE_RUST_SESSION_PROTOCOL_VERSION;
  sessionIdentity: string;
  request: DurableRustSessionRequest;
}

export type DurableRustMailboxErrorCode =
  | 'unsupported-protocol'
  | 'malformed-request'
  | 'expired-request'
  | 'handler-error';

export interface DurableRustMailboxResponseIdentity {
  id: string;
  sessionIdentity: string;
  deadlineAtMs: number;
}

export type DurableRustMailboxRequestDecodeResult =
  | {
      ok: true;
      compatibility: 'legacy-v2' | 'prior-v3' | 'current-v3';
      value: DurableRustMailboxEnvelope;
    }
  | {
      ok: false;
      code: Exclude<DurableRustMailboxErrorCode, 'handler-error'>;
      error: string;
      responseIdentity?: DurableRustMailboxResponseIdentity;
    };

export type DurableRustMailboxResponseDecodeResult =
  | {
      ok: true;
      session: DurableRustSessionResponse['session'];
      response: RustReferenceWorkerResponse | RustImportDefinitionWorkerResponse;
    }
  | {
      ok: false;
      code: DurableRustMailboxErrorCode | 'incompatible-response' | 'malformed-response';
      error: string;
    };

// scip-query: ignore-stale -- Protocol expectation binds durable-session identity, operation, and deadline checks.
export interface DurableRustMailboxResponseExpectation {
  requestId: string;
  operationKey: string;
  sessionIdentity: string;
  deadlineAtMs: number;
  requestKind: DurableRustSessionRequest['kind'];
  nowMs: number;
}

/**
 * Identifies one durable mailbox namespace independently of any request in it.
 * Both processes derive it from the absolute session directory, so a response
 * copied from another project/helper namespace cannot satisfy the contract.
 */
export function durableRustMailboxSessionIdentity(sessionDir: string): string {
  return createHash('sha256')
    .update(
      stableJson({
        kind: 'scip-query-durable-rust-mailbox',
        protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
        sessionDir: resolve(sessionDir),
      }),
    )
    .digest('hex');
}

export function decodeDurableRustMailboxRequest(
  value: unknown,
  context: {
    claimRequestId: string;
    sessionIdentity: string;
    nowMs: number;
  },
): DurableRustMailboxRequestDecodeResult {
  if (!isRecordObject(value) || typeof value.id !== 'string' || !value.id) {
    return malformedRequest('Durable Rust semantic helper received an invalid mailbox request.');
  }
  if (value.id !== context.claimRequestId) {
    return malformedRequest('Durable Rust semantic request identity does not match its mailbox path.');
  }

  if (value.protocolVersion === undefined) {
    if (
      value.mailboxVersion !== undefined ||
      value.operationKey !== undefined ||
      value.clientId !== undefined ||
      value.enqueuedAtMs !== undefined ||
      value.deadlineAtMs !== undefined ||
      value.sessionIdentity !== undefined
    ) {
      return malformedRequest(
        'Durable Rust semantic helper received a partially versioned request without a protocol version.',
      );
    }
    const request = decodeDurableRustSessionRequest(value.request);
    if (!request) {
      return malformedRequest('Durable Rust semantic helper received an invalid legacy request kind or payload.');
    }
    const deadlineAtMs = context.nowMs + Math.max(1, request.timeoutMs);
    return {
      ok: true,
      compatibility: 'legacy-v2',
      value: {
        mailboxVersion: BOUNDED_MAILBOX_VERSION,
        protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
        id: value.id,
        operationKey: boundedMailboxOperationKey('rust-semantic-v2', { id: value.id, request }),
        clientId: 'legacy-v2',
        enqueuedAtMs: context.nowMs,
        deadlineAtMs,
        sessionIdentity: context.sessionIdentity,
        request,
      },
    };
  }

  const correlation = decodeCurrentCorrelation(value, context);
  if (!correlation.ok) return correlation;
  if (value.protocolVersion !== DURABLE_RUST_SESSION_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'unsupported-protocol',
      error: `Durable Rust semantic helper does not support mailbox protocol ${String(value.protocolVersion)}.`,
      responseIdentity: correlation.responseIdentity,
    };
  }

  const request = decodeDurableRustSessionRequest(value.request);
  if (!request) {
    return {
      ok: false,
      code: 'malformed-request',
      error: 'Durable Rust semantic helper received an invalid request kind or payload.',
      responseIdentity: correlation.responseIdentity,
    };
  }
  if (correlation.operationKey !== boundedMailboxOperationKey('rust-semantic-v3', request)) {
    return {
      ok: false,
      code: 'malformed-request',
      error: 'Durable Rust semantic helper received a mismatched mailbox operation identity.',
      responseIdentity: correlation.responseIdentity,
    };
  }
  if (correlation.deadlineAtMs - correlation.enqueuedAtMs !== request.timeoutMs) {
    return {
      ok: false,
      code: 'malformed-request',
      error: 'Durable Rust semantic helper received a deadline that does not match the request timeout.',
      responseIdentity: correlation.responseIdentity,
    };
  }
  if (correlation.deadlineAtMs < context.nowMs) {
    return {
      ok: false,
      code: 'expired-request',
      error: 'Durable Rust semantic request expired before processing.',
      responseIdentity: correlation.responseIdentity,
    };
  }

  return {
    ok: true,
    compatibility: correlation.priorSessionIdentity ? 'prior-v3' : 'current-v3',
    value: {
      mailboxVersion: BOUNDED_MAILBOX_VERSION,
      protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
      id: value.id,
      operationKey: correlation.operationKey,
      clientId: correlation.clientId,
      enqueuedAtMs: correlation.enqueuedAtMs,
      deadlineAtMs: correlation.deadlineAtMs,
      sessionIdentity: context.sessionIdentity,
      request,
    },
  };
}

export function decodeDurableRustMailboxResponse(
  value: unknown,
  expected: DurableRustMailboxResponseExpectation,
): DurableRustMailboxResponseDecodeResult {
  if (!isRecordObject(value)) {
    return malformedResponse('helper wrote an invalid response object');
  }
  if (value.protocolVersion !== DURABLE_RUST_SESSION_PROTOCOL_VERSION) {
    return incompatibleResponse(
      value.protocolVersion === undefined
        ? 'helper wrote a prior uncorrelated response protocol'
        : `helper wrote unsupported response protocol ${String(value.protocolVersion)}`,
    );
  }
  if (
    value.mailboxVersion !== BOUNDED_MAILBOX_VERSION ||
    value.id !== expected.requestId ||
    value.operationKey !== expected.operationKey ||
    value.sessionIdentity !== expected.sessionIdentity ||
    value.deadlineAtMs !== expected.deadlineAtMs
  ) {
    return incompatibleResponse('helper wrote an incompatible response identity');
  }
  if (
    typeof value.completedAtMs !== 'number' ||
    !Number.isFinite(value.completedAtMs) ||
    value.completedAtMs > expected.deadlineAtMs ||
    expected.nowMs > expected.deadlineAtMs
  ) {
    return {
      ok: false,
      code: 'expired-request',
      error: 'helper response arrived after the durable request deadline',
    };
  }

  if (value.ok === false) {
    if (typeof value.error !== 'string' || !isDurableRustMailboxErrorCode(value.errorCode)) {
      return malformedResponse('helper wrote an invalid rejection response');
    }
    return { ok: false, code: value.errorCode, error: value.error };
  }
  if (
    value.ok !== true ||
    (value.session !== 'created' && value.session !== 'reused' && value.session !== 'invalidated') ||
    !isResponseForKind(value.response, expected.requestKind)
  ) {
    return malformedResponse('helper wrote an invalid success response');
  }
  return {
    ok: true,
    session: value.session,
    response: value.response,
  };
}

function decodeCurrentCorrelation(
  value: Record<string, unknown>,
  context: {
    claimRequestId: string;
    sessionIdentity: string;
    nowMs: number;
  },
):
  | {
      ok: true;
      responseIdentity: DurableRustMailboxResponseIdentity;
      operationKey: string;
      clientId: string;
      enqueuedAtMs: number;
      deadlineAtMs: number;
      priorSessionIdentity: boolean;
    }
  | Extract<DurableRustMailboxRequestDecodeResult, { ok: false }> {
  if (
    value.mailboxVersion !== BOUNDED_MAILBOX_VERSION ||
    typeof value.protocolVersion !== 'number' ||
    !Number.isInteger(value.protocolVersion) ||
    typeof value.operationKey !== 'string' ||
    !isSha256Hex(value.operationKey) ||
    value.id !== boundedMailboxRequestId(value.operationKey) ||
    typeof value.clientId !== 'string' ||
    !value.clientId ||
    typeof value.enqueuedAtMs !== 'number' ||
    !Number.isFinite(value.enqueuedAtMs) ||
    typeof value.deadlineAtMs !== 'number' ||
    !Number.isFinite(value.deadlineAtMs) ||
    value.deadlineAtMs < value.enqueuedAtMs ||
    (value.sessionIdentity !== undefined &&
      (typeof value.sessionIdentity !== 'string' || !isSha256Hex(value.sessionIdentity))) ||
    (value.sessionIdentity === undefined && value.protocolVersion !== DURABLE_RUST_SESSION_PROTOCOL_VERSION)
  ) {
    return malformedRequest('Durable Rust semantic helper received an invalid mailbox lifecycle.');
  }
  const responseIdentity = {
    id: context.claimRequestId,
    sessionIdentity: context.sessionIdentity,
    deadlineAtMs: value.deadlineAtMs,
  };
  if (value.sessionIdentity !== undefined && value.sessionIdentity !== context.sessionIdentity) {
    return {
      ok: false,
      code: 'malformed-request',
      error: 'Durable Rust semantic request belongs to a different mailbox session.',
      responseIdentity,
    };
  }
  return {
    ok: true,
    responseIdentity,
    operationKey: value.operationKey,
    clientId: value.clientId,
    enqueuedAtMs: value.enqueuedAtMs,
    deadlineAtMs: value.deadlineAtMs,
    priorSessionIdentity: value.sessionIdentity === undefined,
  };
}

function decodeDurableRustSessionRequest(value: unknown): DurableRustSessionRequest | null {
  if (
    !isRecordObject(value) ||
    typeof value.identityKey !== 'string' ||
    !value.identityKey ||
    !isPositiveInteger(value.timeoutMs) ||
    (value.workerEnvironment !== undefined && !isStringOrNullRecord(value.workerEnvironment))
  ) {
    return null;
  }
  if (value.kind === 'semantic' && isRustReferenceWorkerRequest(value.request)) {
    return {
      kind: 'semantic',
      identityKey: value.identityKey,
      ...(value.workerEnvironment === undefined ? {} : { workerEnvironment: value.workerEnvironment }),
      request: value.request,
      timeoutMs: value.timeoutMs,
    };
  }
  if (value.kind === 'import-definitions' && isRustImportDefinitionWorkerRequest(value.request)) {
    return {
      kind: 'import-definitions',
      identityKey: value.identityKey,
      ...(value.workerEnvironment === undefined ? {} : { workerEnvironment: value.workerEnvironment }),
      request: value.request,
      timeoutMs: value.timeoutMs,
    };
  }
  return null;
}

function isRustReferenceWorkerRequest(value: unknown): value is RustReferenceWorkerRequest {
  if (
    !isRecordObject(value) ||
    !isNonEmptyString(value.projectRoot) ||
    !isNonEmptyString(value.rustAnalyzerBinary) ||
    !isIndexedDefinitionArray(value.definitions)
  ) {
    return false;
  }
  return (
    optionalDefinitionArray(value.referenceDefinitions) &&
    optionalDefinitionArray(value.calleeDefinitions) &&
    optionalDefinitionArray(value.signatureDefinitions) &&
    optionalNonNegativeNumber(value.requestTimeoutMs) &&
    optionalNonNegativeNumber(value.readinessDeadlineMs) &&
    optionalNonNegativeNumber(value.referenceRetryTimeoutMs) &&
    optionalNonNegativeNumber(value.diagnosticsTimeoutMs) &&
    optionalNonNegativeNumber(value.settleDelayMs) &&
    optionalPositiveInteger(value.concurrency) &&
    optionalBoolean(value.includeReferences) &&
    optionalBoolean(value.includeCallees) &&
    optionalBoolean(value.includeSignatures)
  );
}

function isRustImportDefinitionWorkerRequest(value: unknown): value is RustImportDefinitionWorkerRequest {
  if (
    !isRecordObject(value) ||
    !isNonEmptyString(value.projectRoot) ||
    !isNonEmptyString(value.rustAnalyzerBinary) ||
    !isNonEmptyString(value.file) ||
    !Array.isArray(value.positions) ||
    !value.positions.every(
      (position) =>
        isRecordObject(position) &&
        isNonEmptyString(position.id) &&
        isNonEmptyString(position.file) &&
        isNonNegativeInteger(position.line) &&
        isNonNegativeInteger(position.column),
    )
  ) {
    return false;
  }
  return (
    optionalNonNegativeNumber(value.requestTimeoutMs) &&
    optionalNonNegativeNumber(value.readinessDeadlineMs) &&
    optionalNonNegativeNumber(value.diagnosticsTimeoutMs) &&
    optionalNonNegativeNumber(value.settleDelayMs) &&
    optionalPositiveInteger(value.concurrency)
  );
}

function isIndexedDefinitionArray(value: unknown): value is IndexedDefinition[] {
  return Array.isArray(value) && value.every(isIndexedDefinition);
}

function optionalDefinitionArray(value: unknown): boolean {
  return value === undefined || isIndexedDefinitionArray(value);
}

function isIndexedDefinition(value: unknown): value is IndexedDefinition {
  return (
    isRecordObject(value) &&
    isNonNegativeInteger(value.symbolId) &&
    isNonNegativeInteger(value.documentId) &&
    isNonNegativeInteger(value.startLine) &&
    optionalNonNegativeInteger(value.startChar) &&
    isNonNegativeInteger(value.endLine) &&
    optionalNonNegativeInteger(value.endChar) &&
    typeof value.symbol === 'string' &&
    typeof value.relativePath === 'string' &&
    typeof value.leaf === 'string' &&
    (value.parentTypeName === null || typeof value.parentTypeName === 'string') &&
    typeof value.isFunctionLike === 'boolean' &&
    typeof value.isTypeLike === 'boolean' &&
    (value.kind === null || Number.isSafeInteger(value.kind)) &&
    (value.documentation === null || typeof value.documentation === 'string') &&
    (value.enclosingSymbol === null || typeof value.enclosingSymbol === 'string')
  );
}

function isResponseForKind(
  value: unknown,
  kind: DurableRustSessionRequest['kind'],
): value is RustReferenceWorkerResponse | RustImportDefinitionWorkerResponse {
  if (!isRecordObject(value) || typeof value.available !== 'boolean') return false;
  if (
    (value.available === false && (typeof value.reason !== 'string' || value.reason.length === 0)) ||
    (value.available === true && value.reason !== undefined)
  ) {
    return false;
  }
  if (kind === 'import-definitions') {
    return (
      Array.isArray(value.sourcePaths) &&
      value.sourcePaths.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          (entry[1] === null || typeof entry[1] === 'string'),
      )
    );
  }
  return (
    isNumberTupleArray(value.references, isSemanticReference) &&
    (value.incompleteReferenceSymbolIds === undefined ||
      (Array.isArray(value.incompleteReferenceSymbolIds) &&
        value.incompleteReferenceSymbolIds.every((entry) => Number.isSafeInteger(entry)))) &&
    (value.callees === undefined || isNumberTupleArray(value.callees, isSemanticCallee)) &&
    (value.signatures === undefined ||
      (Array.isArray(value.signatures) &&
        value.signatures.every(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            Number.isSafeInteger(entry[0]) &&
            (entry[1] === null || typeof entry[1] === 'string'),
        )))
  );
}

function isNumberTupleArray<T>(value: unknown, itemGuard: (item: unknown) => item is T): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        Number.isSafeInteger(entry[0]) &&
        Array.isArray(entry[1]) &&
        entry[1].every(itemGuard),
    )
  );
}

function isSemanticReference(value: unknown): value is SemanticReference {
  return (
    isRecordObject(value) &&
    typeof value.file === 'string' &&
    isNonNegativeInteger(value.line) &&
    isNonNegativeInteger(value.column)
  );
}

function isSemanticCallee(value: unknown): value is SemanticCallee {
  return (
    isRecordObject(value) &&
    typeof value.symbol === 'string' &&
    typeof value.file === 'string' &&
    isNonNegativeInteger(value.line) &&
    (value.callsiteLine === undefined || isNonNegativeInteger(value.callsiteLine))
  );
}

function isDurableRustMailboxErrorCode(value: unknown): value is DurableRustMailboxErrorCode {
  return (
    value === 'unsupported-protocol' ||
    value === 'malformed-request' ||
    value === 'expired-request' ||
    value === 'handler-error'
  );
}

function malformedRequest(error: string): Extract<DurableRustMailboxRequestDecodeResult, { ok: false }> {
  return { ok: false, code: 'malformed-request', error };
}

function malformedResponse(error: string): Extract<DurableRustMailboxResponseDecodeResult, { ok: false }> {
  return { ok: false, code: 'malformed-response', error };
}

function incompatibleResponse(error: string): Extract<DurableRustMailboxResponseDecodeResult, { ok: false }> {
  return { ok: false, code: 'incompatible-response', error };
}


function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeFiniteNumber(value);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}
