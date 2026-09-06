import { isRecordObject } from '../domain/record-validation.js';
import { readProjectFile } from '../platform/project-files.js';
import { sourceHash, type SourceFunction } from './ast/function-metrics.js';

export type FunctionCoverage =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'available';
      basis: 'istanbul-statement-start-lines';
      coveredLines: number;
      measuredLines: number;
      fraction: number;
      crap: number;
    };

interface CoverageEntry {
  sourceHash?: unknown;
  coverage?: {
    statementMap?: Record<
      string,
      { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } }
    >;
    s?: Record<string, number>;
  };
}

export interface ReviewCoverage {
  files: Record<string, CoverageEntry>;
  problem?: string;
}

export function loadReviewCoverage(projectRoot: string, file?: string): ReviewCoverage {
  if (!file) return { files: {}, problem: 'No source-matched coverage artifact supplied.' };
  try {
    const parsed = JSON.parse(readProjectFile(projectRoot, file).toString('utf8')) as {
      schemaVersion?: unknown;
      files?: unknown;
    };
    if (
      parsed.schemaVersion !== 1 ||
      !parsed.files ||
      typeof parsed.files !== 'object' ||
      Array.isArray(parsed.files)
    ) {
      return {
        files: {},
        problem: 'Expected a version 1 source-matched coverage artifact; use scripts/record-review-coverage.mjs.',
      };
    }
    return { files: parsed.files as Record<string, CoverageEntry> };
  } catch (error) {
    return { files: {}, problem: `Cannot read coverage: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function functionCoverage(
  fn: SourceFunction,
  peers: readonly SourceFunction[],
  source: string,
  input: ReviewCoverage,
): FunctionCoverage {
  const unavailable = (reason: string): FunctionCoverage => ({ status: 'unavailable', reason });
  if (input.problem) return unavailable(input.problem);
  const entry = input.files[fn.file];
  if (!entry || entry.sourceHash !== sourceHash(source))
    return unavailable('Coverage missing or source hash does not match current bytes.');
  const { statementMap, s } = entry.coverage ?? {};
  if (!isRecordObject(statementMap) || !isRecordObject(s)) return unavailable('Malformed statement coverage.');
  const statements = measuredStatements(statementMap, s, source);
  if (!statements) return unavailable('Malformed statement coverage locations or counts.');
  const lines = functionStatementLines(fn, peers, statements);
  if (lines.size === 0) return unavailable('No measured executable lines in this function.');
  const coveredLines = [...lines.values()].filter(Boolean).length;
  const fraction = coveredLines / lines.size;
  return {
    status: 'available',
    basis: 'istanbul-statement-start-lines',
    coveredLines,
    measuredLines: lines.size,
    fraction,
    crap: Number((fn.cyclomatic ** 2 * (1 - fraction) ** 3 + fn.cyclomatic).toFixed(2)),
  };
}

interface MeasuredStatement {
  line: number;
  offset: number;
  count: number;
}

/** Validate every location before selecting a function, so malformed sibling evidence stays unavailable. */
function measuredStatements(
  statementMap: NonNullable<CoverageEntry['coverage']>['statementMap'] & object,
  counts: Record<string, number>,
  source: string,
): MeasuredStatement[] | undefined {
  const offsets = [0];
  for (let offset = 0; offset < source.length; offset++) if (source[offset] === '\n') offsets.push(offset + 1);
  const statements: MeasuredStatement[] = [];
  for (const [id, span] of Object.entries(statementMap)) {
    const line = span?.start?.line;
    const column = span?.start?.column;
    const count = counts[id];
    if (!validMeasuredLocation(line, column, count, offsets, source.length)) return undefined;
    statements.push({ line: line!, offset: offsets[line! - 1]! + column!, count: count! });
  }
  return statements;
}

function functionStatementLines(
  fn: SourceFunction,
  peers: readonly SourceFunction[],
  statements: readonly MeasuredStatement[],
): Map<number, boolean> {
  const nested = peers.filter(
    (peer) => peer !== fn && peer.startOffset > fn.startOffset && peer.endOffset <= fn.endOffset,
  );
  const lines = new Map<number, boolean>();
  for (const { line, offset, count } of statements) {
    if (offset < fn.startOffset || offset >= fn.endOffset) continue;
    if (nested.some((peer) => offset >= peer.startOffset && offset < peer.endOffset)) continue;
    lines.set(line, (lines.get(line) ?? false) || count > 0);
  }
  return lines;
}

function validMeasuredLocation(
  line: number | undefined,
  column: number | undefined,
  count: number | undefined,
  offsets: readonly number[],
  sourceLength: number,
): boolean {
  if (!Number.isInteger(line) || !Number.isInteger(column) || !Number.isInteger(count)) return false;
  if (line! < 1 || line! > offsets.length || column! < 0 || count! < 0) return false;
  const start = offsets[line! - 1]! + column!;
  const end = offsets[line!] ?? sourceLength;
  return start < end;
}
