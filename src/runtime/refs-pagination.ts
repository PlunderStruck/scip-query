import type { ScipDatabase } from '../storage/db.js';
import { refs, type RefResult } from '../queries/navigation/refs.js';
import { getResolvedReferenceSites } from '../symbols/references/reference-sites.js';
import { getSourceFiles } from '../source/primitives/source-fileset.js';
import { findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import { isFunctionLikeSymbol } from '../symbols/symbol-parser.js';
import { sourceReferenceLinesForFile, sourceReferenceTarget } from '../symbols/identifier-attribution.js';
import type { ResultKeyset, ResultPageProducer } from './result-pagination.js';

export interface RefPageInstrumentation {
  fileScanned?(relativePath: string): void;
  rowAccepted?(row: RefResult): void;
}

export interface RefPageRequest {
  limit: number;
  after?: ResultKeyset;
  producer?: ResultPageProducer;
  semantic?: boolean;
  instrumentation?: RefPageInstrumentation;
}

export interface RefPage {
  rows: RefResult[];
  hasMore: boolean;
  producer: ResultPageProducer;
  semanticEnrichment: boolean;
}

/**
 * Produces one stable logical page of references.
 *
 * The normal limited path walks source files from the prior `(path, line)`
 * frontier and stops after `limit + 1` eligible rows. Providers that cannot
 * resume without complete materialization (explicit semantic enrichment,
 * Ruby's supplemental token rules, and SCIP chunk fallback) are preserved,
 * but labeled `complete-only` so callers never mistake their cost for a
 * producer-bounded page.
 */
export function referencePage(db: ScipDatabase, symbolPattern: string, request: RefPageRequest): RefPage {
  if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
    throw new Error('Reference page limit must be a positive safe integer.');
  }

  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) {
    return {
      rows: [],
      hasMore: false,
      producer: request.producer ?? 'source-keyset',
      semanticEnrichment: false,
    };
  }

  const requiresCompleteProvider =
    request.producer === 'complete-only' || request.semantic === true || match.relativePath.endsWith('.rb');
  if (requiresCompleteProvider) {
    return completeReferencePage(db, symbolPattern, request);
  }

  const target = sourceReferenceTarget(db, match);
  if (!target) return completeReferencePage(db, symbolPattern, request);

  const definition = definitionReference(db, match);
  const paths = sourcePathsWithDefinition(db, definition);
  const accepted: RefResult[] = [];
  let sourceReferenceFound = request.producer === 'source-keyset';

  for (const relativePath of paths) {
    if (request.after && relativePath < request.after.relativePath) continue;
    request.instrumentation?.fileScanned?.(relativePath);
    const sourceLines = sourceReferenceLinesForFile(db, target, relativePath);
    if (sourceLines.length > 0) sourceReferenceFound = true;

    const lines = new Set(sourceLines);
    if (definition?.relativePath === relativePath) lines.add(definition.line);
    for (const line of [...lines].sort((left, right) => left - right)) {
      const row = { relativePath, line };
      if (request.after && compareReferenceKey(row, request.after) <= 0) continue;
      accepted.push(row);
      request.instrumentation?.rowAccepted?.(row);
      if (sourceReferenceFound && accepted.length > request.limit) {
        return boundedPage(accepted, request.limit);
      }
    }
  }

  if (sourceReferenceFound) return boundedPage(accepted, request.limit);
  return completeReferencePage(db, symbolPattern, request, definition);
}

export function compareReferenceKey(
  left: Pick<RefResult, 'relativePath' | 'line'>,
  right: Pick<RefResult, 'relativePath' | 'line'>,
): number {
  const pathOrder = left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
  return pathOrder || left.line - right.line;
}

function boundedPage(rows: RefResult[], limit: number): RefPage {
  return {
    rows: rows.slice(0, limit),
    hasMore: rows.length > limit,
    producer: 'source-keyset',
    semanticEnrichment: false,
  };
}

function completeReferencePage(
  db: ScipDatabase,
  symbolPattern: string,
  request: RefPageRequest,
  knownDefinition?: RefResult | null,
): RefPage {
  const match = findFirstSymbolMatch(db, symbolPattern);
  const allRows =
    request.semantic === true || match?.relativePath.endsWith('.rb')
      ? refs(db, symbolPattern, { semantic: request.semantic })
      : completeFallbackRows(db, symbolPattern, knownDefinition);
  const remaining = dedupeAndSort(allRows).filter(
    (row) => !request.after || compareReferenceKey(row, request.after) > 0,
  );
  for (const row of remaining.slice(0, request.limit + 1)) request.instrumentation?.rowAccepted?.(row);
  return {
    rows: remaining.slice(0, request.limit),
    hasMore: remaining.length > request.limit,
    producer: 'complete-only',
    semanticEnrichment: request.semantic === true,
  };
}

function completeFallbackRows(
  db: ScipDatabase,
  symbolPattern: string,
  knownDefinition?: RefResult | null,
): RefResult[] {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return [];
  const definition = knownDefinition === undefined ? definitionReference(db, match) : knownDefinition;
  const fallback = getResolvedReferenceSites(db, match).map((site) => ({
    relativePath: site.file,
    line: site.line,
  }));
  return definition ? [definition, ...fallback] : fallback;
}

function definitionReference(
  db: ScipDatabase,
  match: NonNullable<ReturnType<typeof findFirstSymbolMatch>>,
): RefResult | null {
  return !isFunctionLikeSymbol(match.symbol) && !db.isIgnored(match.relativePath)
    ? { relativePath: match.relativePath, line: match.startLine }
    : null;
}

function sourcePathsWithDefinition(db: ScipDatabase, definition: RefResult | null): string[] {
  const paths = getSourceFiles(db);
  if (!definition || paths.includes(definition.relativePath)) return paths;
  return [...paths, definition.relativePath].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function dedupeAndSort(rows: readonly RefResult[]): RefResult[] {
  const byIdentity = new Map<string, RefResult>();
  for (const row of rows) byIdentity.set(`${row.relativePath}\0${row.line}`, row);
  return [...byIdentity.values()].sort(compareReferenceKey);
}
