import type { ScipDatabase } from '../db.js';
import { getDefinitionsForFile, getScopedDefinitions } from '../query-support.js';
import type { StaleAbstraction } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find stale abstractions: type-level symbols (classes, interfaces, type
 * aliases) that have 0 or 1 cross-file consumers.
 *
 * A type that only one file uses is over-abstracted — it was designed
 * for reuse that never materialized. Large single-consumer types are
 * the strongest signal of wasted abstraction.
 */
export function staleAbstractions(
  db: ScipDatabase,
  opts?: { scope?: string; minLoc?: number; limit?: number },
): StaleAbstraction[] {
  const { scope, minLoc = 3, limit = 30 } = opts ?? {};
  const rows = getScopedDefinitions(db, scope)
    .filter((definition) => definition.isTypeLike && definitionLoc(definition) >= minLoc)
    .map((definition) => ({
      symbol: definition.symbol,
      file: definition.relativePath,
      start_line: definition.startLine,
      end_line: definition.endLine,
      loc: definitionLoc(definition),
      consumers: countCrossFileConsumers(db, definition),
    }))
    .filter((row) => row.consumers <= 1)
    .sort((left, right) => right.loc - left.loc || left.file.localeCompare(right.file) || left.start_line - right.start_line);

  const filesWithFunctions = getFilesWithFunctions(db, scope);

  return rows
    .filter((r) => !db.isIgnored(r.file))
    .filter((r) => isTrueStaleAbstraction(r, filesWithFunctions))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      file: r.file,
      startLine: r.start_line,
      endLine: r.end_line,
      loc: r.loc,
      consumers: r.consumers,
    }))
    .slice(0, limit);
}

function getFilesWithFunctions(
  db: ScipDatabase,
  scope?: string,
): Set<string> {
  return new Set(getScopedDefinitions(db, scope)
    .filter((definition) => definition.isFunctionLike)
    .map((definition) => definition.relativePath));
}

function isTrueStaleAbstraction(
  row: { file: string; consumers: number },
  filesWithFunctions: ReadonlySet<string>,
): boolean {
  const basename = row.file.split('/').pop() ?? '';
  const isTypeFile = basename.includes('types') || row.file.includes('/types/');
  if (isTypeFile && row.consumers > 0) {
    return false;
  }

  // 0-consumer types in files that also export functions are often parameter/
  // return-only shapes that the SCIP graph does not model as direct mentions.
  if (row.consumers === 0 && filesWithFunctions.has(row.file)) {
    return false;
  }

  return true;
}

function countCrossFileConsumers(
  db: ScipDatabase,
  definition: ReturnType<typeof getDefinitionsForFile>[number],
): number {
  const callers = db.all<{ relative_path: string }>(
    `SELECT DISTINCT d.relative_path
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.symbol_id = ?
       AND m.role != 1
       ${db.pathExclusionsFor('d')}`,
    definition.symbolId,
  )
    .map((row) => row.relative_path)
    .filter((relativePath) => relativePath !== definition.relativePath && !db.isIgnored(relativePath));

  return new Set(callers).size;
}

function definitionLoc(
  definition: ReturnType<typeof getDefinitionsForFile>[number],
): number {
  return definition.endLine - definition.startLine + 1;
}
