const MAX_CITATION_CONTEXT_LINES = 40;
const MAX_CITATION_CONTEXT_CHARS = 2_000;

interface LineRange {
  start: number;
  end: number;
}

type MarkdownInterrupt = 'blank' | 'heading' | 'fence' | 'table' | 'list';

export function markdownCitationContext(lines: readonly string[], lineIndex: number): string {
  const range =
    fencedCodeRange(lines, lineIndex) ??
    tableRange(lines, lineIndex) ??
    listItemRange(lines, lineIndex) ??
    paragraphRange(lines, lineIndex);
  return contextFromRange(lines, range, lineIndex);
}

function fencedCodeRange(lines: readonly string[], lineIndex: number): LineRange | null {
  let openStart = -1;
  let openMarker: '`' | '~' | null = null;
  for (let index = 0; index <= lineIndex; index += 1) {
    const marker = fenceMarker(lines[index] ?? '');
    if (!marker) continue;
    if (openMarker === null) {
      openMarker = marker;
      openStart = index;
    } else if (marker === openMarker) {
      openMarker = null;
      openStart = -1;
    }
  }
  if (openMarker === null || openStart < 0) return null;
  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    if (fenceMarker(lines[index] ?? '') === openMarker) return { start: openStart, end: index + 1 };
  }
  return { start: openStart, end: lines.length };
}

function fenceMarker(line: string): '`' | '~' | null {
  const match = line.match(/^\s*(```+|~~~+)/);
  if (!match) return null;
  return match[1]!.startsWith('`') ? '`' : '~';
}

function tableRange(lines: readonly string[], lineIndex: number): LineRange | null {
  if (!isTableLine(lines[lineIndex] ?? '')) return null;
  let start = lineIndex;
  while (start > 0 && isTableLine(lines[start - 1] ?? '')) start -= 1;
  let end = lineIndex + 1;
  while (end < lines.length && isTableLine(lines[end] ?? '')) end += 1;
  return { start, end };
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|');
}

function listItemRange(lines: readonly string[], lineIndex: number): LineRange | null {
  let start = lineIndex;
  while (start >= 0) {
    const line = lines[start] ?? '';
    if (listMarkerIndent(line) !== null) break;
    if (markdownInterrupt(line) !== null) return null;
    start -= 1;
  }
  if (start < 0) return null;
  const baseIndent = listMarkerIndent(lines[start] ?? '');
  if (baseIndent === null) return null;

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? '';
    const nextIndent = listMarkerIndent(line);
    if (nextIndent !== null) {
      if (nextIndent <= baseIndent) break;
      end += 1;
      continue;
    }
    if (markdownInterrupt(line) !== null) break;
    end += 1;
  }
  return { start, end };
}

function listMarkerIndent(line: string): number | null {
  const match = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/);
  return match ? match[1]!.length : null;
}

function paragraphRange(lines: readonly string[], lineIndex: number): LineRange {
  const line = lines[lineIndex] ?? '';
  if (isHeadingLine(line) || line.trim().length === 0) return { start: lineIndex, end: lineIndex + 1 };

  let start = lineIndex;
  while (start > 0 && isParagraphContinuation(lines[start - 1] ?? '')) start -= 1;
  let end = lineIndex + 1;
  while (end < lines.length && isParagraphContinuation(lines[end] ?? '')) end += 1;
  return { start, end };
}

function isParagraphContinuation(line: string): boolean {
  return markdownInterrupt(line) === null;
}

function markdownInterrupt(line: string): MarkdownInterrupt | null {
  if (line.trim().length === 0) return 'blank';
  if (isHeadingLine(line)) return 'heading';
  if (fenceMarker(line)) return 'fence';
  if (isTableLine(line)) return 'table';
  if (listMarkerIndent(line) !== null) return 'list';
  return null;
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim());
}

function contextFromRange(lines: readonly string[], range: LineRange, lineIndex: number): string {
  let { start, end } = range;
  if (end - start > MAX_CITATION_CONTEXT_LINES) {
    const before = Math.floor(MAX_CITATION_CONTEXT_LINES / 2);
    start = Math.max(start, lineIndex - before);
    end = Math.min(end, start + MAX_CITATION_CONTEXT_LINES);
    start = Math.max(range.start, end - MAX_CITATION_CONTEXT_LINES);
  }
  const context = lines.slice(start, end).join('\n').trim();
  if (context.length <= MAX_CITATION_CONTEXT_CHARS) return context;
  return `${context.slice(0, MAX_CITATION_CONTEXT_CHARS).trimEnd()}...`;
}
