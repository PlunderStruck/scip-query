import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { tryAcquireProcessFileLock, type ProcessFileLock } from '../platform/process-file-lock.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { displayLine, displayPathRange } from './render.js';

const SOURCE_EMISSION_LEDGER_VERSION = 2;
const SOURCE_EMISSION_SESSION_ENV = 'SCIP_QUERY_SESSION';
const SOURCE_EMISSION_ROOT_ENV = 'SCIP_QUERY_SESSION_DIR';
const MAX_SESSION_NAME_CHARACTERS = 128;

interface PersistedSourceRange {
  relativePath: string;
  startLine: number;
  endLine: number;
  ordinal: number;
  command: string;
  policy: 'exact-unit' | 'preview';
  lineHashes: string[];
  ownerSymbol?: string;
}

interface PersistedEvidenceItem {
  kind: 'unit' | 'edge';
  identity: string;
  contentHash: string;
  receiptId: string;
  ordinal: number;
  command: string;
  label?: string;
}

interface SourceEmissionLedger {
  version: typeof SOURCE_EMISSION_LEDGER_VERSION;
  projectRoot: string;
  generationIdentity: string;
  sessionIdentity: string;
  nextOrdinal: number;
  updatedAt: string;
  ranges: PersistedSourceRange[];
  evidence: PersistedEvidenceItem[];
}

interface StagedSourceRange {
  relativePath: string;
  startLine: number;
  endLine: number;
  policy: 'exact-unit' | 'preview';
  lineHashes: string[];
  ownerSymbol?: string;
}

interface StagedEvidenceItem {
  kind: PersistedEvidenceItem['kind'];
  identity: string;
  contentHash: string;
  receiptId: string;
  label?: string;
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
  stagedEvidence: StagedEvidenceItem[];
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

export interface SessionEvidenceRenderOptions {
  kind: PersistedEvidenceItem['kind'];
  /** Stable compiler/topology identity for the returned fact. */
  identity: string;
  /** Complete rendered evidence that may be replaced only by an exact receipt. */
  content: string;
  /** Short human identity retained in the visible receipt reference. */
  label?: string;
  indent?: string;
}

export interface SourceEmissionSessionSummary {
  enabled: boolean;
  reason?: string;
  uniqueLines: number;
  evidenceItems: number;
  emissions: number;
  rows: string[];
}

const invocationStorage = new AsyncLocalStorage<SourceEmissionInvocation>();

/**
 * Binds one CLI invocation to source rendering state. Cross-command preview
 * suppression is opt-in via an explicit SCIP_QUERY_SESSION. Source and graph
 * evidence are suppressed only by a content-identical, generation-bound receipt.
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
    stagedEvidence: [],
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
    invocation.stagedEvidence.length = 0;
    return;
  }
  try {
    if (deliveredCompleteOutput && (invocation.staged.length > 0 || invocation.stagedEvidence.length > 0)) {
      const ordinal = active.ledger.nextOrdinal;
      const ranges = coalesceStagedRanges(invocation.staged).map(
        (range): PersistedSourceRange => ({
          ...range,
          ordinal,
          command: invocation.command,
        }),
      );
      const evidence = uniqueStagedEvidence(invocation.stagedEvidence).map(
        (item): PersistedEvidenceItem => ({
          ...item,
          ordinal,
          command: invocation.command,
        }),
      );
      active.ledger.ranges.push(...ranges);
      active.ledger.evidence.push(...evidence);
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
    invocation.stagedEvidence.length = 0;
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

/**
 * Render one complete graph unit or edge, or a visible reference to the exact
 * same generation-bound evidence delivered by an earlier command.
 */
export function renderSessionEvidence(options: SessionEvidenceRenderOptions): string {
  const invocation = invocationStorage.getStore();
  if (!invocation || !invocation.enabled) return options.content;
  const active = activateSession(invocation);
  if (!active) return options.content;
  const contentHash = digest(options.content);
  const prior = findLastMatching(
    active.ledger.evidence,
    (item) => item.kind === options.kind && item.identity === options.identity && item.contentHash === contentHash,
  );
  if (prior && !invocation.reemit) {
    const label = options.label ? `; ${boundedEvidenceLabel(options.label)}` : '';
    return (
      `${options.indent ?? ''}[${options.kind} evidence previously emitted: receipt ${prior.receiptId}; ` +
      `session #${prior.ordinal} via ${prior.command}${label}; not repeated]`
    );
  }
  invocation.stagedEvidence.push({
    kind: options.kind,
    identity: options.identity,
    contentHash,
    receiptId: evidenceReceiptId(options.kind, options.identity, contentHash),
    ...(options.label ? { label: boundedEvidenceLabel(options.label) } : {}),
  });
  return options.content;
}

export function sourceEmissionSessionSummary(reset = false): SourceEmissionSessionSummary {
  const invocation = invocationStorage.getStore();
  if (!invocation?.enabled) {
    return {
      enabled: false,
      reason: 'No explicit SCIP_QUERY_SESSION is active; source packets render independently.',
      uniqueLines: 0,
      evidenceItems: 0,
      emissions: 0,
      rows: [],
    };
  }
  const active = activateSession(invocation);
  if (!active) {
    return {
      enabled: false,
      reason:
        'The exploration-session ledger was unavailable or contended; evidence output is fail-open for this command.',
      uniqueLines: 0,
      evidenceItems: 0,
      emissions: 0,
      rows: [],
    };
  }
  if (reset) {
    active.ledger.ranges = [];
    active.ledger.evidence = [];
    active.ledger.nextOrdinal = 1;
    active.ledger.updatedAt = new Date().toISOString();
    try {
      writeJsonAtomic(active.ledgerPath, active.ledger, { spacing: 2, trailingNewline: true });
    } catch {
      return {
        enabled: false,
        reason: 'The exploration-session ledger could not be reset; evidence output remains fail-open.',
        uniqueLines: 0,
        evidenceItems: 0,
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
  const evidenceByOrdinal = new Map<number, PersistedEvidenceItem[]>();
  for (const item of active.ledger.evidence) {
    const items = evidenceByOrdinal.get(item.ordinal) ?? [];
    items.push(item);
    evidenceByOrdinal.set(item.ordinal, items);
  }
  const ordinals = [...new Set([...byOrdinal.keys(), ...evidenceByOrdinal.keys()])].sort((left, right) => left - right);
  const rows = ordinals.map((ordinal) => {
    const ranges = byOrdinal.get(ordinal) ?? [];
    const items = evidenceByOrdinal.get(ordinal) ?? [];
    const command = ranges[0]?.command ?? items[0]?.command ?? 'unknown';
    const sourceRow =
      ranges.length === 0
        ? null
        : (() => {
            const citations = ranges
              .slice(0, 8)
              .map((range) => displayPathRange(range.relativePath, range.startLine, range.endLine))
              .join(', ');
            const omitted = ranges.length > 8 ? `, ... ${ranges.length - 8} more range(s)` : '';
            return `  #${ordinal} ${command}: ${citations}${omitted}`;
          })();
    if (items.length === 0) return sourceRow!;
    const receipts = items
      .slice(0, 8)
      .map((item) => `${item.receiptId} ${item.kind}${item.label ? ` ${item.label}` : ''}`)
      .join(', ');
    const omitted = items.length > 8 ? `, ... ${items.length - 8} more item(s)` : '';
    return sourceRow
      ? `${sourceRow}\n     evidence: ${receipts}${omitted}`
      : `  #${ordinal} ${command}: ${receipts}${omitted}`;
  });
  return {
    enabled: true,
    uniqueLines: uniqueCoveredLineCount(active.ledger.ranges),
    evidenceItems: active.ledger.evidence.length,
    emissions: new Set([...byOrdinal.keys(), ...evidenceByOrdinal.keys()]).size,
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
  const lineHashes = sourceLines.map(digest);
  const exactReceipt =
    sessionPolicy === 'exact-unit' && !invocation.reemit
      ? findLastMatching(
          persisted,
          (range) =>
            range.policy === 'exact-unit' &&
            range.relativePath === relativePath &&
            range.startLine === startLine &&
            range.endLine === endLine &&
            range.ownerSymbol === ownerSymbol &&
            equalStrings(range.lineHashes, lineHashes),
        )
      : undefined;
  if (exactReceipt) {
    return [
      {
        kind: 'covered',
        startLine,
        endLine,
        ordinal: exactReceipt.ordinal,
        command: exactReceipt.command,
      },
    ];
  }
  const containingExactReceipt =
    sessionPolicy === 'exact-unit' && !invocation.reemit
      ? coveringExactEmission(persisted, relativePath, startLine, endLine, lineHashes)
      : undefined;
  if (containingExactReceipt) {
    return [
      {
        kind: 'covered',
        startLine,
        endLine,
        ordinal: containingExactReceipt.ordinal,
        command: containingExactReceipt.command,
      },
    ];
  }
  const coverage = sourceLines.map((_, index) =>
    coveringEmission(persisted, relativePath, startLine + index, lineHashes[index]!),
  );
  const mayCitePriorPreview =
    sessionPolicy === 'preview' && !invocation.reemit && coverage.every((reference) => reference !== undefined);
  if (!mayCitePriorPreview) {
    invocation.staged.push({ relativePath, startLine, endLine, ownerSymbol, policy: sessionPolicy, lineHashes });
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
  lineHash: string,
): { ordinal: number | null; command: string } | undefined {
  const prior = findLastMatching(
    persisted,
    (range) =>
      range.relativePath === relativePath &&
      range.startLine <= line &&
      line <= range.endLine &&
      range.lineHashes[line - range.startLine] === lineHash,
  );
  if (prior) return { ordinal: prior.ordinal, command: prior.command };
  return undefined;
}

function coveringExactEmission(
  persisted: readonly PersistedSourceRange[],
  relativePath: string,
  startLine: number,
  endLine: number,
  lineHashes: readonly string[],
): { ordinal: number | null; command: string } | undefined {
  const prior = findLastMatching(
    persisted,
    (range) =>
      range.policy === 'exact-unit' &&
      range.relativePath === relativePath &&
      range.startLine <= startLine &&
      range.endLine >= endLine &&
      lineHashes.every((hash, index) => range.lineHashes[startLine - range.startLine + index] === hash),
  );
  return prior ? { ordinal: prior.ordinal, command: prior.command } : undefined;
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
    evidence: [],
  };
}

function parseLedger(
  value: unknown,
  expected: Pick<SourceEmissionLedger, 'projectRoot' | 'generationIdentity' | 'sessionIdentity'>,
): SourceEmissionLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source emission ledger.');
  const parsed = value as Partial<SourceEmissionLedger>;
  const legacyVersion = (value as { version?: unknown }).version;
  if (
    legacyVersion === 1 &&
    parsed.projectRoot === expected.projectRoot &&
    parsed.generationIdentity === expected.generationIdentity &&
    parsed.sessionIdentity === expected.sessionIdentity &&
    Number.isSafeInteger(parsed.nextOrdinal) &&
    (parsed.nextOrdinal ?? 0) > 0
  ) {
    return {
      version: SOURCE_EMISSION_LEDGER_VERSION,
      projectRoot: expected.projectRoot,
      generationIdentity: expected.generationIdentity,
      sessionIdentity: expected.sessionIdentity,
      nextOrdinal: parsed.nextOrdinal!,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      ranges: [],
      evidence: [],
    };
  }
  if (
    parsed.version !== SOURCE_EMISSION_LEDGER_VERSION ||
    parsed.projectRoot !== expected.projectRoot ||
    parsed.generationIdentity !== expected.generationIdentity ||
    parsed.sessionIdentity !== expected.sessionIdentity ||
    !Number.isSafeInteger(parsed.nextOrdinal) ||
    (parsed.nextOrdinal ?? 0) <= 0 ||
    !Array.isArray(parsed.ranges) ||
    !parsed.ranges.every(validPersistedRange) ||
    !Array.isArray(parsed.evidence) ||
    !parsed.evidence.every(validPersistedEvidenceItem)
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
    (range.policy === 'exact-unit' || range.policy === 'preview') &&
    Array.isArray(range.lineHashes) &&
    range.lineHashes.length === (range.endLine ?? 0) - (range.startLine ?? 0) + 1 &&
    range.lineHashes.every(isSha256) &&
    (range.ownerSymbol === undefined || typeof range.ownerSymbol === 'string')
  );
}

function validPersistedEvidenceItem(value: unknown): value is PersistedEvidenceItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<PersistedEvidenceItem>;
  return (
    (item.kind === 'unit' || item.kind === 'edge') &&
    typeof item.identity === 'string' &&
    item.identity !== '' &&
    typeof item.contentHash === 'string' &&
    isSha256(item.contentHash) &&
    typeof item.receiptId === 'string' &&
    /^ev-[0-9a-f]{12}$/u.test(item.receiptId) &&
    Number.isSafeInteger(item.ordinal) &&
    (item.ordinal ?? 0) > 0 &&
    typeof item.command === 'string' &&
    item.command !== '' &&
    (item.label === undefined || typeof item.label === 'string')
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
      prior.policy === range.policy &&
      range.startLine <= prior.endLine + 1 &&
      overlappingHashesAgree(prior, range)
    ) {
      const offset = range.startLine - prior.startLine;
      for (let index = 0; index < range.lineHashes.length; index += 1) {
        prior.lineHashes[offset + index] ??= range.lineHashes[index]!;
      }
      prior.endLine = Math.max(prior.endLine, range.endLine);
    } else {
      result.push({ ...range, lineHashes: [...range.lineHashes] });
    }
  }
  return result;
}

function overlappingHashesAgree(left: StagedSourceRange, right: StagedSourceRange): boolean {
  const overlapStart = Math.max(left.startLine, right.startLine);
  const overlapEnd = Math.min(left.endLine, right.endLine);
  for (let line = overlapStart; line <= overlapEnd; line += 1) {
    if (left.lineHashes[line - left.startLine] !== right.lineHashes[line - right.startLine]) return false;
  }
  return true;
}

function uniqueStagedEvidence(items: readonly StagedEvidenceItem[]): StagedEvidenceItem[] {
  const seen = new Set<string>();
  const result: StagedEvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.kind}\0${item.identity}\0${item.contentHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
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

function evidenceReceiptId(kind: PersistedEvidenceItem['kind'], identity: string, contentHash: string): string {
  return `ev-${createHash('sha256').update(kind).update('\0').update(identity).update('\0').update(contentHash).digest('hex').slice(0, 12)}`;
}

function boundedEvidenceLabel(label: string): string {
  const normalized = label
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findLastMatching<T>(values: readonly T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]!;
    if (predicate(value)) return value;
  }
  return undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
