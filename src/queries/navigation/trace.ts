import type { ScipDatabase } from '../../storage/db.js';
import { cleanSignature, extractSignature, findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { referenceSitesForSymbol } from '../../symbols/references/reference-sites.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { sourceSnippet } from './source-snippet.js';

export interface TraceResult {
  definitions: Array<{
    relativePath: string;
    startLine: number;
    endLine: number;
    signature: string | null;
    source: string | null;
  }>;
  referencedBy: Array<{
    relativePath: string;
    line: number;
    enclosingSymbol: string | null;
    enclosingShort: string;
  }>;
}

export interface TraceEvidenceResult {
  definitions: TraceResult['definitions'];
  referencedBy: Array<
    TraceResult['referencedBy'][number] & {
      sourceStartLine: number | null;
      sourceEndLine: number | null;
      source: string | null;
    }
  >;
}

// scip-query: ignore-extract — trace is the user-facing evidence assembly:
// definition metadata plus source-scan references with mention fallback.
export function trace(db: ScipDatabase, symbolPattern: string, opts: { semantic?: boolean } = {}): TraceResult {
  const result = traceEvidence(db, symbolPattern, opts);
  return {
    definitions: result.definitions,
    referencedBy: result.referencedBy.map((reference) => ({
      relativePath: reference.relativePath,
      line: reference.line,
      enclosingSymbol: reference.enclosingSymbol,
      enclosingShort: reference.enclosingShort,
    })),
  };
}

/** Trace a symbol and include bounded source around each reference. */
export function traceEvidence(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { semantic?: boolean; referenceContext?: number } = {},
): TraceEvidenceResult {
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
    : [
        {
          relativePath: match.relativePath,
          startLine: match.startLine,
          endLine: match.endLine,
          signature: buildTraceSignature(sig, definitionMeta?.display_name ?? null, match.symbol),
          source: definitionSource(db, match.relativePath, match.startLine, match.endLine),
        },
      ];

  const referenceContext = opts.referenceContext ?? 2;
  const referencedBy = referenceSitesForSymbol(db, match, {
    semantic: opts.semantic,
    semanticEvidence: symbolSemanticEvidence,
  }).map((site) => {
    const snippet = sourceSnippet(db, site.file, site.line, referenceContext);
    return {
      relativePath: site.file,
      line: site.line,
      enclosingSymbol: site.enclosingSymbol,
      enclosingShort: site.enclosingSymbol ? shortenSymbol(site.enclosingSymbol) : '(top-level)',
      sourceStartLine: snippet?.startLine ?? null,
      sourceEndLine: snippet?.endLine ?? null,
      source: snippet?.source ?? null,
    };
  });

  return { definitions, referencedBy };
}

function definitionSource(db: ScipDatabase, relativePath: string, startLine: number, endLine: number): string | null {
  const source = getSourceText(db, relativePath);
  if (!source) {
    return null;
  }

  const lines = source.split('\n');
  const slice = lines
    .slice(startLine, endLine + 1)
    .join('\n')
    .trimEnd();
  return slice.length > 0 ? slice : null;
}

function buildTraceSignature(signature: string | null, displayName: string | null, rawSymbol: string): string | null {
  const cleaned = cleanSignature(signature);
  if (cleaned && !looksBogusSignature(cleaned)) {
    return cleaned;
  }

  const fallback = (displayName ?? '').trim();
  if (fallback) {
    return isFunctionLikeSymbol(rawSymbol) && !fallback.endsWith('()') ? `${fallback}()` : fallback;
  }

  return shortenSymbol(rawSymbol);
}

function looksBogusSignature(signature: string): boolean {
  return signature.startsWith('undefined') || signature.includes('|') || signature.includes('```');
}
