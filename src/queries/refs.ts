import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getSourceReferenceSites } from '../query-support.js';
import { getSourceText } from '../source-analysis.js';
import { isFunctionLikeSymbol } from '../symbol-parser.js';
import type { RefResult } from '../types.js';

export function refs(db: ScipDatabase, symbolPattern: string): RefResult[] {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (match) {
    const includeDefinitionSite = !isFunctionLikeSymbol(match.symbol);
    const definitionRows = includeDefinitionSite
      ? [{
        relativePath: match.relativePath,
        line: match.startLine,
      }]
      : [];
    const sourceSites = getSourceReferenceSites(db, match)
      .filter((site) => !db.isIgnored(site.file))
      .map((site) => ({
        relativePath: site.file,
        line: site.line,
      }));

    if (sourceSites.length > 0) {
      const seen = new Set<string>();
      const rows = [...definitionRows, ...sourceSites, ...getRubySemanticRefs(db, match)].filter((site) => {
        const key = `${site.relativePath}:${site.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return rows;
    }
  }

  const rows = db.all<{
    relative_path: string;
    start_line: number;
  }>(
    `SELECT DISTINCT d.relative_path, c.start_line
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    WHERE m.symbol_id = ?
      AND ${db.localSymbolPredicate}
      AND m.role != 1
    ORDER BY d.relative_path, c.start_line`,
    match?.symbolId ?? -1,
  );

  const referenceRows = rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      relativePath: r.relative_path,
      line: r.start_line,
    }));

  if (!match || db.isIgnored(match.relativePath) || isFunctionLikeSymbol(match.symbol)) {
    return referenceRows;
  }

  const seen = new Set(referenceRows.map((row) => `${row.relativePath}:${row.line}`));
  if (!seen.has(`${match.relativePath}:${match.startLine}`)) {
    referenceRows.unshift({
      relativePath: match.relativePath,
      line: match.startLine,
    });
  }

  for (const row of getRubySemanticRefs(db, match)) {
    const key = `${row.relativePath}:${row.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    referenceRows.push(row);
  }

  return referenceRows;
}

function getRubySemanticRefs(
  db: ScipDatabase,
  match: NonNullable<ReturnType<typeof findFirstSymbolMatch>>,
): RefResult[] {
  if (!match.relativePath.endsWith('.rb')) {
    return [];
  }

  const tokens = rubyReferenceTokens(match.symbol);
  if (tokens.length === 0) {
    return [];
  }

  const rows = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE relative_path LIKE '%.rb'
       ${db.pathExclusionsFor('documents')}
     ORDER BY relative_path`,
  );

  const results: RefResult[] = [];
  for (const row of rows) {
    if (db.isIgnored(row.relative_path)) continue;
    const source = getSourceText(db, row.relative_path);
    if (!source) continue;

    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (tokens.some((token) => new RegExp(`@${token}\\b|\\b${token}:`).test(line))) {
        results.push({
          relativePath: row.relative_path,
          line: index,
        });
      }
    }
  }

  return results;
}

function rubyReferenceTokens(rawSymbol: string): string[] {
  const leaf = rawSymbol.split(':').pop() ?? rawSymbol;
  const snake = leaf
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');

  const parts = snake.split('_').filter(Boolean);
  const candidates = new Set<string>();
  if (snake) candidates.add(snake);
  if (parts.length >= 1) candidates.add(parts[parts.length - 1]!);
  if (parts.length >= 2) candidates.add(parts.slice(-2).join('_'));
  return [...candidates];
}
