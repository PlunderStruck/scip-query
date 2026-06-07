import type { ScipDatabase } from '../storage/db.js';
import { findIdentifierLines } from './identifier-index.js';
import { findEnclosingDefinition, getDefinitionsForFile } from './definition-catalog.js';
import { getFullSymbolMatch } from './symbol-lookup.js';
import { leafName } from './symbol-parser.js';
import type { ReferenceSite, SymbolLocation } from '../domain/types.js';

interface ReferenceChunk {
  start_line: number;
  end_line: number;
}

// ── Reference-site resolution ──────────────────────────────────

// `findReferences` (source-text-based reference scan) and
// `findCallerFiles` (bulk source-fallback caller-file builder) live in
// `identifier-attribution.ts`. They used to be re-exported here under
// their query-support-era names (`getSourceReferenceSites` and
// `buildSourceFallbackCallerFiles`) but the back-edge created a
// reference-graph ↔ identifier-attribution cycle that the cycles
// detector flagged. Callers now import them directly from
// identifier-attribution.

/**
 * Precision-upgraded fallback for callers/references when
 * `getSourceReferenceSites` bails out (leaf name is shared across symbols,
 * or the unique-leaf check doesn't apply). Starts from SCIP's authoritative
 * mention table (role != 1) so resolution is correct, then refines each
 * chunk's coarse `start_line` by source-scanning for the symbol's leaf
 * name within the chunk range. Falls back to chunk start when the leaf
 * name is unavailable or the scan finds nothing.
 *
 * Use this instead of raw `c.start_line` for any query that reports where
 * references occur.
 */
export function getResolvedReferenceSites(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferenceSite[] {
  const prelude = resolveReferencePrelude(db, symbol);
  if (!prelude) return [];
  return buildReferenceSites(db, resolvedCandidateLines(db, prelude.match, prelude.identifier));
}

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
  const rows = db.all<{ relative_path: string; start_line: number; end_line: number }>(
    `SELECT DISTINCT d.relative_path, c.start_line, c.end_line
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.symbol_id = ?
       AND m.role != 1
       ${db.pathExclusionsFor('d')}
     ORDER BY d.relative_path, c.start_line`,
    symbolId,
  );
  for (const row of rows) {
    if (db.isIgnored(row.relative_path)) continue;
    let bucket = chunksByFile.get(row.relative_path);
    if (!bucket) {
      bucket = [];
      chunksByFile.set(row.relative_path, bucket);
    }
    bucket.push({ start_line: row.start_line, end_line: row.end_line });
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

export function resolveReferencePrelude(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferencePrelude | null {
  const match = getFullSymbolMatch(db, symbol);
  if (!match) return null;
  return { match, identifier: leafName(match.symbol) || null };
}

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
