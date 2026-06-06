import type { ScipDatabase } from '../storage/db.js';
import { cleanSignature, extractSignature, findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import { getResolvedReferenceSites } from '../symbols/reference-graph.js';
import { getSourceReferenceSites } from '../symbols/identifier-attribution.js';
import { getSourceText } from '../source/source-text.js';
import type { TraceResult } from '../domain/types.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../symbols/symbol-parser.js';

// scip-query: ignore-extract — trace is the user-facing evidence assembly:
// definition metadata plus source-scan references with mention fallback.
export function trace(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { semantic?: boolean } = {},
): TraceResult {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) {
    return { definitions: [], referencedBy: [] };
  }

  const definitionMeta = db.get<{ display_name: string | null; documentation: string | null }>(
    'SELECT display_name, documentation FROM global_symbols WHERE id = ?',
    match.symbolId,
  );
  const sig = extractSignature(definitionMeta?.documentation ?? null);

  const definitions = db.isIgnored(match.relativePath)
    ? []
    : [{
      relativePath: match.relativePath,
      startLine: match.startLine,
      endLine: match.endLine,
      signature: buildTraceSignature(sig, definitionMeta?.display_name ?? null, match.symbol),
      source: definitionSource(db, match.relativePath, match.startLine, match.endLine),
    }];

  // Primary: cross-file identifier scan. Fallback: mention-resolved sites
  // with in-chunk line refinement (precise line, not chunk-start).
  const sourceSites = getSourceReferenceSites(db, match, { semantic: opts.semantic });
  const resolvedSites = sourceSites.length > 0 ? sourceSites : getResolvedReferenceSites(db, match);
  const referencedBy = resolvedSites
    .filter((site) => !db.isIgnored(site.file))
    .map((site) => ({
      relativePath: site.file,
      line: site.line,
      enclosingSymbol: site.enclosingSymbol,
      enclosingShort: site.enclosingSymbol ? shortenSymbol(site.enclosingSymbol) : '(top-level)',
    }));

  return { definitions, referencedBy };
}

function definitionSource(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): string | null {
  const source = getSourceText(db, relativePath);
  if (!source) {
    return null;
  }

  const lines = source.split('\n');
  const slice = lines.slice(startLine, endLine + 1).join('\n').trimEnd();
  return slice.length > 0 ? slice : null;
}

function buildTraceSignature(
  signature: string | null,
  displayName: string | null,
  rawSymbol: string,
): string | null {
  const cleaned = cleanSignature(signature);
  if (cleaned && !looksBogusSignature(cleaned)) {
    return cleaned;
  }

  const fallback = (displayName ?? '').trim();
  if (fallback) {
    return isFunctionLikeSymbol(rawSymbol) && !fallback.endsWith('()')
      ? `${fallback}()`
      : fallback;
  }

  return shortenSymbol(rawSymbol);
}

function looksBogusSignature(signature: string): boolean {
  return signature.startsWith('undefined') || signature.includes('|') || signature.includes('```');
}
