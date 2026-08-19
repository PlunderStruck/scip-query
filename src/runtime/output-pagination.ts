import { createHash, randomBytes } from 'node:crypto';
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
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { InvalidArgumentError } from 'commander';
import {
  parseProcessIdentity,
  readProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from '../platform/process-identity.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import { tryAcquireProcessFileLock } from '../platform/process-file-lock.js';
import {
  CLIENT_SAFE_OUTPUT_BYTES,
  DEFAULT_OUTPUT_PAGE_SIZE,
  HUMAN_OUTPUT_PAGE_CONTENT_BYTES,
  JSON_OUTPUT_PAGE_CONTENT_BYTES,
  sanitizeTerminalLine,
} from '../platform/terminal-output.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { quoteShellArgument } from '../platform/shell-arguments.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { isNonNegativeInteger, isRecordObject, isSha256Hex } from '../domain/record-validation.js';
import { finalizeSourceEmission, runWithSourceEmissionInvocation } from './source-emission-session.js';
import { assertNavigationMapCanStart, recordNavigationOutputDelivery } from './navigation-session.js';
export {
  CLIENT_SAFE_OUTPUT_BYTES,
  DEFAULT_OUTPUT_PAGE_SIZE,
  HUMAN_OUTPUT_PAGE_CONTENT_BYTES,
  JSON_OUTPUT_PAGE_CONTENT_BYTES,
} from '../platform/terminal-output.js';

export const CLI_OUTPUT_PAGE_KIND = 'scip-query-output-page' as const;
export const CLI_OUTPUT_PAGE_SCHEMA_VERSION = 1 as const;
export const CLI_OUTPUT_CONTINUATION_COMMAND = 'continue' as const;
export const MIN_OUTPUT_PAGE_SIZE = 256;
export const MAX_OUTPUT_PAGE_SIZE = 100_000;
export const MAX_OUTPUT_CURSOR_LENGTH = 4_096;
export const MAX_TRACKED_OUTPUT_CHARACTERS = 32_000_000;
export const MAX_OUTPUT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_OUTPUT_SNAPSHOT_AGGREGATE_BYTES = 256 * 1024 * 1024;
export const MAX_OUTPUT_SNAPSHOT_COUNT = 32;
export const MAX_OUTPUT_SNAPSHOT_PAGES = 32_768;
export const MAX_AGENT_OUTPUT_PAGES = 16;
export const MAX_AGENT_OUTPUT_CHARACTERS = JSON_OUTPUT_PAGE_CONTENT_BYTES * MAX_AGENT_OUTPUT_PAGES;
export const MAX_JSON_OUTPUT_PATH_LENGTH = 4_096;
export const MAX_JSON_OUTPUT_FILE_BYTES = MAX_OUTPUT_SNAPSHOT_BYTES;
export const OUTPUT_SNAPSHOT_TTL_MS = 60 * 60 * 1_000;
export const CLI_JSON_EXPORT_RECEIPT_KIND = 'scip-query-json-export' as const;
export const CLI_JSON_EXPORT_RECEIPT_SCHEMA_VERSION = 1 as const;

const OUTPUT_SNAPSHOT_VERSION = 3;
function outputSnapshotRoot(): string {
  return join(tmpdir(), `scip-query-output-pages-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`);
}
const LEGACY_OUTPUT_SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHORT_OUTPUT_SNAPSHOT_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{11}$/u;
const UUID_OUTPUT_CURSOR = /^4\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,10})$/u;
const SHORT_OUTPUT_CURSOR = /^([A-Za-z0-9_][A-Za-z0-9_-]{11})(?:\.([0-9a-z]{1,10}))?$/u;
const OUTPUT_RESERVATION_VERSION = 1;
const OUTPUT_QUOTA_LOCK_NAME = 'quota.lock';
const OUTPUT_QUOTA_LOCK_WAIT_MS = 2_000;
const OUTPUT_QUOTA_LOCK_RETRY_MS = 5;
const OUTPUT_RESERVATION_CHUNK_BYTES = 1024 * 1024;
const OUTPUT_QUOTA_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
let outputProcessIdentity: ProcessIdentity | null | undefined;

interface LegacyOutputCursorPayload {
  version: 3;
  invocationHash: string;
  pageIndex: number;
  pageSize: number;
  outputHash: string;
  snapshotId: string;
}

interface ShortOutputCursorPayload {
  version: 4;
  pageIndex: number;
  snapshotId: string;
}

type OutputCursorPayload = LegacyOutputCursorPayload | ShortOutputCursorPayload;

interface OutputSnapshotPage {
  characterOffset: number;
  characterLength: number;
  byteOffset: number;
  byteLength: number;
  hash: string;
}

interface OutputSnapshotMetadata {
  version: typeof OUTPUT_SNAPSHOT_VERSION;
  snapshotId: string;
  invocationHash: string;
  invocationPrefix: string[];
  command: string;
  cwd: string;
  argv: string[];
  outputHash: string;
  pageSize: number;
  pages: OutputSnapshotPage[];
  totalCharacters: number;
  byteLength: number;
  createdAtMs: number;
}

interface OutputSnapshotReservation {
  version: typeof OUTPUT_RESERVATION_VERSION;
  snapshotId: string;
  pid: number;
  processIdentity?: ProcessIdentity;
  reservedBytes: number;
  state: 'active' | 'complete';
  createdAtMs: number;
  updatedAtMs: number;
}

export interface OutputSnapshotLimits {
  maxSnapshotBytes: number;
  maxAggregateBytes: number;
  maxSnapshotCount: number;
}

/** Bounded session-restoration metadata for one still-readable output page. */
export interface PendingCliOutputSnapshot {
  snapshotId: string;
  pageIndex: number;
  command: string;
  cwd: string;
  continuationCommand: string;
  remainingCharacters: number;
  totalCharacters: number;
  outputHash: string;
  createdAtMs: number;
}

const DEFAULT_OUTPUT_SNAPSHOT_LIMITS: OutputSnapshotLimits = Object.freeze({
  maxSnapshotBytes: MAX_OUTPUT_SNAPSHOT_BYTES,
  maxAggregateBytes: MAX_OUTPUT_SNAPSHOT_AGGREGATE_BYTES,
  maxSnapshotCount: MAX_OUTPUT_SNAPSHOT_COUNT,
});

interface CliOutputPageCommon {
  offset: number;
  returnedCharacters: number;
  totalCharacters: number;
  omittedCharacters: number;
  remainingCharacters: number;
  outputHash: string;
}

export type CliOutputPage =
  | (CliOutputPageCommon & {
      complete: false;
      continuation: {
        cursor: string;
        command: string;
      };
    })
  | (CliOutputPageCommon & {
      complete: true;
      continuation?: never;
    });

// scip-query: ignore-stale -- Versioned transport envelope is a compatibility contract, not local type ceremony.
export interface CliOutputPageEnvelopeV1 {
  kind: typeof CLI_OUTPUT_PAGE_KIND;
  schemaVersion: typeof CLI_OUTPUT_PAGE_SCHEMA_VERSION;
  producer: { name: 'scip-query'; version: string };
  command: string;
  contentType: 'text/plain' | 'application/json';
  /** Direct model-facing instruction; incomplete pages are not usable as complete evidence. */
  agentInstruction?: string;
  page: CliOutputPage;
  content: string;
}

export type DecodedCliOutputPageEnvelope =
  | { kind: 'supported'; envelope: CliOutputPageEnvelopeV1 }
  | { kind: 'malformed'; reason: string };

export function decodeCliOutputPageEnvelope(input: unknown): DecodedCliOutputPageEnvelope {
  if (!isRecordObject(input)) return { kind: 'malformed', reason: 'Output page envelope must be an object.' };
  if (input['kind'] !== CLI_OUTPUT_PAGE_KIND || input['schemaVersion'] !== CLI_OUTPUT_PAGE_SCHEMA_VERSION) {
    return { kind: 'malformed', reason: 'Output page envelope kind or schema version is unsupported.' };
  }
  if (
    !isRecordObject(input['producer']) ||
    input['producer']['name'] !== 'scip-query' ||
    typeof input['producer']['version'] !== 'string' ||
    input['producer']['version'].length === 0 ||
    typeof input['command'] !== 'string' ||
    input['command'].length === 0 ||
    (input['contentType'] !== 'text/plain' && input['contentType'] !== 'application/json') ||
    (input['agentInstruction'] !== undefined && typeof input['agentInstruction'] !== 'string') ||
    typeof input['content'] !== 'string' ||
    !isRecordObject(input['page'])
  ) {
    return { kind: 'malformed', reason: 'Output page envelope contains invalid common fields.' };
  }
  const page = input['page'];
  const integerFields = [
    'offset',
    'returnedCharacters',
    'totalCharacters',
    'omittedCharacters',
    'remainingCharacters',
  ] as const;
  if (integerFields.some((field) => !isNonNegativeInteger(page[field])) || !isSha256Hex(page['outputHash'])) {
    return { kind: 'malformed', reason: 'Output page counts or output hash are invalid.' };
  }
  const offset = Number(page['offset']);
  const returnedCharacters = Number(page['returnedCharacters']);
  const totalCharacters = Number(page['totalCharacters']);
  const omittedCharacters = Number(page['omittedCharacters']);
  const remainingCharacters = Number(page['remainingCharacters']);
  if (
    returnedCharacters !== input['content'].length ||
    omittedCharacters !== totalCharacters - returnedCharacters ||
    remainingCharacters !== totalCharacters - offset - returnedCharacters ||
    remainingCharacters < 0
  ) {
    return { kind: 'malformed', reason: 'Output page character counts are inconsistent.' };
  }
  if (page['complete'] === true) {
    if (page['remainingCharacters'] !== 0 || page['continuation'] !== undefined) {
      return { kind: 'malformed', reason: 'A complete output page cannot have remaining content or a continuation.' };
    }
  } else if (page['complete'] === false) {
    const continuation = page['continuation'];
    if (
      page['remainingCharacters'] === 0 ||
      !isRecordObject(continuation) ||
      typeof continuation['cursor'] !== 'string' ||
      continuation['cursor'].length === 0 ||
      typeof continuation['command'] !== 'string' ||
      continuation['command'].length === 0
    ) {
      return { kind: 'malformed', reason: 'An incomplete output page requires a non-empty continuation.' };
    }
  } else {
    return { kind: 'malformed', reason: 'Output page complete must be a Boolean.' };
  }
  return { kind: 'supported', envelope: input as unknown as CliOutputPageEnvelopeV1 };
}

export function requireCliOutputPageEnvelope(input: unknown): CliOutputPageEnvelopeV1 {
  const decoded = decodeCliOutputPageEnvelope(input);
  if (decoded.kind === 'malformed') throw new Error(decoded.reason);
  return decoded.envelope;
}

// scip-query: ignore-stale -- Shared pagination input and deterministic I/O seam used by both render paths.
export interface CliOutputPaginationOptions {
  command: string;
  producerVersion: string;
  /** Executable/package-runner prefix that must be reused for every continuation. */
  invocationPrefix?: readonly string[];
  argv: readonly string[];
  cwd: string;
  json: boolean;
  /** Emit a bounded command-owned projection intended for model consumption. */
  agentOutput?: boolean;
  /** Atomically write the complete JSON result and print only a bounded receipt. */
  jsonOutputPath?: string;
  /** Reuse an agent-scoped ledger to replace repeated source and graph evidence with citations. */
  sourceSession?: boolean;
  /** Render complete evidence even when the current agent session saw it already. */
  reemitSource?: boolean;
  pageSize?: number;
  cursor?: string;
  maxOutputCharacters?: number;
  /** @internal deterministic quota tests and embedded runtimes. */
  snapshotLimits?: Partial<OutputSnapshotLimits>;
  /** @internal isolate snapshot state in tests and embedded runtimes. */
  snapshotRoot?: string;
  /** @internal observe continuation I/O without patching filesystem globals. */
  onSnapshotRead?: (bytes: number) => void;
}

export interface CliJsonExportReceiptV1 {
  kind: typeof CLI_JSON_EXPORT_RECEIPT_KIND;
  schemaVersion: typeof CLI_JSON_EXPORT_RECEIPT_SCHEMA_VERSION;
  producer: { name: 'scip-query'; version: string };
  command: string;
  path: string;
  bytes: number;
  sha256: string;
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
 * JSON stays byte-compatible unless bounded agent output, file export, or
 * paging is explicitly requested. Large unpaged JSON gets an early stderr
 * instruction naming the exact opt-in paging command.
 */
export async function runWithCliOutputPagination(
  options: CliOutputPaginationOptions,
  action: () => void | Promise<void>,
  runtime: CliOutputPaginationRuntime = defaultRuntime,
): Promise<void> {
  return runWithSourceEmissionInvocation(
    {
      command: options.command,
      cwd: options.cwd,
      argv: options.argv,
      json: options.json,
      sessionEnabled: options.sourceSession,
      reemit: options.reemitSource,
    },
    async () => {
      try {
        await runWithCliOutputPaginationInSession(options, action, runtime);
      } finally {
        finalizeSourceEmission(false);
      }
    },
  );
}

async function runWithCliOutputPaginationInSession(
  options: CliOutputPaginationOptions,
  action: () => void | Promise<void>,
  runtime: CliOutputPaginationRuntime,
): Promise<void> {
  const pageSize = options.pageSize ?? DEFAULT_OUTPUT_PAGE_SIZE;
  const snapshotRoot = options.snapshotRoot ?? outputSnapshotRoot();
  const snapshotLimits = resolveOutputSnapshotLimits(options.snapshotLimits);
  const requestedMaxOutputCharacters = options.maxOutputCharacters ?? MAX_TRACKED_OUTPUT_CHARACTERS;
  if (!Number.isSafeInteger(requestedMaxOutputCharacters) || requestedMaxOutputCharacters <= 0) {
    throw new Error('Output character safety limit must be a positive integer.');
  }
  const maxOutputCharacters = Math.min(
    requestedMaxOutputCharacters,
    MAX_TRACKED_OUTPUT_CHARACTERS,
    options.agentOutput ? MAX_AGENT_OUTPUT_CHARACTERS : MAX_TRACKED_OUTPUT_CHARACTERS,
  );
  validatePageSize(pageSize);
  if (options.cursor !== undefined && options.cursor.length > MAX_OUTPUT_CURSOR_LENGTH) {
    throw new Error(
      `Output cursor exceeds the ${MAX_OUTPUT_CURSOR_LENGTH}-character limit. Run the command again without --output-cursor.`,
    );
  }

  if (options.jsonOutputPath !== undefined) {
    if (!options.json) throw new Error('--json-output requires --json.');
    if (options.agentOutput || options.pageSize !== undefined || options.cursor !== undefined) {
      throw new Error('--json-output cannot be combined with --agent-output or output pagination.');
    }
    if (options.command === 'system-map') {
      assertNavigationMapCanStart(options.cwd, options.sourceSession !== false);
    }
    await runJsonToOutputFile(options, action, runtime, maxOutputCharacters);
    return;
  }

  if (options.json && !options.agentOutput && options.pageSize === undefined && options.cursor === undefined) {
    if (options.command === 'system-map') {
      assertNavigationMapCanStart(options.cwd, options.sourceSession !== false);
    }
    await runJsonWithOversizeWarning(options, action, runtime);
    return;
  }

  const filteredArgv = withoutOutputPaginationArgs(options.argv);
  const invocationPrefix = normalizeInvocationPrefix(options.invocationPrefix);
  const invocationHash = hashInvocation(options.command, options.cwd, invocationPrefix, filteredArgv);
  const decodedCursor = options.cursor === undefined ? undefined : decodeOutputCursor(options.cursor, invocationHash);
  if (options.command === 'system-map' && !decodedCursor) {
    assertNavigationMapCanStart(options.cwd, options.sourceSession !== false);
  }
  let snapshotId = decodedCursor?.snapshotId;
  let completed: {
    content: string;
    offset: number;
    pageIndex: number;
    pageCount: number;
    totalCharacters: number;
    outputHash: string;
  };
  if (decodedCursor) {
    try {
      completed = captureOutputSnapshotPage(
        decodedCursor,
        invocationHash,
        pageSize,
        maxOutputCharacters,
        snapshotRoot,
        options.onSnapshotRead,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} Restart with: ${renderInitialPageCommand(invocationPrefix, filteredArgv, pageSize)}`, {
        cause: error,
      });
    }
  } else {
    const snapshot = new OutputSnapshotWriter(
      invocationHash,
      invocationPrefix,
      options.command,
      options.cwd,
      filteredArgv,
      pageSize,
      maxOutputCharacters,
      pageContentByteLimit(options, invocationPrefix),
      snapshotRoot,
      snapshotLimits,
      options.agentOutput ? MAX_AGENT_OUTPUT_PAGES : MAX_OUTPUT_SNAPSHOT_PAGES,
      !options.json,
      outputSafetyLimitMessage(maxOutputCharacters, options.agentOutput === true),
    );
    const restore = installStdoutCapture((bytes) => snapshot.write(bytes));
    let actionCompleted = false;
    try {
      await action();
      actionCompleted = true;
    } finally {
      restore();
      if (!actionCompleted) snapshot.abort();
    }
    let captured: ReturnType<OutputSnapshotWriter['complete']>;
    try {
      captured = snapshot.complete();
    } catch (error) {
      snapshot.abort();
      throw error;
    }
    snapshotId = captured.snapshotId;
    completed = {
      content: captured.content,
      offset: 0,
      pageIndex: 0,
      pageCount: captured.pageCount,
      totalCharacters: captured.totalCharacters,
      outputHash: captured.outputHash,
    };
  }

  const nextOffset = completed.offset + completed.content.length;
  const complete = completed.pageIndex + 1 >= completed.pageCount;
  const continuation = complete
    ? undefined
    : createContinuation({
        invocationPrefix,
        nextPageIndex: completed.pageIndex + 1,
        snapshotId: requireSnapshotId(snapshotId),
      });

  recordNavigationOutputDelivery(
    options.command,
    options.cwd,
    complete,
    options.sourceSession !== false,
    continuation?.command,
  );

  if (completed.offset === 0 && complete && options.cursor === undefined) {
    runtime.writeStdout(completed.content);
    finalizeSourceEmission(true);
    if (snapshotId) removeOutputSnapshot(snapshotId, snapshotRoot);
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
    page: continuation
      ? {
          offset: completed.offset,
          returnedCharacters: completed.content.length,
          totalCharacters: completed.totalCharacters,
          omittedCharacters: completed.totalCharacters - completed.content.length,
          remainingCharacters: completed.totalCharacters - nextOffset,
          complete: false,
          outputHash: completed.outputHash,
          continuation,
        }
      : {
          offset: completed.offset,
          returnedCharacters: completed.content.length,
          totalCharacters: completed.totalCharacters,
          omittedCharacters: completed.totalCharacters - completed.content.length,
          remainingCharacters: completed.totalCharacters - nextOffset,
          complete: true,
          outputHash: completed.outputHash,
        },
    content: completed.content,
  };

  if (options.json) {
    runtime.writeStdout(`${JSON.stringify(envelope)}\n`);
    if (complete && snapshotId) removeOutputSnapshot(snapshotId, snapshotRoot);
    return;
  }
  runtime.writeStdout(renderHumanOutputPage(envelope));
  if (complete && snapshotId) removeOutputSnapshot(snapshotId, snapshotRoot);
}

/** Resume one immutable output snapshot without repeating its original command. */
export async function continueCliOutput(
  cursor: string,
  producerVersion: string,
  snapshotRoot = outputSnapshotRoot(),
  runtime: CliOutputPaginationRuntime = defaultRuntime,
): Promise<void> {
  if (cursor.length > MAX_OUTPUT_CURSOR_LENGTH) {
    throw new Error(`Output cursor exceeds the ${MAX_OUTPUT_CURSOR_LENGTH}-character limit.`);
  }
  const parsed = parseOutputCursor(cursor);
  if (!parsed) throw new Error('Invalid output cursor. Run the original command again.');
  const metadata = readOutputSnapshotMetadata(parsed.snapshotId, snapshotRoot);
  await runWithCliOutputPagination(
    {
      command: metadata.command,
      producerVersion,
      invocationPrefix: metadata.invocationPrefix,
      argv: [...metadata.argv, '--output-page-size', String(metadata.pageSize), '--output-cursor', cursor],
      cwd: metadata.cwd,
      json: metadata.argv.some((argument) => argument === '--json' || argument.startsWith('--json=')),
      sourceSession: !metadata.argv.some((argument) => argument === '--no-session'),
      agentOutput: metadata.argv.some((argument) => argument === '--agent-output'),
      pageSize: metadata.pageSize,
      cursor,
      snapshotRoot,
    },
    () => {
      throw new Error('Output continuation attempted to rerun the original command.');
    },
    runtime,
  );
}

async function runJsonToOutputFile(
  options: CliOutputPaginationOptions,
  action: () => void | Promise<void>,
  runtime: CliOutputPaginationRuntime,
  maxOutputCharacters: number,
): Promise<void> {
  const requestedPath = options.jsonOutputPath;
  if (
    requestedPath === undefined ||
    requestedPath.length === 0 ||
    Buffer.byteLength(requestedPath) > MAX_JSON_OUTPUT_PATH_LENGTH ||
    requestedPath.includes('\0')
  ) {
    throw new Error(`--json-output requires a path from 1 through ${MAX_JSON_OUTPUT_PATH_LENGTH} UTF-8 bytes.`);
  }
  const outputPath = resolve(options.cwd, requestedPath);
  if (Buffer.byteLength(outputPath) > MAX_JSON_OUTPUT_PATH_LENGTH) {
    throw new Error(`The resolved --json-output path exceeds ${MAX_JSON_OUTPUT_PATH_LENGTH} UTF-8 bytes.`);
  }
  const decoder = new StringDecoder('utf8');
  const hash = createHash('sha256');
  let totalBytes = 0;
  let totalCharacters = 0;
  const addCharacters = (value: string): void => {
    totalCharacters += value.length;
    if (!Number.isSafeInteger(totalCharacters) || totalCharacters > maxOutputCharacters) {
      throw new Error(outputSafetyLimitMessage(maxOutputCharacters, false));
    }
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${randomBytes(12).toString('hex')}`;
  let descriptor: number | undefined = openSync(temporaryPath, 'wx', 0o600);
  let temporaryOwned = true;
  const restore = installStdoutCapture((bytes) => {
    const nextTotalBytes = totalBytes + bytes.length;
    if (!Number.isSafeInteger(nextTotalBytes) || nextTotalBytes > MAX_JSON_OUTPUT_FILE_BYTES) {
      throw new Error(
        `JSON export exceeds the ${MAX_JSON_OUTPUT_FILE_BYTES}-byte file safety limit. Narrow the query before retrying.`,
      );
    }
    addCharacters(decoder.write(bytes));
    if (descriptor === undefined) throw new Error('JSON export writer is closed.');
    writeAll(descriptor, bytes);
    hash.update(bytes);
    totalBytes = nextTotalBytes;
  });
  try {
    await action();
    addCharacters(decoder.end());
    restore();
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, outputPath);
    temporaryOwned = false;
  } finally {
    restore();
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the command or write error; owned temporary cleanup follows.
      }
    }
    if (temporaryOwned) rmSync(temporaryPath, { force: true });
  }

  const receipt: CliJsonExportReceiptV1 = {
    kind: CLI_JSON_EXPORT_RECEIPT_KIND,
    schemaVersion: CLI_JSON_EXPORT_RECEIPT_SCHEMA_VERSION,
    producer: { name: 'scip-query', version: options.producerVersion },
    command: options.command,
    path: outputPath,
    bytes: totalBytes,
    sha256: hash.digest('hex'),
  };
  runtime.writeStdout(`${JSON.stringify(receipt)}\n`);
  recordNavigationOutputDelivery(options.command, options.cwd, true, options.sourceSession !== false);
  finalizeSourceEmission(true);
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('JSON export write made no forward progress.');
    offset += written;
  }
}

function outputSafetyLimitMessage(limit: number, agentOutput: boolean): string {
  const base = `Command output exceeds the ${limit}-character safety limit. Narrow the query before retrying.`;
  return agentOutput
    ? `${base} For the complete machine result, use --json --json-output <path> and inspect the file programmatically.`
    : base;
}

export function parseOutputPageSize(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError(
      `Output page size must be an integer from ${MIN_OUTPUT_PAGE_SIZE} through ${MAX_OUTPUT_PAGE_SIZE}.`,
    );
  }
  const parsed = Number(value);
  try {
    validatePageSize(parsed);
  } catch {
    throw new InvalidArgumentError(
      `Output page size must be an integer from ${MIN_OUTPUT_PAGE_SIZE} through ${MAX_OUTPUT_PAGE_SIZE}.`,
    );
  }
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
    CLIENT_SAFE_OUTPUT_BYTES,
    options.maxOutputCharacters ?? MAX_TRACKED_OUTPUT_CHARACTERS,
  );
  const originalWrite = process.stdout.write;
  let warningWritten = false;
  const warning = `${sanitizeTerminalLine(
    `scip-query: JSON output exceeds the ${CLIENT_SAFE_OUTPUT_BYTES}-byte client-safe budget and may be truncated by the client. Do not use possibly partial client output as evidence. Read every page with: ${renderInitialPageCommand(
      normalizeInvocationPrefix(options.invocationPrefix),
      withoutRawJsonArg(withoutOutputPaginationArgs(options.argv)),
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
    recordNavigationOutputDelivery(options.command, options.cwd, true, options.sourceSession !== false);
  } finally {
    process.stdout.write = originalWrite;
  }
}

function installStdoutCapture(write: (bytes: Buffer) => void): () => void {
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    const bytes = outputChunkToBuffer(chunk, encodingOrCallback);
    write(bytes);
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
  private totalBytes = 0;

  constructor(
    private readonly byteLimit: number,
    private readonly maxOutputCharacters: number,
  ) {}

  push(chunk: string | Uint8Array, encodingOrCallback: unknown): Buffer | undefined {
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? (encodingOrCallback as BufferEncoding) : 'utf8')
        : Buffer.from(chunk);
    this.totalBytes += bytes.length;
    this.addCharacters(this.decoder.write(bytes));
    if (this.overflowed) return bytes;
    this.chunks.push(bytes);
    if (this.totalBytes <= this.byteLimit) return undefined;
    this.overflowed = true;
    const complete = Buffer.concat(this.chunks);
    this.chunks.length = 0;
    return complete;
  }

  finish(): { bytes: Buffer; crossedPageBoundary: boolean } {
    this.addCharacters(this.decoder.end());
    const crossedPageBoundary = this.totalBytes > this.byteLimit;
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

class OutputSnapshotWriter {
  readonly snapshotId: string;
  private readonly temporaryPath: string;
  private readonly decoder = new StringDecoder('utf8');
  private readonly hash = createHash('sha256');
  private readonly pages: OutputSnapshotPage[] = [];
  private descriptor: number | null = null;
  private pending = '';
  private firstPageContent = '';
  private totalCharacters = 0;
  private pageCharacterOffset = 0;
  private byteLength = 0;
  private reservedBytes = 0;
  private opened = false;
  private finished = false;

  constructor(
    private readonly invocationHash: string,
    private readonly invocationPrefix: readonly string[],
    private readonly command: string,
    private readonly cwd: string,
    private readonly argv: readonly string[],
    private readonly pageSize: number,
    private readonly maxOutputCharacters: number,
    private readonly pageContentByteLimit: number,
    private readonly snapshotRoot: string,
    private readonly limits: OutputSnapshotLimits,
    private readonly maxPages: number,
    private readonly preferLineBoundaries: boolean,
    private readonly overflowMessage = outputSafetyLimitMessage(maxOutputCharacters, false),
  ) {
    ensureOutputSnapshotRoot(snapshotRoot);
    do {
      this.snapshotId = randomBytes(9).toString('base64url');
    } while (this.snapshotId.startsWith('-'));
    this.temporaryPath = outputSnapshotPath(snapshotRoot, this.snapshotId, 'tmp');
  }

  write(bytes: Buffer): void {
    if (this.finished) throw new Error('Output snapshot writer is closed.');
    this.appendDecoded(this.decoder.write(bytes));
  }

  complete(): {
    content: string;
    totalCharacters: number;
    outputHash: string;
    pageCount: number;
    snapshotId?: string;
  } {
    if (this.finished) throw new Error('Output snapshot writer is closed.');
    this.appendDecoded(this.decoder.end());
    this.finished = true;
    if (!this.opened) {
      const content = this.pending;
      const bytes = Buffer.from(content);
      this.assertWithinByteLimit(bytes.length);
      this.hash.update(bytes);
      this.pending = '';
      return {
        content,
        totalCharacters: this.totalCharacters,
        outputHash: this.hash.digest('hex'),
        pageCount: 1,
      };
    }
    if (this.pending.length > 0 || this.pages.length === 0) {
      this.flushPage(this.pending);
      this.pending = '';
    }
    if (this.descriptor === null) throw new Error('Output snapshot writer is not open.');
    closeSync(this.descriptor);
    this.descriptor = null;
    const outputHash = this.hash.digest('hex');
    const outputPath = outputSnapshotPath(this.snapshotRoot, this.snapshotId, 'output');
    const metadataPath = outputSnapshotPath(this.snapshotRoot, this.snapshotId, 'json');
    try {
      renameSync(this.temporaryPath, outputPath);
      const metadata: OutputSnapshotMetadata = {
        version: OUTPUT_SNAPSHOT_VERSION,
        snapshotId: this.snapshotId,
        invocationHash: this.invocationHash,
        invocationPrefix: [...this.invocationPrefix],
        command: this.command,
        cwd: this.cwd,
        argv: [...this.argv],
        outputHash,
        pageSize: this.pageSize,
        pages: this.pages,
        totalCharacters: this.totalCharacters,
        byteLength: this.byteLength,
        createdAtMs: Date.now(),
      };
      writeJsonAtomic(metadataPath, metadata);
      updateOutputReservation(this.snapshotRoot, this.snapshotId, this.byteLength, 'complete', this.limits);
      this.reservedBytes = this.byteLength;
      return {
        content: this.firstPageContent,
        totalCharacters: this.totalCharacters,
        outputHash,
        pageCount: this.pages.length,
        snapshotId: this.snapshotId,
      };
    } catch (error) {
      removeOutputSnapshot(this.snapshotId, this.snapshotRoot);
      throw error;
    }
  }

  abort(): void {
    if (this.descriptor !== null) {
      closeSync(this.descriptor);
      this.descriptor = null;
    }
    this.finished = true;
    removeOutputSnapshot(this.snapshotId, this.snapshotRoot);
  }

  private appendDecoded(value: string): void {
    if (value.length === 0) return;
    const nextTotal = this.totalCharacters + value.length;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > this.maxOutputCharacters) {
      throw new Error(this.overflowMessage);
    }
    this.totalCharacters = nextTotal;
    this.pending += value;
    this.assertWithinByteLimit(this.byteLength + Buffer.byteLength(this.pending));
    while (this.pending.length > this.pageSize || Buffer.byteLength(this.pending) > this.pageContentByteLimit) {
      this.open();
      const pageEnd = outputPageEnd(this.pending, this.pageSize, this.pageContentByteLimit, this.preferLineBoundaries);
      const page = this.pending.slice(0, pageEnd);
      this.pending = this.pending.slice(pageEnd);
      this.flushPage(page);
    }
  }

  private open(): void {
    if (this.opened) return;
    reserveOutputSnapshot(this.snapshotRoot, this.snapshotId, 0, this.limits);
    try {
      this.descriptor = openSync(this.temporaryPath, 'wx', 0o600);
      this.opened = true;
    } catch (error) {
      releaseOutputReservation(this.snapshotRoot, this.snapshotId);
      throw error;
    }
  }

  private flushPage(content: string): void {
    if (this.descriptor === null) throw new Error('Output snapshot writer is not open.');
    if (this.pages.length >= this.maxPages) {
      throw new Error(
        `Command output requires more than ${this.maxPages} snapshot pages. Retry with a larger --output-page-size, narrow the query, or use --json --json-output <path>.`,
      );
    }
    const bytes = Buffer.from(content);
    const nextByteLength = this.byteLength + bytes.length;
    this.assertWithinByteLimit(nextByteLength);
    if (nextByteLength > this.reservedBytes) {
      const nextReservation = Math.min(
        this.limits.maxSnapshotBytes,
        Math.ceil(nextByteLength / OUTPUT_RESERVATION_CHUNK_BYTES) * OUTPUT_RESERVATION_CHUNK_BYTES,
      );
      updateOutputReservation(this.snapshotRoot, this.snapshotId, nextReservation, 'active', this.limits);
      this.reservedBytes = nextReservation;
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(this.descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('Output snapshot write made no progress.');
      offset += written;
    }
    const page: OutputSnapshotPage = {
      characterOffset: this.pageCharacterOffset,
      characterLength: content.length,
      byteOffset: this.byteLength,
      byteLength: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'),
    };
    if (this.pages.length === 0) this.firstPageContent = content;
    this.pages.push(page);
    this.hash.update(bytes);
    this.pageCharacterOffset += content.length;
    this.byteLength = nextByteLength;
  }

  private assertWithinByteLimit(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes > this.limits.maxSnapshotBytes) {
      throw new Error(
        `Command output exceeds the ${this.limits.maxSnapshotBytes}-byte snapshot limit. Narrow the query before retrying.`,
      );
    }
  }
}

function captureOutputSnapshotPage(
  cursor: OutputCursorPayload,
  expectedInvocationHash: string,
  pageSize: number,
  maxOutputCharacters: number,
  snapshotRoot: string,
  onRead?: (bytes: number) => void,
): {
  content: string;
  offset: number;
  pageIndex: number;
  pageCount: number;
  totalCharacters: number;
  outputHash: string;
} {
  ensureOutputSnapshotRoot(snapshotRoot);
  const metadata = readOutputSnapshotMetadata(cursor.snapshotId, snapshotRoot);
  if (metadata.invocationHash !== expectedInvocationHash) {
    throw new Error(
      'This output cursor belongs to a different command, working directory, or argument set. Run again without --output-cursor.',
    );
  }
  if (
    metadata.snapshotId !== cursor.snapshotId ||
    (cursor.version === 3 &&
      (metadata.invocationHash !== cursor.invocationHash || metadata.outputHash !== cursor.outputHash))
  ) {
    throw new Error('Output snapshot identity does not match this cursor.');
  }
  if (metadata.pageSize !== pageSize || (cursor.version === 3 && cursor.pageSize !== pageSize)) {
    throw new Error(`Output page size changed after this cursor was issued; use ${metadata.pageSize}.`);
  }
  const page = metadata.pages[cursor.pageIndex];
  if (!page) throw new Error('Output cursor points past the current result.');
  if (metadata.totalCharacters > maxOutputCharacters) {
    throw new Error(`Output snapshot exceeds the ${maxOutputCharacters}-character safety limit.`);
  }
  if (Date.now() - metadata.createdAtMs > OUTPUT_SNAPSHOT_TTL_MS) {
    removeOutputSnapshot(cursor.snapshotId, snapshotRoot);
    throw new Error('Output snapshot expired before all pages were read.');
  }

  const path = outputSnapshotPath(snapshotRoot, cursor.snapshotId, 'output');
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== metadata.byteLength) {
      throw new Error('Output snapshot size or type changed.');
    }
    const bytes = Buffer.allocUnsafe(page.byteLength);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const count = readSync(descriptor, bytes, bytesRead, bytes.length - bytesRead, page.byteOffset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
      onRead?.(count);
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      bytesRead !== page.byteLength
    ) {
      throw new Error('Output snapshot changed while it was being read.');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== page.hash) {
      throw new Error('Output snapshot page no longer matches its metadata.');
    }
    const content = bytes.toString('utf8');
    if (content.length !== page.characterLength) throw new Error('Output snapshot page character count changed.');
    return {
      content,
      offset: page.characterOffset,
      pageIndex: cursor.pageIndex,
      pageCount: metadata.pages.length,
      totalCharacters: metadata.totalCharacters,
      outputHash: metadata.outputHash,
    };
  } catch (error) {
    removeOutputSnapshot(cursor.snapshotId, snapshotRoot);
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function readOutputSnapshotMetadata(snapshotId: string, snapshotRoot: string): OutputSnapshotMetadata {
  if (!isOutputSnapshotId(snapshotId)) throw new Error('Output snapshot identifier is invalid.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readSmallArtifactText(outputSnapshotPath(snapshotRoot, snapshotId, 'json'), 'output snapshot metadata'),
    );
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
    isOutputSnapshotId(metadata.snapshotId) &&
    isSha256Hex(metadata.invocationHash) &&
    isInvocationPrefix(metadata.invocationPrefix) &&
    typeof metadata.command === 'string' &&
    metadata.command.length > 0 &&
    metadata.command.length <= 256 &&
    typeof metadata.cwd === 'string' &&
    metadata.cwd.length > 0 &&
    metadata.cwd.length <= 8_192 &&
    isInvocationArgv(metadata.argv) &&
    hashInvocation(metadata.command, metadata.cwd, metadata.invocationPrefix, metadata.argv) ===
      metadata.invocationHash &&
    isSha256Hex(metadata.outputHash) &&
    Number.isSafeInteger(metadata.pageSize) &&
    (metadata.pageSize ?? 0) >= MIN_OUTPUT_PAGE_SIZE &&
    (metadata.pageSize ?? 0) <= MAX_OUTPUT_PAGE_SIZE &&
    Array.isArray(metadata.pages) &&
    metadata.pages.length > 1 &&
    metadata.pages.length <= MAX_OUTPUT_SNAPSHOT_PAGES &&
    metadata.pages.every(isOutputSnapshotPage) &&
    pagesAreContiguous(metadata.pages) &&
    Number.isSafeInteger(metadata.totalCharacters) &&
    (metadata.totalCharacters ?? -1) >= 0 &&
    metadata.pages.reduce((total, page) => total + page.characterLength, 0) === metadata.totalCharacters &&
    Number.isSafeInteger(metadata.byteLength) &&
    (metadata.byteLength ?? -1) >= 0 &&
    metadata.pages.reduce((total, page) => total + page.byteLength, 0) === metadata.byteLength &&
    Number.isSafeInteger(metadata.createdAtMs) &&
    (metadata.createdAtMs ?? -1) >= 0
  );
}

function isOutputSnapshotPage(value: unknown): value is OutputSnapshotPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Partial<OutputSnapshotPage>;
  return (
    Number.isSafeInteger(page.characterOffset) &&
    (page.characterOffset ?? -1) >= 0 &&
    Number.isSafeInteger(page.characterLength) &&
    (page.characterLength ?? 0) > 0 &&
    Number.isSafeInteger(page.byteOffset) &&
    (page.byteOffset ?? -1) >= 0 &&
    Number.isSafeInteger(page.byteLength) &&
    (page.byteLength ?? 0) > 0 &&
    isSha256Hex(page.hash)
  );
}

function pagesAreContiguous(pages: readonly OutputSnapshotPage[]): boolean {
  let characterOffset = 0;
  let byteOffset = 0;
  for (const page of pages) {
    if (page.characterOffset !== characterOffset || page.byteOffset !== byteOffset) return false;
    characterOffset += page.characterLength;
    byteOffset += page.byteLength;
  }
  return true;
}

function ensureOutputSnapshotRoot(snapshotRoot: string): void {
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const stat = lstatSync(snapshotRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Output snapshot root is not a private directory: ${snapshotRoot}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Output snapshot root is not owned by the current user: ${snapshotRoot}`);
  }
  if (process.platform !== 'win32') chmodSync(snapshotRoot, 0o700);
}

function resolveOutputSnapshotLimits(overrides: Partial<OutputSnapshotLimits> | undefined): OutputSnapshotLimits {
  const resolved = { ...DEFAULT_OUTPUT_SNAPSHOT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Output snapshot ${name} must be a positive integer.`);
  }
  if (resolved.maxSnapshotBytes > resolved.maxAggregateBytes) {
    throw new Error('Output snapshot maxSnapshotBytes cannot exceed maxAggregateBytes.');
  }
  return resolved;
}

function reserveOutputSnapshot(
  snapshotRoot: string,
  snapshotId: string,
  reservedBytes: number,
  limits: OutputSnapshotLimits,
): void {
  withOutputQuotaLock(snapshotRoot, () => {
    pruneAbandonedOutputSnapshots(snapshotRoot);
    writeOutputReservation(snapshotRoot, snapshotId, reservedBytes, 'active', limits);
  });
}

function updateOutputReservation(
  snapshotRoot: string,
  snapshotId: string,
  reservedBytes: number,
  state: OutputSnapshotReservation['state'],
  limits: OutputSnapshotLimits,
): void {
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > limits.maxSnapshotBytes) {
    throw new Error(`Command output exceeds the ${limits.maxSnapshotBytes}-byte snapshot limit.`);
  }
  withOutputQuotaLock(snapshotRoot, () => {
    writeOutputReservation(snapshotRoot, snapshotId, reservedBytes, state, limits);
  });
}

function writeOutputReservation(
  snapshotRoot: string,
  snapshotId: string,
  reservedBytes: number,
  state: OutputSnapshotReservation['state'],
  limits: OutputSnapshotLimits,
): void {
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > limits.maxSnapshotBytes) {
    throw new Error(`Command output exceeds the ${limits.maxSnapshotBytes}-byte snapshot limit.`);
  }
  const reservations = readOutputReservations(snapshotRoot);
  const current = reservations.find((reservation) => reservation.snapshotId === snapshotId);
  const aggregateBytes =
    reservations.reduce((total, reservation) => total + reservation.reservedBytes, 0) -
    (current?.reservedBytes ?? 0) +
    reservedBytes;
  const snapshotCount = reservations.length + (current ? 0 : 1);
  if (snapshotCount > limits.maxSnapshotCount || aggregateBytes > limits.maxAggregateBytes) {
    throw new Error(
      `Output snapshot capacity is full (${snapshotCount}/${limits.maxSnapshotCount} snapshots, ${aggregateBytes}/${limits.maxAggregateBytes} bytes). Narrow the query or finish an existing pagination sequence before retrying.`,
    );
  }
  const nowMs = Date.now();
  const reservation: OutputSnapshotReservation = {
    version: OUTPUT_RESERVATION_VERSION,
    snapshotId,
    pid: process.pid,
    ...(currentOutputProcessIdentity() ? { processIdentity: currentOutputProcessIdentity()! } : {}),
    reservedBytes,
    state,
    createdAtMs: current?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
  };
  writeJsonAtomic(outputSnapshotPath(snapshotRoot, snapshotId, 'reserve'), reservation);
}

function releaseOutputReservation(snapshotRoot: string, snapshotId: string): void {
  withOutputQuotaLock(snapshotRoot, () => {
    rmSync(outputSnapshotPath(snapshotRoot, snapshotId, 'reserve'), { force: true });
  });
}

function readOutputReservations(snapshotRoot: string): OutputSnapshotReservation[] {
  const reservations: OutputSnapshotReservation[] = [];
  for (const entry of readdirSync(snapshotRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.reserve')) continue;
    const snapshotId = entry.name.slice(0, -'.reserve'.length);
    if (!isOutputSnapshotId(snapshotId)) continue;
    try {
      const parsed = JSON.parse(
        readSmallArtifactText(join(snapshotRoot, entry.name), 'output snapshot reservation'),
      ) as unknown;
      if (!isOutputSnapshotReservation(parsed) || parsed.snapshotId !== snapshotId) {
        throw new Error('reservation identity is invalid');
      }
      reservations.push(parsed);
    } catch (error) {
      throw new Error(
        `Output snapshot reservation ${entry.name} is invalid; retry after its owning process or snapshot expires.`,
        { cause: error },
      );
    }
  }
  return reservations;
}

function isOutputSnapshotReservation(value: unknown): value is OutputSnapshotReservation {
  if (!value || typeof value !== 'object') return false;
  const reservation = value as Partial<OutputSnapshotReservation>;
  return (
    reservation.version === OUTPUT_RESERVATION_VERSION &&
    typeof reservation.snapshotId === 'string' &&
    isOutputSnapshotId(reservation.snapshotId) &&
    Number.isSafeInteger(reservation.pid) &&
    (reservation.pid ?? 0) > 0 &&
    (reservation.processIdentity === undefined ||
      (parseProcessIdentity(reservation.processIdentity) !== null &&
        reservation.processIdentity.pid === reservation.pid)) &&
    Number.isSafeInteger(reservation.reservedBytes) &&
    (reservation.reservedBytes ?? -1) >= 0 &&
    (reservation.state === 'active' || reservation.state === 'complete') &&
    Number.isSafeInteger(reservation.createdAtMs) &&
    Number.isSafeInteger(reservation.updatedAtMs)
  );
}

function pruneAbandonedOutputSnapshots(snapshotRoot: string): void {
  const nowMs = Date.now();
  for (const entry of readdirSync(snapshotRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.reserve')) continue;
    const snapshotId = entry.name.slice(0, -'.reserve'.length);
    if (!isOutputSnapshotId(snapshotId)) continue;
    let reservation: OutputSnapshotReservation | null = null;
    try {
      const parsed = JSON.parse(
        readSmallArtifactText(join(snapshotRoot, entry.name), 'output snapshot reservation'),
      ) as unknown;
      reservation = isOutputSnapshotReservation(parsed) ? parsed : null;
    } catch {
      reservation = null;
    }
    const metadataExists = fileExists(outputSnapshotPath(snapshotRoot, snapshotId, 'json'));
    const activeOwner =
      reservation?.state === 'active' &&
      isProcessAlive(reservation.pid) &&
      (reservation.processIdentity === undefined ||
        (() => {
          const actual = readProcessIdentity(reservation.pid);
          return actual !== null && sameProcessIdentity(reservation.processIdentity!, actual);
        })());
    const expired = reservation ? nowMs - reservation.updatedAtMs > OUTPUT_SNAPSHOT_TTL_MS : false;
    if (activeOwner || (metadataExists && !expired)) continue;
    if (!metadataExists && reservation && !expired && reservation.state === 'complete') continue;
    removeOutputSnapshotFiles(snapshotId, snapshotRoot);
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function withOutputQuotaLock<T>(snapshotRoot: string, action: () => T): T {
  ensureOutputSnapshotRoot(snapshotRoot);
  const lockPath = join(snapshotRoot, OUTPUT_QUOTA_LOCK_NAME);
  const deadlineAtMs = Date.now() + OUTPUT_QUOTA_LOCK_WAIT_MS;
  while (true) {
    const result = tryAcquireProcessFileLock(lockPath, {
      kind: 'output-snapshot-quota',
      processIdentity: currentOutputProcessIdentity(),
    });
    if (result.kind === 'acquired') {
      try {
        return action();
      } finally {
        result.lock.release();
      }
    }
    if (Date.now() >= deadlineAtMs) {
      throw new Error('Output snapshot quota is busy. Retry the command.');
    }
    Atomics.wait(OUTPUT_QUOTA_WAIT_BUFFER, 0, 0, OUTPUT_QUOTA_LOCK_RETRY_MS);
  }
}

function currentOutputProcessIdentity(): ProcessIdentity | null {
  if (outputProcessIdentity === undefined) outputProcessIdentity = readProcessIdentity(process.pid);
  return outputProcessIdentity;
}

function removeOutputSnapshot(snapshotId: string, snapshotRoot: string): void {
  if (!isOutputSnapshotId(snapshotId)) return;
  withOutputQuotaLock(snapshotRoot, () => removeOutputSnapshotFiles(snapshotId, snapshotRoot));
}

function removeOutputSnapshotFiles(snapshotId: string, snapshotRoot: string): void {
  for (const extension of ['json', 'output', 'tmp', 'reserve'] as const) {
    rmSync(outputSnapshotPath(snapshotRoot, snapshotId, extension), { force: true });
  }
}

function outputSnapshotPath(
  snapshotRoot: string,
  snapshotId: string,
  extension: 'json' | 'output' | 'tmp' | 'reserve',
): string {
  if (!isOutputSnapshotId(snapshotId)) throw new Error('Output snapshot identifier is invalid.');
  return join(snapshotRoot, `${snapshotId}.${extension}`);
}

function requireSnapshotId(value: string | undefined): string {
  if (!value) throw new Error('Incomplete output did not create a resumable snapshot.');
  return value;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function outputPageEnd(
  content: string,
  pageSize: number,
  pageContentByteLimit: number,
  preferLineBoundaries: boolean,
): number {
  let boundedEnd = Math.min(content.length, pageSize);
  if (isHighSurrogate(content.charCodeAt(boundedEnd - 1))) boundedEnd -= 1;
  if (Buffer.byteLength(content.slice(0, boundedEnd)) > pageContentByteLimit) {
    let lower = 0;
    let upper = boundedEnd;
    while (lower < upper) {
      const candidate = Math.ceil((lower + upper) / 2);
      if (Buffer.byteLength(content.slice(0, candidate)) <= pageContentByteLimit) {
        lower = candidate;
      } else {
        upper = candidate - 1;
      }
    }
    boundedEnd = lower;
    if (isHighSurrogate(content.charCodeAt(boundedEnd - 1))) boundedEnd -= 1;
  }
  if (boundedEnd <= 0) {
    throw new Error('Output page byte limit cannot contain one UTF-8 character.');
  }
  if (preferLineBoundaries) {
    const newline = content.lastIndexOf('\n', boundedEnd - 1);
    if (newline >= 0) return newline + 1;
  }
  return boundedEnd;
}

function createContinuation(input: {
  invocationPrefix: readonly string[];
  nextPageIndex: number;
  snapshotId: string;
}): { cursor: string; command: string } {
  const cursor = encodeOutputCursor({
    pageIndex: input.nextPageIndex,
    snapshotId: input.snapshotId,
  });
  return {
    cursor,
    command: renderContinuationCommand(input.invocationPrefix, cursor),
  };
}

function pageContentByteLimit(
  options: Pick<CliOutputPaginationOptions, 'command' | 'json' | 'producerVersion'>,
  invocationPrefix: readonly string[],
): number {
  const cursor = 'c'.repeat(64);
  const continuation = {
    cursor,
    command: renderContinuationCommand(invocationPrefix, cursor),
  };
  if (!options.json) {
    const digits = '9'.repeat(String(MAX_TRACKED_OUTPUT_CHARACTERS).length);
    const wrapper =
      `[scip-query output page: characters ${digits}-${digits} of ${digits}]\n` +
      `\n[Incomplete: ${digits} characters remain. Continue exactly:\n${continuation.command}]\n`;
    return pageContentBudgetAfterWrapper(HUMAN_OUTPUT_PAGE_CONTENT_BYTES, Buffer.byteLength(wrapper), 1);
  }
  const envelope: CliOutputPageEnvelopeV1 = {
    kind: CLI_OUTPUT_PAGE_KIND,
    schemaVersion: CLI_OUTPUT_PAGE_SCHEMA_VERSION,
    producer: { name: 'scip-query', version: options.producerVersion },
    command: options.command,
    contentType: 'application/json',
    agentInstruction:
      'INCOMPLETE EVIDENCE: do not draw conclusions or report completion from this partial page. Run page.continuation.command exactly, then repeat until page.complete is true.',
    page: {
      offset: MAX_TRACKED_OUTPUT_CHARACTERS,
      returnedCharacters: MAX_TRACKED_OUTPUT_CHARACTERS,
      totalCharacters: MAX_TRACKED_OUTPUT_CHARACTERS,
      omittedCharacters: MAX_TRACKED_OUTPUT_CHARACTERS,
      remainingCharacters: MAX_TRACKED_OUTPUT_CHARACTERS,
      complete: false,
      outputHash: 'f'.repeat(64),
      continuation,
    },
    content: '',
  };
  const wrapperBytes = Buffer.byteLength(`${JSON.stringify(envelope)}\n`);
  return pageContentBudgetAfterWrapper(JSON_OUTPUT_PAGE_CONTENT_BYTES, wrapperBytes, 2);
}

function pageContentBudgetAfterWrapper(maximum: number, wrapperBytes: number, escapingMultiplier: number): number {
  const available = Math.floor((CLIENT_SAFE_OUTPUT_BYTES - wrapperBytes) / escapingMultiplier);
  if (available < MIN_OUTPUT_PAGE_SIZE) {
    throw new Error(
      `The command invocation leaves fewer than ${MIN_OUTPUT_PAGE_SIZE} bytes for client-safe output content. Use a shorter executable path.`,
    );
  }
  return Math.min(maximum, available);
}

function encodeOutputCursor(payload: Omit<ShortOutputCursorPayload, 'version'>): string {
  if (SHORT_OUTPUT_SNAPSHOT_ID.test(payload.snapshotId)) {
    return payload.pageIndex === 1 ? payload.snapshotId : `${payload.snapshotId}.${payload.pageIndex.toString(36)}`;
  }
  return `4.${snapshotIdToCursorToken(payload.snapshotId)}.${payload.pageIndex.toString(36)}`;
}

function decodeOutputCursor(cursor: string, expectedInvocationHash: string): OutputCursorPayload {
  const parsed = parseOutputCursor(cursor);
  if (!parsed) {
    throw new Error('Invalid output cursor. Run the command again without --output-cursor.');
  }
  if (parsed.version === 3 && parsed.invocationHash !== expectedInvocationHash) {
    throw new Error(
      'This output cursor belongs to a different command, working directory, or argument set. Run again without --output-cursor.',
    );
  }
  return parsed;
}

function parseOutputCursor(cursor: string): OutputCursorPayload | null {
  const short = SHORT_OUTPUT_CURSOR.exec(cursor);
  if (short) {
    const encodedPageIndex = short[2] ?? '1';
    const pageIndex = Number.parseInt(encodedPageIndex, 36);
    if (Number.isSafeInteger(pageIndex) && pageIndex >= 1 && pageIndex.toString(36) === encodedPageIndex) {
      return { version: 4, pageIndex, snapshotId: short[1]! };
    }
    return null;
  }
  const uuid = UUID_OUTPUT_CURSOR.exec(cursor);
  if (uuid) {
    const snapshotId = cursorTokenToSnapshotId(uuid[1]!);
    const pageIndex = Number.parseInt(uuid[2]!, 36);
    if (snapshotId && Number.isSafeInteger(pageIndex) && pageIndex >= 1 && pageIndex.toString(36) === uuid[2]) {
      return { version: 4, pageIndex, snapshotId };
    }
    return null;
  }
  // Version 3 embedded snapshot validation data in a large base64url JSON
  // token. Keep reading it until every cursor issued by an older binary has
  // exceeded the one-hour snapshot TTL.
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return isLegacyOutputCursorPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a cursor found in one provider transcript without reading output
 * content. Missing, completed, expired, or incompatible snapshots are not
 * resumable and therefore return undefined.
 */
export function inspectPendingCliOutputCursor(
  cursor: string,
  snapshotRoot = outputSnapshotRoot(),
): PendingCliOutputSnapshot | undefined {
  const parsed = parseOutputCursor(cursor);
  if (!parsed) return undefined;
  try {
    const metadata = readOutputSnapshotMetadata(parsed.snapshotId, snapshotRoot);
    if (
      metadata.snapshotId !== parsed.snapshotId ||
      (parsed.version === 3 &&
        (metadata.invocationHash !== parsed.invocationHash ||
          metadata.outputHash !== parsed.outputHash ||
          metadata.pageSize !== parsed.pageSize)) ||
      Date.now() - metadata.createdAtMs > OUTPUT_SNAPSHOT_TTL_MS ||
      !metadata.pages[parsed.pageIndex]
    ) {
      return undefined;
    }
    const page = metadata.pages[parsed.pageIndex]!;
    return {
      snapshotId: metadata.snapshotId,
      pageIndex: parsed.pageIndex,
      command: metadata.command,
      cwd: metadata.cwd,
      continuationCommand: renderContinuationCommand(metadata.invocationPrefix, cursor),
      remainingCharacters: metadata.totalCharacters - page.characterOffset,
      totalCharacters: metadata.totalCharacters,
      outputHash: metadata.outputHash,
      createdAtMs: metadata.createdAtMs,
    };
  } catch {
    return undefined;
  }
}

function isLegacyOutputCursorPayload(value: unknown): value is LegacyOutputCursorPayload {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<LegacyOutputCursorPayload>;
  return (
    cursor.version === 3 &&
    isSha256Hex(cursor.invocationHash) &&
    Number.isSafeInteger(cursor.pageIndex) &&
    (cursor.pageIndex ?? -1) >= 1 &&
    Number.isSafeInteger(cursor.pageSize) &&
    (cursor.pageSize ?? 0) >= MIN_OUTPUT_PAGE_SIZE &&
    (cursor.pageSize ?? 0) <= MAX_OUTPUT_PAGE_SIZE &&
    isSha256Hex(cursor.outputHash) &&
    typeof cursor.snapshotId === 'string' &&
    isOutputSnapshotId(cursor.snapshotId)
  );
}

function snapshotIdToCursorToken(snapshotId: string): string {
  if (!LEGACY_OUTPUT_SNAPSHOT_ID.test(snapshotId)) throw new Error('Output snapshot identifier is invalid.');
  return Buffer.from(snapshotId.replaceAll('-', ''), 'hex').toString('base64url');
}

function cursorTokenToSnapshotId(token: string): string | null {
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 16) return null;
  const hex = bytes.toString('hex');
  const snapshotId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return LEGACY_OUTPUT_SNAPSHOT_ID.test(snapshotId) ? snapshotId : null;
}

function isOutputSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && (SHORT_OUTPUT_SNAPSHOT_ID.test(value) || LEGACY_OUTPUT_SNAPSHOT_ID.test(value));
}

function hashInvocation(
  command: string,
  cwd: string,
  invocationPrefix: readonly string[],
  argv: readonly string[],
): string {
  return createHash('sha256').update(JSON.stringify({ command, cwd, invocationPrefix, argv })).digest('hex');
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

function withoutRawJsonArg(argv: readonly string[]): string[] {
  return argv.filter((argument) => argument !== '--raw-json' && argument !== '--raw-json=true');
}

function renderInitialPageCommand(
  invocationPrefix: readonly string[],
  argv: readonly string[],
  pageSize: number,
): string {
  return shellJoin([...invocationPrefix, ...argv, '--output-page-size', String(pageSize)]);
}

function renderContinuationCommand(invocationPrefix: readonly string[], cursor: string): string {
  return shellJoin([...invocationPrefix, CLI_OUTPUT_CONTINUATION_COMMAND, cursor]);
}

function normalizeInvocationPrefix(value: readonly string[] | undefined): string[] {
  const prefix = value === undefined ? ['scip-query'] : [...value];
  if (!isInvocationPrefix(prefix)) {
    throw new Error('Output pagination invocation prefix must contain one to sixteen non-empty shell arguments.');
  }
  return prefix;
}

function isInvocationPrefix(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every(
      (part) =>
        typeof part === 'string' &&
        part.length > 0 &&
        part.length <= 2_048 &&
        !part.includes('\0') &&
        !part.includes('\r') &&
        !part.includes('\n'),
    )
  );
}

function isInvocationArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 256 &&
    value.every(
      (part) =>
        typeof part === 'string' &&
        part.length <= 8_192 &&
        !part.includes('\0') &&
        !part.includes('\r') &&
        !part.includes('\n'),
    )
  );
}

function shellJoin(args: readonly string[]): string {
  return args.map((argument) => quoteShellArgument(argument, { omitSafeQuotes: true })).join(' ');
}

function renderHumanOutputPage(envelope: CliOutputPageEnvelopeV1): string {
  const continuation = envelope.page.continuation;
  const pageEnd = Math.max(envelope.page.offset, envelope.page.offset + envelope.page.returnedCharacters - 1);
  const header = `[scip-query output page: characters ${envelope.page.offset}-${pageEnd} of ${envelope.page.totalCharacters}]\n`;
  const footer = continuation
    ? `\n[Incomplete: ${envelope.page.remainingCharacters} characters remain. Continue exactly:\n${continuation.command}]\n`
    : '\n[scip-query transport complete; evaluate command coverage separately]\n';
  return `${header}${envelope.content}${footer}`;
}
