import { describe, expect, it } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import {
  createRustAnalyzerSessionResolver,
  type RustAnalyzerSessionRequester,
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

describe('RustAnalyzerSessionResolver', () => {
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
});

function availableStatus() {
  return {
    available: true,
    dependencyAvailable: true,
    resolvedBinary: 'rust-analyzer',
    reason: 'rust-analyzer semantic queries are enabled.',
  };
}
