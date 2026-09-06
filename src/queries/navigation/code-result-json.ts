import type { ScipDatabase } from '../../storage/db.js';
import { nearestSymbolNames, resolveSymbol } from '../../symbols/symbol-lookup.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import type { CodeBatchResult, CodeResult } from './code.js';

/** Stable machine-readable views shared by direct and persistent navigation paths. */
export interface SymbolResolutionJson {
  matched: boolean;
  resolved?: {
    symbol: string;
    shortName: string;
    relativePath: string;
  };
  otherMatches?: Array<{
    shortName: string;
    relativePath: string;
    startLine: number;
  }>;
  totalMatches?: number;
  suggestions?: string[];
}

export function symbolResolutionJson(db: ScipDatabase, query: string): SymbolResolutionJson {
  const resolution = resolveSymbol(db, query);
  if (!resolution.match) {
    return {
      matched: false,
      suggestions: nearestSymbolNames(db, query, 5),
    };
  }
  return {
    matched: true,
    resolved: {
      symbol: resolution.match.symbol,
      shortName: shortenSymbol(resolution.match.symbol),
      relativePath: resolution.match.relativePath,
    },
    otherMatches: resolution.candidates.map((candidate) => ({
      shortName: candidate.shortName,
      relativePath: candidate.relativePath,
      startLine: candidate.startLine,
    })),
    totalMatches: resolution.total,
  };
}

export function withSymbolResolutionJson<T>(
  db: ScipDatabase,
  query: string,
  payload: T,
  payloadKey: string,
): SymbolResolutionJson & Record<string, unknown> {
  return {
    ...symbolResolutionJson(db, query),
    [payloadKey]: payload,
  };
}

export function singleExactCodeResult(result: CodeBatchResult): CodeResult | null {
  const entry = result.entries[0];
  return result.requested === 1 &&
    entry?.status === 'matched' &&
    entry.kind === 'source' &&
    (!entry.rangeCoverage || entry.rangeCoverage.referencedDefinitions === 0) &&
    entry.results.length === 1
    ? entry.results[0]!
    : null;
}

export function codeResultOnlyJson(db: ScipDatabase, query: string, result: CodeResult | null): unknown {
  if (!result) return symbolResolutionJson(db, query);
  const projected = {
    file: result.relativePath,
    symbol: result.shortName,
    language: result.language ?? 'unknown',
    range: {
      startLine: displayLine(result.startLine),
      endLine: displayLine(result.endLine),
    },
    ...(result.freshness ? { freshness: result.freshness } : {}),
    lines: result.source.split('\n').map((text, index) => ({
      line: displayLine(result.startLine + index),
      text,
    })),
  };
  const resolution = symbolResolutionJson(db, query);
  const totalMatches = resolution.totalMatches ?? 0;
  if (!resolution.matched || !resolution.resolved || totalMatches <= 1) return projected;
  return {
    ...projected,
    resolution: {
      selected: resolution.resolved,
      alternatives: resolution.otherMatches ?? [],
      totalMatches,
    },
  };
}

export function codeBatchResultOnlyJson(result: CodeBatchResult): unknown {
  return {
    requested: result.requested,
    matched: result.matched,
    ambiguous: result.ambiguous,
    missing: result.missing,
    entries: result.entries.map((entry) => ({
      selector: entry.selector,
      status: entry.status,
      kind: entry.kind,
      totalCandidates: entry.totalCandidates,
      sources: entry.results.map((source) => ({
        file: source.relativePath,
        symbol: source.shortName,
        language: source.language ?? 'unknown',
        range: { startLine: displayLine(source.startLine), endLine: displayLine(source.endLine) },
        ...(source.freshness ? { freshness: source.freshness } : {}),
        lines: source.source.split('\n').map((text, index) => ({
          line: displayLine(source.startLine + index),
          text,
        })),
      })),
      definitions: entry.definitions,
      ...(entry.fileCoverage ? { fileCoverage: entry.fileCoverage } : {}),
      ...(entry.rangeCoverage ? { rangeCoverage: entry.rangeCoverage } : {}),
      candidates: entry.candidates,
      omittedCandidates: entry.omittedCandidates,
      suggestions: entry.suggestions,
      ...(entry.reason ? { reason: entry.reason } : {}),
    })),
    literalValues: result.bindingClosure.inline,
  };
}

export function codeBatchResultOnlyJsonForSelectors(
  db: ScipDatabase,
  selectors: readonly string[],
  result: CodeBatchResult,
): unknown {
  const single = singleExactCodeResult(result);
  return single ? codeResultOnlyJson(db, selectors[0]!, single) : codeBatchResultOnlyJson(result);
}

function displayLine(line: number): number {
  return line + 1;
}
