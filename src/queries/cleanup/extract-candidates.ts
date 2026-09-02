import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import type { CalleeRow } from '../../symbols/graph/call-graph-evidence.js';
import type { LocalOccurrence } from '../../symbols/graph/scip-chunk-occurrences.js';
import { scipOccurrenceTargetsForFile } from '../../symbols/graph/scip-occurrence-call-targets.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import { runCandidateAnalysis } from '../internal/candidate-scan.js';
import { definitionLoc } from '../query-utils.js';

export type ExtractCandidateKind = 'call-region' | 'render-region';
/** `support` when the largest region's interface is wide: it would take more locals in or hand more back than a helper should. */
export type ExtractCandidateActionTier = 'signal' | 'support';

/** One contiguous line range whose callees are used nowhere else in the function. */
export interface ExtractRegion {
  startLine: number;
  endLine: number;
  lines: number;
  /** `render-region` when most of the region's names are rendered component elements. */
  kind: ExtractCandidateKind;
  /** Callees used only inside this region, in first-use order. */
  callees: string[];
  renderCallees: number;
  /** Bindings declared before the region and read inside it: the parameters an extraction would take. */
  inboundLocals: string[];
  /** Bindings declared inside the region and read after it: the values an extraction would hand back. */
  outboundLocals: string[];
  /** Callees used across the whole body that also appear inside the region. */
  ambientCallees: string[];
}

export interface ExtractCandidate {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
  /** Distinct callees with a known call line inside the function. */
  totalCallees: number;
  /** Callee rows without a call line; they cannot be placed and are not analyzed. */
  unpositionedCallees: number;
  /** Callees whose uses span at least half the body; they belong to no region. */
  ambientCallees: string[];
  /** False when the indexer emitted no local-symbol occurrences for the file, so data flow is unknown. */
  localsAvailable: boolean;
  /** Kind of the largest region. */
  extractionKind: ExtractCandidateKind;
  /** Extraction candidates are contextual signals, not direct repair mandates; `support` marks a wide interface. */
  actionTier: ExtractCandidateActionTier;
  /** Why the candidate sits at its tier. */
  tierReason: string;
  /**
   * Return statements of the function itself inside the largest region: a
   * region that returns for the function is its control flow, not a helper.
   */
  ownReturnsInRegion: number;
  evidenceReasons: string[];
  recommendation: string;
  /** Qualifying regions, largest first. */
  regions: ExtractRegion[];
}

/** A region must carry this many distinct exclusive callees. */
const MIN_REGION_CALLEES = 3;
/** A region must span this many source lines. */
const MIN_REGION_LINES = 8;
/** A region covering more of the body than this is the function itself, not a seam. */
const MAX_REGION_BODY_SHARE = 0.75;
/** The rest of the function must keep this many distinct callees of its own. */
const MIN_OUTSIDE_CALLEES = 2;
/** A callee used at least twice across at least this share of the body is ambient, not regional. */
const AMBIENT_BODY_SHARE = 0.5;
/** Call lines this close together belong to the same region. */
const REGION_MERGE_GAP_LINES = 2;
/** A signal-tier region takes at most this many locals in. */
const MAX_SIGNAL_INBOUND_LOCALS = 5;
/** A signal-tier region hands at most this many values back. */
const MAX_SIGNAL_OUTBOUND_LOCALS = 2;
/** A region grows over at most this many enclosing block-opener and block-closer lines on each side. */
const BLOCK_SNAP_LINES = 2;

interface CalleeUse {
  symbol: string;
  lines: number[];
  render: boolean;
}

interface CalleeInterval {
  symbol: string;
  min: number;
  max: number;
  render: boolean;
}

interface RegionSpan {
  start: number;
  end: number;
  members: CalleeInterval[];
}

interface FileLocals {
  available: boolean;
  occurrences: readonly LocalOccurrence[];
  lines: readonly string[];
}

interface ExtractionContext {
  callees: Map<number, CalleeRow[]>;
}

/**
 * Find extraction seams in large functions.
 *
 * A seam is a contiguous line range whose callees appear nowhere else in the
 * function: everything the range calls could move with it. Regions are built
 * from each callee's first-to-last use interval (overlapping intervals must
 * stay together), merged when their call lines sit close together, and kept
 * only when the region is large enough, is not the whole body, and leaves
 * the rest of the function with callees of its own. Callees used across the
 * body (a logger, a translator) are reported as ambient rather than allowed
 * to glue every region into one. When the indexer emitted local-symbol
 * occurrences, each region also reports the bindings it would need as
 * parameters and the bindings it would hand back.
 */
// scip-query: ignore-extract — this is the public extraction-candidate
// detector pipeline: callable selection, callee-map loading, per-symbol
// region analysis, and result ordering are one command contract.
export function extractCandidates(
  db: ScipDatabase,
  opts: {
    scope?: string;
    minLoc?: number;
    minCallees?: number;
    limit?: number;
    scanLimit?: number;
    semantic?: boolean;
  } = {},
): ExtractCandidate[] {
  const { scope, minLoc = 10, minCallees = 6, limit = 20, scanLimit } = opts;
  const index = new ProjectIndex(db);
  return runCandidateAnalysis<IndexedDefinition, ExtractionContext, ExtractCandidate>({
    candidates: () =>
      index.productionCallableDefinitions({
        scope,
        minLoc,
        excludeTypesFiles: true,
        requireFunctionLikeSymbol: true,
        sortByLocDesc: true,
      }),
    scanLimit,
    profile: { name: 'extract-candidates' },
    prepare: (symbols) => ({
      callees: index.calleeMap(symbols, { semantic: opts.semantic !== false }),
    }),
    evaluate: (definition, context) =>
      extractionCandidateForSymbol(
        definition,
        context.callees.get(definition.symbolId) ?? [],
        minCallees,
        fileLocalsFor(db, definition.relativePath),
      ),
    orderResults: (a, b) =>
      tierRank(a.actionTier) - tierRank(b.actionTier) || b.regions[0]!.lines - a.regions[0]!.lines || b.loc - a.loc,
    limit,
  });
}

function tierRank(tier: ExtractCandidateActionTier): number {
  return tier === 'signal' ? 0 : 1;
}

/**
 * Per-file locals and source lines come from bounded per-database caches;
 * holding them per run would keep every visited file resident on a
 * whole-project pass.
 */
function fileLocalsFor(db: ScipDatabase, relativePath: string): FileLocals {
  const occurrences = scipOccurrenceTargetsForFile(db, relativePath)?.locals ?? [];
  return {
    available: occurrences.length > 0,
    occurrences,
    lines: getSourceLines(db, relativePath),
  };
}

// scip-query: ignore-extract — this is the detector's own per-symbol unit;
// callee placement, ambient separation, region formation, and the qualifying
// thresholds are the definition of an extraction seam.
function extractionCandidateForSymbol(
  definition: IndexedDefinition,
  rows: readonly CalleeRow[],
  minCallees: number,
  locals: FileLocals,
): ExtractCandidate | null {
  const { uses, unpositioned } = calleeUses(definition, rows);
  if (uses.length < minCallees) return null;

  const loc = definitionLoc(definition);
  const ambient: CalleeUse[] = [];
  const intervals: CalleeInterval[] = [];
  for (const use of uses) {
    const min = Math.min(...use.lines);
    const max = Math.max(...use.lines);
    if (use.lines.length >= 2 && max - min + 1 >= AMBIENT_BODY_SHARE * loc) ambient.push(use);
    else intervals.push({ symbol: use.symbol, min, max, render: use.render });
  }

  const callLines = new Set(uses.flatMap((use) => use.lines));
  const spans = mergeAdjacentSpans(
    exclusiveSpans(intervals),
    locals.lines,
    bodyIndentation(definition, locals.lines),
  ).map((span) => snapToBlock(span, definition, locals.lines, callLines));
  const regions = spans
    .filter((span) => qualifies(span, intervals.length, loc))
    .map((span) => describeRegion(definition, span, ambient, locals))
    .sort((a, b) => b.lines - a.lines || a.startLine - b.startLine);
  if (regions.length === 0) return null;

  // The candidate's region is the largest one a reviewer could extract: a
  // larger region that swallowed the function's own `return` is its control
  // flow, and a smaller extractable region beside it is the better advice.
  const allCallLines = new Set(uses.flatMap((use) => use.lines));
  const best = [...regions].sort((a, b) => {
    const rankA = tierRank(tierFor(a, locals.available, ownReturnStatements(locals.lines, a, allCallLines)).tier);
    const rankB = tierRank(tierFor(b, locals.available, ownReturnStatements(locals.lines, b, allCallLines)).tier);
    return rankA - rankB || b.lines - a.lines || a.startLine - b.startLine;
  })[0]!;
  const reasons = [
    `${uses.length} callees placed on call lines across ${loc} lines` +
      (unpositioned > 0 ? `; ${unpositioned} callee row(s) without a call line ignored` : ''),
  ];
  if (ambient.length > 0) {
    reasons.push(
      `${ambient.length} ambient callee(s) used across the body: ${ambient.map((use) => shortenSymbol(use.symbol)).join(', ')}`,
    );
  }
  for (const region of regions) {
    reasons.push(
      `lines ${region.startLine + 1}-${region.endLine + 1} (${region.lines} lines) use ${region.callees.length} callees exclusively` +
        (locals.available
          ? `; ${region.inboundLocals.length} local(s) in, ${region.outboundLocals.length} out`
          : '; local data flow unknown'),
    );
  }
  reasons.push(`${intervals.length - regionMemberCount(spans, best)} callee(s) stay outside the largest region`);
  const ownReturns = ownReturnStatements(locals.lines, best, allCallLines);
  const tier = tierFor(best, locals.available, ownReturns);
  reasons.push(tier.reason);

  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    relativePath: definition.relativePath,
    startLine: definition.startLine,
    endLine: definition.endLine,
    loc,
    totalCallees: uses.length,
    unpositionedCallees: unpositioned,
    ambientCallees: ambient.map((use) => shortenSymbol(use.symbol)),
    localsAvailable: locals.available,
    extractionKind: best.kind,
    actionTier: tier.tier,
    tierReason: tier.reason,
    ownReturnsInRegion: ownReturns,
    evidenceReasons: reasons,
    recommendation: recommendationFor(best, locals.available),
    regions,
  };
}

function calleeUses(
  definition: IndexedDefinition,
  rows: readonly CalleeRow[],
): { uses: CalleeUse[]; unpositioned: number } {
  const bySymbol = new Map<string, CalleeUse>();
  const unpositionedSymbols = new Set<string>();
  for (const row of rows) {
    if (row.symbol === definition.symbol) continue;
    const line = row.callsiteLine;
    if (line === undefined || line < definition.startLine || line > definition.endLine) {
      unpositionedSymbols.add(row.symbol);
      continue;
    }
    const use = bySymbol.get(row.symbol);
    if (use) {
      if (!use.lines.includes(line)) use.lines.push(line);
      use.render ||= row.kind === 'jsx-render';
    } else {
      bySymbol.set(row.symbol, { symbol: row.symbol, lines: [line], render: row.kind === 'jsx-render' });
    }
  }
  let unpositioned = 0;
  for (const symbol of unpositionedSymbols) if (!bySymbol.has(symbol)) unpositioned += 1;
  return { uses: [...bySymbol.values()], unpositioned };
}

/**
 * Maximal line ranges in which every callee's uses are fully contained: the
 * union of overlapping first-to-last use intervals. Any cut inside a callee's
 * interval would separate its uses, so these are the only exclusive spans.
 */
function exclusiveSpans(intervals: readonly CalleeInterval[]): RegionSpan[] {
  const ordered = [...intervals].sort((a, b) => a.min - b.min || a.max - b.max);
  const spans: RegionSpan[] = [];
  for (const interval of ordered) {
    const current = spans[spans.length - 1];
    if (current && interval.min <= current.end) {
      current.end = Math.max(current.end, interval.max);
      current.members.push(interval);
    } else {
      spans.push({ start: interval.min, end: interval.max, members: [interval] });
    }
  }
  return spans;
}

/**
 * Exclusive spans form one region when their call lines sit close together
 * or when no statement-level line separates them: a fluent chain or a
 * literal that spans dozens of lines is one statement, and a region never
 * cuts through a statement.
 */
function mergeAdjacentSpans(spans: readonly RegionSpan[], lines: readonly string[], bodyIndent: number): RegionSpan[] {
  const merged: RegionSpan[] = [];
  for (const span of spans) {
    const current = merged[merged.length - 1];
    // A rendered subtree is a cut inside one statement, so render spans keep
    // the proximity rule only; call spans also merge across a statement.
    const sameStatement =
      current !== undefined &&
      !hasRenderMember(current) &&
      !hasRenderMember(span) &&
      !statementBoundaryBetween(lines, current.end, span.start, bodyIndent);
    if (current && (span.start - current.end <= REGION_MERGE_GAP_LINES || sameStatement)) {
      current.end = span.end;
      current.members.push(...span.members);
    } else {
      merged.push({ start: span.start, end: span.end, members: [...span.members] });
    }
  }
  return merged;
}

function hasRenderMember(span: RegionSpan): boolean {
  return span.members.some((member) => member.render);
}

/**
 * The indentation of the function's own statements: the first non-blank
 * line of the body. The shallowest line would be wrong here because
 * template literals and multi-line strings put text at column zero.
 */
function bodyIndentation(definition: IndexedDefinition, lines: readonly string[]): number {
  for (let line = definition.startLine + 1; line < definition.endLine; line += 1) {
    const text = lines[line] ?? '';
    if (text.trim().length > 0) return indentation(text);
  }
  return 0;
}

/** True when a line between `from` and `to` (exclusive) sits exactly at the function's statement level. */
function statementBoundaryBetween(lines: readonly string[], from: number, to: number, bodyIndent: number): boolean {
  for (let line = from + 1; line < to; line += 1) {
    const text = lines[line] ?? '';
    if (text.trim().length === 0) continue;
    if (indentation(text) === bodyIndent) return true;
  }
  return false;
}

/**
 * A region's call lines usually sit inside a block whose opener and closer
 * carry no call of their own (`if (...) {` above, `}` below). Grow the region
 * over such lines so its size reflects the block, never over a line that
 * calls something outside the region.
 */
function snapToBlock(
  span: RegionSpan,
  definition: IndexedDefinition,
  lines: readonly string[],
  callLines: ReadonlySet<number>,
): RegionSpan {
  let start = span.start;
  let end = span.end;
  for (let step = 0; step < BLOCK_SNAP_LINES; step += 1) {
    const above = start - 1;
    if (above <= definition.startLine || callLines.has(above) || !isBlockOpener(lines[above] ?? '')) break;
    start = above;
  }
  for (let step = 0; step < BLOCK_SNAP_LINES; step += 1) {
    const below = end + 1;
    if (below >= definition.endLine || callLines.has(below) || !isBlockCloser(lines[below] ?? '')) break;
    end = below;
  }
  if (hasRenderMember(span)) {
    // A rendered region cut inside an element (`<HeroStat` above, `/>` two
    // lines below) is a fragment; grow it to the element boundaries so the
    // region is a subtree, or so a span that only straddles two elements
    // fails the size rules honestly.
    let balance = jsxTagBalance(lines, start, end);
    for (let step = 0; balance > 0 && step < JSX_SNAP_LINES && end + 1 < definition.endLine; step += 1) {
      end += 1;
      balance = jsxTagBalance(lines, start, end);
    }
    // Growing upward stops at the function's own `return (`: a region that
    // swallows it is the function's control flow, not a child component.
    for (
      let step = 0;
      balance < 0 &&
      step < JSX_SNAP_LINES &&
      start - 1 > definition.startLine &&
      !/^\s*return\b/.test(lines[start - 1] ?? '');
      step += 1
    ) {
      start -= 1;
      balance = jsxTagBalance(lines, start, end);
    }
  }
  return { start, end, members: span.members };
}

const JSX_SNAP_LINES = 40;
const JSX_OPEN_TAG = /<([A-Za-z][\w.:-]*)(?=[\s/>])/g;
const JSX_CLOSE_TAG = /<\/[A-Za-z][\w.:-]*\s*>/g;
const JSX_SELF_CLOSE = /\/>/g;

/** Opening tags minus closing and self-closing tags over the lines; zero when the lines hold whole elements. */
function jsxTagBalance(lines: readonly string[], start: number, end: number): number {
  let balance = 0;
  for (let line = start; line <= end; line += 1) {
    const text = lines[line] ?? '';
    balance += (text.match(JSX_OPEN_TAG) ?? []).length;
    balance -= (text.match(JSX_CLOSE_TAG) ?? []).length;
    balance -= (text.match(JSX_SELF_CLOSE) ?? []).length;
  }
  return balance;
}

function isBlockOpener(line: string): boolean {
  const text = line.trim();
  return text.length > 0 && /(?:\{|\(|\[|=>|:)$/u.test(text) && !/^(?:\/\/|\*|\/\*)/u.test(text);
}

function isBlockCloser(line: string): boolean {
  return /^[\s)\]}>;,]+$/u.test(line) && line.trim().length > 0;
}

function qualifies(span: RegionSpan, positionedCallees: number, loc: number): boolean {
  const lines = span.end - span.start + 1;
  return (
    span.members.length >= MIN_REGION_CALLEES &&
    lines >= MIN_REGION_LINES &&
    lines <= MAX_REGION_BODY_SHARE * loc &&
    positionedCallees - span.members.length >= MIN_OUTSIDE_CALLEES
  );
}

function regionMemberCount(spans: readonly RegionSpan[], region: ExtractRegion): number {
  return spans.find((span) => span.start === region.startLine && span.end === region.endLine)?.members.length ?? 0;
}

function describeRegion(
  definition: IndexedDefinition,
  span: RegionSpan,
  ambient: readonly CalleeUse[],
  locals: FileLocals,
): ExtractRegion {
  const members = [...span.members].sort((a, b) => a.min - b.min);
  const renderCallees = members.filter((member) => member.render).length;
  const flow = regionLocalFlow(definition, span, locals);
  return {
    startLine: span.start,
    endLine: span.end,
    lines: span.end - span.start + 1,
    kind: renderCallees * 2 > members.length ? 'render-region' : 'call-region',
    callees: members.map((member) => shortenSymbol(member.symbol)),
    renderCallees,
    inboundLocals: flow.inbound,
    outboundLocals: flow.outbound,
    ambientCallees: ambient
      .filter((use) => use.lines.some((line) => line >= span.start && line <= span.end))
      .map((use) => shortenSymbol(use.symbol)),
  };
}

/**
 * Bindings a region exchanges with the rest of the function, from the
 * indexer's local-symbol occurrences: declared before and read inside means
 * a parameter; declared inside and read after means a returned value.
 */
function regionLocalFlow(
  definition: IndexedDefinition,
  span: RegionSpan,
  locals: FileLocals,
): { inbound: string[]; outbound: string[] } {
  if (!locals.available) return { inbound: [], outbound: [] };
  const bindings = new Map<string, { declaredAt: number | null; name: string; uses: number[]; writes: number[] }>();
  for (const occurrence of locals.occurrences) {
    if (occurrence.line < definition.startLine || occurrence.line > definition.endLine) continue;
    let binding = bindings.get(occurrence.symbol);
    if (!binding) {
      binding = { declaredAt: null, name: '', uses: [], writes: [] };
      bindings.set(occurrence.symbol, binding);
    }
    if (occurrence.definition) {
      binding.declaredAt = occurrence.line;
      binding.name = localName(locals.lines, occurrence);
    } else {
      binding.uses.push(occurrence.line);
      if (occurrence.write) binding.writes.push(occurrence.line);
    }
  }
  const inside = (line: number): boolean => line >= span.start && line <= span.end;
  const inbound = new Set<string>();
  const outbound = new Set<string>();
  for (const binding of bindings.values()) {
    if (binding.declaredAt === null || binding.name === '') continue;
    const declaredInside = inside(binding.declaredAt);
    const readAfter = binding.uses.some((line) => line > span.end);
    if (!declaredInside && binding.declaredAt < span.start && binding.uses.some(inside)) inbound.add(binding.name);
    if (declaredInside && readAfter) outbound.add(binding.name);
    if (!declaredInside && binding.writes.some(inside) && readAfter) outbound.add(binding.name);
  }
  return { inbound: [...inbound].sort(), outbound: [...outbound].sort() };
}

function localName(lines: readonly string[], occurrence: LocalOccurrence): string {
  if (occurrence.endLine !== occurrence.line) return '';
  return lines[occurrence.line]?.slice(occurrence.startChar, occurrence.endChar).trim() ?? '';
}

/**
 * A region is a signal when moving it needs a narrow interface. With no
 * local-symbol data the cost is unknown and the region stays a signal.
 */
function tierFor(
  region: ExtractRegion,
  localsAvailable: boolean,
  ownReturns: number,
): { tier: ExtractCandidateActionTier; reason: string } {
  if (ownReturns > 0) {
    return {
      tier: 'support',
      reason: `support tier: the largest region holds ${ownReturns} return statement(s) of the function itself, so it is the function's control flow rather than a helper`,
    };
  }
  if (!localsAvailable)
    return { tier: 'signal', reason: 'signal tier: local data flow unknown, interface cost not assessed' };
  const inbound = region.inboundLocals.length;
  const outbound = region.outboundLocals.length;
  if (inbound <= MAX_SIGNAL_INBOUND_LOCALS && outbound <= MAX_SIGNAL_OUTBOUND_LOCALS) {
    return {
      tier: 'signal',
      reason: `signal tier: the largest region takes ${inbound} local(s) in and hands ${outbound} back`,
    };
  }
  return {
    tier: 'support',
    reason: `support tier: the largest region would take ${inbound} local(s) in and hand ${outbound} back, more than ${MAX_SIGNAL_INBOUND_LOCALS} in or ${MAX_SIGNAL_OUTBOUND_LOCALS} out`,
  };
}

/**
 * Count `return` statements inside the region that belong to the function
 * rather than to a callback nested in it: a return indented no deeper than
 * the shallowest call line of the region sits at the region's own level.
 */
function ownReturnStatements(lines: readonly string[], region: ExtractRegion, callLines: ReadonlySet<number>): number {
  let shallowestCall = Number.POSITIVE_INFINITY;
  for (let line = region.startLine; line <= region.endLine; line += 1) {
    if (callLines.has(line)) shallowestCall = Math.min(shallowestCall, indentation(lines[line] ?? ''));
  }
  if (!Number.isFinite(shallowestCall)) return 0;
  let returns = 0;
  for (let line = region.startLine; line <= region.endLine; line += 1) {
    const text = lines[line] ?? '';
    if (/^\s*return\b/u.test(text) && indentation(text) <= shallowestCall) returns += 1;
  }
  return returns;
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function recommendationFor(region: ExtractRegion, localsAvailable: boolean): string {
  const range = `${region.startLine + 1}-${region.endLine + 1}`;
  const flow = localsAvailable
    ? `; an extraction would take ${region.inboundLocals.length} local(s) in` +
      (region.inboundLocals.length > 0 ? ` (${region.inboundLocals.join(', ')})` : '') +
      ` and hand ${region.outboundLocals.length} back` +
      (region.outboundLocals.length > 0 ? ` (${region.outboundLocals.join(', ')})` : '')
    : '; local data flow is unknown because the indexer emitted no local symbols for this file';
  if (region.kind === 'render-region') {
    return `Review lines ${range} as a child component: its ${region.callees.length} rendered or called names appear nowhere else in this component${flow}. Extract only if the new name states what the subtree shows.`;
  }
  return `Review lines ${range} as a helper: its ${region.callees.length} callees are used nowhere else in this function${flow}. Extract only if the new name states what the region does.`;
}
