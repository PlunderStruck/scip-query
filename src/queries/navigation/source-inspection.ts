import type { ScipDatabase } from '../../storage/db.js';
import { resolveIndexedFile } from '../internal/file-resolution.js';
import { evidence, type EvidenceOptions, type EvidenceResult } from './evidence.js';
import { searchSource } from './source-search.js';
import { enclosingSourceUnitSnippet, type SourceUnitSnippet } from './source-snippet.js';

const MAX_SELECTORS = 24;
const DEFAULT_SEARCH_LIMIT = 6;
const DEFAULT_CONTEXT = 6;
const DEFAULT_UNIT_LINES = 80;
const DEFAULT_TOTAL_LINES = 300;
const DEFAULT_SLICE_LIMIT = 18;

export interface SourceInspectionSlice extends SourceUnitSnippet {
  reasons: string[];
  focusLines: number[];
  ownerSymbol: string | null;
  ownerShort: string | null;
}

export interface SourceInspectionSearch {
  pattern: string;
  matchingLines: number;
  returnedMatches: number;
  omittedMatches: number;
}

export interface SourceInspectionLocation {
  target: string;
  matched: boolean;
}

export interface SourceInspectionResult {
  searches: SourceInspectionSearch[];
  evidence: EvidenceResult[];
  locations: SourceInspectionLocation[];
  slices: SourceInspectionSlice[];
  candidateSlices: number;
  omittedSlices: number;
  maxSlices: number;
  maxTotalLines: number;
}

export interface SourceInspectionOptions {
  searches?: readonly string[];
  symbols?: readonly string[];
  locations?: readonly string[];
  scope?: string;
  context?: number;
  searchLimit?: number;
  unitLines?: number;
  totalLines?: number;
  sliceLimit?: number;
  evidence?: EvidenceOptions;
}

/** Build one bounded, deduplicated packet from several known source questions. */
export function inspectSource(db: ScipDatabase, opts: SourceInspectionOptions): SourceInspectionResult {
  const searches = uniqueNonEmpty(opts.searches);
  const symbols = uniqueNonEmpty(opts.symbols);
  const locations = uniqueNonEmpty(opts.locations);
  const selectorCount = searches.length + symbols.length + locations.length;
  if (selectorCount === 0) throw new Error('inspect requires at least one --search, --symbol, or --at selector.');
  if (selectorCount > MAX_SELECTORS) {
    throw new RangeError(`inspect accepts at most ${MAX_SELECTORS} selectors; received ${selectorCount}.`);
  }

  const context = positiveOrZero(opts.context ?? DEFAULT_CONTEXT, 'context');
  const searchLimit = positive(opts.searchLimit ?? DEFAULT_SEARCH_LIMIT, 'searchLimit');
  const unitLines = positive(opts.unitLines ?? DEFAULT_UNIT_LINES, 'unitLines');
  const totalLines = positive(opts.totalLines ?? DEFAULT_TOTAL_LINES, 'totalLines');
  const sliceLimit = positive(opts.sliceLimit ?? DEFAULT_SLICE_LIMIT, 'sliceLimit');
  const slices = new Map<string, SourceInspectionSlice>();

  const searchResults = searches.map((pattern) => {
    const result = searchSource(db, pattern, { scope: opts.scope, context: 0, limit: searchLimit });
    for (const match of result.matches) {
      const unit = enclosingSourceUnitSnippet(db, match.relativePath, match.focusLine, unitLines, context);
      if (!unit) continue;
      addSlice(slices, unit, `search:${pattern}`, match.ownerSymbol, match.ownerShort);
    }
    return {
      pattern,
      matchingLines: result.matchingLines,
      returnedMatches: result.matches.length,
      omittedMatches: result.omittedMatches,
    };
  });

  const locationResults = locations.map((target) => {
    const parsed = parseLocation(target);
    const relativePath = parsed ? resolveIndexedFile(db, parsed.path) : null;
    const unit = relativePath
      ? enclosingSourceUnitSnippet(db, relativePath, parsed!.line - 1, unitLines, context)
      : null;
    if (unit) {
      addSlice(slices, unit, `at:${target}`, null, null);
    }
    return { target, matched: unit !== null };
  });

  const evidenceResults = symbols.map((symbol) => evidence(db, symbol, opts.evidence));
  const boundedSlices = boundSlices([...slices.values()], sliceLimit, totalLines);
  return {
    searches: searchResults,
    evidence: evidenceResults,
    locations: locationResults,
    slices: boundedSlices,
    candidateSlices: slices.size,
    omittedSlices: Math.max(0, slices.size - boundedSlices.length),
    maxSlices: sliceLimit,
    maxTotalLines: totalLines,
  };
}

function addSlice(
  slices: Map<string, SourceInspectionSlice>,
  unit: SourceUnitSnippet,
  reason: string,
  ownerSymbol: string | null,
  ownerShort: string | null,
): void {
  const existing = [...slices.values()].find(
    (slice) =>
      slice.relativePath === unit.relativePath &&
      slice.unitStartLine === unit.unitStartLine &&
      slice.unitEndLine === unit.unitEndLine &&
      unit.focusLine >= slice.startLine &&
      unit.focusLine <= slice.endLine,
  );
  if (existing) {
    existing.reasons = [...new Set([...existing.reasons, reason])];
    existing.focusLines = [...new Set([...existing.focusLines, unit.focusLine])].sort((left, right) => left - right);
    if (!existing.ownerSymbol && ownerSymbol) existing.ownerSymbol = ownerSymbol;
    if (!existing.ownerShort && ownerShort) existing.ownerShort = ownerShort;
    return;
  }
  const key = `${unit.relativePath}:${unit.unitStartLine}-${unit.unitEndLine}:${unit.startLine}-${unit.endLine}`;
  slices.set(key, {
    ...unit,
    reasons: [reason],
    focusLines: [unit.focusLine],
    ownerSymbol,
    ownerShort,
  });
}

function boundSlices(
  slices: SourceInspectionSlice[],
  maxSlices: number,
  maxTotalLines: number,
): SourceInspectionSlice[] {
  const out: SourceInspectionSlice[] = [];
  let remainingLines = maxTotalLines;
  for (const slice of slices) {
    if (out.length >= maxSlices || remainingLines <= 0) break;
    const lines = slice.source.split('\n');
    const kept = Math.min(lines.length, remainingLines);
    if (kept <= 0) break;
    const desiredOffset = slice.focusLine - slice.startLine - Math.floor(kept / 2);
    const offset = Math.max(0, Math.min(lines.length - kept, desiredOffset));
    const startLine = slice.startLine + offset;
    const endLine = startLine + kept - 1;
    out.push({
      ...slice,
      startLine,
      endLine,
      source: lines.slice(offset, offset + kept).join('\n'),
      focusLines: slice.focusLines.filter((line) => line >= startLine && line <= endLine),
      omittedLines: slice.omittedLines + Math.max(0, lines.length - kept),
    });
    remainingLines -= kept;
  }
  return out;
}

function parseLocation(target: string): { path: string; line: number } | null {
  const match = target.match(/^(.+\.\w+):(\d+)$/u);
  if (!match) return null;
  const line = Number(match[2]);
  return Number.isSafeInteger(line) && line > 0 ? { path: match[1]!, line } : null;
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer; received ${value}`);
  }
  return value;
}

function positiveOrZero(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer; received ${value}`);
  }
  return value;
}
