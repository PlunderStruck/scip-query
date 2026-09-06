export interface OccurrenceSourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** Convert declared SCIP columns to JavaScript string columns. Unknown encodings
 * support ASCII prefixes only, where UTF-8/16/32 coordinates agree. */
export function normalizeOccurrenceRange(
  range: readonly number[],
  encoding: string | null | undefined,
  lines: readonly string[],
): OccurrenceSourceRange | undefined {
  if (range.length !== 3 && range.length !== 4) return undefined;
  const startLine = range[0]!,
    endLine = range.length === 4 ? range[2]! : startLine;
  const startColumn = occurrenceStringColumn(lines[startLine], range[1]!, encoding);
  const endColumn = occurrenceStringColumn(lines[endLine], range[range.length - 1]!, encoding);
  if (startColumn === undefined || endColumn === undefined) return undefined;
  return { startLine, startColumn, endLine, endColumn };
}

function occurrenceStringColumn(
  line: string | undefined,
  column: number,
  encoding: string | null | undefined,
): number | undefined {
  if (line === undefined || !Number.isSafeInteger(column) || column < 0) return undefined;
  const effectiveEncoding =
    encoding || ([...line.slice(0, column)].every((char) => char.charCodeAt(0) < 128) ? 'UTF-16' : undefined);
  switch (effectiveEncoding) {
    case 'UTF-16':
      return column <= line.length ? column : undefined;
    case 'UTF-8':
    case 'UTF-32':
      return decodeOccurrenceColumn(line, column, effectiveEncoding);
    default:
      return undefined;
  }
}

function decodeOccurrenceColumn(line: string, column: number, encoding: 'UTF-8' | 'UTF-32'): number | undefined {
  let units = 0,
    offset = 0;
  for (const char of line) {
    if (units === column) return offset;
    units += encoding === 'UTF-8' ? Buffer.byteLength(char, 'utf8') : 1;
    offset += char.length;
    if (units > column) return undefined;
  }
  return units === column ? offset : undefined;
}
