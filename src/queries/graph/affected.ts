import type { ScipDatabase } from '../../storage/db.js';
import { findExactSymbolMatch, resolveSymbol } from '../../symbols/symbol-lookup.js';
import { findEnclosingDefinition, getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { getCallerRowsMapForSymbols } from '../../symbols/graph/call-graph-evidence.js';
import type { SymbolMatch } from '../../domain/types.js';
import { leafSuffix, shortenSymbol } from '../../symbols/symbol-parser.js';
import { detectAstLanguage } from '../../source/ast.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { referenceOccurrenceLines } from '../../storage/scip-rows.js';

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
// scip-query: ignore-passthrough — public compatibility name preserves the conservative possible-impact contract.
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

  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0)
    throw new RangeError('Impact depth must be a non-negative safe integer.');
  const resolution = resolveSymbol(db, symbolPattern);
  if (resolution.candidates.length > 0)
    throw new Error(`Ambiguous symbol: ${symbolPattern}. Use an exact SCIP symbol or file:line.`);
  const target = resolution.match;
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

    const level = directImpactLevel(db, frontier, scope, perSymbolEvidenceLimit);
    perSymbolEvidenceBounded ||= level.bounded;
    const nextFrontier = appendImpactRows(level.rows, depth, visited, seenResults, results);

    frontier = nextFrontier;
  }

  // Sort by depth then file path
  results.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  return {
    rows: results,
    coverage: impactCoverage(
      results,
      maxDepth,
      reachedDepth,
      perSymbolEvidenceLimit,
      frontier.length,
      perSymbolEvidenceBounded,
    ),
  };
}

function impactCoverage(
  results: readonly AffectedResult[],
  maxDepth: number,
  reachedDepth: number,
  perSymbolEvidenceLimit: number | null,
  remainingFrontierSymbols: number,
  perSymbolEvidenceBounded: boolean,
): PossibleImpactCoverage {
  const depthBounded = remainingFrontierSymbols > 0;
  const reasons: string[] = [];
  if (depthBounded) reasons.push(`${remainingFrontierSymbols} symbol(s) remain eligible beyond depth ${maxDepth}.`);
  if (perSymbolEvidenceBounded) {
    reasons.push(`At least one symbol had more than ${perSymbolEvidenceLimit} incoming evidence row(s).`);
  }
  const fileOnly = results.filter((row) => row.symbol === row.file).length;
  if (fileOnly > 0)
    reasons.push(`${fileOnly} consumer file(s) lack an exact owning symbol; further symbol propagation is unknown.`);
  if (reasons.length === 0) reasons.push('The discovered reverse evidence frontier was exhausted.');
  return {
    status: fileOnly > 0 ? 'incomplete' : depthBounded || perSymbolEvidenceBounded ? 'bounded' : 'accounted',
    edgeBasis: 'reverse-static-call-or-reference-evidence',
    maxDepth,
    reachedDepth,
    perSymbolEvidenceLimit,
    remainingFrontierSymbols,
    reasons,
  };
}

function directImpactLevel(
  db: ScipDatabase,
  frontier: readonly SymbolMatch[],
  scope: string | undefined,
  limit: number | null,
): { rows: DirectAffectedRow[]; bounded: boolean } {
  const callerRows = getCallerRowsMapForSymbols(db, frontier, {
    ...(limit === null ? {} : { limit: limit + 1 }),
    semanticEvidence: symbolSemanticEvidence,
  });
  const rows: DirectAffectedRow[] = [];
  let bounded = false;
  for (const current of frontier) {
    const prefetched = callerRows.get(current.symbolId) ?? [];
    if (limit !== null && prefetched.length > limit) bounded = true;
    const selected = limit === null ? prefetched : prefetched.slice(0, limit);
    rows.push(...getDirectAffectedRows(db, current, scope, selected));
  }
  return { rows, bounded };
}

function appendImpactRows(
  rows: readonly DirectAffectedRow[],
  depth: number,
  visited: Set<number>,
  seenResults: Set<string>,
  results: AffectedResult[],
): SymbolMatch[] {
  const nextFrontier: SymbolMatch[] = [];
  for (const row of rows) {
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
  return nextFrontier;
}

// scip-query: ignore-similar — shares enclosing-definition + symbol-lookup
// helpers with forwardSlice; computes BFS-affected rows for impact propagation,
// not slice connectivity. Different intent.
function getDirectAffectedRows(
  db: ScipDatabase,
  target: SymbolMatch,
  scope: string | undefined,
  prefetchedCallerRows: ReadonlyArray<{ symbol: string; file: string }>,
): DirectAffectedRow[] {
  // Two sources unioned: AST-backed callers (precise enclosing function for
  // call expressions) PLUS targeted file-level references from SCIP mentions
  // (catches type-annotation users — `function f(x: Target)` doesn't appear
  // as a call but the file IS affected if Target's API changes).
  const callerRows = prefetchedCallerRows
    .filter((row) => !db.isIgnored(row.file))
    .filter((row) => !scope || row.file.includes(scope));

  const typeReferenceRows = referenceConsumerRows(db, target, scope, new Set(callerRows.map((row) => row.file)));
  const allCallerRows = [...callerRows, ...typeReferenceRows];

  const results: DirectAffectedRow[] = [];
  const seen = new Set<string>();
  for (const row of allCallerRows) {
    const resolved = resolveAffectedRow(db, target, row);
    if (!resolved || seen.has(resolved.key)) continue;
    seen.add(resolved.key);
    results.push(resolved.row);
  }
  return results;
}

interface DirectAffectedRow {
  symbolId: number | null;
  symbol: string;
  shortName: string;
  file: string;
  symbolMatch: SymbolMatch | null;
}

function referenceConsumerRows(
  db: ScipDatabase,
  target: SymbolMatch,
  scope: string | undefined,
  callerSeenFiles: ReadonlySet<string>,
): Array<{ symbol: string; file: string }> {
  const typeReferenceRows: Array<{ symbol: string; file: string }> = [];
  for (const file of consumerFilesForSymbol(db, target, scope)) {
    const lines = referenceOccurrenceLines(db, file, target.symbol);
    const definitions = getDefinitionsForFile(db, file);
    const owners = new Set<string>();
    for (const line of lines ?? []) {
      const owner = findEnclosingDefinition(definitions, line);
      if (owner && canPropagateImpact(owner)) owners.add(owner.symbol);
    }
    for (const symbol of owners) typeReferenceRows.push({ symbol, file });
    // A file-level reference cannot justify inventing a function owner.
    // Keep the file as an unresolved frontier unless another observed owner
    // already represents this file. Exact occurrence owners above still join.
    if (owners.size === 0 && !callerSeenFiles.has(file)) typeReferenceRows.push({ symbol: file, file });
  }
  return typeReferenceRows;
}

/** Preserve unresolved file/SCIP identity; only exact propagatable declarations enter the symbol frontier. */
function resolveAffectedRow(
  db: ScipDatabase,
  target: SymbolMatch,
  row: { symbol: string; file: string },
): { key: string; row: DirectAffectedRow } | null {
  const match = findExactSymbolMatch(db, row.symbol);
  if (!match) {
    return {
      key: `${row.file}|${row.symbol}`,
      row: {
        symbolId: null,
        symbol: row.symbol,
        shortName: shortenSymbol(row.symbol),
        file: row.file,
        symbolMatch: null,
      },
    };
  }
  if (match.symbolId === target.symbolId || db.isIgnored(match.relativePath) || !canPropagateImpact(match)) return null;
  return {
    key: `${match.symbolId}|${match.relativePath}`,
    row: {
      symbolId: match.symbolId,
      symbol: match.symbol,
      shortName: shortenSymbol(match.symbol),
      file: match.relativePath,
      symbolMatch: match,
    },
  };
}

function consumerFilesForSymbol(db: ScipDatabase, target: SymbolMatch, scope: string | undefined): Set<string> {
  const scopeFilter = scope ? 'AND instr(consumer_d.relative_path, ?) > 0' : '';
  const params: Array<number | string> = [target.symbolId, target.documentId];
  if (scope) params.push(scope);

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
