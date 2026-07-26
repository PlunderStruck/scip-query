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

export interface RustAnalyzerRequestOptions {
  timeoutMs?: number;
  deadlineMs?: number;
}

export interface RustAnalyzerServerStatus {
  health: 'ok' | 'warning' | 'error';
  quiescent: boolean;
  message?: string;
}

export interface RustAnalyzerServerStatusSnapshot {
  generation: number;
  status: RustAnalyzerServerStatus;
}

interface RustAnalyzerServerStatusPayload {
  health: 'ok' | 'warning' | 'error';
  quiescent: boolean;
  message?: string | null;
}

export class RustAnalyzerReadinessError extends Error {}

class RustAnalyzerResponseError extends Error {
  constructor(
    readonly code: number | undefined,
    method: string,
    message: string,
  ) {
    super(`rust-analyzer LSP request ${method} failed: ${message}`);
  }
}

interface PendingRequest {
  method: string;
  deadlineMs: number | undefined;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ReadinessWaiter {
  afterGeneration: number;
  resolve: (status: RustAnalyzerServerStatus) => void;
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
  private readonly readinessWaiters = new Set<ReadinessWaiter>();
  private readonly requestTimeoutMs: number;
  private readonly configuration: Record<string, unknown>;
  private currentServerStatusGeneration = 0;
  private latestServerStatus: { generation: number; status: RustAnalyzerServerStatus } | null = null;
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

  async initialize(params: LspInitializeParams, opts: RustAnalyzerRequestOptions = {}): Promise<LspInitializeResult> {
    const capabilities = params.capabilities ?? {};
    const experimental =
      capabilities.experimental &&
      typeof capabilities.experimental === 'object' &&
      !Array.isArray(capabilities.experimental)
        ? (capabilities.experimental as Record<string, unknown>)
        : {};
    const result = await this.request<LspInitializeResult>(
      'initialize',
      {
        ...params,
        capabilities: {
          ...capabilities,
          experimental: {
            ...experimental,
            serverStatusNotification: true,
          },
        },
      },
      opts,
    );
    this.notify('initialized', {});
    return result;
  }

  async references(params: LspReferenceParams, opts: RustAnalyzerRequestOptions = {}): Promise<LspLocation[]> {
    const result = await this.request<LspLocation[] | null>('textDocument/references', params, opts);
    return Array.isArray(result) ? result : [];
  }

  async definition(
    params: LspTextDocumentPositionParams,
    opts: RustAnalyzerRequestOptions = {},
  ): Promise<LspLocation[]> {
    const result = await this.request<LspLocation | LspLocation[] | LspLocationLink[] | null>(
      'textDocument/definition',
      params,
      opts,
    );
    return normalizeDefinitionResult(result);
  }

  async prepareCallHierarchy(
    params: LspTextDocumentPositionParams,
    opts: RustAnalyzerRequestOptions = {},
  ): Promise<LspCallHierarchyItem[]> {
    const result = await this.request<LspCallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', params, opts);
    return Array.isArray(result) ? result : [];
  }

  async outgoingCalls(
    item: LspCallHierarchyItem,
    opts: RustAnalyzerRequestOptions = {},
  ): Promise<LspCallHierarchyOutgoingCall[]> {
    const result = await this.request<LspCallHierarchyOutgoingCall[] | null>(
      'callHierarchy/outgoingCalls',
      { item },
      opts,
    );
    return Array.isArray(result) ? result : [];
  }

  async hover(params: LspTextDocumentPositionParams, opts: RustAnalyzerRequestOptions = {}): Promise<LspHover | null> {
    const result = await this.request<LspHover | null>('textDocument/hover', params, opts);
    return result && typeof result === 'object' ? result : null;
  }

  async readinessBarrier(opts: RustAnalyzerRequestOptions = {}): Promise<void> {
    try {
      await this.request<unknown>('scip-query/readinessBarrier', null, opts);
    } catch (error) {
      if (error instanceof RustAnalyzerResponseError && error.code === -32601) return;
      throw error;
    }
  }

  serverStatusGeneration(): number {
    return this.currentServerStatusGeneration;
  }

  serverStatusSnapshot(): RustAnalyzerServerStatusSnapshot | null {
    const latest = this.latestServerStatus;
    return latest ? { generation: latest.generation, status: { ...latest.status } } : null;
  }

  waitForQuiescence(afterGeneration: number, timeoutMs: number): Promise<RustAnalyzerServerStatus> {
    const latest = this.latestServerStatus;
    if (latest && latest.generation > afterGeneration) {
      if (latest.status.health === 'error') {
        return Promise.reject(readinessErrorForHealth());
      }
      if (latest.status.quiescent) return Promise.resolve(latest.status);
    }
    return new Promise((resolve, reject) => {
      const waiter: ReadinessWaiter = {
        afterGeneration,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.readinessWaiters.delete(waiter);
          reject(new Error(`rust-analyzer readiness timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.readinessWaiters.add(waiter);
    });
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

  async shutdown(opts: RustAnalyzerRequestOptions = {}): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    try {
      await this.request<null>('shutdown', null, opts);
      this.notify('exit', null);
    } catch (error) {
      this.notify('exit', null);
      this.transport.kill();
      throw error;
    }
  }

  // scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
  private request<T>(method: string, params: unknown, opts: RustAnalyzerRequestOptions = {}): Promise<T> {
    const budget = rustAnalyzerOperationBudget(opts.timeoutMs ?? this.requestTimeoutMs, opts.deadlineMs);
    const id = this.nextId++;
    const message: LspJsonMessage = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          budget.deadlineLimited
            ? new RustAnalyzerReadinessError(`rust-analyzer readiness deadline expired during LSP request ${method}`)
            : new Error(`rust-analyzer LSP request ${method} timed out after ${budget.timeoutMs}ms`),
        );
      }, budget.timeoutMs);
      this.pending.set(id, {
        method,
        deadlineMs: opts.deadlineMs,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
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

  // scip-query: ignore-extract — reviewed E3 feature-local pipeline; the helper cluster has no separate owner or consumer.
  private dispatchMessage(message: LspJsonMessage): void {
    this.recordDiagnosticNotification(message);
    this.recordServerStatusNotification(message);
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
      pending.reject(new RustAnalyzerResponseError(message.error.code, pending.method, message.error.message));
      return;
    }
    if (pending.deadlineMs !== undefined && Date.now() >= pending.deadlineMs) {
      pending.reject(
        new RustAnalyzerReadinessError(`rust-analyzer readiness deadline expired during LSP request ${pending.method}`),
      );
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

  private recordServerStatusNotification(message: LspJsonMessage): void {
    if (
      message.method !== 'experimental/serverStatus' ||
      message.id !== undefined ||
      !isRustAnalyzerServerStatusPayload(message.params)
    ) {
      return;
    }
    const payload = message.params;
    const status: RustAnalyzerServerStatus = {
      health: payload.health,
      quiescent: payload.quiescent,
      ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
    };
    const generation = ++this.currentServerStatusGeneration;
    this.latestServerStatus = { generation, status };
    if (status.health === 'error') {
      this.rejectReadinessWaiters(readinessErrorForHealth());
      return;
    }
    if (!status.quiescent) return;
    for (const waiter of this.readinessWaiters) {
      if (generation <= waiter.afterGeneration) continue;
      clearTimeout(waiter.timeout);
      this.readinessWaiters.delete(waiter);
      waiter.resolve(status);
    }
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
    this.rejectReadinessWaiters(error);
  }

  private rejectReadinessWaiters(error: Error): void {
    for (const waiter of this.readinessWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
      this.readinessWaiters.delete(waiter);
    }
  }
}

export function rustAnalyzerOperationBudget(
  configuredTimeoutMs: number,
  deadlineMs: number | undefined,
  now: () => number = Date.now,
): { timeoutMs: number; deadlineLimited: boolean } {
  if (deadlineMs === undefined) return { timeoutMs: configuredTimeoutMs, deadlineLimited: false };
  const remainingMs = deadlineMs - now();
  if (remainingMs <= 0) {
    throw new RustAnalyzerReadinessError('rust-analyzer readiness deadline expired before LSP operation');
  }
  return {
    timeoutMs: Math.min(configuredTimeoutMs, remainingMs),
    deadlineLimited: remainingMs <= configuredTimeoutMs,
  };
}

function isRustAnalyzerServerStatusPayload(value: unknown): value is RustAnalyzerServerStatusPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = value as { health?: unknown; quiescent?: unknown; message?: unknown };
  return (
    (status.health === 'ok' || status.health === 'warning' || status.health === 'error') &&
    typeof status.quiescent === 'boolean' &&
    (status.message === undefined || status.message === null || typeof status.message === 'string')
  );
}

function readinessErrorForHealth(): RustAnalyzerReadinessError {
  return new RustAnalyzerReadinessError('rust-analyzer reported error health before reaching readiness');
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
  // scip-query: process-lifetime-reviewed -- the returned transport owns this
  // session process and its initialize/request/shutdown deadlines.
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
