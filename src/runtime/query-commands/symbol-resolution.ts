import type { ScipDatabase } from '../../storage/db.js';
import { nearestSymbolNames, resolveSymbol } from '../../symbols/symbol-lookup.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import type { SymbolResolution } from '../../domain/types.js';
import { displayLine } from '../render.js';

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

export function symbolResolutionBefore(db: ScipDatabase, query: string): void {
  const resolution = resolveSymbol(db, query);
  const rows = symbolResolutionNoticeRows(resolution);
  for (const row of rows) console.log(row);
}

export function symbolResolutionEmptyMessage(
  db: ScipDatabase,
  query: string,
  fallback = 'No results found for resolved symbol.',
): string {
  return resolveSymbol(db, query).match ? fallback : noMatchMessage(query, nearestSymbolNames(db, query, 5));
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

export function noMatchMessage(query: string, suggestions: readonly string[]): string {
  const base = `No definition matched '${query}'.`;
  return suggestions.length > 0 ? `${base} Suggestions: ${suggestions.join(', ')}` : base;
}

function symbolResolutionNoticeRows(resolution: SymbolResolution): string[] {
  if (!resolution.match || resolution.total <= 1) return [];
  const match = resolution.match;
  const others = Math.max(0, resolution.total - 1);
  const rows = [
    `Resolved: ${shortenSymbol(match.symbol)} (${match.relativePath}) -- ${others} other definition(s) share this name; qualify as <dir/leaf> to target another.`,
  ];
  const alternates = resolution.candidates.slice(0, 3);
  if (alternates.length > 0) {
    rows.push(
      `Alternates: ${alternates
        .map((candidate) => `${candidate.shortName} (${candidate.relativePath}:${displayLine(candidate.startLine)})`)
        .join('; ')}`,
    );
  }
  rows.push('');
  return rows;
}
