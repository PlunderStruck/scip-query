import { spawn } from 'node:child_process';
import type {
  LspCallHierarchyItem,
  LspCallHierarchyOutgoingCall,
  LspHover,
  LspInitializeParams,
  LspInitializeResult,
  LspLocation,
  LspLocationLink,
  LspReferenceParams,
  LspTextDocumentPositionParams,
} from './lsp-types.js';

// scip-query: ignore-stale — JSON-RPC envelope shared by the framed LSP client
// and tests; keeping it named makes protocol handling explicit.
export interface LspJsonMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message: string;
    data?: unknown;
  };
}

// scip-query: ignore-stale — transport boundary for rust-analyzer subprocesses
// and tests that inject an in-memory LSP transport.
export interface RustAnalyzerTransport {
  write(payload: string): void;
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(): void;
}

export interface RustAnalyzerLspClientOptions {
  requestTimeoutMs?: number;
  configuration?: Record<string, unknown>;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class RustAnalyzerLspClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly diagnosedUris = new Set<string>();
  private readonly diagnosticWaiters = new Map<string, Array<(value: boolean) => void>>();
  private readonly requestTimeoutMs: number;
  private readonly configuration: Record<string, unknown>;
  private shutdownStarted = false;

  constructor(
    private readonly transport: RustAnalyzerTransport,
    opts: RustAnalyzerLspClientOptions = {},
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.configuration = opts.configuration ?? {};
    this.transport.onData((chunk) => this.handleData(chunk));
    this.transport.onClose((code, signal) => this.rejectPending(new Error(closeMessage(code, signal))));
    this.transport.onError((error) => this.rejectPending(error));
  }

  async initialize(params: LspInitializeParams): Promise<LspInitializeResult> {
    const result = await this.request<LspInitializeResult>('initialize', params);
    this.notify('initialized', {});
    return result;
  }

  async references(params: LspReferenceParams): Promise<LspLocation[]> {
    const result = await this.request<LspLocation[] | null>('textDocument/references', params);
    return Array.isArray(result) ? result : [];
  }

  async definition(params: LspTextDocumentPositionParams): Promise<LspLocation[]> {
    const result = await this.request<LspLocation | LspLocation[] | LspLocationLink[] | null>(
      'textDocument/definition',
      params,
    );
    return normalizeDefinitionResult(result);
  }

  async prepareCallHierarchy(params: LspTextDocumentPositionParams): Promise<LspCallHierarchyItem[]> {
    const result = await this.request<LspCallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', params);
    return Array.isArray(result) ? result : [];
  }

  async outgoingCalls(item: LspCallHierarchyItem): Promise<LspCallHierarchyOutgoingCall[]> {
    const result = await this.request<LspCallHierarchyOutgoingCall[] | null>('callHierarchy/outgoingCalls', { item });
    return Array.isArray(result) ? result : [];
  }

  async hover(params: LspTextDocumentPositionParams): Promise<LspHover | null> {
    const result = await this.request<LspHover | null>('textDocument/hover', params);
    return result && typeof result === 'object' ? result : null;
  }

  didOpenTextDocument(textDocument: { uri: string; languageId: string; version: number; text: string }): void {
    this.notify('textDocument/didOpen', { textDocument });
  }

  waitForDiagnostics(uri: string, timeoutMs: number): Promise<boolean> {
    if (this.diagnosedUris.has(uri)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wrappedResolve = (value: boolean): void => {
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        const waiters = this.diagnosticWaiters.get(uri)?.filter((waiter) => waiter !== wrappedResolve);
        if (waiters && waiters.length > 0) this.diagnosticWaiters.set(uri, waiters);
        else this.diagnosticWaiters.delete(uri);
        resolve(false);
      }, timeoutMs);
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(wrappedResolve);
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    try {
      await this.request<null>('shutdown', null);
      this.notify('exit', null);
    } catch (error) {
      this.notify('exit', null);
      this.transport.kill();
      throw error;
    }
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const message: LspJsonMessage = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rust-analyzer LSP request ${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timeout });
      this.transport.write(frameJsonMessage(message));
    });
  }

  private notify(method: string, params: unknown): void {
    this.transport.write(frameJsonMessage({ jsonrpc: '2.0', method, params }));
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.rejectPending(new Error('rust-analyzer LSP response missing Content-Length header'));
        return;
      }

      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) return;

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.subarray(bodyEnd);
      this.dispatchMessage(parseJsonMessage(body));
    }
  }

  private dispatchMessage(message: LspJsonMessage): void {
    this.recordDiagnosticNotification(message);
    if (message.id !== undefined && message.id !== null && message.method) {
      this.respondToServerRequest(message);
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`rust-analyzer LSP request ${pending.method} failed: ${message.error.message}`));
      return;
    }
    pending.resolve(message.result);
  }

  private recordDiagnosticNotification(message: LspJsonMessage): void {
    if (message.method !== 'textDocument/publishDiagnostics') return;
    const params = message.params;
    const uri =
      params && typeof params === 'object' && typeof (params as { uri?: unknown }).uri === 'string'
        ? (params as { uri: string }).uri
        : null;
    if (!uri) return;
    this.diagnosedUris.add(uri);
    const waiters = this.diagnosticWaiters.get(uri) ?? [];
    this.diagnosticWaiters.delete(uri);
    waiters.forEach((resolve) => resolve(true));
  }

  private respondToServerRequest(message: LspJsonMessage): void {
    if (message.id === undefined || message.id === null || !message.method) return;
    const result = message.method === 'workspace/configuration' ? this.workspaceConfiguration(message.params) : null;
    this.transport.write(frameJsonMessage({ jsonrpc: '2.0', id: message.id, result }));
  }

  private workspaceConfiguration(params: unknown): unknown[] {
    const items =
      params && typeof params === 'object' && Array.isArray((params as { items?: unknown }).items)
        ? ((params as { items: unknown[] }).items as Array<{ section?: unknown }>)
        : [];
    return items.map((item) =>
      typeof item.section === 'string'
        ? configurationValueForSection(this.configuration, item.section)
        : this.configuration,
    );
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function configurationValueForSection(configuration: Record<string, unknown>, section: string): unknown {
  const normalized = section.startsWith('rust-analyzer.') ? section.slice('rust-analyzer.'.length) : section;
  if (normalized === '' || normalized === 'rust-analyzer') return configuration;
  let current: unknown = configuration;
  for (const part of normalized.split('.')) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}

function normalizeDefinitionResult(result: LspLocation | LspLocation[] | LspLocationLink[] | null): LspLocation[] {
  if (!result) return [];
  const entries = Array.isArray(result) ? result : [result];
  return entries.flatMap((entry) => {
    if (isLspLocation(entry)) return [entry];
    if (isLspLocationLink(entry)) {
      return [
        {
          uri: entry.targetUri,
          range: entry.targetSelectionRange,
        },
      ];
    }
    return [];
  });
}

function isLspLocation(value: unknown): value is LspLocation {
  return Boolean(value && typeof value === 'object' && typeof (value as { uri?: unknown }).uri === 'string');
}

function isLspLocationLink(value: unknown): value is LspLocationLink {
  return Boolean(
    value && typeof value === 'object' && typeof (value as { targetUri?: unknown }).targetUri === 'string',
  );
}

export function createRustAnalyzerTransport(
  binary: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): RustAnalyzerTransport {
  const child = spawn(binary, [], {
    cwd: projectRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    write(payload) {
      child.stdin.write(payload);
    },
    onData(listener) {
      child.stdout.on('data', listener);
    },
    onClose(listener) {
      child.on('close', listener);
    },
    onError(listener) {
      child.on('error', listener);
    },
    kill() {
      child.kill();
    },
  };
}

function frameJsonMessage(message: LspJsonMessage): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function parseJsonMessage(body: string): LspJsonMessage {
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('rust-analyzer LSP response was not a JSON object');
  }
  return parsed as LspJsonMessage;
}

function closeMessage(code: number | null, signal: NodeJS.Signals | null): string {
  const suffix = signal ? ` by ${signal}` : code === null ? '' : ` with code ${code}`;
  return `rust-analyzer LSP transport closed${suffix}`;
}
