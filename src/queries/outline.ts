import type { ScipDatabase } from '../db.js';
import type { OutlineNode } from '../types.js';
import { resolveIndexedPaths } from '../query-support.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Build a tree-structured outline of symbols in a file,
 * using the enclosing_symbol field to establish parent-child relationships.
 */
export function outline(db: ScipDatabase, filePattern: string): OutlineNode[] {
  const resolvedPaths = resolveIndexedPaths(db, filePattern);
  if (resolvedPaths.length === 0) {
    return [];
  }

  const placeholders = resolvedPaths.map(() => '?').join(', ');
  const rows = db.all<{
    symbol: string;
    enclosing_symbol: string | null;
    start_line: number;
    end_line: number;
  }>(
    `SELECT gs.symbol, gs.enclosing_symbol, der.start_line, der.end_line
    FROM defn_enclosing_ranges der
    JOIN global_symbols gs ON der.symbol_id = gs.id
    JOIN documents d ON der.document_id = d.id
    WHERE d.relative_path IN (${placeholders})
      ${db.symbolNoise}
    ORDER BY d.relative_path, der.start_line`,
    ...resolvedPaths,
  );

  // Build a map of symbol -> node
  const nodeMap = new Map<string, OutlineNode>();
  const roots: OutlineNode[] = [];

  for (const r of rows) {
    const node: OutlineNode = {
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      startLine: r.start_line,
      endLine: r.end_line,
      children: [],
    };
    nodeMap.set(r.symbol, node);
  }

  // Wire up parent-child via enclosing_symbol
  for (const r of rows) {
    const node = nodeMap.get(r.symbol)!;
    if (r.enclosing_symbol && nodeMap.has(r.enclosing_symbol)) {
      nodeMap.get(r.enclosing_symbol)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
