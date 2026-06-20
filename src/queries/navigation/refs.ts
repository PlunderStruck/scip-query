import type { ScipDatabase } from '../../storage/db.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { referenceSitesForSymbol } from '../../symbols/references/reference-sites.js';
import { getSourceText } from '../../source/source-text.js';
import { isFunctionLikeSymbol } from '../../symbols/symbol-parser.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';

export interface RefResult {
  relativePath: string;
  line: number;
}

export function refs(db: ScipDatabase, symbolPattern: string, opts: { semantic?: boolean } = {}): RefResult[] {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return [];

  const includeDefinitionSite = !isFunctionLikeSymbol(match.symbol);
  const definitionRows: RefResult[] =
    includeDefinitionSite && !db.isIgnored(match.relativePath)
      ? [{ relativePath: match.relativePath, line: match.startLine }]
      : [];

  const referenceSites = referenceSitesForSymbol(db, match, { semantic: opts.semantic }).map((site) => ({
    relativePath: site.file,
    line: site.line,
  }));

  const rubySites = getRubySemanticRefs(db, match);

  const seen = new Set<string>();
  const out: RefResult[] = [];
  for (const row of [...definitionRows, ...referenceSites, ...rubySites]) {
    const key = `${row.relativePath}:${row.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// scip-query: ignore-extract — this Ruby fallback is a narrow semantic
// evidence adapter; splitting its guard/query/filter/project sequence would
// obscure why it only runs for Ruby symbols.
function getRubySemanticRefs(
  db: ScipDatabase,
  match: NonNullable<ReturnType<typeof findFirstSymbolMatch>>,
): RefResult[] {
  if (!match.relativePath.endsWith('.rb')) {
    return [];
  }

  const tokens = rubyReferenceTokens(match.symbol);
  if (tokens.length === 0) {
    return [];
  }

  const results: RefResult[] = [];
  for (const relativePath of indexedDocumentPaths(db, { extensions: ['.rb'], includeIgnored: false })) {
    const source = getSourceText(db, relativePath);
    if (!source) continue;

    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (tokens.some((token) => new RegExp(`@${token}\\b|\\b${token}:`).test(line))) {
        results.push({
          relativePath,
          line: index,
        });
      }
    }
  }

  return results;
}

function rubyReferenceTokens(rawSymbol: string): string[] {
  const leaf = rawSymbol.split(':').pop() ?? rawSymbol;
  const snake = leaf
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');

  const parts = snake.split('_').filter(Boolean);
  const candidates = new Set<string>();
  if (snake) candidates.add(snake);
  if (parts.length >= 1) candidates.add(parts[parts.length - 1]!);
  if (parts.length >= 2) candidates.add(parts.slice(-2).join('_'));
  return [...candidates];
}
