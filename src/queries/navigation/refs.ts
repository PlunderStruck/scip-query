import type { ScipDatabase } from '../../storage/db.js';
import { referenceOccurrenceLines } from '../../storage/scip-rows.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { referenceSitesForSymbol } from '../../symbols/references/reference-sites.js';
import { isFunctionLikeSymbol } from '../../symbols/symbol-parser.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';

export interface RefResult {
  relativePath: string;
  line: number;
  evidence?: 'indexed-occurrence' | 'indexed-definition' | 'source-or-chunk-candidate';
}

export function refs(db: ScipDatabase, symbolPattern: string, opts: { semantic?: boolean } = {}): RefResult[] {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return [];

  const includeDefinitionSite = !isFunctionLikeSymbol(match.symbol);
  const definitionRows: RefResult[] =
    includeDefinitionSite && !db.isIgnored(match.relativePath)
      ? [{ relativePath: match.relativePath, line: match.startLine, evidence: 'indexed-definition' }]
      : [];

  const referenceSites = referenceSitesForSymbol(db, match, {
    semantic: opts.semantic,
    semanticEvidence: symbolSemanticEvidence,
  }).map((site) => referenceLocation(db, match.symbol, site.file, site.line));

  const seen = new Set<string>();
  const out: RefResult[] = [];
  for (const row of [...definitionRows, ...referenceSites]) {
    const key = `${row.relativePath}:${row.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Preserve whether this location is an index binding or a name/chunk candidate. */
export function referenceLocation(db: ScipDatabase, symbol: string, relativePath: string, line: number): RefResult {
  return {
    relativePath,
    line,
    evidence: referenceOccurrenceLines(db, relativePath, symbol)?.includes(line)
      ? 'indexed-occurrence'
      : 'source-or-chunk-candidate',
  };
}
