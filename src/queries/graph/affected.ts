import type { ScipDatabase } from '../../storage/db.js';
import { findExactSymbolMatch, findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { findEnclosingDefinition, getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { getCallerRowsMapForSymbols } from '../../symbols/graph/call-graph-evidence.js';
import type { SymbolMatch } from '../../domain/types.js';
import { leafSuffix, shortenSymbol } from '../../symbols/symbol-parser.js';
import { detectAstLanguage } from '../../source/ast.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';

export interface AffectedResult {
  symbol: string;
  shortName: string;
  file: string;
  depth: number;
}

export interface PossibleImpactCoverage {
  status: 'accounted' | 'bounded' | 'incomplete';
  edgeBasis: 'reverse-static-call-or-reference-evidence';
  maxDepth: number;
  reachedDepth: number;
  perSymbolEvidenceLimit: number | null;
  remainingFrontierSymbols: number;
  reasons: string[];
}

export interface PossibleImpactClosureResult {
  rows: AffectedResult[];
  coverage: PossibleImpactCoverage;
}

/**
 * Bounded reverse closure of symbols that may consume a given symbol.
 * BFS from the target through the mention graph: depth 1 = direct consumers,
 * depth 2 = consumers of consumers, etc.
 */
export function affected(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { maxDepth?: number; scope?: string } = {},
): AffectedResult[] {
  return computePossibleImpactClosure(db, symbolPattern, opts).rows;
}

/** Conservative reverse reference/caller closure; rows are possible impacts, not predicted failures. */
export function possibleImpactClosure(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { maxDepth?: number; scope?: string } = {},
): PossibleImpactClosureResult {
  return computePossibleImpactClosure(db, symbolPattern, opts);
}

function computePossibleImpactClosure(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { maxDepth?: number; scope?: string },
): PossibleImpactClosureResult {
  const { maxDepth = 5, scope } = opts;
  const full = maxDepth === Number.MAX_SAFE_INTEGER;
  const perSymbolEvidenceLimit = full ? null : 500;

  const target = findFirstSymbolMatch(db, symbolPattern);
  if (!target) {
    return {
      rows: [],
      coverage: {
        status: 'incomplete',
        edgeBasis: 'reverse-static-call-or-reference-evidence',
        maxDepth,
        reachedDepth: 0,
        perSymbolEvidenceLimit,
        remainingFrontierSymbols: 0,
        reasons: ['The requested symbol could not be resolved.'],
      },
    };
  }

  const results: AffectedResult[] = [];
  const visited = new Set<number>([target.symbolId]);
  const seenResults = new Set<string>();
  let frontier = [target];
  let reachedDepth = 0;
  let perSymbolEvidenceBounded = false;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;
    reachedDepth = depth;

    const nextFrontier: typeof frontier = [];
    const callerRows = getCallerRowsMapForSymbols(db, frontier, {
      ...(full ? {} : { limit: perSymbolEvidenceLimit! + 1 }),
      semanticEvidence: symbolSemanticEvidence,
    });

    for (const current of frontier) {
      const prefetched = callerRows.get(current.symbolId) ?? [];
      if (perSymbolEvidenceLimit !== null && prefetched.length > perSymbolEvidenceLimit) {
        perSymbolEvidenceBounded = true;
      }
      const selected = perSymbolEvidenceLimit === null ? prefetched : prefetched.slice(0, perSymbolEvidenceLimit);
      for (const row of getDirectAffectedRows(db, current, scope, selected)) {
        const resultKey = `${row.file}|${row.shortName}`;
        if (row.symbolId !== null) {
          if (visited.has(row.symbolId)) continue;
          visited.add(row.symbolId);
        } else if (seenResults.has(resultKey)) {
          continue;
        }

        seenResults.add(resultKey);
        results.push({
          symbol: row.symbol,
          shortName: row.shortName,
          file: row.file,
          depth,
        });

        if (row.symbolId !== null && row.symbolMatch) {
          nextFrontier.push(row.symbolMatch);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Sort by depth then file path
  results.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  const depthBounded = frontier.length > 0;
  const reasons: string[] = [];
  if (depthBounded) reasons.push(`${frontier.length} symbol(s) remain eligible beyond depth ${maxDepth}.`);
  if (perSymbolEvidenceBounded) {
    reasons.push(`At least one symbol had more than ${perSymbolEvidenceLimit} incoming evidence row(s).`);
  }
  if (reasons.length === 0) reasons.push('The discovered reverse evidence frontier was exhausted.');
  return {
    rows: results,
    coverage: {
      status: depthBounded || perSymbolEvidenceBounded ? 'bounded' : 'accounted',
      edgeBasis: 'reverse-static-call-or-reference-evidence',
      maxDepth,
      reachedDepth,
      perSymbolEvidenceLimit,
      remainingFrontierSymbols: frontier.length,
      reasons,
    },
  };
}

// scip-query: ignore-similar — shares enclosing-definition + symbol-lookup
// helpers with forwardSlice; computes BFS-affected rows for impact propagation,
// not slice connectivity. Different intent.
function getDirectAffectedRows(
  db: ScipDatabase,
  target: SymbolMatch,
  scope: string | undefined,
  prefetchedCallerRows: ReadonlyArray<{ symbol: string; file: string }>,
): Array<{
  symbolId: number | null;
  symbol: string;
  shortName: string;
  file: string;
  symbolMatch: SymbolMatch | null;
}> {
  // Two sources unioned: AST-backed callers (precise enclosing function for
  // call expressions) PLUS targeted file-level references from SCIP mentions
  // (catches type-annotation users — `function f(x: Target)` doesn't appear
  // as a call but the file IS affected if Target's API changes).
  const callerRows = prefetchedCallerRows
    .filter((row) => !db.isIgnored(row.file))
    .filter((row) => !scope || row.file.includes(scope));

  const callerSeenFiles = new Set(callerRows.map((r) => r.file));
  const typeReferenceRows: Array<{ symbol: string; file: string }> = [];
  for (const file of consumerFilesForSymbol(db, target, scope)) {
    if (callerSeenFiles.has(file)) continue;
    // For type-only consumers, attribute to the file's first definition that
    // mentions the target's leaf in source — the closest "owner" we can name
    // without per-line precision. If no enclosing def is found, attribute to
    // the file as a whole (symbolId: null).
    const fileDefs = getDefinitionsForFile(db, file);
    const enclosing = fileDefs.length > 0 ? findEnclosingDefinition(fileDefs, fileDefs[0]!.startLine) : null;
    typeReferenceRows.push({
      symbol: enclosing?.symbol ?? file,
      file,
    });
  }
  const allCallerRows = [...callerRows, ...typeReferenceRows];

  const results: Array<{
    symbolId: number | null;
    symbol: string;
    shortName: string;
    file: string;
    symbolMatch: SymbolMatch | null;
  }> = [];
  const seen = new Set<string>();

  for (const row of allCallerRows) {
    const match = findExactSymbolMatch(db, row.symbol);
    if (!match) {
      const key = `${row.file}|${row.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        symbolId: null,
        symbol: row.symbol,
        shortName: shortenSymbol(row.symbol),
        file: row.file,
        symbolMatch: null,
      });
      continue;
    }

    if (match.symbolId === target.symbolId || db.isIgnored(match.relativePath)) {
      continue;
    }
    if (!canPropagateImpact(match)) {
      continue;
    }

    const key = `${match.symbolId}|${match.relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      symbolId: match.symbolId,
      symbol: match.symbol,
      shortName: shortenSymbol(match.symbol),
      file: match.relativePath,
      symbolMatch: match,
    });
  }

  return results;
}

function consumerFilesForSymbol(db: ScipDatabase, target: SymbolMatch, scope: string | undefined): Set<string> {
  const scopeFilter = scope ? 'AND consumer_d.relative_path LIKE ?' : '';
  const params: Array<number | string> = [target.symbolId, target.documentId];
  if (scope) params.push(`%${scope}%`);

  return new Set(
    db
      .all<{ relative_path: string }>(
        `SELECT DISTINCT consumer_d.relative_path
       FROM mentions m
       JOIN chunks c ON m.chunk_id = c.id
       JOIN documents consumer_d ON consumer_d.id = c.document_id
       WHERE m.symbol_id = ?
         AND m.role != 1
         AND c.document_id != ?
         ${db.pathExclusionsFor('consumer_d')}
         ${scopeFilter}`,
        ...params,
      )
      .map((row) => row.relative_path)
      .filter((file) => !db.isIgnored(file)),
  );
}

function canPropagateImpact(match: SymbolMatch): boolean {
  if (match.symbol.startsWith('scip-clojure ') || detectAstLanguage(match.relativePath) === 'clojure') return true;
  const suffix = leafSuffix(match.symbol);
  return suffix === 'method' || suffix === 'type' || match.symbol.endsWith('().');
}
