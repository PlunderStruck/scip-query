import type { ScipDatabase } from '../../storage/db.js';
import { compileBoundedRegExp } from '../../domain/bounded-regexp.js';
import { getDefinitionsForFile, findEnclosingDefinition } from '../../symbols/definition-catalog.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { sourceSnippet, type SourceSnippet } from './source-snippet.js';

export interface SourceSearchMatch extends SourceSnippet {
  ownerSymbol: string | null;
  ownerShort: string | null;
}

export interface SourceSearchResult {
  pattern: string;
  mode: 'literal' | 'regexp';
  matches: SourceSearchMatch[];
  matchingLines: number;
  omittedMatches: number;
  scannedFiles: number;
}

export interface SourceSearchOptions {
  scope?: string;
  context?: number;
  limit?: number;
  regexp?: boolean;
  ignoreCase?: boolean;
}

/** Search the source of indexed documents and retain line and symbol ownership. */
export function searchSource(db: ScipDatabase, pattern: string, opts: SourceSearchOptions = {}): SourceSearchResult {
  if (pattern.length === 0) throw new Error('The source search pattern must not be empty.');
  const context = opts.context ?? 6;
  const limit = opts.limit ?? 12;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive safe integer; received ${limit}`);
  }
  const regexp = opts.regexp
    ? compileBoundedRegExp(pattern, 'source search pattern', opts.ignoreCase ? 'iu' : 'u')
    : null;
  const literal = opts.ignoreCase ? pattern.toLocaleLowerCase() : pattern;
  const paths = indexedDocumentPaths(db, { scope: opts.scope, includeIgnored: false });
  const matches: SourceSearchMatch[] = [];
  let matchingLines = 0;

  for (const relativePath of paths) {
    const lines = getSourceLines(db, relativePath);
    if (lines.length === 0) continue;
    const definitions = getDefinitionsForFile(db, relativePath);
    for (let line = 0; line < lines.length; line += 1) {
      const text = lines[line] ?? '';
      const matched = regexp
        ? regexp.test(text)
        : (opts.ignoreCase ? text.toLocaleLowerCase() : text).includes(literal);
      if (!matched) continue;
      matchingLines += 1;
      if (matches.length >= limit) continue;
      const snippet = sourceSnippet(db, relativePath, line, context);
      if (!snippet) continue;
      const owner = findEnclosingDefinition(definitions, line);
      matches.push({
        ...snippet,
        ownerSymbol: owner?.symbol ?? null,
        ownerShort: owner ? shortenSymbol(owner.symbol) : null,
      });
    }
  }

  return {
    pattern,
    mode: opts.regexp ? 'regexp' : 'literal',
    matches,
    matchingLines,
    omittedMatches: Math.max(0, matchingLines - matches.length),
    scannedFiles: paths.length,
  };
}
