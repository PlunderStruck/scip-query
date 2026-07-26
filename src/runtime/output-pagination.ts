import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { sanitizeTerminalLine } from '../platform/terminal-output.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { encodeCursorPayload } from './cursor-codec.js';

export const CLI_OUTPUT_PAGE_KIND = 'scip-query-output-page' as const;
export const CLI_OUTPUT_PAGE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_OUTPUT_PAGE_SIZE = 12_000;
export const MIN_OUTPUT_PAGE_SIZE = 256;
export const MAX_OUTPUT_PAGE_SIZE = 100_000;
export const MAX_OUTPUT_CURSOR_LENGTH = 4_096;
export const MAX_TRACKED_OUTPUT_CHARACTERS = Number.MAX_SAFE_INTEGER;
export const OUTPUT_SNAPSHOT_TTL_MS = 60 * 60 * 1_000;

const OUTPUT_SNAPSHOT_VERSION = 1;
const OUTPUT_SNAPSHOT_ROOT = join(
  tmpdir(),
  `scip-query-output-pages-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
);
const OUTPUT_SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface OutputCursorPayload {
  version: 1;
  invocationHash: string;
  offset: number;
  outputHash: string;
  snapshotId: string;
}

interface OutputSnapshotMetadata {
  version: typeof OUTPUT_SNAPSHOT_VERSION;
  snapshotId: string;
  invocationHash: string;
  outputHash: string;
  totalCharacters: number;
  byteLength: number;
  createdAtMs: number;
}

export interface CliOutputPageEnvelopeV1 {
  kind: typeof CLI_OUTPUT_PAGE_KIND;
  schemaVersion: typeof CLI_OUTPUT_PAGE_SCHEMA_VERSION;
  producer: { name: 'scip-query'; version: string };
  command: string;
  contentType: 'text/plain' | 'application/json';
  /** Direct model-facing obligation; incomplete pages are not usable as complete evidence. */
  agentInstruction?: string;
  page: {
    offset: number;
    returnedCharacters: number;
    totalCharacters: number;
    omittedCharacters: number;
    remainingCharacters: number;
    complete: boolean;
    outputHash: string;
    continuation?: {
      cursor: string;
      command: string;
    };
  };
  content: string;
}

export interface CliOutputPaginationOptions {
  command: string;
  producerVersion: string;
  argv: readonly string[];
  cwd: string;
  json: boolean;
  pageSize?: number;
  cursor?: string;
  maxOutputCharacters?: number;
}

export interface CliOutputPaginationRuntime {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

const defaultRuntime: CliOutputPaginationRuntime = {
  writeStdout: (value) => {
    process.stdout.write(value);
  },
  writeStderr: (value) => {
    process.stderr.write(value);
  },
};

/**
 * Run one command behind a bounded output transport.
 *
 * Human output is captured and paged when it exceeds the default safe page.
 * JSON stays byte-compatible unless paging is explicitly requested; large
 * unpaged JSON gets an early stderr instruction naming the exact opt-in
 * paging command.
 */
export async function runWithCliOutputPagination(
  options: CliOutputPaginationOptions,
  action: () => void | Promise<void>,
  runtime: CliOutputPaginationRuntime = defaultRuntime,
): Promise<void> {
  const pageSize = options.pageSize ?? DEFAULT_OUTPUT_PAGE_SIZE;
  validatePageSize(pageSize);
  if (options.cursor !== undefined && options.cursor.length > MAX_OUTPUT_CURSOR_LENGTH) {
    throw new Error(
      `Output cursor exceeds the ${MAX_OUTPUT_CURSOR_LENGTH}-character limit. Run the command again without --output-cursor.`,
    );
  }

  if (options.json && options.pageSize === undefined && options.cursor === undefined) {
    await runJsonWithOversizeWarning(options, action, runtime);
    return;
  }

  const filteredArgv = withoutOutputPaginationArgs(options.argv);
  const invocationHash = hashInvocation(options.command, options.cwd, filteredArgv);
  const decodedCursor = options.cursor === undefined ? undefined : decodeOutputCursor(options.cursor, invocationHash);
  const offset = decodedCursor?.offset ?? 0;
  let snapshotId = decodedCursor?.snapshotId;
  let completed: { content: string; totalCharacters: number; outputHash: string };
  if (decodedCursor) {
    try {
      completed = captureOutputSnapshotPage(
        decodedCursor,
        pageSize,
        options.maxOutputCharacters ?? MAX_TRACKED_OUTPUT_CHARACTERS,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} Restart with: ${renderInitialPageCommand(filteredArgv, pageSize)}`, {
        cause: error,
      });
    }
  } else {
    const capture = new OutputPageCapture(
      offset,
      pageSize,
      options.maxOutputCharacters ?? MAX_TRACKED_OUTPUT_CHARACTERS,
    );
    const snapshot = new OutputSnapshotWriter(invocationHash);
    const restore = installStdoutCapture(capture, (bytes) => snapshot.write(bytes));
    let actionCompleted = false;
    try {
      await action();
      actionCompleted = true;
    } finally {
      restore();
      if (!actionCompleted) snapshot.abort();
    }
    completed = capture.finish();
    if (completed.totalCharacters > pageSize) {
      snapshotId = snapshot.complete({
        outputHash: completed.outputHash,
        totalCharacters: completed.totalCharacters,
      });
    } else {
      snapshot.abort();
    }
  }
  if (offset > completed.totalCharacters) {
    throw new Error('Output cursor points past the current result. Run the command again without --output-cursor.');
  }
  if (decodedCursor && decodedCursor.outputHash !== completed.outputHash) {
    throw new Error(
      `Command output changed after this cursor was issued. Restart with: ${renderInitialPageCommand(
        filteredArgv,
        pageSize,
      )}`,
    );
  }

  const nextOffset = offset + completed.content.length;
  const complete = nextOffset >= completed.totalCharacters;
  const continuation = complete
    ? undefined
    : createContinuation({
        filteredArgv,
        invocationHash,
        nextOffset,
        outputHash: completed.outputHash,
        pageSize,
        snapshotId: requireSnapshotId(snapshotId),
      });

  if (offset === 0 && complete && options.pageSize === undefined && options.cursor === undefined) {
    runtime.writeStdout(completed.content);
    return;
  }

  const envelope: CliOutputPageEnvelopeV1 = {
    kind: CLI_OUTPUT_PAGE_KIND,
    schemaVersion: CLI_OUTPUT_PAGE_SCHEMA_VERSION,
    producer: { name: 'scip-query', version: options.producerVersion },
    command: options.command,
    contentType: options.json ? 'application/json' : 'text/plain',
    agentInstruction: continuation
      ? 'INCOMPLETE EVIDENCE: do not draw conclusions or report completion from this partial page. Run page.continuation.command exactly, then repeat until page.complete is true.'
      : "OUTPUT COMPLETE: all rendered characters have been retrieved. Evaluate the command result's own coverage separately.",
    page: {
      offset,
      returnedCharacters: completed.content.length,
      totalCharacters: completed.totalCharacters,
      omittedCharacters: completed.totalCharacters - completed.content.length,
      remainingCharacters: completed.totalCharacters - nextOffset,
      complete,
      outputHash: completed.outputHash,
      ...(continuation ? { continuation } : {}),
    },
    content: completed.content,
  };

  if (options.json || options.pageSize !== undefined || options.cursor !== undefined) {
    runtime.writeStdout(`${JSON.stringify(envelope, null, options.json ? 0 : 2)}\n`);
    if (complete && snapshotId) removeOutputSnapshot(snapshotId);
    return;
  }
  runtime.writeStdout(renderHumanOutputPage(envelope));
  if (complete && snapshotId) removeOutputSnapshot(snapshotId);
}

export function parseOutputPageSize(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `Output page size must be an integer from ${MIN_OUTPUT_PAGE_SIZE} through ${MAX_OUTPUT_PAGE_SIZE}.`,
    );
  }
  const parsed = Number(value);
  validatePageSize(parsed);
  return parsed;
}

function validatePageSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < MIN_OUTPUT_PAGE_SIZE || value > MAX_OUTPUT_PAGE_SIZE) {
    throw new Error(
      `Output page size must be an integer from ${MIN_OUTPUT_PAGE_SIZE} through ${MAX_OUTPUT_PAGE_SIZE}.`,
    );
  }
}

async function runJsonWithOversizeWarning(
  options: CliOutputPaginationOptions,
  action: () => void | Promise<void>,
  runtime: CliOutputPaginationRuntime,
): Promise<void> {
  const buffered = new PrefixBuffer(
    DEFAULT_OUTPUT_PAGE_SIZE,
    options.maxOutputCharacters ?? MAX_TRACKED_OUTPUT_CHARACTERS,
  );
  const originalWrite = process.stdout.write;
  let warningWritten = false;
  const warning = `${sanitizeTerminalLine(
    `scip-query: JSON output exceeds ${DEFAULT_OUTPUT_PAGE_SIZE} characters and may be truncated by the client. Do not use possibly partial client output as evidence. Read every page with: ${renderInitialPageCommand(
      withoutOutputPaginationArgs(options.argv),
      DEFAULT_OUTPUT_PAGE_SIZE,
    )}`,
  )}\n`;
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    const overflow = buffered.push(chunk, encodingOrCallback);
    if (overflow !== undefined) {
      if (!warningWritten) {
        warningWritten = true;
        runtime.writeStderr(warning);
      }
      originalWrite.call(process.stdout, overflow);
    }
    invokeWriteCallback(encodingOrCallback, callback);
    return true;
  }) as typeof process.stdout.write;
  try {
    await action();
    const remainder = buffered.finish();
    if (remainder.crossedPageBoundary && !warningWritten) {
      warningWritten = true;
      runtime.writeStderr(warning);
    }
    if (remainder.bytes.length > 0) originalWrite.call(process.stdout, remainder.bytes);
    if (warningWritten) runtime.writeStderr(warning);
  } finally {
    process.stdout.write = originalWrite;
  }
}

function installStdoutCapture(capture: OutputPageCapture, mirror?: (bytes: Buffer) => void): () => void {
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    const bytes = outputChunkToBuffer(chunk, encodingOrCallback);
    mirror?.(bytes);
    capture.write(bytes, undefined);
    invokeWriteCallback(encodingOrCallback, callback);
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = originalWrite;
  };
}

function outputChunkToBuffer(chunk: string | Uint8Array, encodingOrCallback: unknown): Buffer {
  return typeof chunk === 'string'
    ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? (encodingOrCallback as BufferEncoding) : 'utf8')
    : Buffer.from(chunk);
}

function invokeWriteCallback(encodingOrCallback: unknown, callback: unknown): void {
  const fn = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof fn === 'function') fn();
}

class PrefixBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private readonly chunks: Buffer[] = [];
  private overflowed = false;
  private totalCharacters = 0;

  constructor(
    private readonly limit: number,
    private readonly maxOutputCharacters: number,
  ) {}

  push(chunk: string | Uint8Array, encodingOrCallback: unknown): Buffer | undefined {
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? (encodingOrCallback as BufferEncoding) : 'utf8')
        : Buffer.from(chunk);
    this.addCharacters(this.decoder.write(bytes));
    if (this.overflowed) return bytes;
    this.chunks.push(bytes);
    if (this.totalCharacters <= this.limit) return undefined;
    this.overflowed = true;
    const complete = Buffer.concat(this.chunks);
    this.chunks.length = 0;
    return complete;
  }

  finish(): { bytes: Buffer; crossedPageBoundary: boolean } {
    this.addCharacters(this.decoder.end());
    const crossedPageBoundary = this.totalCharacters > this.limit;
    const bytes = Buffer.concat(this.chunks);
    this.chunks.length = 0;
    return { bytes, crossedPageBoundary };
  }

  private addCharacters(value: string): void {
    this.totalCharacters += value.length;
    if (!Number.isSafeInteger(this.totalCharacters) || this.totalCharacters > this.maxOutputCharacters) {
      throw new Error(
        `Command output exceeds the ${this.maxOutputCharacters}-character safety limit. Narrow the query before retrying.`,
      );
    }
  }
}

class OutputPageCapture {
  private readonly decoder = new StringDecoder('utf8');
  private readonly hash = createHash('sha256');
  private content = '';
  private totalCharacters = 0;
  private finished = false;

  constructor(
    private readonly offset: number,
    private readonly pageSize: number,
    private readonly maxOutputCharacters: number,
  ) {}

  write(chunk: string | Uint8Array, encodingOrCallback: unknown): void {
    if (this.finished) throw new Error('Output capture is already complete.');
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? (encodingOrCallback as BufferEncoding) : 'utf8')
        : Buffer.from(chunk);
    this.hash.update(bytes);
    this.appendDecoded(this.decoder.write(bytes));
  }

  finish(): { content: string; totalCharacters: number; outputHash: string } {
    if (this.finished) throw new Error('Output capture is already complete.');
    this.appendDecoded(this.decoder.end());
    this.finished = true;
    return {
      content: this.content,
      totalCharacters: this.totalCharacters,
      outputHash: this.hash.digest('hex'),
    };
  }

  private appendDecoded(value: string): void {
    if (value.length === 0) return;
    const nextTotal = this.totalCharacters + value.length;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > this.maxOutputCharacters) {
      throw new Error(
        `Command output exceeds the ${this.maxOutputCharacters}-character safety limit. Narrow the query before retrying.`,
      );
    }
    const pageEnd = this.offset + this.pageSize;
    const overlapStart = Math.max(this.offset, this.totalCharacters);
    const overlapEnd = Math.min(pageEnd, nextTotal);
    if (overlapStart < overlapEnd) {
      const localStart = overlapStart - this.totalCharacters;
      let localEnd = overlapEnd - this.totalCharacters;
      if (isHighSurrogate(value.charCodeAt(localEnd - 1))) localEnd -= 1;
      this.content += value.slice(localStart, localEnd);
    }
    this.totalCharacters = nextTotal;
  }
}

class OutputSnapshotWriter {
  readonly snapshotId: string;
  private readonly temporaryPath: string;
  private descriptor: number | null;
  private byteLength = 0;

  constructor(private readonly invocationHash: string) {
    ensureOutputSnapshotRoot();
    pruneExpiredOutputSnapshots();
    this.snapshotId = randomUUID();
    this.temporaryPath = outputSnapshotPath(this.snapshotId, 'tmp');
    this.descriptor = openSync(this.temporaryPath, 'wx', 0o600);
  }

  write(bytes: Buffer): void {
    if (this.descriptor === null) throw new Error('Output snapshot writer is closed.');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(this.descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('Output snapshot write made no progress.');
      offset += written;
    }
    this.byteLength += bytes.length;
    if (!Number.isSafeInteger(this.byteLength)) throw new Error('Output snapshot exceeds the safe byte counter.');
  }

  complete(result: { outputHash: string; totalCharacters: number }): string {
    if (this.descriptor === null) throw new Error('Output snapshot writer is closed.');
    closeSync(this.descriptor);
    this.descriptor = null;
    const outputPath = outputSnapshotPath(this.snapshotId, 'output');
    const metadataPath = outputSnapshotPath(this.snapshotId, 'json');
    const metadataTemporaryPath = outputSnapshotPath(this.snapshotId, 'meta.tmp');
    try {
      renameSync(this.temporaryPath, outputPath);
      const metadata: OutputSnapshotMetadata = {
        version: OUTPUT_SNAPSHOT_VERSION,
        snapshotId: this.snapshotId,
        invocationHash: this.invocationHash,
        outputHash: result.outputHash,
        totalCharacters: result.totalCharacters,
        byteLength: this.byteLength,
        createdAtMs: Date.now(),
      };
      writeFileSync(metadataTemporaryPath, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      renameSync(metadataTemporaryPath, metadataPath);
      return this.snapshotId;
    } catch (error) {
      rmSync(outputPath, { force: true });
      rmSync(metadataPath, { force: true });
      rmSync(metadataTemporaryPath, { force: true });
      throw error;
    }
  }

  abort(): void {
    if (this.descriptor !== null) {
      closeSync(this.descriptor);
      this.descriptor = null;
    }
    rmSync(this.temporaryPath, { force: true });
  }
}

function captureOutputSnapshotPage(
  cursor: OutputCursorPayload,
  pageSize: number,
  maxOutputCharacters: number,
): { content: string; totalCharacters: number; outputHash: string } {
  ensureOutputSnapshotRoot();
  const metadata = readOutputSnapshotMetadata(cursor.snapshotId);
  if (
    metadata.invocationHash !== cursor.invocationHash ||
    metadata.outputHash !== cursor.outputHash ||
    metadata.snapshotId !== cursor.snapshotId
  ) {
    throw new Error('Output snapshot identity does not match this cursor.');
  }
  if (Date.now() - metadata.createdAtMs > OUTPUT_SNAPSHOT_TTL_MS) {
    removeOutputSnapshot(cursor.snapshotId);
    throw new Error('Output snapshot expired before all pages were read.');
  }

  const path = outputSnapshotPath(cursor.snapshotId, 'output');
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== metadata.byteLength) {
      throw new Error('Output snapshot size or type changed.');
    }
    const capture = new OutputPageCapture(cursor.offset, pageSize, maxOutputCharacters);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead === 0) break;
      capture.write(buffer.subarray(0, bytesRead), undefined);
      position += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      position !== before.size
    ) {
      throw new Error('Output snapshot changed while it was being read.');
    }
    const completed = capture.finish();
    if (completed.outputHash !== metadata.outputHash || completed.totalCharacters !== metadata.totalCharacters) {
      throw new Error('Output snapshot content no longer matches its metadata.');
    }
    return completed;
  } catch (error) {
    removeOutputSnapshot(cursor.snapshotId);
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function readOutputSnapshotMetadata(snapshotId: string): OutputSnapshotMetadata {
  if (!OUTPUT_SNAPSHOT_ID.test(snapshotId)) throw new Error('Output snapshot identifier is invalid.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readSmallArtifactText(outputSnapshotPath(snapshotId, 'json'), 'output snapshot metadata'));
  } catch (error) {
    throw new Error('Output snapshot is unavailable.', { cause: error });
  }
  if (!isOutputSnapshotMetadata(parsed)) throw new Error('Output snapshot metadata is invalid.');
  return parsed;
}

function isOutputSnapshotMetadata(value: unknown): value is OutputSnapshotMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Partial<OutputSnapshotMetadata>;
  return (
    metadata.version === OUTPUT_SNAPSHOT_VERSION &&
    typeof metadata.snapshotId === 'string' &&
    OUTPUT_SNAPSHOT_ID.test(metadata.snapshotId) &&
    isSha256(metadata.invocationHash) &&
    isSha256(metadata.outputHash) &&
    Number.isSafeInteger(metadata.totalCharacters) &&
    (metadata.totalCharacters ?? -1) >= 0 &&
    Number.isSafeInteger(metadata.byteLength) &&
    (metadata.byteLength ?? -1) >= 0 &&
    Number.isSafeInteger(metadata.createdAtMs) &&
    (metadata.createdAtMs ?? -1) >= 0
  );
}

function ensureOutputSnapshotRoot(): void {
  mkdirSync(OUTPUT_SNAPSHOT_ROOT, { recursive: true, mode: 0o700 });
  const stat = lstatSync(OUTPUT_SNAPSHOT_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Output snapshot root is not a private directory: ${OUTPUT_SNAPSHOT_ROOT}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Output snapshot root is not owned by the current user: ${OUTPUT_SNAPSHOT_ROOT}`);
  }
  if (process.platform !== 'win32') chmodSync(OUTPUT_SNAPSHOT_ROOT, 0o700);
}

function pruneExpiredOutputSnapshots(): void {
  const cutoff = Date.now() - OUTPUT_SNAPSHOT_TTL_MS;
  for (const entry of readdirSync(OUTPUT_SNAPSHOT_ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.(?:json|output|tmp|meta\.tmp)$/u.test(entry.name)) continue;
    const path = join(OUTPUT_SNAPSHOT_ROOT, entry.name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // A concurrent continuation or cleanup may already own this entry.
    }
  }
}

function removeOutputSnapshot(snapshotId: string): void {
  if (!OUTPUT_SNAPSHOT_ID.test(snapshotId)) return;
  for (const extension of ['json', 'output', 'tmp', 'meta.tmp'] as const) {
    rmSync(outputSnapshotPath(snapshotId, extension), { force: true });
  }
}

function outputSnapshotPath(snapshotId: string, extension: 'json' | 'output' | 'tmp' | 'meta.tmp'): string {
  if (!OUTPUT_SNAPSHOT_ID.test(snapshotId)) throw new Error('Output snapshot identifier is invalid.');
  return join(OUTPUT_SNAPSHOT_ROOT, `${snapshotId}.${extension}`);
}

function requireSnapshotId(value: string | undefined): string {
  if (!value) throw new Error('Incomplete output did not create a resumable snapshot.');
  return value;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function createContinuation(input: {
  filteredArgv: readonly string[];
  invocationHash: string;
  nextOffset: number;
  outputHash: string;
  pageSize: number;
  snapshotId: string;
}): { cursor: string; command: string } {
  const cursor = encodeOutputCursor({
    invocationHash: input.invocationHash,
    offset: input.nextOffset,
    outputHash: input.outputHash,
    snapshotId: input.snapshotId,
  });
  return {
    cursor,
    command: renderContinuationCommand(input.filteredArgv, input.pageSize, cursor),
  };
}

function encodeOutputCursor(payload: Omit<OutputCursorPayload, 'version'>): string {
  return encodeCursorPayload({ version: 1, ...payload } satisfies OutputCursorPayload);
}

function decodeOutputCursor(cursor: string, expectedInvocationHash: string): OutputCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid output cursor. Run the command again without --output-cursor.');
  }
  if (!isOutputCursorPayload(parsed)) {
    throw new Error('Invalid output cursor. Run the command again without --output-cursor.');
  }
  if (parsed.invocationHash !== expectedInvocationHash) {
    throw new Error(
      'This output cursor belongs to a different command, working directory, or argument set. Run again without --output-cursor.',
    );
  }
  return parsed;
}

function isOutputCursorPayload(value: unknown): value is OutputCursorPayload {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<OutputCursorPayload>;
  return (
    cursor.version === 1 &&
    isSha256(cursor.invocationHash) &&
    Number.isSafeInteger(cursor.offset) &&
    (cursor.offset ?? -1) >= 0 &&
    isSha256(cursor.outputHash) &&
    typeof cursor.snapshotId === 'string' &&
    OUTPUT_SNAPSHOT_ID.test(cursor.snapshotId)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function hashInvocation(command: string, cwd: string, argv: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ command, cwd, argv })).digest('hex');
}

function withoutOutputPaginationArgs(argv: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--output-page-size' || arg === '--output-cursor') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--output-page-size=') || arg.startsWith('--output-cursor=')) continue;
    filtered.push(arg);
  }
  return filtered;
}

function renderInitialPageCommand(argv: readonly string[], pageSize: number): string {
  return shellJoin(['scip-query', ...argv, '--output-page-size', String(pageSize)]);
}

function renderContinuationCommand(argv: readonly string[], pageSize: number, cursor: string): string {
  return shellJoin(['scip-query', ...argv, '--output-page-size', String(pageSize), '--output-cursor', cursor]);
}

function shellJoin(args: readonly string[]): string {
  return args.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderHumanOutputPage(envelope: CliOutputPageEnvelopeV1): string {
  const continuation = envelope.page.continuation;
  const header = [
    `[scip-query output page: characters ${envelope.page.offset}-${envelope.page.offset + envelope.page.returnedCharacters - 1} of ${envelope.page.totalCharacters}]`,
    ...(continuation
      ? [
          'INCOMPLETE EVIDENCE — do not draw conclusions or report completion from this partial page.',
          `Continue exactly: ${continuation.command}`,
        ]
      : []),
    '',
  ];
  const footer = continuation
    ? [
        '',
        `[${envelope.page.remainingCharacters} output characters remain]`,
        'INCOMPLETE EVIDENCE — retrieve the remaining pages before using this output as evidence.',
        `Continue exactly: ${continuation.command}`,
      ]
    : ['', '[scip-query output complete]'];
  return `${header.join('\n')}${envelope.content}${footer.join('\n')}\n`;
}
