import type { ScipDatabase } from '../../storage/db.js';
import type { SymbolResolutionCandidate } from '../../domain/types.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { callGraph } from './call-graph.js';
import { code, type CodeResult } from './code.js';
import { deps, rdeps, type DepResult } from './deps.js';
import { boundedDefinitionSnippet, type SourceSnippet } from './source-snippet.js';
import {
  qualifiedTraceEvidence,
  type TraceClaimSupport,
  type TraceEvidenceResult,
  type TraceReferenceEvidence,
} from './trace.js';

export type EvidencePart = 'definition' | 'references' | 'callers' | 'callees' | 'dependencies' | 'consumers';

export interface EvidenceRelatedSymbol extends SourceSnippet {
  symbol: string;
  shortName: string;
  omittedLines: number;
}

export interface EvidenceReferenceWindow {
  relativePath: string;
  startLine: number;
  endLine: number;
  source: string;
  references: Array<{
    line: number;
    enclosingSymbol: string | null;
    enclosingShort: string;
  }>;
}

export type EvidenceResult =
  | { kind: 'missing'; query: string }
  | {
      kind: 'ambiguous';
      query: string;
      total: number;
      candidates: SymbolResolutionCandidate[];
    }
  | {
      kind: 'matched';
      query: string;
      symbol: string;
      shortName: string;
      file: string;
      parts: EvidencePart[];
      definition: CodeResult | null;
      referenceWindows: EvidenceReferenceWindow[];
      callers: EvidenceRelatedSymbol[];
      callees: EvidenceRelatedSymbol[];
      dependencies: DepResult[];
      consumers: DepResult[];
    };

export type QualifiedEvidenceResult =
  | Exclude<EvidenceResult, { kind: 'matched' }>
  | (Extract<EvidenceResult, { kind: 'matched' }> & {
      referenceEvidence: TraceReferenceEvidence[];
      claimSupport: TraceClaimSupport | null;
    });

export interface EvidenceOptions {
  parts?: readonly EvidencePart[];
  referenceContext?: number;
  relatedSourceLines?: number;
  semantic?: boolean;
}

/** Build one read-only view from a symbol and selected compiler relationships. */
export function evidence(db: ScipDatabase, query: string, opts: EvidenceOptions = {}): EvidenceResult {
  const qualified = qualifiedEvidence(db, query, opts);
  if (qualified.kind !== 'matched') return qualified;
  const { referenceEvidence: _referenceEvidence, claimSupport: _claimSupport, ...result } = qualified;
  return result;
}

/** Build symbol evidence with explicit metadata governing source-derived claims. */
export function qualifiedEvidence(
  db: ScipDatabase,
  query: string,
  opts: EvidenceOptions = {},
): QualifiedEvidenceResult {
  const resolution = resolveSymbol(db, query);
  if (!resolution.match) return { kind: 'missing', query };
  if (resolution.total > 1) {
    return {
      kind: 'ambiguous',
      query,
      total: resolution.total,
      candidates: [
        {
          symbol: resolution.match.symbol,
          shortName: shortenSymbol(resolution.match.symbol),
          relativePath: resolution.match.relativePath,
          startLine: resolution.match.startLine,
        },
        ...resolution.candidates,
      ],
    };
  }

  const match = resolution.match;
  const parts = normalizeEvidenceParts(opts.parts);
  const traced =
    parts.includes('definition') || parts.includes('references')
      ? qualifiedTraceEvidence(db, match.symbol, {
          semantic: opts.semantic,
          referenceContext: opts.referenceContext,
        })
      : { definitions: [], referencedBy: [], referenceEvidence: [], claimSupport: null };
  const graph =
    parts.includes('callers') || parts.includes('callees')
      ? callGraph(db, match.symbol, { semantic: opts.semantic })
      : null;
  const relatedSourceLines = opts.relatedSourceLines ?? 80;

  return {
    kind: 'matched',
    query,
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    file: match.relativePath,
    parts,
    definition: parts.includes('definition') ? code(db, match.symbol) : null,
    referenceWindows: parts.includes('references') ? mergeReferenceWindows(db, traced.referencedBy) : [],
    callers: parts.includes('callers') ? relatedSymbols(db, graph?.callers ?? [], relatedSourceLines) : [],
    callees: parts.includes('callees') ? relatedSymbols(db, graph?.callees ?? [], relatedSourceLines) : [],
    dependencies: parts.includes('dependencies') ? deps(db, match.relativePath) : [],
    consumers: parts.includes('consumers') ? rdeps(db, match.relativePath) : [],
    referenceEvidence: traced.referenceEvidence,
    claimSupport: traced.claimSupport,
  };
}

function mergeReferenceWindows(
  db: ScipDatabase,
  references: TraceEvidenceResult['referencedBy'],
): EvidenceReferenceWindow[] {
  const readable = references
    .filter(
      (reference): reference is typeof reference & { sourceStartLine: number; sourceEndLine: number; source: string } =>
        reference.sourceStartLine !== null && reference.sourceEndLine !== null && reference.source !== null,
    )
    .sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath) ||
        left.sourceStartLine - right.sourceStartLine ||
        left.line - right.line,
    );
  const windows: EvidenceReferenceWindow[] = [];
  for (const reference of readable) {
    const previous = windows[windows.length - 1];
    if (
      previous &&
      previous.relativePath === reference.relativePath &&
      reference.sourceStartLine <= previous.endLine + 1
    ) {
      previous.endLine = Math.max(previous.endLine, reference.sourceEndLine);
      previous.references.push(referenceIdentity(reference));
      previous.source = getSourceLines(db, previous.relativePath)
        .slice(previous.startLine, previous.endLine + 1)
        .join('\n');
      continue;
    }
    windows.push({
      relativePath: reference.relativePath,
      startLine: reference.sourceStartLine,
      endLine: reference.sourceEndLine,
      source: reference.source,
      references: [referenceIdentity(reference)],
    });
  }
  return windows;
}

function referenceIdentity(
  reference: TraceEvidenceResult['referencedBy'][number],
): EvidenceReferenceWindow['references'][number] {
  return {
    line: reference.line,
    enclosingSymbol: reference.enclosingSymbol,
    enclosingShort: reference.enclosingShort,
  };
}

function normalizeEvidenceParts(parts: readonly EvidencePart[] | undefined): EvidencePart[] {
  const selected: readonly EvidencePart[] = parts && parts.length > 0 ? parts : ['definition', 'references'];
  return [...new Set(selected)];
}

function relatedSymbols(
  db: ScipDatabase,
  rows: ReadonlyArray<{ symbol: string; shortName: string; file: string }>,
  maxLines: number,
): EvidenceRelatedSymbol[] {
  const out: EvidenceRelatedSymbol[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.symbol)) continue;
    seen.add(row.symbol);
    const definition =
      (row.file
        ? getDefinitionsForFile(db, row.file).find((candidate) => candidate.symbol === row.symbol)
        : undefined) ?? resolveSymbol(db, row.symbol).match;
    if (!definition) continue;
    const snippet = boundedDefinitionSnippet(
      db,
      definition.relativePath,
      definition.startLine,
      definition.endLine,
      maxLines,
    );
    if (!snippet) continue;
    out.push({
      ...snippet,
      symbol: row.symbol,
      shortName: row.shortName,
      omittedLines: Math.max(0, definition.endLine - snippet.endLine),
    });
  }
  return out;
}
