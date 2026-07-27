import { describe, expect, it, vi } from 'vitest';
import {
  ABSOLUTE_RUST_ANALYZER_LSP_BUFFER_BYTES,
  ABSOLUTE_RUST_ANALYZER_LSP_MAX_HEADER_BYTES,
  DEFAULT_RUST_ANALYZER_LSP_MAX_HEADER_BYTES,
  DEFAULT_RUST_ANALYZER_LSP_MAX_MESSAGE_BYTES,
  RustAnalyzerLspClient,
  RustAnalyzerProtocolError,
  RustAnalyzerReadinessError,
  rustAnalyzerLspFrameLimits,
  rustAnalyzerOperationBudget,
  type LspJsonMessage,
  type RustAnalyzerTransport,
} from '../../../src/semantic/rust/lsp-client.js';

class ScriptedTransport implements RustAnalyzerTransport {
  readonly writes: LspJsonMessage[] = [];
  private readonly dataListeners: Array<(chunk: Buffer) => void> = [];
  private readonly closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private killCalls = 0;

  constructor(
    private readonly respond: (message: LspJsonMessage, transport: ScriptedTransport) => void,
    private readonly onKill?: () => void | Promise<void>,
  ) {}

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

  kill(): void | Promise<void> {
    this.killCalls += 1;
    return this.onKill?.();
  }

  isKilled(): boolean {
    return this.killCalls > 0;
  }

  killCount(): number {
    return this.killCalls;
  }

  send(message: LspJsonMessage): void {
    this.sendRaw(frameMessage(message));
  }

  sendRaw(payload: string | Buffer): void {
    const chunk = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    this.dataListeners.forEach((listener) => listener(chunk));
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

function frameMessage(message: LspJsonMessage): Buffer {
  const json = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

describe('RustAnalyzerLspClient', () => {
  it('caps an operation timeout to the remaining absolute deadline', () => {
    expect(rustAnalyzerOperationBudget(500, 1_250, () => 1_000)).toEqual({
      timeoutMs: 250,
      deadlineLimited: true,
    });
    expect(rustAnalyzerOperationBudget(100, 1_250, () => 1_000)).toEqual({
      timeoutMs: 100,
      deadlineLimited: false,
    });
    expect(() => rustAnalyzerOperationBudget(100, 1_000, () => 1_000)).toThrow(RustAnalyzerReadinessError);
  });

  it('uses conservative defaults and rejects configured frame limits above the absolute memory ceiling', () => {
    expect(rustAnalyzerLspFrameLimits()).toEqual({
      maxHeaderBytes: DEFAULT_RUST_ANALYZER_LSP_MAX_HEADER_BYTES,
      maxMessageBytes: DEFAULT_RUST_ANALYZER_LSP_MAX_MESSAGE_BYTES,
    });
    expect(() => rustAnalyzerLspFrameLimits(ABSOLUTE_RUST_ANALYZER_LSP_MAX_HEADER_BYTES + 1, 1)).toThrow(
      /maxHeaderBytes cannot exceed/,
    );
    expect(() => rustAnalyzerLspFrameLimits(1, ABSOLUTE_RUST_ANALYZER_LSP_BUFFER_BYTES)).toThrow(
      /Combined rust-analyzer LSP header and message limits cannot exceed/,
    );
    expect(() => rustAnalyzerLspFrameLimits(0, 1)).toThrow(/positive safe integer/);
  });

  it('kills once and rejects a pending request when an unterminated header exceeds its bound', async () => {
    const transport = new ScriptedTransport(() => undefined);
    const client = new RustAnalyzerLspClient(transport, {
      requestTimeoutMs: 1_000,
      maxHeaderBytes: 32,
      maxMessageBytes: 1_024,
    });
    const initialization = client.initialize({ rootUri: 'file:///repo' });
    const rejection = expect(initialization).rejects.toThrow(/header exceeded 32 byte limit/);

    transport.sendRaw('x'.repeat(37));
    await rejection;
    transport.sendRaw('ignored after failure');
    transport.error(new Error('late transport error'));
    transport.close(1);

    expect(transport.killCount()).toBe(1);
  });

  it('rejects an oversized declared body before allocating or reading it', async () => {
    const transport = new ScriptedTransport(() => undefined);
    const client = new RustAnalyzerLspClient(transport, {
      requestTimeoutMs: 1_000,
      maxHeaderBytes: 128,
      maxMessageBytes: 64,
    });
    const initialization = client.initialize({ rootUri: 'file:///repo' });
    const rejection = expect(initialization).rejects.toThrow(/exceeds 64 byte message limit/);

    transport.sendRaw('Content-Length: 65\r\n\r\n');

    await rejection;
    expect(transport.killCount()).toBe(1);
  });

  it.each([
    {
      label: 'missing length',
      frame: 'Content-Type: application/json\r\n\r\n',
      message: /missing Content-Length/,
    },
    {
      label: 'negative length',
      frame: 'Content-Length: -1\r\n\r\n',
      message: /non-negative safe integer/,
    },
    {
      label: 'non-numeric length',
      frame: 'Content-Length: nope\r\n\r\n',
      message: /non-negative safe integer/,
    },
    {
      label: 'duplicate length',
      frame: 'Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}',
      message: /duplicate Content-Length/,
    },
    {
      label: 'conflicting duplicate length',
      frame: 'Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}',
      message: /conflicting Content-Length/,
    },
    {
      label: 'unsafe-integer length',
      frame: 'Content-Length: 9007199254740992\r\n\r\n',
      message: /non-negative safe integer/,
    },
    {
      label: 'invalid JSON body',
      frame: 'Content-Length: 1\r\n\r\n{',
      message: /body was not a valid JSON object/,
    },
  ])('fails closed on $label', async ({ frame, message }) => {
    const transport = new ScriptedTransport(() => undefined);
    const client = new RustAnalyzerLspClient(transport, {
      requestTimeoutMs: 1_000,
      maxHeaderBytes: 128,
      maxMessageBytes: 1_024,
    });
    const initialization = client.initialize({ rootUri: 'file:///repo' });
    const errorPromise = initialization.catch((error: unknown) => error);

    transport.sendRaw(frame);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(RustAnalyzerProtocolError);
    expect(error).toMatchObject({ message: expect.stringMatching(message) });
    expect(transport.killCount()).toBe(1);
  });

  it('accepts exact-boundary frames, multiple frames, and every possible one-byte split', async () => {
    const transport = new ScriptedTransport(() => undefined);
    const status: LspJsonMessage = {
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'ok', quiescent: true, message: 'ready' },
    };
    const response: LspJsonMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: { capabilities: { referencesProvider: true } },
    };
    const frames = [frameMessage(status), frameMessage(response)];
    const bodyLengths = [status, response].map((message) => Buffer.byteLength(JSON.stringify(message), 'utf8'));
    const headerLengths = bodyLengths.map((length) => Buffer.byteLength(`Content-Length: ${length}`, 'ascii'));
    const client = new RustAnalyzerLspClient(transport, {
      requestTimeoutMs: 1_000,
      maxHeaderBytes: Math.max(...headerLengths),
      maxMessageBytes: Math.max(...bodyLengths),
    });
    const initialization = client.initialize({ rootUri: 'file:///repo' });
    const combined = Buffer.concat(frames);

    for (let offset = 0; offset < combined.length; offset += 1) {
      transport.sendRaw(combined.subarray(offset, offset + 1));
    }

    await expect(initialization).resolves.toEqual({ capabilities: { referencesProvider: true } });
    expect(client.serverStatusGeneration()).toBe(1);
    expect(client.serverStatusSnapshot()?.status).toEqual({ health: 'ok', quiescent: true, message: 'ready' });
    expect(transport.killCount()).toBe(0);
  });

  it('makes protocol failure sticky and drains request, readiness, and diagnostic waiters', async () => {
    vi.useFakeTimers();
    try {
      const { client, transport } = await createIdleClient(1_000);
      const references = client
        .references({
          textDocument: { uri: 'file:///repo/src/lib.rs' },
          position: { line: 1, character: 7 },
          context: { includeDeclaration: false },
        })
        .catch((error: unknown) => error);
      const readiness = client
        .waitForQuiescence(client.serverStatusGeneration(), 2_000)
        .catch((error: unknown) => error);
      const diagnostics = client.waitForDiagnostics('file:///repo/src/lib.rs', 3_000);
      const writesBeforeFailure = transport.writes.length;

      transport.sendRaw('Content-Length: nope\r\n\r\n');

      const [requestError, readinessError, diagnosticResult] = await Promise.all([references, readiness, diagnostics]);
      expect(requestError).toBeInstanceOf(RustAnalyzerProtocolError);
      expect(readinessError).toBe(requestError);
      expect(diagnosticResult).toBe(false);
      await expect(
        client.hover({
          textDocument: { uri: 'file:///repo/src/lib.rs' },
          position: { line: 1, character: 7 },
        }),
      ).rejects.toBe(requestError);
      expect(transport.writes).toHaveLength(writesBeforeFailure);
      expect(transport.killCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      transport.sendRaw('Content-Length: nope\r\n\r\n');
      transport.error(new Error('late transport error'));
      transport.close(1);
      expect(transport.killCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('joins transport process-tree cleanup after the graceful shutdown handshake', async () => {
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });
    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 100 });
    await client.initialize({ rootUri: 'file:///repo' });

    await client.shutdownAndReap();

    expect(transport.writes.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'shutdown',
      'exit',
    ]);
    expect(transport.killCount()).toBe(1);
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

  it('cancels a stalled request, poisons the transport, and reaps it before rejecting', async () => {
    let finishKill!: () => void;
    const killFinished = new Promise<void>((resolve) => {
      finishKill = resolve;
    });
    const transport = new ScriptedTransport(
      (message, server) => {
        if (message.method === 'initialize') {
          server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { referencesProvider: true } } });
        }
        if (message.method === 'shutdown') {
          server.send({ jsonrpc: '2.0', id: message.id, result: null });
        }
      },
      () => killFinished,
    );

    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 5 });
    await client.initialize({ rootUri: 'file:///repo' });

    let settled = false;
    const request = client
      .references({
        textDocument: { uri: 'file:///repo/src/lib.rs' },
        position: { line: 1, character: 7 },
        context: { includeDeclaration: false },
      })
      .finally(() => {
        settled = true;
      });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(transport.writes.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: '$/cancelRequest',
      params: { id: 2 },
    });
    expect(transport.isKilled()).toBe(true);
    expect(settled).toBe(false);
    finishKill();
    await expect(request).rejects.toThrow(/timed out/);
    expect(settled).toBe(true);
    await expect(client.shutdown()).rejects.toThrow(/timed out/);
  });

  it('allows a references request to use a shorter per-request timeout', async () => {
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { referencesProvider: true } } });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });

    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 1_000 });
    await client.initialize({ rootUri: 'file:///repo' });

    await expect(
      client.references(
        {
          textDocument: { uri: 'file:///repo/src/lib.rs' },
          position: { line: 1, character: 7 },
          context: { includeDeclaration: false },
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toThrow(/timed out after 5ms/);

    expect(transport.writes.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: '$/cancelRequest',
      params: { id: 2 },
    });
    expect(transport.isKilled()).toBe(true);
    await expect(client.shutdown()).rejects.toThrow(/timed out after 5ms/);
  });

  it('reports an unreaped transport instead of hiding timeout cleanup failure', async () => {
    const transport = new ScriptedTransport(
      (message, server) => {
        if (message.method === 'initialize') {
          server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { referencesProvider: true } } });
        }
      },
      async () => {
        throw new Error('process tree remained alive');
      },
    );
    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 5 });
    await client.initialize({ rootUri: 'file:///repo' });

    await expect(
      client.references({
        textDocument: { uri: 'file:///repo/src/lib.rs' },
        position: { line: 1, character: 7 },
        context: { includeDeclaration: false },
      }),
    ).rejects.toThrow(/cleanup failed: process tree remained alive/);
    expect(transport.isKilled()).toBe(true);
  });

  it('bounds initialization by a monotonic readiness deadline', async () => {
    const transport = new ScriptedTransport(() => undefined);
    let monotonicNow = 1_000;
    const client = new RustAnalyzerLspClient(transport, {
      requestTimeoutMs: 100,
      monotonicNow: () => monotonicNow,
    });

    const initialization = client.initialize(
      { rootUri: 'file:///repo' },
      { timeoutMs: 50, deadlineMs: monotonicNow + 5 },
    );
    monotonicNow += 5;

    await expect(initialization).rejects.toBeInstanceOf(RustAnalyzerReadinessError);
    await expect(initialization).rejects.toThrow(/readiness deadline expired during LSP request initialize/);
    expect(transport.writes.map((message) => message.method)).toEqual(['initialize', '$/cancelRequest']);
    expect(transport.isKilled()).toBe(true);
  });

  it('accepts an in-budget response across forward and backward civil-clock jumps', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      let monotonicNow = 100;
      const transport = new ScriptedTransport((message, server) => {
        if (message.method === 'initialize') {
          server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { referencesProvider: true } } });
        }
        if (message.method === 'shutdown') server.send({ jsonrpc: '2.0', id: message.id, result: null });
      });
      const client = new RustAnalyzerLspClient(transport, {
        requestTimeoutMs: 100,
        monotonicNow: () => monotonicNow,
      });
      await client.initialize({ rootUri: 'file:///repo' });
      const response = client.references(
        {
          textDocument: { uri: 'file:///repo/src/lib.rs' },
          position: { line: 1, character: 7 },
          context: { includeDeclaration: false },
        },
        { timeoutMs: 100, deadlineMs: 110 },
      );
      const requestId = transport.writes.at(-1)?.id;

      vi.setSystemTime(86_401_000);
      vi.setSystemTime(-86_399_000);
      monotonicNow = 105;
      transport.send({ jsonrpc: '2.0', id: requestId, result: [] });

      await expect(response).resolves.toEqual([]);
      await client.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a successful semantic response delivered after its monotonic deadline before timers flush', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const transport = new ScriptedTransport((message, server) => {
        if (message.method === 'initialize') {
          server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { referencesProvider: true } } });
        }
        if (message.method === 'shutdown') {
          server.send({ jsonrpc: '2.0', id: message.id, result: null });
        }
      });
      let monotonicNow = 1_000;
      const client = new RustAnalyzerLspClient(transport, {
        requestTimeoutMs: 100,
        monotonicNow: () => monotonicNow,
      });
      await client.initialize({ rootUri: 'file:///repo' });
      const deadlineMs = monotonicNow + 10;
      const request = client.references(
        {
          textDocument: { uri: 'file:///repo/src/lib.rs' },
          position: { line: 1, character: 7 },
          context: { includeDeclaration: false },
        },
        { timeoutMs: 100, deadlineMs },
      );
      const requestId = transport.writes.at(-1)?.id;
      const outcome = request.then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );

      vi.setSystemTime(deadlineMs + 1);
      monotonicNow = deadlineMs + 1;
      transport.send({ jsonrpc: '2.0', id: requestId, result: [] });

      const result = await outcome;
      expect(result.status).toBe('rejected');
      expect(result).toMatchObject({
        error: expect.objectContaining({
          message: 'rust-analyzer readiness deadline expired during LSP request textDocument/references',
        }),
      });
      if (result.status === 'rejected') expect(result.error).toBeInstanceOf(RustAnalyzerReadinessError);
      expect(vi.getTimerCount()).toBe(0);
      await client.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects and kills shutdown when its success response arrives after the monotonic deadline', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      const transport = new ScriptedTransport((message, server) => {
        if (message.method === 'initialize') {
          server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
        }
      });
      let monotonicNow = 2_000;
      const client = new RustAnalyzerLspClient(transport, {
        requestTimeoutMs: 100,
        monotonicNow: () => monotonicNow,
      });
      await client.initialize({ rootUri: 'file:///repo' });
      const deadlineMs = monotonicNow + 10;
      const shutdown = client.shutdown({ timeoutMs: 100, deadlineMs });
      const shutdownId = transport.writes.at(-1)?.id;
      const outcome = shutdown.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );

      vi.setSystemTime(deadlineMs + 1);
      monotonicNow = deadlineMs + 1;
      transport.send({ jsonrpc: '2.0', id: shutdownId, result: null });

      const result = await outcome;
      expect(result.status).toBe('rejected');
      expect(result).toMatchObject({
        error: expect.objectContaining({
          message: 'rust-analyzer readiness deadline expired during LSP request shutdown',
        }),
      });
      if (result.status === 'rejected') expect(result.error).toBeInstanceOf(RustAnalyzerReadinessError);
      expect(transport.isKilled()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('advertises server-status support without replacing caller capabilities', async () => {
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });
    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 100 });

    await client.initialize({
      rootUri: 'file:///repo',
      capabilities: {
        workspace: { configuration: true },
        experimental: { callerCapability: true },
      },
    });
    await client.shutdown();

    expect(transport.writes[0]?.params).toEqual({
      rootUri: 'file:///repo',
      capabilities: {
        workspace: { configuration: true },
        experimental: {
          callerCapability: true,
          serverStatusNotification: true,
        },
      },
    });
  });

  it('waits for a newer healthy quiescent server status', async () => {
    const { client, transport } = await createIdleClient();
    const afterGeneration = client.serverStatusGeneration();
    const readiness = client.waitForQuiescence(afterGeneration, 100);

    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'ok', quiescent: false },
    });
    expect(client.serverStatusGeneration()).toBe(afterGeneration + 1);
    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'ok', quiescent: true, message: 'ready' },
    });

    await expect(readiness).resolves.toEqual({ health: 'ok', quiescent: true, message: 'ready' });
    await client.shutdown();
  });

  it('accepts a null wire status message and omits it from the public status', async () => {
    const { client, transport } = await createIdleClient();
    const afterGeneration = client.serverStatusGeneration();
    const readiness = client.waitForQuiescence(afterGeneration, 25);

    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'ok', quiescent: true, message: null },
    });

    await expect(readiness).resolves.toEqual({ health: 'ok', quiescent: true });
    expect(client.serverStatusGeneration()).toBe(afterGeneration + 1);
    await client.shutdown();
  });

  it('uses a method-not-found response as an ordered protocol barrier and returns a defensive status snapshot', async () => {
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      }
      if (message.method === 'scip-query/readinessBarrier') {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });
    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 100 });
    await client.initialize({ rootUri: 'file:///repo' });
    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'ok', quiescent: true, message: 'ready' },
    });

    const first = client.serverStatusSnapshot();
    expect(first).toEqual({
      generation: 1,
      status: { health: 'ok', quiescent: true, message: 'ready' },
    });
    if (first) first.status.health = 'error';

    await expect(client.readinessBarrier({ deadlineMs: Date.now() + 100 })).resolves.toBeUndefined();
    expect(client.serverStatusSnapshot()).toEqual({
      generation: 1,
      status: { health: 'ok', quiescent: true, message: 'ready' },
    });
    expect(transport.writes.find((message) => message.method === 'scip-query/readinessBarrier')).toMatchObject({
      method: 'scip-query/readinessBarrier',
      params: null,
    });

    await client.shutdown();
  });

  it('rejects a protocol-barrier error other than method-not-found', async () => {
    const transport = new ScriptedTransport((message, server) => {
      if (message.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      }
      if (message.method === 'scip-query/readinessBarrier') {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'Internal error' },
        });
      }
      if (message.method === 'shutdown') {
        server.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });
    const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs: 100 });
    await client.initialize({ rootUri: 'file:///repo' });

    await expect(client.readinessBarrier({ deadlineMs: Date.now() + 100 })).rejects.toThrow('Internal error');

    await client.shutdown();
  });

  it('does not use a quiescent status observed at the waiter generation', async () => {
    const { client, transport } = await createIdleClient();
    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'ok', quiescent: true },
    });
    const afterGeneration = client.serverStatusGeneration();

    await expect(client.waitForQuiescence(afterGeneration, 5)).rejects.toThrow(/readiness timed out after 5ms/);
    await client.shutdown();
  });

  it('does not establish readiness from unrelated or malformed notifications', async () => {
    const { client, transport } = await createIdleClient();
    const readiness = client.waitForQuiescence(client.serverStatusGeneration(), 5);

    transport.send({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { health: 'ok', quiescent: true },
    });
    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'unknown', quiescent: true },
    });
    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'warning', quiescent: 'yes', message: 'source details' },
    });
    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'ok', quiescent: true, message: { text: 'source details' } },
    });

    expect(client.serverStatusGeneration()).toBe(0);
    await expect(readiness).rejects.toThrow(/readiness timed out after 5ms/);
    await client.shutdown();
  });

  it('does not treat a server-status message with a null id as a notification', async () => {
    const { client, transport } = await createIdleClient();
    const readiness = client.waitForQuiescence(client.serverStatusGeneration(), 25);

    transport.send({
      jsonrpc: '2.0',
      id: null,
      method: 'experimental/serverStatus',
      params: { health: 'ok', quiescent: true },
    });

    await expect(readiness).rejects.toThrow(/readiness timed out after 25ms/);
    expect(client.serverStatusGeneration()).toBe(0);
    await client.shutdown();
  });

  it('waits through a warning and resolves when the warning state becomes quiescent', async () => {
    const { client, transport } = await createIdleClient();
    const readiness = client.waitForQuiescence(client.serverStatusGeneration(), 100);

    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'warning', quiescent: false, message: 'build scripts are still running' },
    });
    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'warning', quiescent: true, message: 'some build scripts failed' },
    });

    await expect(readiness).resolves.toEqual({
      health: 'warning',
      quiescent: true,
      message: 'some build scripts failed',
    });
    await client.shutdown();
  });

  it('rejects error server health without exposing source text', async () => {
    const { client, transport } = await createIdleClient();
    const sourceText = 'private rust-analyzer source details';
    const readiness = client.waitForQuiescence(client.serverStatusGeneration(), 100);

    transport.send({
      jsonrpc: '2.0',
      method: 'experimental/serverStatus',
      params: { health: 'error', quiescent: false, message: sourceText },
    });
    const error = await readiness.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RustAnalyzerReadinessError);
    expect((error as Error).message).not.toContain(sourceText);
    await client.shutdown();
  });

  it('rejects and removes a readiness waiter on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { client } = await createIdleClient();
      const readiness = client.waitForQuiescence(client.serverStatusGeneration(), 25);
      const rejection = expect(readiness).rejects.toThrow(/readiness timed out after 25ms/);

      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
      await client.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label: 'transport close',
      fail: (transport: ScriptedTransport) => transport.close(17),
      message: 'transport closed with code 17',
    },
    {
      label: 'transport error',
      fail: (transport: ScriptedTransport) => transport.error(new Error('transport broke')),
      message: 'transport broke',
    },
  ])('rejects and removes all readiness waiters on $label', async ({ fail, message }) => {
    vi.useFakeTimers();
    try {
      const { client, transport } = await createIdleClient();
      const waiters = [
        client.waitForQuiescence(client.serverStatusGeneration(), 1_000),
        client.waitForQuiescence(client.serverStatusGeneration(), 2_000),
      ];
      const rejections = waiters.map((waiter) => waiter.catch((error: unknown) => error));

      fail(transport);
      const errors = await Promise.all(rejections);

      expect(errors).toHaveLength(2);
      errors.forEach((error) => expect(error).toMatchObject({ message: expect.stringContaining(message) }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows definition, call-hierarchy, outgoing-call, and hover requests to set timeouts', async () => {
    const params = {
      textDocument: { uri: 'file:///repo/src/lib.rs' },
      position: { line: 1, character: 7 },
    };
    const item = {
      name: 'run',
      kind: 12,
      uri: 'file:///repo/src/lib.rs',
      range: { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } },
      selectionRange: { start: { line: 1, character: 7 }, end: { line: 1, character: 10 } },
    };
    const operations: Array<(client: RustAnalyzerLspClient) => Promise<unknown>> = [
      (client) => client.definition(params, { timeoutMs: 5 }),
      (client) => client.prepareCallHierarchy(params, { timeoutMs: 5 }),
      (client) => client.outgoingCalls(item, { timeoutMs: 5 }),
      (client) => client.hover(params, { timeoutMs: 5 }),
    ];

    for (const operation of operations) {
      const { client, transport } = await createIdleClient(25);
      await expect(operation(client)).rejects.toThrow(/timed out after 5ms/);
      expect(transport.isKilled()).toBe(true);
    }
  });
});

async function createIdleClient(requestTimeoutMs = 100): Promise<{
  client: RustAnalyzerLspClient;
  transport: ScriptedTransport;
}> {
  const transport = new ScriptedTransport((message, server) => {
    if (message.method === 'initialize') {
      server.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    }
    if (message.method === 'shutdown') {
      server.send({ jsonrpc: '2.0', id: message.id, result: null });
    }
  });
  const client = new RustAnalyzerLspClient(transport, { requestTimeoutMs });
  await client.initialize({ rootUri: 'file:///repo' });
  return { client, transport };
}
