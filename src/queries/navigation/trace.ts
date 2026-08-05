import type { ScipDatabase } from '../../storage/db.js';
import { cleanSignature, extractSignature, findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { referenceEvidenceForSymbol } from '../../symbols/references/reference-sites.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { isFunctionLikeSymbol, leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../internal/inspection-limits.js';
import { referenceSourceSnippet } from './source-snippet.js';

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

export type TraceReferenceProvenance = 'source-attribution' | 'scip-reference-chunk';
export type TraceReferenceSourceKind =
  | 'complete-call-expression'
  | 'non-call-reference'
  | 'bounded-context'
  | 'unavailable';

export interface TraceReferenceEvidence {
  relativePath: string;
  line: number;
  provenance: TraceReferenceProvenance;
  sourceKind: TraceReferenceSourceKind;
}

export interface QualifiedTraceEvidenceResult extends TraceEvidenceResult {
  referenceEvidence: TraceReferenceEvidence[];
  claimSupport: TraceClaimSupport | null;
}

export type TraceClaimEligibility =
  | {
      status: 'eligible';
      scope: string;
      limitations: string[];
    }
  | {
      status: 'ineligible';
      scope: string;
      reason: string;
      followup: string | null;
    };

export interface TraceClaimSupport {
  referenceAbsence: TraceClaimEligibility;
  callsitePredicates: TraceClaimEligibility;
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
  const qualified = qualifiedTraceEvidence(db, symbolPattern, opts);
  return { definitions: qualified.definitions, referencedBy: qualified.referencedBy };
}

/** Trace a symbol with explicit metadata governing which claims its source can support. */
export function qualifiedTraceEvidence(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { semantic?: boolean; referenceContext?: number } = {},
): QualifiedTraceEvidenceResult {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) {
    return { definitions: [], referencedBy: [], referenceEvidence: [], claimSupport: null };
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
  const qualifiedReferences = referenceEvidenceForSymbol(db, match, {
    semantic: opts.semantic,
    semanticEvidence: symbolSemanticEvidence,
  }).map((site) => {
    const snippet = referenceSourceSnippet(db, site.file, site.line, referenceContext, leafName(match.symbol));
    return {
      relativePath: site.file,
      line: site.line,
      enclosingSymbol: site.enclosingSymbol,
      enclosingShort: site.enclosingSymbol ? shortenSymbol(site.enclosingSymbol) : '(top-level)',
      provenance: site.provenance,
      sourceStartLine: snippet?.startLine ?? null,
      sourceEndLine: snippet?.endLine ?? null,
      source: snippet?.source ?? null,
      sourceKind: snippet?.kind ?? ('unavailable' as const),
    };
  });

  const referencedBy = qualifiedReferences.map(stripReferenceQualification);
  return {
    definitions,
    referencedBy,
    referenceEvidence: qualifiedReferences.map((reference) => ({
      relativePath: reference.relativePath,
      line: reference.line,
      provenance: reference.provenance,
      sourceKind: reference.sourceKind,
    })),
    claimSupport: claimSupportFor(qualifiedReferences),
  };
}

type QualifiedReference = QualifiedTraceEvidenceResult['referencedBy'][number] & {
  provenance: TraceReferenceProvenance;
  sourceKind: TraceReferenceSourceKind;
};

function stripReferenceQualification(reference: QualifiedReference): TraceEvidenceResult['referencedBy'][number] {
  return {
    relativePath: reference.relativePath,
    line: reference.line,
    enclosingSymbol: reference.enclosingSymbol,
    enclosingShort: reference.enclosingShort,
    sourceStartLine: reference.sourceStartLine,
    sourceEndLine: reference.sourceEndLine,
    source: reference.source,
  };
}

function claimSupportFor(references: readonly QualifiedReference[]): TraceClaimSupport {
  const referenceScope = 'resolved source-attributed or SCIP-indexed references to this exact symbol';
  const limitations = ['Dynamic dispatch, reflection, generated calls, and unindexed source are outside this scope.'];
  const uncertain = references.filter(
    (reference) => reference.sourceKind !== 'complete-call-expression' && reference.sourceKind !== 'non-call-reference',
  );
  const callsiteScope = 'direct, statically visible call expressions among the resolved reference sites';
  return {
    referenceAbsence: {
      status: 'eligible',
      scope: referenceScope,
      limitations,
    },
    callsitePredicates:
      uncertain.length === 0
        ? {
            status: 'eligible',
            scope: callsiteScope,
            limitations,
          }
        : {
            status: 'ineligible',
            scope: callsiteScope,
            reason: `${uncertain.length} reference site(s) lack one unambiguous complete call expression.`,
            followup: callsiteFollowup(uncertain),
          },
  };
}

function callsiteFollowup(references: readonly QualifiedReference[]): string | null {
  const locations = [...new Set(references.map((reference) => `${reference.relativePath}:${reference.line + 1}`))];
  if (locations.length === 0 || locations.length > SOURCE_INSPECTION_MAX_SELECTORS) return null;
  return `scip-query inspect ${locations.map((location) => `--at ${shellArgument(location)}`).join(' ')} --view behavior`;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
