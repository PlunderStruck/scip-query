import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../../core/project-index.js';
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
 * Ranges come from getDefinitionsForFile so they are source-corrected
 * and match `scip symbols` output.
 */
export function members(db: ScipDatabase, symbolPattern: string): MemberResult[] {
  const parent = findFirstSymbolMatch(db, symbolPattern);
  if (!parent) return [];

  const index = new ProjectIndex(db);
  const graphMembers = index
    .definitionsForFile(parent.relativePath)
    .filter((definition) => definition.symbol !== parent.symbol)
    .filter((definition) => isDirectChildSymbol(parent.symbol, definition.symbol))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
    .map((definition) => ({
      symbol: definition.symbol,
      shortName: shortenSymbol(definition.symbol),
      startLine: definition.startLine,
      endLine: definition.endLine,
      kind: leafSuffix(definition.symbol) ?? 'unknown',
    }));
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
