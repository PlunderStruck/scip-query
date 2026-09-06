import type Database from 'better-sqlite3';
import { relative } from 'node:path';
import { leafName } from '../../domain/scip-symbol.js';
import { normalizeOccurrenceRange } from '../../domain/scip-range.js';

export interface DefinitionInfo {
  fileName: string;
  textSpan: { start: number; length: number };
  name?: string;
  kind?: string;
}

export interface SourceTextInfo {
  text: string;
  lineStarts: number[];
}

export interface SourcePosition {
  line: number;
  character: number;
}

export interface VueSourceReader {
  get(fileName: string): SourceTextInfo | null;
  positionAt(source: SourceTextInfo, offset: number): SourcePosition;
}

interface DefinitionRangeLookup {
  symbolId: number;
  name: string;
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  encoding: string | null;
}

/** Resolve a Volar definition only inside a matching named compiler range. */
export function createSymbolLookup(
  db: Database.Database,
  projectRoot: string,
  sourceReader: VueSourceReader,
): (definition: DefinitionInfo) => number | null {
  const rangesByFile = loadDefinitionRanges(db);
  return (definition): number | null => {
    if (!definition.name) return null;
    const source = sourceReader.get(definition.fileName);
    if (!source) return null;
    const start = sourceReader.positionAt(source, definition.textSpan.start);
    const end = sourceReader.positionAt(source, definition.textSpan.start + definition.textSpan.length);
    const lines = source.text.split('\n');
    const candidates = (
      rangesByFile.get(relative(projectRoot, definition.fileName).replaceAll('\\', '/')) ?? []
    ).filter((row) => {
      if (row.name !== definition.name) return false;
      const range = normalizeOccurrenceRange(
        [row.startLine, row.startChar, row.endLine, row.endChar],
        row.encoding,
        lines,
      );
      if (!range) return false;
      return (
        (start.line > range.startLine || (start.line === range.startLine && start.character >= range.startColumn)) &&
        (end.line < range.endLine || (end.line === range.endLine && end.character <= range.endColumn))
      );
    });
    const ids = new Set(candidates.map((candidate) => candidate.symbolId));
    return ids.size === 1 ? [...ids][0]! : null;
  };
}

function loadDefinitionRanges(db: Database.Database): Map<string, DefinitionRangeLookup[]> {
  const rows = db
    .prepare(
      `
    SELECT d.relative_path AS relativePath, d.position_encoding AS encoding,
      der.start_line AS startLine, der.start_char AS startChar,
      der.end_line AS endLine, der.end_char AS endChar,
      der.symbol_id AS symbolId, gs.display_name AS displayName, gs.symbol AS symbol
    FROM defn_enclosing_ranges der
    JOIN documents d ON d.id = der.document_id
    JOIN global_symbols gs ON gs.id = der.symbol_id
    ORDER BY d.relative_path, der.start_line, der.start_char, der.symbol_id
  `,
    )
    .all() as (Omit<DefinitionRangeLookup, 'name'> & {
    relativePath: string;
    displayName: string | null;
    symbol: string;
  })[];
  const byFile = new Map<string, DefinitionRangeLookup[]>();
  for (const row of rows) {
    const name = row.displayName ?? leafName(row.symbol);
    const definitions = byFile.get(row.relativePath) ?? [];
    definitions.push({ ...row, name });
    byFile.set(row.relativePath, definitions);
  }
  return byFile;
}
