import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { leafName } from '../../symbols/symbol-parser.js';

export function findIndexedDefinitionNear(
  db: ScipDatabase,
  file: string,
  line: number,
  symbolName: string,
): IndexedDefinition | null {
  const rows = db.all<IndexedDefinition>(
    `SELECT
       gs.id AS symbolId,
       gs.symbol,
       d.relative_path AS relativePath,
       COALESCE(der.start_line, c.start_line) AS startLine,
       COALESCE(der.end_line, c.end_line) AS endLine,
       COALESCE(gs.display_name, '') AS leaf,
       NULL AS parentTypeName,
       CASE WHEN gs.kind IN (6, 12, 13) OR gs.symbol LIKE '%().' THEN 1 ELSE 0 END AS isFunctionLike,
       CASE WHEN gs.kind IN (5, 8, 11) THEN 1 ELSE 0 END AS isTypeLike,
       gs.kind AS kind,
       gs.documentation AS documentation,
       gs.enclosing_symbol AS enclosingSymbol
     FROM global_symbols gs
     LEFT JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
     LEFT JOIN chunks c ON c.document_id = der.document_id
     JOIN documents d ON d.id = der.document_id
     WHERE d.relative_path = ?
       AND COALESCE(gs.display_name, gs.symbol) LIKE ?
     ORDER BY ABS(COALESCE(der.start_line, c.start_line) - ?)
     LIMIT 5`,
    file,
    `%${symbolName}%`,
    line,
  );
  return rows[0] ?? null;
}

export function indexedDefinitionLeafMap(
  db: ScipDatabase,
  file: string,
): Map<string, IndexedDefinition> {
  const rows = db.all<IndexedDefinition>(
    `SELECT
       d.id AS documentId,
       gs.id AS symbolId,
       gs.symbol,
       d.relative_path AS relativePath,
       der.start_line AS startLine,
       der.end_line AS endLine,
       COALESCE(gs.display_name, '') AS leaf,
       NULL AS parentTypeName,
       CASE WHEN gs.kind IN (6, 12, 13) OR gs.symbol LIKE '%().' THEN 1 ELSE 0 END AS isFunctionLike,
       CASE WHEN gs.kind IN (5, 8, 11) THEN 1 ELSE 0 END AS isTypeLike,
       gs.kind AS kind,
       gs.documentation AS documentation,
       gs.enclosing_symbol AS enclosingSymbol
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
     JOIN documents d ON d.id = der.document_id
     WHERE d.relative_path = ?
     UNION ALL
     SELECT
       d.id AS documentId,
       gs.id AS symbolId,
       gs.symbol,
       d.relative_path AS relativePath,
       MIN(c.start_line) AS startLine,
       MAX(c.end_line) AS endLine,
       COALESCE(gs.display_name, '') AS leaf,
       NULL AS parentTypeName,
       CASE WHEN gs.kind IN (6, 12, 13) OR gs.symbol LIKE '%().' THEN 1 ELSE 0 END AS isFunctionLike,
       CASE WHEN gs.kind IN (5, 8, 11) THEN 1 ELSE 0 END AS isTypeLike,
       gs.kind AS kind,
       gs.documentation AS documentation,
       gs.enclosing_symbol AS enclosingSymbol
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON c.id = m.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE d.relative_path = ?
       AND m.role = 1
     GROUP BY gs.id, gs.symbol, d.id, d.relative_path, gs.display_name, gs.kind, gs.documentation, gs.enclosing_symbol
     ORDER BY startLine, endLine`,
    file,
    file,
  );
  const byId = new Set<number>();
  const byLeaf = new Map<string, IndexedDefinition>();
  for (const row of rows) {
    if (byId.has(row.symbolId)) continue;
    byId.add(row.symbolId);
    const leaf = row.leaf || leafName(row.symbol);
    if (!leaf || byLeaf.has(leaf)) continue;
    byLeaf.set(leaf, { ...row, leaf });
  }
  return byLeaf;
}
