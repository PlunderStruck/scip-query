import { spawn } from 'node:child_process';
import { monotonicNowMs } from '../../domain/time.js';
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
  maxHeaderBytes?: number;
  maxMessageBytes?: number;
  /** Process-local elapsed clock. Deadlines passed to this client use this domain. */
  monotonicNow?: () => number;
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

export class RustAnalyzerProtocolError extends Error {}

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
export const DEFAULT_RUST_ANALYZER_LSP_MAX_HEADER_BYTES = 16 * 1024;
export const DEFAULT_RUST_ANALYZER_LSP_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const ABSOLUTE_RUST_ANALYZER_LSP_MAX_HEADER_BYTES = 64 * 1024;
export const ABSOLUTE_RUST_ANALYZER_LSP_BUFFER_BYTES = 256 * 1024 * 1024;
const LSP_HEADER_DELIMITER = Buffer.from('\r\n\r\n', 'ascii');

export class RustAnalyzerLspClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly diagnosedUris = new Set<string>();
  private readonly diagnosticWaiters = new Map<string, Array<(value: boolean) => void>>();
  private readonly readinessWaiters = new Set<ReadinessWaiter>();
  private readonly requestTimeoutMs: number;
  private readonly configuration: Record<string, unknown>;
  private readonly maxHeaderBytes: number;
  private readonly maxMessageBytes: number;
  private readonly monotonicNow: () => number;
  private readonly headerBuffer: Buffer;
  private headerLength = 0;
  private bodyBuffer: Buffer | null = null;
  private bodyLength = 0;
  private transportFailure: Error | null = null;
  private transportKilled = false;
  private currentServerStatusGeneration = 0;
  private latestServerStatus: { generation: number; status: RustAnalyzerServerStatus } | null = null;
  private shutdownStarted = false;

  constructor(
    private readonly transport: RustAnalyzerTransport,
    opts: RustAnalyzerLspClientOptions = {},
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.configuration = opts.configuration ?? {};
    const limits = rustAnalyzerLspFrameLimits(opts.maxHeaderBytes, opts.maxMessageBytes);
    this.maxHeaderBytes = limits.maxHeaderBytes;
    this.maxMessageBytes = limits.maxMessageBytes;
    this.monotonicNow = opts.monotonicNow ?? monotonicNowMs;
    this.headerBuffer = Buffer.allocUnsafe(this.maxHeaderBytes + LSP_HEADER_DELIMITER.length);
    this.transport.onData((chunk) => this.handleData(chunk));
    this.transport.onClose((code, signal) => this.failTransport(new Error(closeMessage(code, signal)), false));
    this.transport.onError((error) => this.failTransport(error, true));
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
    if (this.transportFailure) return Promise.reject(this.transportFailure);
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
    if (this.transportFailure) return Promise.resolve(false);
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
      this.killTransportOnce();
      throw error;
    }
  }

  // scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
  private request<T>(method: string, params: unknown, opts: RustAnalyzerRequestOptions = {}): Promise<T> {
    if (this.transportFailure) return Promise.reject(this.transportFailure);
    const budget = rustAnalyzerOperationBudget(
      opts.timeoutMs ?? this.requestTimeoutMs,
      opts.deadlineMs,
      this.monotonicNow,
    );
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
    if (this.transportFailure) return;
    this.transport.write(frameJsonMessage({ jsonrpc: '2.0', method, params }));
  }

  private handleData(chunk: Buffer): void {
    if (this.transportFailure || chunk.length === 0) return;
    let offset = 0;
    while (offset < chunk.length && !this.transportFailure) {
      if (this.bodyBuffer) {
        const copyLength = Math.min(chunk.length - offset, this.bodyBuffer.length - this.bodyLength);
        chunk.copy(this.bodyBuffer, this.bodyLength, offset, offset + copyLength);
        offset += copyLength;
        this.bodyLength += copyLength;
        if (this.bodyLength === this.bodyBuffer.length) {
          const body = this.bodyBuffer.toString('utf8');
          this.bodyBuffer = null;
          this.bodyLength = 0;
          let message: LspJsonMessage;
          try {
            message = parseJsonMessage(body);
          } catch {
            this.failProtocol('rust-analyzer LSP response body was not a valid JSON object');
            continue;
          }
          try {
            this.dispatchMessage(message);
          } catch {
            this.failTransport(new Error('rust-analyzer LSP message handling failed'), true);
          }
        }
        continue;
      }

      if (this.headerLength === this.headerBuffer.length) {
        this.failProtocol(`rust-analyzer LSP header exceeded ${this.maxHeaderBytes} byte limit`);
        return;
      }
      this.headerBuffer[this.headerLength++] = chunk[offset++]!;
      if (!this.headerDelimiterComplete()) continue;

      const headerLength = this.headerLength - LSP_HEADER_DELIMITER.length;
      if (headerLength > this.maxHeaderBytes) {
        this.failProtocol(`rust-analyzer LSP header exceeded ${this.maxHeaderBytes} byte limit`);
        return;
      }
      const header = this.headerBuffer.subarray(0, headerLength).toString('ascii');
      this.headerLength = 0;
      let contentLength: number;
      try {
        contentLength = parseContentLength(header, this.maxMessageBytes);
      } catch (error) {
        this.failProtocol(error instanceof Error ? error.message : String(error));
        return;
      }
      this.bodyBuffer = Buffer.allocUnsafe(contentLength);
      this.bodyLength = 0;
      if (contentLength === 0) {
        this.bodyBuffer = null;
        this.failProtocol('rust-analyzer LSP response body was not a valid JSON object');
      }
    }
  }

  private headerDelimiterComplete(): boolean {
    if (this.headerLength < LSP_HEADER_DELIMITER.length) return false;
    const start = this.headerLength - LSP_HEADER_DELIMITER.length;
    return this.headerBuffer.subarray(start, this.headerLength).equals(LSP_HEADER_DELIMITER);
  }

  private failProtocol(message: string): void {
    this.failTransport(new RustAnalyzerProtocolError(message), true);
  }

  private failTransport(error: Error, kill: boolean): void {
    if (this.transportFailure) return;
    this.transportFailure = error;
    this.headerLength = 0;
    this.bodyBuffer = null;
    this.bodyLength = 0;
    if (kill) this.killTransportOnce();
    this.rejectPending(error);
    this.resolveDiagnosticWaiters(false);
  }

  private killTransportOnce(): void {
    if (this.transportKilled) return;
    this.transportKilled = true;
    this.transport.kill();
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
    if (pending.deadlineMs !== undefined && this.monotonicNow() >= pending.deadlineMs) {
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

  private resolveDiagnosticWaiters(value: boolean): void {
    for (const waiters of this.diagnosticWaiters.values()) {
      waiters.forEach((resolve) => resolve(value));
    }
    this.diagnosticWaiters.clear();
  }

  private rejectReadinessWaiters(error: Error): void {
    for (const waiter of this.readinessWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
      this.readinessWaiters.delete(waiter);
    }
  }
}

export function rustAnalyzerLspFrameLimits(
  maxHeaderBytes = DEFAULT_RUST_ANALYZER_LSP_MAX_HEADER_BYTES,
  maxMessageBytes = DEFAULT_RUST_ANALYZER_LSP_MAX_MESSAGE_BYTES,
): { maxHeaderBytes: number; maxMessageBytes: number } {
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes <= 0) {
    throw new TypeError('maxHeaderBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    throw new TypeError('maxMessageBytes must be a positive safe integer.');
  }
  if (maxHeaderBytes > ABSOLUTE_RUST_ANALYZER_LSP_MAX_HEADER_BYTES) {
    throw new RangeError(
      `maxHeaderBytes cannot exceed ${ABSOLUTE_RUST_ANALYZER_LSP_MAX_HEADER_BYTES} bytes for rust-analyzer LSP.`,
    );
  }
  if (maxHeaderBytes + LSP_HEADER_DELIMITER.length + maxMessageBytes > ABSOLUTE_RUST_ANALYZER_LSP_BUFFER_BYTES) {
    throw new RangeError(
      `Combined rust-analyzer LSP header and message limits cannot exceed ${ABSOLUTE_RUST_ANALYZER_LSP_BUFFER_BYTES} bytes.`,
    );
  }
  return { maxHeaderBytes, maxMessageBytes };
}

function parseContentLength(header: string, maxMessageBytes: number): number {
  const values: string[] = [];
  for (const line of header.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue;
    values.push(line.slice(colon + 1).trim());
  }
  if (values.length === 0) {
    throw new RustAnalyzerProtocolError('rust-analyzer LSP response missing Content-Length header');
  }
  if (values.length > 1) {
    const message =
      new Set(values).size > 1
        ? 'rust-analyzer LSP response has conflicting Content-Length headers'
        : 'rust-analyzer LSP response has duplicate Content-Length headers';
    throw new RustAnalyzerProtocolError(message);
  }
  const raw = values[0]!;
  if (!/^\d+$/.test(raw)) {
    throw new RustAnalyzerProtocolError('rust-analyzer LSP Content-Length must be a non-negative safe integer');
  }
  const contentLength = Number(raw);
  if (!Number.isSafeInteger(contentLength)) {
    throw new RustAnalyzerProtocolError('rust-analyzer LSP Content-Length must be a non-negative safe integer');
  }
  if (contentLength > maxMessageBytes) {
    throw new RustAnalyzerProtocolError(
      `rust-analyzer LSP Content-Length exceeds ${maxMessageBytes} byte message limit`,
    );
  }
  return contentLength;
}

export function rustAnalyzerOperationBudget(
  configuredTimeoutMs: number,
  deadlineMs: number | undefined,
  now: () => number = monotonicNowMs,
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
