import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';

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
  it('returns outgoing call hierarchy callees when requested', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-callee-worker-'));
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

        async references(): Promise<[]> {
          return [];
        }

        async prepareCallHierarchy(): Promise<
          Array<{
            name: string;
            kind: number;
            uri: string;
            range: { start: { line: number; character: number }; end: { line: number; character: number } };
            selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
          }>
        > {
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

        async outgoingCalls(): Promise<
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
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns signatures from hover information when requested', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-signature-worker-'));
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

        async hover(): Promise<{ contents: { kind: 'markdown'; value: string } }> {
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
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
