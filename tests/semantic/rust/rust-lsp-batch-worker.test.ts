import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import type { RustAnalyzerLspClient } from '../../../src/semantic/rust/lsp-client.js';
import type { LspLocation, LspReferenceParams } from '../../../src/semantic/rust/lsp-types.js';

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

afterEach(() => {
  vi.doUnmock('../../../src/semantic/rust/lsp-client.js');
  vi.resetModules();
});

describe('Rust LSP batch worker', () => {
  it('marks timed-out reference lookups incomplete when retry is disabled', async () => {
    const { referencesWithCompletion } = await import('../../../src/semantic/rust/lsp-batch-worker.js');
    const params = referenceParams();
    const client = {
      references: vi.fn(async () => {
        throw new Error('rust-analyzer LSP request textDocument/references timed out after 15ms');
      }),
    } as unknown as RustAnalyzerLspClient;

    const result = await referencesWithCompletion(client, params);

    expect(result).toEqual({ locations: [], complete: false });
    expect(client.references).toHaveBeenCalledTimes(1);
  });

  it('retries timed-out reference lookups with the configured retry timeout', async () => {
    const { referencesWithCompletion } = await import('../../../src/semantic/rust/lsp-batch-worker.js');
    const params = referenceParams();
    const location: LspLocation = {
      uri: 'file:///repo/src/lib.rs',
      range: { start: { line: 4, character: 9 }, end: { line: 4, character: 16 } },
    };
    const timeouts: Array<number | undefined> = [];
    const client = {
      references: vi.fn(async (_params, opts?: { timeoutMs?: number }) => {
        timeouts.push(opts?.timeoutMs);
        if (timeouts.length === 1) {
          throw new Error('rust-analyzer LSP request textDocument/references timed out after 15ms');
        }
        return [location];
      }),
    } as unknown as RustAnalyzerLspClient;

    const result = await referencesWithCompletion(client, params, {
      requestTimeoutMs: 125,
      retryTimeoutMs: 250,
    });

    expect(result).toEqual({ locations: [location], complete: true });
    expect(timeouts).toEqual([125, 250]);
  });

  it('returns outgoing call hierarchy callees when requested', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-callee-worker-'));
    const referenceTimeouts: Array<number | undefined> = [];
    const prepareTimeouts: Array<number | undefined> = [];
    const outgoingTimeouts: Array<number | undefined> = [];
    try {
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(join(projectRoot, 'src/lib.rs'), ['pub fn run() {', '    compute_total();', '}'].join('\n'));
      writeFileSync(join(projectRoot, 'src/math.rs'), 'pub fn compute_total() {}\n');

      class FakeRustAnalyzerLspClient {
        async initialize(): Promise<{ capabilities: { referencesProvider: boolean; callHierarchyProvider: boolean } }> {
          return { capabilities: { referencesProvider: true, callHierarchyProvider: true } };
        }

        didOpenTextDocument(): void {}

        async waitForDiagnostics(): Promise<boolean> {
          return true;
        }

        async references(_params: unknown, opts?: { timeoutMs?: number }): Promise<[]> {
          referenceTimeouts.push(opts?.timeoutMs);
          return [];
        }

        async prepareCallHierarchy(
          _params: unknown,
          opts?: { timeoutMs?: number },
        ): Promise<
          Array<{
            name: string;
            kind: number;
            uri: string;
            range: { start: { line: number; character: number }; end: { line: number; character: number } };
            selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
          }>
        > {
          prepareTimeouts.push(opts?.timeoutMs);
          return [
            {
              name: 'run',
              kind: 12,
              uri: `file://${projectRoot}/src/lib.rs`,
              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
              selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
            },
          ];
        }

        async outgoingCalls(
          _item: unknown,
          opts?: { timeoutMs?: number },
        ): Promise<
          Array<{
            to: {
              name: string;
              kind: number;
              uri: string;
              range: { start: { line: number; character: number }; end: { line: number; character: number } };
              selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
            };
            fromRanges: Array<{
              start: { line: number; character: number };
              end: { line: number; character: number };
            }>;
          }>
        > {
          outgoingTimeouts.push(opts?.timeoutMs);
          return [
            {
              to: {
                name: 'compute_total',
                kind: 12,
                uri: `file://${projectRoot}/src/math.rs`,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 25 } },
                selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 20 } },
              },
              fromRanges: [{ start: { line: 1, character: 4 }, end: { line: 1, character: 17 } }],
            },
          ];
        }

        async shutdown(): Promise<void> {}
      }

      vi.doMock('../../../src/semantic/rust/lsp-client.js', () => ({
        createRustAnalyzerTransport: () => ({}),
        RustAnalyzerLspClient: FakeRustAnalyzerLspClient,
      }));

      const { runRustAnalyzerReferenceBatch } = await import('../../../src/semantic/rust/lsp-batch-worker.js');

      const response = await runRustAnalyzerReferenceBatch({
        projectRoot,
        rustAnalyzerBinary: 'rust-analyzer',
        definitions: [rustDefinition()],
        requestTimeoutMs: 100,
        diagnosticsTimeoutMs: 0,
        settleDelayMs: 0,
        concurrency: 1,
        includeCallees: true,
      });

      expect(response.available).toBe(true);
      expect(response.callees).toEqual([[1, [{ symbol: 'compute_total', file: 'src/math.rs', line: 0 }]]]);
      expect(referenceTimeouts).toEqual([100]);
      expect(prepareTimeouts).toEqual([100]);
      expect(outgoingTimeouts).toEqual([100]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns signatures from hover information when requested', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-signature-worker-'));
    const hoverTimeouts: Array<number | undefined> = [];
    try {
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(join(projectRoot, 'src/lib.rs'), ['pub fn run() -> i32 {', '    1', '}'].join('\n'));

      class FakeRustAnalyzerLspClient {
        async initialize(): Promise<{ capabilities: { referencesProvider: boolean; hoverProvider: boolean } }> {
          return { capabilities: { referencesProvider: true, hoverProvider: true } };
        }

        didOpenTextDocument(): void {}

        async waitForDiagnostics(): Promise<boolean> {
          return true;
        }

        async references(): Promise<[]> {
          return [];
        }

        async hover(
          _params: unknown,
          opts?: { timeoutMs?: number },
        ): Promise<{ contents: { kind: 'markdown'; value: string } }> {
          hoverTimeouts.push(opts?.timeoutMs);
          return {
            contents: {
              kind: 'markdown',
              value: '```rust\npub fn run() -> i32\n```',
            },
          };
        }

        async shutdown(): Promise<void> {}
      }

      vi.doMock('../../../src/semantic/rust/lsp-client.js', () => ({
        createRustAnalyzerTransport: () => ({}),
        RustAnalyzerLspClient: FakeRustAnalyzerLspClient,
      }));

      const { runRustAnalyzerReferenceBatch } = await import('../../../src/semantic/rust/lsp-batch-worker.js');

      const response = await runRustAnalyzerReferenceBatch({
        projectRoot,
        rustAnalyzerBinary: 'rust-analyzer',
        definitions: [rustDefinition()],
        requestTimeoutMs: 100,
        diagnosticsTimeoutMs: 0,
        settleDelayMs: 0,
        concurrency: 1,
        includeReferences: false,
        includeSignatures: true,
      });

      expect(response.available).toBe(true);
      expect(response.references).toEqual([[1, []]]);
      expect(response.signatures).toEqual([[1, 'pub fn run() -> i32']]);
      expect(hoverTimeouts).toEqual([100]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('passes the current request timeout through a hover retry', async () => {
    vi.useFakeTimers();
    try {
      const { signatureForDefinition } = await import('../../../src/semantic/rust/lsp-batch-worker.js');
      const timeouts: Array<number | undefined> = [];
      const client = {
        hover: vi.fn(async (_params, opts?: { timeoutMs?: number }) => {
          timeouts.push(opts?.timeoutMs);
          if (timeouts.length === 1) throw new Error('content modified');
          return { contents: { kind: 'markdown', value: '```rust\npub fn run() -> i32\n```' } };
        }),
      } as unknown as RustAnalyzerLspClient;

      const signaturePromise = signatureForDefinition(client, '/repo', rustDefinition(), { timeoutMs: 125 });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(signaturePromise).resolves.toBe('pub fn run() -> i32');
      expect(timeouts).toEqual([125, 125]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function referenceParams(): LspReferenceParams {
  return {
    textDocument: { uri: 'file:///repo/src/lib.rs' },
    position: { line: 1, character: 7 },
    context: { includeDeclaration: false },
  };
}
