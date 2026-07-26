import { describe, expect, it } from 'vitest';

import type { IndexedDefinition } from '../../../src/domain/types.js';
import {
  DURABLE_RUST_SESSION_PROTOCOL_VERSION,
  decodeDurableRustMailboxRequest,
  decodeDurableRustMailboxResponse,
  durableRustMailboxSessionIdentity,
  type DurableRustMailboxResponseExpectation,
  type DurableRustSessionRequest,
} from '../../../src/semantic/rust/durable-session-protocol.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxRequestId,
} from '../../../src/storage/bounded-mailbox.js';

const NOW = Date.parse('2026-07-25T20:00:00.000Z');
const SESSION = durableRustMailboxSessionIdentity('/tmp/scip-query-rust-session-a');
const OTHER_SESSION = durableRustMailboxSessionIdentity('/tmp/scip-query-rust-session-b');

const definition: IndexedDefinition = {
  symbolId: 1,
  symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().',
  documentId: 1,
  startLine: 0,
  startChar: 0,
  endLine: 2,
  endChar: 1,
  relativePath: 'src/lib.rs',
  leaf: 'run',
  parentTypeName: null,
  isFunctionLike: true,
  isTypeLike: false,
  kind: 12,
  documentation: null,
  enclosingSymbol: null,
};

const semanticRequest: DurableRustSessionRequest = {
  kind: 'semantic',
  identityKey: 'identity-a',
  request: {
    projectRoot: '/repo',
    rustAnalyzerBinary: '/bin/rust-analyzer',
    definitions: [definition],
    requestTimeoutMs: 15_000,
    diagnosticsTimeoutMs: 10_000,
    settleDelayMs: 0,
    concurrency: 8,
    includeReferences: true,
  },
  timeoutMs: 1_000,
};

describe('durable Rust mailbox request protocol', () => {
  it('derives a stable namespace identity and separates different durable sessions', () => {
    expect(SESSION).toMatch(/^[a-f0-9]{64}$/);
    expect(SESSION).toBe(durableRustMailboxSessionIdentity('/tmp/scip-query-rust-session-a'));
    expect(SESSION).not.toBe(OTHER_SESSION);
  });

  it('accepts a fully correlated current request and the prior unversioned request', () => {
    const current = currentEnvelope();
    expect(
      decodeDurableRustMailboxRequest(current, {
        claimRequestId: current.id,
        sessionIdentity: SESSION,
        nowMs: NOW,
      }),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        compatibility: 'current-v3',
        value: expect.objectContaining({
          id: current.id,
          operationKey: current.operationKey,
          sessionIdentity: SESSION,
          request: semanticRequest,
        }),
      }),
    );

    const { sessionIdentity: _sessionIdentity, ...priorV3 } = current;
    expect(
      decodeDurableRustMailboxRequest(priorV3, {
        claimRequestId: priorV3.id,
        sessionIdentity: SESSION,
        nowMs: NOW,
      }),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        compatibility: 'prior-v3',
        value: expect.objectContaining({
          id: current.id,
          sessionIdentity: SESSION,
          request: semanticRequest,
        }),
      }),
    );

    expect(
      decodeDurableRustMailboxRequest(
        { id: 'legacy-request', request: semanticRequest },
        {
          claimRequestId: 'legacy-request',
          sessionIdentity: SESSION,
          nowMs: NOW,
        },
      ),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        compatibility: 'legacy-v2',
        value: expect.objectContaining({
          id: 'legacy-request',
          protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
          sessionIdentity: SESSION,
          deadlineAtMs: NOW + 1_000,
        }),
      }),
    );
  });

  it('rejects a missing, future, mismatched, expired, or replayed lifecycle with a typed reason', () => {
    const current = currentEnvelope();
    const cases: Array<{
      name: string;
      value: Record<string, unknown>;
      claimRequestId?: string;
      nowMs?: number;
      code: string;
      message: string;
    }> = [
      {
        name: 'missing version',
        value: { ...current, protocolVersion: undefined },
        code: 'malformed-request',
        message: 'partially versioned',
      },
      {
        name: 'future version',
        value: { ...current, protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION + 1 },
        code: 'unsupported-protocol',
        message: 'does not support',
      },
      {
        name: 'wrong mailbox session',
        value: { ...current, sessionIdentity: OTHER_SESSION },
        code: 'malformed-request',
        message: 'different mailbox session',
      },
      {
        name: 'wrong path identity',
        value: current,
        claimRequestId: 'op-' + 'f'.repeat(64),
        code: 'malformed-request',
        message: 'mailbox path',
      },
      {
        name: 'expired before work',
        value: current,
        nowMs: NOW + 1_001,
        code: 'expired-request',
        message: 'expired before processing',
      },
      {
        name: 'deadline does not match timeout',
        value: { ...current, deadlineAtMs: NOW + 999 },
        code: 'malformed-request',
        message: 'does not match the request timeout',
      },
      {
        name: 'replayed operation body',
        value: {
          ...current,
          request: {
            ...semanticRequest,
            identityKey: 'identity-from-another-operation',
          },
        },
        code: 'malformed-request',
        message: 'operation identity',
      },
    ];

    for (const testCase of cases) {
      const decoded = decodeDurableRustMailboxRequest(testCase.value, {
        claimRequestId: testCase.claimRequestId ?? current.id,
        sessionIdentity: SESSION,
        nowMs: testCase.nowMs ?? NOW,
      });
      expect(decoded, testCase.name).toEqual(
        expect.objectContaining({
          ok: false,
          code: testCase.code,
          error: expect.stringContaining(testCase.message),
        }),
      );
    }
  });

  it('validates both request kinds instead of casting their payloads', () => {
    const current = currentEnvelope();
    for (const request of [
      { ...semanticRequest, kind: 'unknown' },
      { ...semanticRequest, timeoutMs: 0 },
      { ...semanticRequest, workerEnvironment: { PATH: 42 } },
      {
        ...semanticRequest,
        request: { ...semanticRequest.request, definitions: [{ ...definition, startLine: -1 }] },
      },
      {
        kind: 'import-definitions',
        identityKey: 'identity-a',
        timeoutMs: 1_000,
        request: {
          projectRoot: '/repo',
          rustAnalyzerBinary: '/bin/rust-analyzer',
          file: 'src/lib.rs',
          positions: [{ id: 'import-1', file: 'src/lib.rs', line: 0, column: -1 }],
        },
      },
    ]) {
      const operationKey = boundedMailboxOperationKey('rust-semantic-v3', request);
      const id = boundedMailboxRequestId(operationKey);
      const decoded = decodeDurableRustMailboxRequest(
        {
          ...current,
          id,
          operationKey,
          request,
        },
        {
          claimRequestId: id,
          sessionIdentity: SESSION,
          nowMs: NOW,
        },
      );
      expect(decoded).toEqual(
        expect.objectContaining({
          ok: false,
          code: 'malformed-request',
          error: expect.stringContaining('invalid request kind or payload'),
        }),
      );
    }
  });
});

describe('durable Rust mailbox response protocol', () => {
  it('accepts only a current response with the expected operation, session, deadline, and response kind', () => {
    const expected = responseExpectation();
    expect(decodeDurableRustMailboxResponse(successResponse(expected), expected)).toEqual({
      ok: true,
      session: 'reused',
      response: {
        available: true,
        references: [[1, []]],
      },
    });

    expect(
      decodeDurableRustMailboxResponse(
        {
          ...successResponse(expected),
          response: { available: true, sourcePaths: [['import-1', null]] },
        },
        expected,
      ),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: 'malformed-response',
        error: expect.stringContaining('invalid success'),
      }),
    );
  });

  it('rejects prior, future, mismatched, replayed, and expired responses before exposing payload data', () => {
    const expected = responseExpectation();
    const current = successResponse(expected);
    const cases: Array<{
      name: string;
      response: Record<string, unknown>;
      expectation?: DurableRustMailboxResponseExpectation;
      code: string;
      message: string;
    }> = [
      {
        name: 'older server omitted the new correlation fields',
        response: {
          ok: true,
          protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
          id: expected.requestId,
          operationKey: expected.operationKey,
          session: 'reused',
          response: current.response,
        },
        code: 'incompatible-response',
        message: 'incompatible response identity',
      },
      {
        name: 'future protocol',
        response: { ...current, protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION + 1 },
        code: 'incompatible-response',
        message: 'unsupported response protocol',
      },
      {
        name: 'wrong request id',
        response: { ...current, id: 'op-' + 'f'.repeat(64) },
        code: 'incompatible-response',
        message: 'incompatible response identity',
      },
      {
        name: 'wrong operation id',
        response: { ...current, operationKey: 'f'.repeat(64) },
        code: 'incompatible-response',
        message: 'incompatible response identity',
      },
      {
        name: 'cross-session replay',
        response: { ...current, sessionIdentity: OTHER_SESSION },
        code: 'incompatible-response',
        message: 'incompatible response identity',
      },
      {
        name: 'wrong deadline',
        response: { ...current, deadlineAtMs: expected.deadlineAtMs + 1 },
        code: 'incompatible-response',
        message: 'incompatible response identity',
      },
      {
        name: 'helper completed after expiry',
        response: { ...current, completedAtMs: expected.deadlineAtMs + 1 },
        code: 'expired-request',
        message: 'after the durable request deadline',
      },
      {
        name: 'client observed after expiry',
        response: current,
        expectation: { ...expected, nowMs: expected.deadlineAtMs + 1 },
        code: 'expired-request',
        message: 'after the durable request deadline',
      },
    ];

    for (const testCase of cases) {
      expect(
        decodeDurableRustMailboxResponse(testCase.response, testCase.expectation ?? expected),
        testCase.name,
      ).toEqual(
        expect.objectContaining({
          ok: false,
          code: testCase.code,
          error: expect.stringContaining(testCase.message),
        }),
      );
    }
  });

  it('accepts a fully correlated explicit rejection and stays additive for the previous v3 reader', () => {
    const expected = responseExpectation();
    const rejection = {
      ...successResponse(expected),
      ok: false,
      errorCode: 'unsupported-protocol',
      error: 'unsupported request protocol',
      session: undefined,
      response: undefined,
    };
    expect(decodeDurableRustMailboxResponse(rejection, expected)).toEqual({
      ok: false,
      code: 'unsupported-protocol',
      error: 'unsupported request protocol',
    });

    expect(previousV3Reader(successResponse(expected))).toEqual({
      ok: true,
      session: 'reused',
      response: {
        available: true,
        references: [[1, []]],
      },
    });
  });
});

function currentEnvelope(): {
  mailboxVersion: 1;
  protocolVersion: 3;
  id: string;
  operationKey: string;
  clientId: string;
  enqueuedAtMs: number;
  deadlineAtMs: number;
  sessionIdentity: string;
  request: DurableRustSessionRequest;
} {
  const operationKey = boundedMailboxOperationKey('rust-semantic-v3', semanticRequest);
  return {
    mailboxVersion: BOUNDED_MAILBOX_VERSION,
    protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
    id: boundedMailboxRequestId(operationKey),
    operationKey,
    clientId: 'client-a',
    enqueuedAtMs: NOW,
    deadlineAtMs: NOW + 1_000,
    sessionIdentity: SESSION,
    request: semanticRequest,
  };
}

function responseExpectation(): DurableRustMailboxResponseExpectation {
  const request = currentEnvelope();
  return {
    requestId: request.id,
    operationKey: request.operationKey,
    sessionIdentity: request.sessionIdentity,
    deadlineAtMs: request.deadlineAtMs,
    requestKind: 'semantic',
    nowMs: NOW + 500,
  };
}

function successResponse(expected: DurableRustMailboxResponseExpectation): Record<string, unknown> {
  return {
    ok: true,
    mailboxVersion: BOUNDED_MAILBOX_VERSION,
    protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
    id: expected.requestId,
    operationKey: expected.operationKey,
    sessionIdentity: expected.sessionIdentity,
    deadlineAtMs: expected.deadlineAtMs,
    completedAtMs: NOW + 400,
    session: 'reused',
    response: {
      available: true,
      references: [[1, []]],
    },
  };
}

function previousV3Reader(value: Record<string, unknown>): unknown {
  if (
    value.protocolVersion !== DURABLE_RUST_SESSION_PROTOCOL_VERSION ||
    typeof value.id !== 'string' ||
    typeof value.operationKey !== 'string'
  ) {
    return null;
  }
  if (
    value.ok === true &&
    (value.session === 'created' || value.session === 'reused' || value.session === 'invalidated') &&
    value.response &&
    typeof value.response === 'object'
  ) {
    return { ok: true, session: value.session, response: value.response };
  }
  return null;
}
