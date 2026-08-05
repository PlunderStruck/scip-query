import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { tryAcquireProcessFileLock, type ProcessFileLock } from '../platform/process-file-lock.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { displayLine, displayPathRange } from './render.js';

const SOURCE_EMISSION_LEDGER_VERSION = 1;
const SOURCE_EMISSION_SESSION_ENV = 'SCIP_QUERY_SESSION';
const SOURCE_EMISSION_ROOT_ENV = 'SCIP_QUERY_SESSION_DIR';
const MAX_SESSION_NAME_CHARACTERS = 128;

interface PersistedSourceRange {
  relativePath: string;
  startLine: number;
  endLine: number;
  ordinal: number;
  command: string;
  ownerSymbol?: string;
}

interface SourceEmissionLedger {
  version: typeof SOURCE_EMISSION_LEDGER_VERSION;
  projectRoot: string;
  generationIdentity: string;
  sessionIdentity: string;
  nextOrdinal: number;
  updatedAt: string;
  ranges: PersistedSourceRange[];
}

interface StagedSourceRange {
  relativePath: string;
  startLine: number;
  endLine: number;
  ownerSymbol?: string;
}

interface SourceEmissionInvocation {
  enabled: boolean;
  reemit: boolean;
  command: string;
  projectRoot: string;
  sessionIdentity?: string;
  generationIdentity?: string;
  state?: ActiveSourceEmissionSession | null;
  staged: StagedSourceRange[];
  finalized: boolean;
}

interface ActiveSourceEmissionSession {
  ledgerPath: string;
  lock: ProcessFileLock;
  ledger: SourceEmissionLedger;
}

interface CoveredSourceChunk {
  kind: 'covered';
  startLine: number;
  endLine: number;
  ordinal: number | null;
  command: string;
}

interface NewSourceChunk {
  kind: 'source';
  startLine: number;
  endLine: number;
  lines: string[];
}

type SourceChunk = CoveredSourceChunk | NewSourceChunk;

export interface SourceEmissionInvocationOptions {
  command: string;
  cwd: string;
  argv: readonly string[];
  json: boolean;
  sessionEnabled?: boolean;
  reemit?: boolean;
}

export interface SourceEvidenceRenderOptions {
  relativePath: string;
  startLine: number;
  source: string;
  /** Exact units always render whole; previews may cite a wholly prior-emitted window. */
  sessionPolicy?: 'exact-unit' | 'preview';
  focusLines?: ReadonlySet<number>;
  ownerSymbol?: string;
  headerSuffix?: string;
  afterHeader?: readonly string[];
  indent?: string;
  sourceIndent?: string;
  showFocusMarker?: boolean;
  lineNumberWidth?: number;
  blankAfterHeader?: boolean;
}

export interface SourceEmissionSessionSummary {
  enabled: boolean;
  reason?: string;
  uniqueLines: number;
  emissions: number;
  rows: string[];
}

const invocationStorage = new AsyncLocalStorage<SourceEmissionInvocation>();

/**
 * Binds one CLI invocation to source rendering state. Cross-command preview
 * suppression is opt-in via an explicit SCIP_QUERY_SESSION. Exact source units
 * are recorded for later preview citations but are never suppressed themselves.
 */
export function runWithSourceEmissionInvocation<T>(options: SourceEmissionInvocationOptions, run: () => T): T {
  const sessionIdentity =
    options.sessionEnabled === false || options.json ? undefined : resolveSourceEmissionSessionIdentity();
  const invocation: SourceEmissionInvocation = {
    enabled: sessionIdentity !== undefined,
    reemit: options.reemit === true,
    command: options.command,
    projectRoot: resolve(options.cwd),
    sessionIdentity,
    staged: [],
    finalized: false,
  };
  return invocationStorage.run(invocation, run);
}

/** Attach the immutable index generation after a database-backed command opens it. */
export function bindSourceEmissionGeneration(generationIdentity: string): void {
  const invocation = invocationStorage.getStore();
  if (!invocation || invocation.finalized) return;
  invocation.generationIdentity = generationIdentity;
}

/** Number of staged ranges, used to roll back speculative packet rendering. */
export function sourceEmissionCheckpoint(): number {
  return invocationStorage.getStore()?.staged.length ?? 0;
}

/** Forget source rendered speculatively but not written to stdout. */
export function rollbackSourceEmission(checkpoint: number): void {
  const invocation = invocationStorage.getStore();
  if (!invocation || checkpoint < 0 || checkpoint > invocation.staged.length) return;
  invocation.staged.length = checkpoint;
}

/**
 * Commit only after the complete captured output was delivered. Paged output
 * deliberately discards its staging because later pages have not yet reached
 * the agent; repeating evidence is safer than claiming unseen evidence.
 */
export function finalizeSourceEmission(deliveredCompleteOutput: boolean): void {
  const invocation = invocationStorage.getStore();
  if (!invocation || invocation.finalized) return;
  invocation.finalized = true;
  const active = invocation.state;
  if (!active) {
    invocation.staged.length = 0;
    return;
  }
  try {
    if (deliveredCompleteOutput && invocation.staged.length > 0) {
      const ordinal = active.ledger.nextOrdinal;
      const ranges = coalesceStagedRanges(invocation.staged).map(
        (range): PersistedSourceRange => ({
          ...range,
          ordinal,
          command: invocation.command,
        }),
      );
      active.ledger.ranges.push(...ranges);
      active.ledger.nextOrdinal += 1;
      active.ledger.updatedAt = new Date().toISOString();
      writeJsonAtomic(active.ledgerPath, active.ledger, { spacing: 2, trailingNewline: true });
    }
  } catch {
    // The ledger is an optimization. Failure must never suppress source or fail
    // the command whose evidence has already been delivered.
  } finally {
    active.lock.release();
    invocation.state = null;
    invocation.staged.length = 0;
  }
}

/**
 * Render citation-ready source. Exact units always remain coherent. A bounded
 * preview is cited only when its whole range was delivered by a prior command;
 * partially covered previews render whole rather than exposing source remnants.
 */
export function renderSourceEvidence(options: SourceEvidenceRenderOptions): string {
  const sourceLines = options.source.split('\n');
  if (sourceLines.length === 0) return '';
  const chunks = sourceChunks(
    options.relativePath,
    options.startLine,
    sourceLines,
    options.ownerSymbol,
    options.sessionPolicy ?? 'exact-unit',
  );
  const indent = options.indent ?? '  ';
  const sourceIndent = options.sourceIndent ?? '    ';
  const focusLines = options.focusLines ?? new Set<number>();
  return chunks
    .map((chunk) => {
      const range = displayPathRange(options.relativePath, chunk.startLine, chunk.endLine);
      if (chunk.kind === 'covered') {
        const origin = chunk.ordinal === null ? 'this command' : `session #${chunk.ordinal} via ${chunk.command}`;
        return [
          `${indent}${range}  [source previously emitted: ${origin}; not repeated]`,
          ...(options.afterHeader ?? []),
        ].join('\n');
      }
      const suffix = options.headerSuffix ?? '';
      const rendered = chunk.lines.map((line, index) => {
        const sourceLine = chunk.startLine + index;
        const marker = options.showFocusMarker === false ? '' : focusLines.has(sourceLine) ? '>' : ' ';
        const lineNumberWidth = options.lineNumberWidth ?? 5;
        return `${sourceIndent}${marker}${String(displayLine(sourceLine)).padStart(lineNumberWidth)}  ${line}`;
      });
      return [
        `${indent}${range}${suffix}`,
        ...(options.blankAfterHeader ? [''] : []),
        ...(options.afterHeader ?? []),
        ...rendered,
      ].join('\n');
    })
    .join('\n');
}

export function sourceEmissionSessionSummary(reset = false): SourceEmissionSessionSummary {
  const invocation = invocationStorage.getStore();
  if (!invocation?.enabled) {
    return {
      enabled: false,
      reason: 'No explicit SCIP_QUERY_SESSION is active; source packets render independently.',
      uniqueLines: 0,
      emissions: 0,
      rows: [],
    };
  }
  const active = activateSession(invocation);
  if (!active) {
    return {
      enabled: false,
      reason: 'The source-session ledger was unavailable or contended; source output is fail-open for this command.',
      uniqueLines: 0,
      emissions: 0,
      rows: [],
    };
  }
  if (reset) {
    active.ledger.ranges = [];
    active.ledger.nextOrdinal = 1;
    active.ledger.updatedAt = new Date().toISOString();
    try {
      writeJsonAtomic(active.ledgerPath, active.ledger, { spacing: 2, trailingNewline: true });
    } catch {
      return {
        enabled: false,
        reason: 'The source-session ledger could not be reset; source output remains fail-open.',
        uniqueLines: 0,
        emissions: 0,
        rows: [],
      };
    }
  }
  const byOrdinal = new Map<number, PersistedSourceRange[]>();
  for (const range of active.ledger.ranges) {
    const ranges = byOrdinal.get(range.ordinal) ?? [];
    ranges.push(range);
    byOrdinal.set(range.ordinal, ranges);
  }
  const rows = [...byOrdinal.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ordinal, ranges]) => {
      const command = ranges[0]?.command ?? 'unknown';
      const citations = ranges
        .slice(0, 8)
        .map((range) => displayPathRange(range.relativePath, range.startLine, range.endLine))
        .join(', ');
      const omitted = ranges.length > 8 ? `, ... ${ranges.length - 8} more range(s)` : '';
      return `  #${ordinal} ${command}: ${citations}${omitted}`;
    });
  return {
    enabled: true,
    uniqueLines: uniqueCoveredLineCount(active.ledger.ranges),
    emissions: byOrdinal.size,
    rows,
  };
}

function sourceChunks(
  relativePath: string,
  startLine: number,
  sourceLines: readonly string[],
  ownerSymbol: string | undefined,
  sessionPolicy: 'exact-unit' | 'preview',
): SourceChunk[] {
  const invocation = invocationStorage.getStore();
  const endLine = startLine + sourceLines.length - 1;
  if (!invocation) {
    return [{ kind: 'source', startLine, endLine, lines: [...sourceLines] }];
  }
  const active = invocation.enabled ? activateSession(invocation) : null;
  const persisted = active?.ledger.ranges ?? [];
  const coverage = sourceLines.map((_, index) => coveringEmission(persisted, relativePath, startLine + index));
  const mayCitePriorPreview =
    sessionPolicy === 'preview' && !invocation.reemit && coverage.every((reference) => reference !== undefined);
  if (!mayCitePriorPreview) {
    invocation.staged.push({ relativePath, startLine, endLine, ownerSymbol });
    return [{ kind: 'source', startLine, endLine, lines: [...sourceLines] }];
  }
  const chunks: SourceChunk[] = [];
  let offset = 0;
  while (offset < sourceLines.length) {
    const reference = coverage[offset];
    let endOffset = offset;
    while (endOffset + 1 < sourceLines.length && sameCoverage(reference, coverage[endOffset + 1])) endOffset += 1;
    const chunkStart = startLine + offset;
    const chunkEnd = startLine + endOffset;
    chunks.push({
      kind: 'covered',
      startLine: chunkStart,
      endLine: chunkEnd,
      ordinal: reference!.ordinal,
      command: reference!.command,
    });
    offset = endOffset + 1;
  }
  return chunks;
}

function coveringEmission(
  persisted: readonly PersistedSourceRange[],
  relativePath: string,
  line: number,
): { ordinal: number | null; command: string } | undefined {
  const prior = persisted.find(
    (range) => range.relativePath === relativePath && range.startLine <= line && line <= range.endLine,
  );
  if (prior) return { ordinal: prior.ordinal, command: prior.command };
  return undefined;
}

function sameCoverage(
  left: { ordinal: number | null; command: string } | undefined,
  right: { ordinal: number | null; command: string } | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.ordinal === right.ordinal && left.command === right.command;
}

function activateSession(invocation: SourceEmissionInvocation): ActiveSourceEmissionSession | null {
  if (invocation.state !== undefined) return invocation.state;
  if (!invocation.sessionIdentity || !invocation.generationIdentity) {
    invocation.state = null;
    return null;
  }
  try {
    const root = sourceEmissionRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const id = createHash('sha256')
      .update(invocation.projectRoot)
      .update('\0')
      .update(invocation.generationIdentity)
      .update('\0')
      .update(invocation.sessionIdentity)
      .digest('hex');
    const ledgerPath = join(root, `${id}.json`);
    const lockResult = tryAcquireProcessFileLock(`${ledgerPath}.lock`, {
      kind: 'source-emission-session',
      detail: { session: id.slice(0, 12) },
    });
    if (lockResult.kind !== 'acquired') {
      invocation.state = null;
      return null;
    }
    let ledger: SourceEmissionLedger;
    try {
      ledger = existsSync(ledgerPath)
        ? parseLedger(JSON.parse(readSmallArtifactText(ledgerPath, 'source emission session ledger')), {
            projectRoot: invocation.projectRoot,
            generationIdentity: invocation.generationIdentity,
            sessionIdentity: invocation.sessionIdentity,
          })
        : emptyLedger(invocation);
    } catch {
      lockResult.lock.release();
      invocation.state = null;
      return null;
    }
    invocation.state = { ledgerPath, lock: lockResult.lock, ledger };
    return invocation.state;
  } catch {
    invocation.state = null;
    return null;
  }
}

function emptyLedger(invocation: SourceEmissionInvocation): SourceEmissionLedger {
  return {
    version: SOURCE_EMISSION_LEDGER_VERSION,
    projectRoot: invocation.projectRoot,
    generationIdentity: invocation.generationIdentity!,
    sessionIdentity: invocation.sessionIdentity!,
    nextOrdinal: 1,
    updatedAt: new Date().toISOString(),
    ranges: [],
  };
}

function parseLedger(
  value: unknown,
  expected: Pick<SourceEmissionLedger, 'projectRoot' | 'generationIdentity' | 'sessionIdentity'>,
): SourceEmissionLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source emission ledger.');
  const parsed = value as Partial<SourceEmissionLedger>;
  if (
    parsed.version !== SOURCE_EMISSION_LEDGER_VERSION ||
    parsed.projectRoot !== expected.projectRoot ||
    parsed.generationIdentity !== expected.generationIdentity ||
    parsed.sessionIdentity !== expected.sessionIdentity ||
    !Number.isSafeInteger(parsed.nextOrdinal) ||
    (parsed.nextOrdinal ?? 0) <= 0 ||
    !Array.isArray(parsed.ranges) ||
    !parsed.ranges.every(validPersistedRange)
  ) {
    throw new Error('Invalid source emission ledger.');
  }
  return parsed as SourceEmissionLedger;
}

function validPersistedRange(value: unknown): value is PersistedSourceRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const range = value as Partial<PersistedSourceRange>;
  return (
    typeof range.relativePath === 'string' &&
    range.relativePath !== '' &&
    Number.isSafeInteger(range.startLine) &&
    (range.startLine ?? -1) >= 0 &&
    Number.isSafeInteger(range.endLine) &&
    (range.endLine ?? -1) >= (range.startLine ?? 0) &&
    Number.isSafeInteger(range.ordinal) &&
    (range.ordinal ?? 0) > 0 &&
    typeof range.command === 'string' &&
    range.command !== '' &&
    (range.ownerSymbol === undefined || typeof range.ownerSymbol === 'string')
  );
}

function coalesceStagedRanges(ranges: readonly StagedSourceRange[]): StagedSourceRange[] {
  const sorted = [...ranges].sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine,
  );
  const result: StagedSourceRange[] = [];
  for (const range of sorted) {
    const prior = result[result.length - 1];
    if (
      prior &&
      prior.relativePath === range.relativePath &&
      prior.ownerSymbol === range.ownerSymbol &&
      range.startLine <= prior.endLine + 1
    ) {
      prior.endLine = Math.max(prior.endLine, range.endLine);
    } else {
      result.push({ ...range });
    }
  }
  return result;
}

function uniqueCoveredLineCount(ranges: readonly PersistedSourceRange[]): number {
  const byPath = new Map<string, Array<{ startLine: number; endLine: number }>>();
  for (const range of ranges) {
    const pathRanges = byPath.get(range.relativePath) ?? [];
    pathRanges.push(range);
    byPath.set(range.relativePath, pathRanges);
  }
  let total = 0;
  for (const pathRanges of byPath.values()) {
    pathRanges.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
    let start = -1;
    let end = -1;
    for (const range of pathRanges) {
      if (start < 0) {
        start = range.startLine;
        end = range.endLine;
      } else if (range.startLine <= end + 1) {
        end = Math.max(end, range.endLine);
      } else {
        total += end - start + 1;
        start = range.startLine;
        end = range.endLine;
      }
    }
    if (start >= 0) total += end - start + 1;
  }
  return total;
}

function sourceEmissionRoot(): string {
  const configured = process.env[SOURCE_EMISSION_ROOT_ENV];
  if (!configured) return join(tmpdir(), `scip-query-source-sessions-${process.getuid?.() ?? 'user'}`);
  if (!isAbsolute(configured)) throw new Error(`${SOURCE_EMISSION_ROOT_ENV} must be an absolute path.`);
  return resolve(configured);
}

function resolveSourceEmissionSessionIdentity(): string | undefined {
  const explicit = process.env[SOURCE_EMISSION_SESSION_ENV]?.trim();
  if (!explicit) return undefined;
  if (explicit.length > MAX_SESSION_NAME_CHARACTERS || !/^[A-Za-z0-9._:-]+$/.test(explicit)) return undefined;
  return `explicit:${explicit}`;
}
