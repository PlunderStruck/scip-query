import type { ScipDatabase } from '../../storage/db.js';
import { readRepositoryTextFile } from '../../source/primitives/repository-text.js';
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
  const file = readRepositoryTextFile(db, path);
  if (file?.freshness.semantic.state === 'stale') {
    throw new Error(`Compiler ownership is stale for ${path}. Reindex or read the current file with code.`);
  }
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
  const parents = new Map<OutlineNode, OutlineNode>();

  for (let i = 0; i < definitions.length; i++) {
    const d = definitions[i]!;
    const node = nodes[i]!;

    if (d.enclosingSymbol && nodeMap.has(d.enclosingSymbol)) {
      const parent = nodeMap.get(d.enclosingSymbol)!;
      parent.children.push(node);
      parents.set(node, parent);
      continue;
    }

    const bestParent = geometricOutlineParent(node, nodes);

    if (bestParent) {
      bestParent.children.push(node);
      parents.set(node, bestParent);
    } else {
      roots.push(node);
    }
  }

  assertOutlineOwnershipAcyclic(path, nodes, parents);
  return roots;
}

function geometricOutlineParent(node: OutlineNode, nodes: readonly OutlineNode[]): OutlineNode | null {
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
  return bestParent;
}

function assertOutlineOwnershipAcyclic(
  path: string,
  nodes: readonly OutlineNode[],
  parents: ReadonlyMap<OutlineNode, OutlineNode>,
): void {
  const checked = new Set<OutlineNode>();
  for (const node of nodes) {
    const chain = new Set<OutlineNode>();
    let current: OutlineNode | undefined = node;
    while (current && !checked.has(current)) {
      if (chain.has(current))
        throw new Error(`Cyclic compiler ownership in ${path}. Reindex before using this outline.`);
      chain.add(current);
      current = parents.get(current);
    }
    for (const member of chain) checked.add(member);
  }
}
