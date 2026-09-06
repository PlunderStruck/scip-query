import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { definitionOccurrenceRanges } from '../../storage/scip-rows.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { detectAstLanguage, getSourceFacts } from '../../source/ast.js';
import { isDirectChildSymbol, leafName, leafSuffix, shortenSymbol } from '../../symbols/symbol-parser.js';

export interface MemberResult {
  symbol: string;
  shortName: string;
  startLine: number;
  endLine: number;
  kind: string;
}

/**
 * Find all direct children of a symbol (methods, fields, nested types).
 * Uses descriptor-chain fallback when enclosing_symbol is not populated.
 *
 * Full declaration ranges come from the definition catalog. Members indexed
 * only as definition occurrences use their identifier range when available.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function members(db: ScipDatabase, symbolPattern: string): MemberResult[] {
  const parent = findFirstSymbolMatch(db, symbolPattern);
  if (!parent) return [];

  const ordinary = getDefinitionsForFile(db, parent.relativePath);
  const precise = new Set(ordinary.map((definition) => definition.symbol));
  const occurrences = definitionOccurrenceRanges(db, parent.relativePath);
  const graphMembers = getDefinitionsForFile(db, parent.relativePath, { includeClassMemberFallbacks: true })
    .filter((definition) => definition.symbol !== parent.symbol)
    .filter((definition) => isDirectChildSymbol(parent.symbol, definition.symbol))
    .map((definition) => ({
      symbol: definition.symbol,
      shortName: shortenSymbol(definition.symbol),
      startLine: !precise.has(definition.symbol)
        ? (occurrences.get(definition.symbol)?.start_line ?? definition.startLine)
        : definition.startLine,
      endLine: !precise.has(definition.symbol)
        ? (occurrences.get(definition.symbol)?.end_line ?? definition.endLine)
        : definition.endLine,
      kind: leafSuffix(definition.symbol) ?? 'unknown',
    }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  if (detectAstLanguage(parent.relativePath) !== 'clojure') return graphMembers;

  return mergeMembers(graphMembers, clojureSourceMembers(db, parent));
}

function clojureSourceMembers(db: ScipDatabase, parent: { symbol: string; relativePath: string }): MemberResult[] {
  const owner = leafName(parent.symbol);
  if (!owner) return [];
  const parentShort = shortenSymbol(parent.symbol);
  return (getSourceFacts(db, parent.relativePath)?.clojureMembers ?? [])
    .filter((member) => member.ownerName === owner)
    .map((member) => ({
      symbol: `${parent.symbol}${member.memberName}().`,
      shortName: `${parentShort}:${member.memberName}()`,
      startLine: member.startLine,
      endLine: member.endLine,
      kind: member.memberKind,
    }));
}

function mergeMembers(graphMembers: MemberResult[], sourceMembers: MemberResult[]): MemberResult[] {
  const byLocation = new Map<string, MemberResult>();
  for (const member of [...graphMembers, ...sourceMembers]) {
    byLocation.set(`${member.shortName}:${member.startLine}:${member.endLine}`, member);
  }
  return [...byLocation.values()].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}
