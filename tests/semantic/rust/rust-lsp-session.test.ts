import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import {
  createConfiguredRustAnalyzerSessionRequester,
  createFailoverRustAnalyzerSessionRequester,
  createRustAnalyzerSessionResolver,
  rustSemanticSessionTransport,
  type RustAnalyzerSessionRequester,
  type RustImportDefinitionWorkerRequest,
} from '../../../src/semantic/rust/lsp-session.js';
import type {
  RustReferenceWorkerRequest,
  RustReferenceWorkerResponse,
} from '../../../src/semantic/rust/lsp-batch-worker.js';

function rustDefinition(overrides: Partial<IndexedDefinition> = {}): IndexedDefinition {
  return {
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
    ...overrides,
  };
}

const semanticRequest: RustReferenceWorkerRequest = {
  projectRoot: '/repo',
  rustAnalyzerBinary: '/bin/rust-analyzer',
  definitions: [rustDefinition()],
  requestTimeoutMs: 15_000,
  diagnosticsTimeoutMs: 10_000,
  settleDelayMs: 5_000,
  concurrency: 8,
  includeReferences: true,
};

const importDefinitionRequest: RustImportDefinitionWorkerRequest = {
  projectRoot: '/repo',
  rustAnalyzerBinary: '/bin/rust-analyzer',
  file: 'src/lib.rs',
  positions: [{ id: 'import-1', file: 'src/lib.rs', line: 0, column: 4 }],
  requestTimeoutMs: 15_000,
  diagnosticsTimeoutMs: 10_000,
  settleDelayMs: 5_000,
  concurrency: 8,
};

describe('createFailoverRustAnalyzerSessionRequester', () => {
  it('keeps healthy semantic and import requests on the primary without creating the fallback', () => {
    let fallbackCreations = 0;
    let primaryShutdowns = 0;
    const primary: RustAnalyzerSessionRequester = {
      requestSemantic(request) {
        return { available: true, references: request.definitions.map((definition) => [definition.symbolId, []]) };
      },
      requestImportDefinitions(request) {
        return { available: true, sourcePaths: request.positions.map((position) => [position.id, 'src/math.rs']) };
      },
      shutdown() {
        primaryShutdowns += 1;
      },
    };
    const requester = createFailoverRustAnalyzerSessionRequester(primary, () => {
      fallbackCreations += 1;
      return fakeSessionRequester('fallback');
    });

    expect(requester.requestSemantic(semanticRequest, 111).references).toEqual([[1, []]]);
    expect(requester.requestImportDefinitions(importDefinitionRequest, 222).sourcePaths).toEqual([
      ['import-1', 'src/math.rs'],
    ]);
    expect(fallbackCreations).toBe(0);

    requester.shutdown();
    requester.shutdown();
    expect(primaryShutdowns).toBe(1);
    expect(fallbackCreations).toBe(0);
  });

  it('replays the exact semantic call once and permanently latches later method types to one fallback', () => {
    const fallbackSemanticCalls: Array<{ request: RustReferenceWorkerRequest; timeoutMs: number }> = [];
    const fallbackImportCalls: Array<{ request: RustImportDefinitionWorkerRequest; timeoutMs: number }> = [];
    let primarySemanticCalls = 0;
    let primaryImportCalls = 0;
    let primaryShutdowns = 0;
    let fallbackCreations = 0;
    let fallbackShutdowns = 0;
    const primary: RustAnalyzerSessionRequester = {
      requestSemantic() {
        primarySemanticCalls += 1;
        throw new Error('durable request failed');
      },
      requestImportDefinitions() {
        primaryImportCalls += 1;
        return { available: true, sourcePaths: [] };
      },
      shutdown() {
        primaryShutdowns += 1;
      },
    };
    const requester = createFailoverRustAnalyzerSessionRequester(primary, () => {
      fallbackCreations += 1;
      return {
        requestSemantic(request, timeoutMs) {
          fallbackSemanticCalls.push({ request, timeoutMs });
          return { available: true, references: [[1, []]] };
        },
        requestImportDefinitions(request, timeoutMs) {
          fallbackImportCalls.push({ request, timeoutMs });
          return { available: true, sourcePaths: [['import-1', 'src/math.rs']] };
        },
        shutdown() {
          fallbackShutdowns += 1;
        },
      };
    });

    expect(requester.requestSemantic(semanticRequest, 777).references).toEqual([[1, []]]);
    expect(fallbackSemanticCalls).toHaveLength(1);
    expect(fallbackSemanticCalls[0]?.request).toBe(semanticRequest);
    expect(fallbackSemanticCalls[0]?.timeoutMs).toBe(777);
    expect(requester.requestImportDefinitions(importDefinitionRequest, 888).sourcePaths).toEqual([
      ['import-1', 'src/math.rs'],
    ]);
    expect(fallbackImportCalls[0]?.request).toBe(importDefinitionRequest);
    expect(fallbackImportCalls[0]?.timeoutMs).toBe(888);
    expect(primarySemanticCalls).toBe(1);
    expect(primaryImportCalls).toBe(0);
    expect(primaryShutdowns).toBe(1);
    expect(fallbackCreations).toBe(1);

    requester.shutdown();
    requester.shutdown();
    expect(primaryShutdowns).toBe(1);
    expect(fallbackShutdowns).toBe(1);
  });

  it('replays the exact import-definition call once after the first primary failure', () => {
    const fallbackCalls: Array<{ request: RustImportDefinitionWorkerRequest; timeoutMs: number }> = [];
    let primaryShutdowns = 0;
    const requester = createFailoverRustAnalyzerSessionRequester(
      {
        requestSemantic() {
          return { available: true, references: [] };
        },
        requestImportDefinitions() {
          throw new Error('durable import request failed');
        },
        shutdown() {
          primaryShutdowns += 1;
        },
      },
      () => ({
        requestSemantic() {
          return { available: true, references: [] };
        },
        requestImportDefinitions(request, timeoutMs) {
          fallbackCalls.push({ request, timeoutMs });
          return { available: true, sourcePaths: [] };
        },
        shutdown() {},
      }),
    );

    expect(requester.requestImportDefinitions(importDefinitionRequest, 999).available).toBe(true);
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]?.request).toBe(importDefinitionRequest);
    expect(fallbackCalls[0]?.timeoutMs).toBe(999);
    expect(primaryShutdowns).toBe(1);
  });

  it('lets fallback failures reach the resolver one-shot and unavailable paths', () => {
    let oneShotCalls = 0;
    let primaryShutdowns = 0;
    const requester = createFailoverRustAnalyzerSessionRequester(
      {
        requestSemantic() {
          throw new Error('durable request failed');
        },
        requestImportDefinitions() {
          throw new Error('durable import request should not be retried');
        },
        shutdown() {
          primaryShutdowns += 1;
        },
      },
      () => ({
        requestSemantic() {
          throw new Error('worker semantic request failed');
        },
        requestImportDefinitions() {
          throw new Error('worker import request failed');
        },
        shutdown() {},
      }),
    );
    const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
      requester,
      fallbackReferenceResolver: {
        referencesForDefinitions(definitions) {
          oneShotCalls += 1;
          return {
            available: true,
            resolvedBinary: 'rust-analyzer',
            references: new Map(definitions.map((definition) => [definition.symbolId, []])),
          };
        },
      },
    });

    expect(resolver.referencesForDefinitions([rustDefinition()]).references).toEqual(new Map([[1, []]]));
    expect(oneShotCalls).toBe(1);
    expect(
      resolver.importDefinitionsForFile('src/lib.rs', [{ id: 'import-1', file: 'src/lib.rs', line: 0, column: 4 }]),
    ).toMatchObject({ available: false, reason: 'worker import request failed' });
    expect(primaryShutdowns).toBe(1);
  });

  it('profiles only sanitized failover reason categories', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-failover-profile-'));
    const profilePath = join(tempRoot, 'profile.jsonl');
    const previousProfile = process.env['SCIP_QUERY_PROFILE'];
    const previousProfileOut = process.env['SCIP_QUERY_PROFILE_OUT'];
    process.env['SCIP_QUERY_PROFILE'] = '1';
    process.env['SCIP_QUERY_PROFILE_OUT'] = profilePath;
    const failures = [
      new Error('rust-analyzer readiness deadline expired for /private/source.rs'),
      new Error('Durable Rust semantic session timed out after 5s at /private/source.rs'),
      new Error('Durable Rust semantic session helper was not found at /secret/helper.js; HOME=/Users/alice'),
      new Error('mailbox request failed for PATH=/secret/bin'),
    ];

    try {
      for (const failure of failures) {
        createFailoverRustAnalyzerSessionRequester(
          {
            requestSemantic() {
              throw failure;
            },
            requestImportDefinitions() {
              throw failure;
            },
            shutdown() {},
          },
          () => fakeSessionRequester('fallback'),
        ).requestSemantic(semanticRequest, 1_000);
      }

      const raw = readFileSync(profilePath, 'utf8');
      const events = raw
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as { name?: string; kind?: string; disposition?: string; reason?: string; error?: string },
        );
      expect(events).toEqual(
        ['readiness', 'timeout', 'helper', 'request'].map((reason) =>
          expect.objectContaining({
            name: 'rust.semantic.durable-session.request',
            kind: 'semantic',
            disposition: 'worker-fallback',
            reason,
          }),
        ),
      );
      expect(events.every((event) => event.error === undefined)).toBe(true);
      expect(raw).not.toContain('/private/source.rs');
      expect(raw).not.toContain('/secret/helper.js');
      expect(raw).not.toContain('/Users/alice');
      expect(raw).not.toContain('/secret/bin');
    } finally {
      restoreEnv('SCIP_QUERY_PROFILE', previousProfile);
      restoreEnv('SCIP_QUERY_PROFILE_OUT', previousProfileOut);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('RustAnalyzerSessionResolver', () => {
  it('selects durable transport only for an explicit opt-in', () => {
    expect(rustSemanticSessionTransport(undefined)).toBe('worker');
    expect(rustSemanticSessionTransport('0')).toBe('worker');
    expect(rustSemanticSessionTransport('false')).toBe('worker');
    expect(rustSemanticSessionTransport('1')).toBe('durable');
    expect(rustSemanticSessionTransport('true')).toBe('durable');
  });

  it('constructs the selected requester without changing the default transport', () => {
    const worker = fakeSessionRequester('worker');
    let workerCreations = 0;
    let durableCreations = 0;
    let durableShutdowns = 0;
    const durable: RustAnalyzerSessionRequester = {
      requestSemantic() {
        throw new Error('durable request failed');
      },
      requestImportDefinitions() {
        throw new Error('durable request failed');
      },
      shutdown() {
        durableShutdowns += 1;
      },
    };
    const factories = {
      worker: () => {
        workerCreations += 1;
        return worker;
      },
      durable: () => {
        durableCreations += 1;
        return durable;
      },
    };

    expect(createConfiguredRustAnalyzerSessionRequester('/repo', undefined, factories)).toBe(worker);
    expect(createConfiguredRustAnalyzerSessionRequester('/repo', 'false', factories)).toBe(worker);
    const configured = createConfiguredRustAnalyzerSessionRequester('/repo', '1', factories);
    expect(configured).not.toBe(durable);
    expect(durableCreations).toBe(1);
    expect(workerCreations).toBe(2);
    expect(configured.requestSemantic(semanticRequest, 1_000).available).toBe(true);
    expect(workerCreations).toBe(3);
    expect(durableShutdowns).toBe(1);
  });

  it('routes references, callees, and signatures through one session requester', () => {
    const requests: RustReferenceWorkerRequest[] = [];
    let shutdowns = 0;
    const requester: RustAnalyzerSessionRequester = {
      requestSemantic(request) {
        requests.push(request);
        if (request.includeCallees) {
          return {
            available: true,
            references: [[1, []]],
            callees: [[1, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]]],
          };
        }
        if (request.includeSignatures) {
          return {
            available: true,
            references: [[1, []]],
            signatures: [[1, 'pub fn run() -> i32']],
          };
        }
        return {
          available: true,
          references: [[1, [{ file: 'src/main.rs', line: 8, column: 5 }]]],
        };
      },
      requestImportDefinitions() {
        return {
          available: true,
          sourcePaths: [],
        };
      },
      shutdown() {
        shutdowns += 1;
      },
    };
    const definition = rustDefinition();
    const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, { requester });

    expect(resolver.referencesForDefinitions([definition]).references).toEqual(
      new Map([[1, [{ file: 'src/main.rs', line: 8, column: 5 }]]]),
    );
    expect(resolver.calleesForDefinitions([definition]).callees).toEqual(
      new Map([[1, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]]]),
    );
    expect(resolver.signaturesForDefinitions([definition]).signatures).toEqual(new Map([[1, 'pub fn run() -> i32']]));

    expect(requests).toHaveLength(3);
    expect(
      requests.map((request) => [request.includeReferences, request.includeCallees, request.includeSignatures]),
    ).toEqual([
      [true, undefined, undefined],
      [false, true, undefined],
      [false, false, true],
    ]);
    resolver.dispose();
    expect(shutdowns).toBe(1);
  });

  it('requests split reference and callee batches through one session request', () => {
    const referenceDefinition = rustDefinition({ symbolId: 1, leaf: 'referenced' });
    const calleeDefinition = rustDefinition({
      symbolId: 2,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/caller().',
      leaf: 'caller',
      startLine: 4,
      endLine: 8,
    });
    const requests: RustReferenceWorkerRequest[] = [];
    const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
      requester: {
        requestSemantic(request) {
          requests.push(request);
          return {
            available: true,
            references: [[1, [{ file: 'src/main.rs', line: 8, column: 5 }]]],
            callees: [[2, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]]],
          };
        },
        requestImportDefinitions() {
          return {
            available: true,
            sourcePaths: [],
          };
        },
        shutdown() {},
      },
    });

    const result = resolver.referencesAndCalleesForDefinitions([referenceDefinition], [calleeDefinition]);

    expect(result).toMatchObject({
      available: true,
      resolvedBinary: 'rust-analyzer',
    });
    expect(result.references).toEqual(new Map([[1, [{ file: 'src/main.rs', line: 8, column: 5 }]]]));
    expect(result.callees).toEqual(new Map([[2, [{ symbol: 'compute_total', file: 'src/math.rs', line: 4 }]]]));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.definitions.map((definition) => definition.symbolId)).toEqual([1, 2]);
    expect(requests[0]?.referenceDefinitions?.map((definition) => definition.symbolId)).toEqual([1]);
    expect(requests[0]?.calleeDefinitions?.map((definition) => definition.symbolId)).toEqual([2]);
    expect([requests[0]?.includeReferences, requests[0]?.includeCallees, requests[0]?.includeSignatures]).toEqual([
      true,
      true,
      undefined,
    ]);
  });

  it('does not complete timed-out reference rows as empty results', () => {
    const completed = rustDefinition({ symbolId: 1, leaf: 'completed' });
    const timedOut = rustDefinition({
      symbolId: 2,
      symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/timed_out().',
      leaf: 'timed_out',
      startLine: 4,
      endLine: 6,
    });
    const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
      requester: {
        requestSemantic() {
          return {
            available: true,
            references: [[1, []]],
            incompleteReferenceSymbolIds: [2],
          };
        },
        requestImportDefinitions() {
          return {
            available: true,
            sourcePaths: [],
          };
        },
        shutdown() {},
      },
    });

    expect(resolver.referencesForDefinitions([completed, timedOut]).references).toEqual(new Map([[1, []]]));
  });

  it('falls back to the one-shot resolver when the session bridge cannot run', () => {
    const definition = rustDefinition();
    const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
      requester: {
        requestSemantic() {
          throw new Error('session worker missing');
        },
        requestImportDefinitions() {
          throw new Error('session worker missing');
        },
        shutdown() {},
      },
      fallbackReferenceResolver: {
        referencesForDefinitions(definitions) {
          return {
            available: true,
            resolvedBinary: 'rust-analyzer',
            references: new Map(
              definitions.map((entry) => [entry.symbolId, [{ file: 'src/fallback.rs', line: 2, column: 9 }]]),
            ),
          };
        },
      },
    });

    expect(resolver.referencesForDefinitions([definition])).toEqual({
      available: true,
      resolvedBinary: 'rust-analyzer',
      references: new Map([[1, [{ file: 'src/fallback.rs', line: 2, column: 9 }]]]),
    });
  });

  it('reports unavailable without calling the requester when rust-analyzer is unavailable', () => {
    const requested: RustReferenceWorkerResponse[] = [];
    const resolver = createRustAnalyzerSessionResolver(
      '/repo',
      () => ({
        available: false,
        dependencyAvailable: false,
        reason: 'rust-analyzer is not runnable',
      }),
      {
        requester: {
          requestSemantic(request) {
            requested.push({
              available: true,
              references: request.definitions.map((definition) => [definition.symbolId, []]),
            });
            return requested[requested.length - 1]!;
          },
          requestImportDefinitions() {
            return {
              available: true,
              sourcePaths: [],
            };
          },
          shutdown() {},
        },
      },
    );

    expect(resolver.referencesForDefinitions([rustDefinition()])).toEqual({
      available: false,
      resolvedBinary: undefined,
      reason: 'rust-analyzer is not runnable',
      references: new Map([[1, []]]),
    });
    expect(requested).toEqual([]);
  });

  it('resolves Rust import positions through the session requester', () => {
    const requests: Array<{ file: string; ids: string[] }> = [];
    const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
      requester: {
        requestSemantic() {
          return {
            available: true,
            references: [],
          };
        },
        requestImportDefinitions(request) {
          requests.push({ file: request.file, ids: request.positions.map((position) => position.id) });
          return {
            available: true,
            sourcePaths: [
              ['0', 'src/math.rs'],
              ['1', null],
            ],
          };
        },
        shutdown() {},
      },
    });

    expect(
      resolver.importDefinitionsForFile('src/lib.rs', [
        { id: '0', file: 'src/lib.rs', line: 0, column: 18 },
        { id: '1', file: 'src/lib.rs', line: 0, column: 29 },
      ]),
    ).toEqual({
      available: true,
      resolvedBinary: 'rust-analyzer',
      reason: undefined,
      sourcePaths: new Map([
        ['0', 'src/math.rs'],
        ['1', null],
      ]),
    });
    expect(requests).toEqual([{ file: 'src/lib.rs', ids: ['0', '1'] }]);
  });

  it('skips the default settle wait for small reference-only batches', () => {
    const requests: RustReferenceWorkerRequest[] = [];
    const previousSettleDelay = process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    delete process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    try {
      const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
        requester: {
          requestSemantic(request) {
            requests.push(request);
            return {
              available: true,
              references: request.definitions.map((definition) => [definition.symbolId, []]),
            };
          },
          requestImportDefinitions() {
            return {
              available: true,
              sourcePaths: [],
            };
          },
          shutdown() {},
        },
      });

      resolver.referencesForDefinitions([rustDefinition()]);
    } finally {
      restoreEnv('SCIP_RUST_SEMANTIC_SETTLE_MS', previousSettleDelay);
    }

    expect(requests[0]?.settleDelayMs).toBe(0);
  });

  it('skips the default settle wait for small combined reference and callee batches', () => {
    const requests: RustReferenceWorkerRequest[] = [];
    const previousSettleDelay = process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    delete process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    try {
      const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
        requester: {
          requestSemantic(request) {
            requests.push(request);
            return {
              available: true,
              references: request.definitions.map((definition) => [definition.symbolId, []]),
              callees: request.definitions.map((definition) => [definition.symbolId, []]),
            };
          },
          requestImportDefinitions() {
            return {
              available: true,
              sourcePaths: [],
            };
          },
          shutdown() {},
        },
      });

      resolver.referencesAndCalleesForDefinitions([rustDefinition({ symbolId: 1 })], [rustDefinition({ symbolId: 2 })]);
    } finally {
      restoreEnv('SCIP_RUST_SEMANTIC_SETTLE_MS', previousSettleDelay);
    }

    expect(requests[0]?.settleDelayMs).toBe(0);
    expect([requests[0]?.includeReferences, requests[0]?.includeCallees, requests[0]?.includeSignatures]).toEqual([
      true,
      true,
      undefined,
    ]);
  });

  it('keeps the default settle wait for large reference and callee batches', () => {
    const requests: RustReferenceWorkerRequest[] = [];
    const previousSettleDelay = process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    delete process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    try {
      const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
        requester: {
          requestSemantic(request) {
            requests.push(request);
            return {
              available: true,
              references: request.definitions.map((definition) => [definition.symbolId, []]),
              callees: request.includeCallees
                ? request.definitions.map((definition) => [definition.symbolId, []])
                : undefined,
            };
          },
          requestImportDefinitions() {
            return {
              available: true,
              sourcePaths: [],
            };
          },
          shutdown() {},
        },
      });
      const largeReferenceBatch = Array.from({ length: 65 }, (_, index) => rustDefinition({ symbolId: index + 1 }));

      resolver.referencesForDefinitions(largeReferenceBatch);
      resolver.calleesForDefinitions([rustDefinition()]);
    } finally {
      restoreEnv('SCIP_RUST_SEMANTIC_SETTLE_MS', previousSettleDelay);
    }

    expect(requests.map((request) => request.settleDelayMs)).toEqual([5000, 5000]);
  });

  it('keeps the default settle wait for large combined reference and callee batches', () => {
    const requests: RustReferenceWorkerRequest[] = [];
    const previousSettleDelay = process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    delete process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    try {
      const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
        requester: {
          requestSemantic(request) {
            requests.push(request);
            return {
              available: true,
              references: request.definitions.map((definition) => [definition.symbolId, []]),
              callees: request.definitions.map((definition) => [definition.symbolId, []]),
            };
          },
          requestImportDefinitions() {
            return {
              available: true,
              sourcePaths: [],
            };
          },
          shutdown() {},
        },
      });
      const largeBatch = Array.from({ length: 97 }, (_, index) => rustDefinition({ symbolId: index + 1 }));

      resolver.referencesAndCalleesForDefinitions(largeBatch, largeBatch);
    } finally {
      restoreEnv('SCIP_RUST_SEMANTIC_SETTLE_MS', previousSettleDelay);
    }

    expect(requests[0]?.settleDelayMs).toBe(5000);
  });

  it('allows zero diagnostics and settle delays for Rust semantic experiments', () => {
    const requests: RustReferenceWorkerRequest[] = [];
    const previousDiagnosticsTimeout = process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'];
    const previousSettleDelay = process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    process.env['SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS'] = '0';
    process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'] = '0';
    try {
      const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
        requester: {
          requestSemantic(request) {
            requests.push(request);
            return {
              available: true,
              references: request.definitions.map((definition) => [definition.symbolId, []]),
            };
          },
          requestImportDefinitions() {
            return {
              available: true,
              sourcePaths: [],
            };
          },
          shutdown() {},
        },
      });

      resolver.referencesForDefinitions([rustDefinition()]);
    } finally {
      restoreEnv('SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS', previousDiagnosticsTimeout);
      restoreEnv('SCIP_RUST_SEMANTIC_SETTLE_MS', previousSettleDelay);
    }

    expect(requests[0]?.diagnosticsTimeoutMs).toBe(0);
    expect(requests[0]?.settleDelayMs).toBe(0);
  });

  it('threads opt-in reference retry timeout through the session request and wait budget', () => {
    const requests: Array<{ request: RustReferenceWorkerRequest; timeoutMs: number }> = [];
    const previousRequestTimeout = process.env['SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS'];
    const previousRetryTimeout = process.env['SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS'];
    const previousConcurrency = process.env['SCIP_RUST_SEMANTIC_CONCURRENCY'];
    process.env['SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS'] = '100';
    process.env['SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS'] = '250';
    process.env['SCIP_RUST_SEMANTIC_CONCURRENCY'] = '8';
    try {
      const resolver = createRustAnalyzerSessionResolver('/repo', availableStatus, {
        requester: {
          requestSemantic(request, timeoutMs) {
            requests.push({ request, timeoutMs });
            return {
              available: true,
              references: request.definitions.map((definition) => [definition.symbolId, []]),
            };
          },
          requestImportDefinitions() {
            return {
              available: true,
              sourcePaths: [],
            };
          },
          shutdown() {},
        },
      });
      const definitions = Array.from({ length: 4000 }, (_, index) =>
        rustDefinition({
          symbolId: index + 1,
          symbol: `rust-analyzer cargo fixture 0.1.0 src/lib.rs/item_${index}().`,
          leaf: `item_${index}`,
          startLine: index,
          endLine: index + 1,
        }),
      );

      resolver.referencesForDefinitions(definitions);
    } finally {
      restoreEnv('SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS', previousRequestTimeout);
      restoreEnv('SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS', previousRetryTimeout);
      restoreEnv('SCIP_RUST_SEMANTIC_CONCURRENCY', previousConcurrency);
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.referenceRetryTimeoutMs).toBe(250);
    expect(requests[0]?.timeoutMs).toBe(155_000);
  });
});

function availableStatus() {
  return {
    available: true,
    dependencyAvailable: true,
    resolvedBinary: 'rust-analyzer',
    reason: 'rust-analyzer semantic queries are enabled.',
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function fakeSessionRequester(_label: string): RustAnalyzerSessionRequester {
  return {
    requestSemantic(request) {
      return {
        available: true,
        references: request.definitions.map((definition) => [definition.symbolId, []]),
      };
    },
    requestImportDefinitions() {
      return { available: true, sourcePaths: [] };
    },
    shutdown() {},
  };
}
