import { describe, expect, it } from 'vitest';
import {
  RustAnalyzerLspClient,
  type LspJsonMessage,
  type RustAnalyzerTransport,
} from '../../../src/semantic/rust/lsp-client.js';

class ScriptedTransport implements RustAnalyzerTransport {
  readonly writes: LspJsonMessage[] = [];
  private readonly dataListeners: Array<(chunk: Buffer) => void> = [];
  private readonly closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private killed = false;

  constructor(private readonly respond: (message: LspJsonMessage, transport: ScriptedTransport) => void) {}

  write(payload: string): void {
    for (const message of decodeFramedMessages(payload)) {
      this.writes.push(message);
      this.respond(message, this);
    }
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  kill(): void {
    this.killed = true;
  }

  isKilled(): boolean {
    return this.killed;
  }

  send(message: LspJsonMessage): void {
    const json = JSON.stringify(message);
    const frame = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    this.dataListeners.forEach((listener) => listener(Buffer.from(frame)));
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.closeListeners.forEach((listener) => listener(code, signal));
  }

  error(error: Error): void {
    this.errorListeners.forEach((listener) => listener(error));
  }
}

function decodeFramedMessages(payload: string): LspJsonMessage[] {
  const messages: LspJsonMessage[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const headerEnd = payload.indexOf('\r\n\r\n', offset);
    expect(headerEnd).toBeGreaterThanOrEqual(0);
    const header = payload.slice(offset, headerEnd);
    const match = /Content-Length: (\d+)/i.exec(header);
    expect(match).not.toBeNull();
    const bodyStart = headerEnd + 4;
    const length = Number(match![1]);
    const body = payload.slice(bodyStart, bodyStart + length);
    messages.push(JSON.parse(body) as LspJsonMessage);
    offset = bodyStart + length;
  }
  return messages;
}

describe('RustAnalyzerLspClient', () => {
  it('initializes, ignores notifications, requests references, and shuts down', async () => {
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({ jsonrpc: '2.0', method: '$/progress', params: { token: 'startup' } });
        server.send({
          jsonrpc: '2.0',
          id: 'server-config-request',
          method: 'workspace/configuration',
          params: { items: [{ section: 'rust-analyzer.linkedProjects' }] },
        });
        server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { referencesProvider: true } } });
      }
      if (message.method === 'textDocument/references') {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          result: [
            {
              uri: 'file:///repo/src/lib.rs',
              range: { start: { line: 4, character: 9 }, end: { line: 4, character: 16 } },
            },
          ],
        });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
      if (message.method === 'textDocument/didOpen') {
        server.send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: { uri: 'file:///repo/src/lib.rs', diagnostics: [], version: 1 },
        });
      }
    });

    const client = new RustAnalyzerLspClient(transport, {
      requestTimeoutMs: 100,
      configuration: { linkedProjects: ['/repo/Cargo.toml'] },
    });
    const initialized = await client.initialize({ rootUri: 'file:///repo' });
    client.didOpenTextDocument({
      uri: 'file:///repo/src/lib.rs',
      languageId: 'rust',
      version: 1,
      text: 'pub fn run() {}',
    });
    await expect(client.waitForDiagnostics('file:///repo/src/lib.rs', 100)).resolves.toBe(true);
    const references = await client.references({
      textDocument: { uri: 'file:///repo/src/lib.rs' },
      position: { line: 1, character: 7 },
      context: { includeDeclaration: false },
    });
    await client.shutdown();

    expect(initialized.capabilities.referencesProvider).toBe(true);
    expect(references).toEqual([
      {
        uri: 'file:///repo/src/lib.rs',
        range: { start: { line: 4, character: 9 }, end: { line: 4, character: 16 } },
      },
    ]);
    expect(transport.writes.map((message) => message.method)).toEqual([
      'initialize',
      undefined,
      'initialized',
      'textDocument/didOpen',
      'textDocument/references',
      'shutdown',
      'exit',
    ]);
    expect(transport.writes[1]).toEqual({
      jsonrpc: '2.0',
      id: 'server-config-request',
      result: [['/repo/Cargo.toml']],
    });
  });

  it('requests call hierarchy outgoing calls', async () => {
    const callHierarchyItem = {
      name: 'run',
      kind: 12,
      uri: 'file:///repo/src/lib.rs',
      range: { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } },
      selectionRange: { start: { line: 1, character: 7 }, end: { line: 1, character: 10 } },
    };
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { capabilities: { referencesProvider: true, callHierarchyProvider: true } },
        });
      }
      if (message.method === 'textDocument/prepareCallHierarchy') {
        server.send({ jsonrpc: '2.0', id: message.id, result: [callHierarchyItem] });
      }
      if (message.method === 'callHierarchy/outgoingCalls') {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          result: [
            {
              to: {
                name: 'compute_total',
                kind: 12,
                uri: 'file:///repo/src/math.rs',
                range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
                selectionRange: { start: { line: 4, character: 7 }, end: { line: 4, character: 20 } },
              },
              fromRanges: [{ start: { line: 2, character: 4 }, end: { line: 2, character: 17 } }],
            },
          ],
        });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });

    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 100 });
    await client.initialize({ rootUri: 'file:///repo' });
    const prepared = await client.prepareCallHierarchy({
      textDocument: { uri: 'file:///repo/src/lib.rs' },
      position: { line: 1, character: 7 },
    });
    const outgoing = await client.outgoingCalls(prepared[0]!);
    await client.shutdown();

    expect(prepared).toEqual([callHierarchyItem]);
    expect(outgoing[0]?.to.name).toBe('compute_total');
    expect(transport.writes.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/prepareCallHierarchy',
      'callHierarchy/outgoingCalls',
      'shutdown',
      'exit',
    ]);
  });

  it('requests hover information', async () => {
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { capabilities: { referencesProvider: true, hoverProvider: true } },
        });
      }
      if (message.method === 'textDocument/hover') {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            contents: {
              kind: 'markdown',
              value: '```rust\npub fn run() -> i32\n```',
            },
          },
        });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });

    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 100 });
    await client.initialize({ rootUri: 'file:///repo' });
    const hover = await client.hover({
      textDocument: { uri: 'file:///repo/src/lib.rs' },
      position: { line: 1, character: 7 },
    });
    await client.shutdown();

    expect(hover).toEqual({
      contents: {
        kind: 'markdown',
        value: '```rust\npub fn run() -> i32\n```',
      },
    });
    expect(transport.writes.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/hover',
      'shutdown',
      'exit',
    ]);
  });

  it('requests definitions and normalizes location links', async () => {
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { capabilities: { definitionProvider: true } },
        });
      }
      if (message.method === 'textDocument/definition') {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          result: [
            {
              targetUri: 'file:///repo/src/math.rs',
              targetRange: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
              targetSelectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
            },
          ],
        });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });

    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 100 });
    await client.initialize({ rootUri: 'file:///repo' });
    const definitions = await client.definition({
      textDocument: { uri: 'file:///repo/src/lib.rs' },
      position: { line: 0, character: 16 },
    });
    await client.shutdown();

    expect(definitions).toEqual([
      {
        uri: 'file:///repo/src/math.rs',
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
      },
    ]);
    expect(transport.writes.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/definition',
      'shutdown',
      'exit',
    ]);
  });

  it('times out a stalled request without preventing shutdown', async () => {
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { referencesProvider: true } } });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });

    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 5 });
    await client.initialize({ rootUri: 'file:///repo' });

    await expect(
      client.references({
        textDocument: { uri: 'file:///repo/src/lib.rs' },
        position: { line: 1, character: 7 },
        context: { includeDeclaration: false },
      }),
    ).rejects.toThrow(/timed out/);

    await client.shutdown();
    expect(transport.isKilled()).toBe(false);
  });
});
