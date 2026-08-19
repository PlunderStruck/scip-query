import type { ScipDatabase } from '../../storage/db.js';
import { getSourceText, splitSearchableSourceLines } from '../../source/primitives/source-text.js';
import { loadFileSymbols } from '../../symbols/definition-catalog.js';
import { resolveUniqueIndexedPath } from '../internal/file-resolution.js';
import { isAncestorSymbol } from '../../symbols/symbol-parser.js';

export interface OutlineNode {
  symbol: string;
  shortName: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  children: OutlineNode[];
}

/**
 * Build a tree-structured outline of symbols in a file,
 * using the enclosing_symbol field to establish parent-child relationships.
 *
 * Uses source-corrected ranges via getDefinitionsForFile so the line
 * numbers match `scip symbols` output exactly.
 */
export function outline(db: ScipDatabase, filePattern: string): OutlineNode[] {
  const path = resolveUniqueIndexedPath(db, filePattern);
  if (!path) return [];
  const definitions = loadFileSymbols(db, [path], { sort: true });
  if (definitions.length === 0) return [];
  const sourceEndLine = Math.max(0, splitSearchableSourceLines(getSourceText(db, path)).length - 1);

  const nodes: OutlineNode[] = definitions.map((d) => ({
    symbol: d.symbol,
    shortName: d.shortName,
    startLine: d.startLine,
    endLine: Math.min(d.endLine, sourceEndLine),
    signature: d.signature,
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

    // Geometric containment fallback for indexers that don't populate
    // enclosing_symbol (e.g. rust-analyzer, where every same-module
    // symbol shares the same range). When ranges are equal we'd otherwise
    // pick an arbitrary same-range sibling as parent and form a cycle —
    // disambiguate by requiring a SCIP descriptor-chain ancestor.
    let bestParent: OutlineNode | null = null;
    let bestSize = Infinity;

    for (const candidate of nodes) {
      if (candidate === node) continue;
      if (candidate.startLine <= node.startLine && candidate.endLine >= node.endLine) {
        const sameRange = candidate.startLine === node.startLine && candidate.endLine === node.endLine;
        if (sameRange && !isAncestorSymbol(candidate.symbol, node.symbol)) continue;
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
