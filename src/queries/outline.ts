import type { ScipDatabase } from '../db.js';
import type { OutlineNode } from '../types.js';
import { loadFileSymbols } from '../definition-catalog.js';

/**
 * Build a tree-structured outline of symbols in a file,
 * using the enclosing_symbol field to establish parent-child relationships.
 *
 * Uses source-corrected ranges via getDefinitionsForFile so the line
 * numbers match `scip symbols` output exactly.
 */
export function outline(db: ScipDatabase, filePattern: string): OutlineNode[] {
  const definitions = loadFileSymbols(db, filePattern, { sort: true });
  if (definitions.length === 0) return [];

  const nodes: OutlineNode[] = definitions.map((d) => ({
    symbol: d.symbol,
    shortName: d.shortName,
    startLine: d.startLine,
    endLine: d.endLine,
    children: [],
  }));

  const nodeMap = new Map<string, OutlineNode>();
  for (const n of nodes) nodeMap.set(n.symbol, n);

  const roots: OutlineNode[] = [];

  for (let i = 0; i < definitions.length; i++) {
    const d = definitions[i]!;
    const node = nodes[i]!;

    if (d.enclosingSymbol && nodeMap.has(d.enclosingSymbol)) {
      nodeMap.get(d.enclosingSymbol)!.children.push(node);
      continue;
    }

    let bestParent: OutlineNode | null = null;
    let bestSize = Infinity;

    for (const candidate of nodes) {
      if (candidate === node) continue;
      if (candidate.startLine <= node.startLine && candidate.endLine >= node.endLine) {
        const size = candidate.endLine - candidate.startLine;
        if (size < bestSize) {
          bestSize = size;
          bestParent = candidate;
        }
      }
    }

    if (bestParent) {
      bestParent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
