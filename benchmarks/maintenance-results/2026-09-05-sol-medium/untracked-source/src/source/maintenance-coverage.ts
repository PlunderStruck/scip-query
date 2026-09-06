import { readProjectFile } from '../platform/project-files.js';
import { sourceHash, type SourceFunction } from './ast/function-metrics.js';

export interface FunctionCoverage {
  status: 'available' | 'unavailable';
  reason?: string;
  basis?: 'istanbul-statement-start-lines';
  coveredLines?: number;
  measuredLines?: number;
  fraction?: number;
  crap?: number;
}

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
  if (!statementMap || !s || typeof statementMap !== 'object' || typeof s !== 'object')
    return unavailable('Malformed statement coverage.');
  const lines = new Map<number, boolean>();
  const offsets = [0];
  for (let offset = 0; offset < source.length; offset++) if (source[offset] === '\n') offsets.push(offset + 1);
  for (const [id, span] of Object.entries(statementMap)) {
    const line = span?.start?.line;
    const column = span?.start?.column;
    const count = s[id];
    if (
      !Number.isInteger(line) ||
      !Number.isInteger(column) ||
      line! < 1 ||
      line! > offsets.length ||
      column! < 0 ||
      !Number.isFinite(count) ||
      count! < 0
    )
      return unavailable('Malformed statement coverage locations or counts.');
    const start = offsets[line! - 1]! + column!;
    if (start < fn.startOffset || start >= fn.endOffset) continue;
    if (
      peers.some(
        (peer) =>
          peer !== fn &&
          peer.startOffset > fn.startOffset &&
          peer.endOffset <= fn.endOffset &&
          start >= peer.startOffset &&
          start < peer.endOffset,
      )
    )
      continue;
    lines.set(line!, (lines.get(line!) ?? false) || count! > 0);
  }
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
