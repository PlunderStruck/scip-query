import type { ScipDatabase } from '../storage/db.js';
import { findIdentifierLines } from './identifier-index.js';
import { findEnclosingDefinition, getDefinitionsForFile } from './definition-catalog.js';
import { getFullSymbolMatch } from './symbol-lookup.js';
import { leafName } from './symbol-parser.js';
import { mentionReferenceChunkRows } from '../storage/scip-mentions.js';
import { findReferences } from './identifier-attribution.js';
import type { ReferenceSite, SymbolLocation } from '../domain/types.js';

interface ReferenceChunk {
  start_line: number;
  end_line: number;
}

// ── Reference-site resolution ──────────────────────────────────

// `findReferences` (source-text-based reference scan) lives in
// `identifier-attribution.ts`; this module owns the query-facing policy that
// chooses between that source-backed evidence and SCIP mention fallback.
// `findCallerFiles` remains imported directly from identifier-attribution by
// callers that need the bulk inverse view.

/**
 * Precision-upgraded fallback for callers/references when
 * source-backed reference attribution bails out (leaf name is shared across symbols,
 * or the unique-leaf check doesn't apply). Starts from SCIP's authoritative
 * mention table (role != 1) so resolution is correct, then refines each
 * chunk's coarse `start_line` by source-scanning for the symbol's leaf
 * name within the chunk range. Falls back to chunk start when the leaf
 * name is unavailable or the scan finds nothing.
 *
 * Use this instead of raw `c.start_line` for any query that reports where
 * references occur.
 */
// scip-query: ignore-wrapper — SCIP-only fallback primitive used by the
// source-primary reference policy and targeted caller rows; keeping it named
// prevents those evidence modes from collapsing into one behavior.
export function getResolvedReferenceSites(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferenceSite[] {
  const prelude = resolveReferencePrelude(db, symbol);
  if (!prelude) return [];
  return buildReferenceSites(db, resolvedCandidateLines(db, prelude.match, prelude.identifier));
}

export function referenceSitesForSymbol(
  db: ScipDatabase,
  symbol: SymbolLocation,
  opts: { semantic?: boolean; includeIgnored?: boolean } = {},
): ReferenceSite[] {
  const sourceSites = findReferences(db, symbol, { semantic: opts.semantic });
  const sites = sourceSites.length > 0 ? sourceSites : getResolvedReferenceSites(db, symbol);
  return opts.includeIgnored === true ? sites : sites.filter((site) => !db.isIgnored(site.file));
}

// scip-query: ignore-wrapper — named precision stage used by reference
// reporting; keeps SCIP chunk reads separate from source-line refinement.
export function resolvedCandidateLines(
  db: ScipDatabase,
  match: { symbolId: number; relativePath: string; startLine: number; endLine: number },
  identifier: string | null,
): Map<string, number[]> {
  const fileLines = new Map<string, number[]>();
  for (const [file, chunks] of referenceChunksByFile(db, match.symbolId)) {
    fileLines.set(file, resolvedLinesForFile(db, file, chunks, match, identifier));
  }
  return fileLines;
}

function referenceChunksByFile(db: ScipDatabase, symbolId: number): Map<string, ReferenceChunk[]> {
  const chunksByFile = new Map<string, ReferenceChunk[]>();
  for (const row of mentionReferenceChunkRows(db, [symbolId])) {
    if (db.isIgnored(row.relative_path)) continue;
    let bucket = chunksByFile.get(row.relative_path);
    if (!bucket) {
      bucket = [];
      chunksByFile.set(row.relative_path, bucket);
    }
    bucket.push({ start_line: row.chunk_start, end_line: row.chunk_end });
  }
  return chunksByFile;
}

function resolvedLinesForFile(
  db: ScipDatabase,
  file: string,
  chunks: readonly ReferenceChunk[],
  match: { relativePath: string; startLine: number; endLine: number },
  identifier: string | null,
): number[] {
  const excludeOpts = file === match.relativePath
    ? { excludeStartLine: match.startLine, excludeEndLine: match.endLine }
    : {};
  const allHits = identifier
    ? findIdentifierLines(db, file, identifier, excludeOpts)
    : [];
  return chunks.flatMap((chunk) => hitsOrChunkStart(allHits, chunk));
}

function hitsOrChunkStart(allHits: readonly number[], chunk: ReferenceChunk): number[] {
  const hitsInChunk = allHits.filter((line) => line >= chunk.start_line && line <= chunk.end_line);
  return hitsInChunk.length > 0 ? hitsInChunk : [chunk.start_line];
}

interface ReferencePrelude {
  match: NonNullable<ReturnType<typeof getFullSymbolMatch>>;
  identifier: string | null;
}

// scip-query: ignore-wrapper — named lookup stage used by reference reporting;
// callers should not repeat full-symbol matching plus leaf extraction.
export function resolveReferencePrelude(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferencePrelude | null {
  const match = getFullSymbolMatch(db, symbol);
  if (!match) return null;
  return { match, identifier: leafName(match.symbol) || null };
}

// scip-query: ignore-wrapper — named attribution stage used by reference
// reporting; keeps line candidates separate from enclosing-symbol lookup.
export function buildReferenceSites(
  db: ScipDatabase,
  perFileLines: Map<string, number[]>,
): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  const seen = new Set<string>();
  for (const [file, lines] of perFileLines) {
    const definitions = getDefinitionsForFile(db, file);
    for (const line of lines) {
      const enclosing = findEnclosingDefinition(definitions, line);
      const key = `${file}|${line}|${enclosing?.symbol ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({ file, line, enclosingSymbol: enclosing?.symbol ?? null });
    }
  }
  return sites;
}
