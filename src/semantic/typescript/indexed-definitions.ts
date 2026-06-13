import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { leafName } from '../../symbols/symbol-parser.js';

const TS_DEFINITION_LEAF_CANDIDATES = createPerDbCache<string, Map<string, IndexedDefinition[]>>(
  'ts-definition-leaf-candidates',
  { clearGroups: ['definition-catalog'] },
);

export function findIndexedDefinitionNear(
  db: ScipDatabase,
  file: string,
  line: number,
  symbolName: string,
): IndexedDefinition | null {
  const byLeaf = indexedDefinitionCandidatesByLeaf(db, file);
  const exact = nearestDefinition(byLeaf.get(symbolName) ?? [], line);
  if (exact) return exact;

  const fallback: IndexedDefinition[] = [];
  for (const candidates of byLeaf.values()) {
    for (const definition of candidates) {
      const leaf = definition.leaf || leafName(definition.symbol) || '';
      if (leaf.includes(symbolName) || definition.symbol.includes(symbolName)) {
        fallback.push(definition);
      }
    }
  }
  return nearestDefinition(fallback, line);
}

export function indexedDefinitionLeafMap(
  db: ScipDatabase,
  file: string,
): Map<string, IndexedDefinition> {
  const byLeaf = new Map<string, IndexedDefinition>();
  for (const [leaf, candidates] of indexedDefinitionCandidatesByLeaf(db, file)) {
    const first = candidates[0];
    if (first) byLeaf.set(leaf, first);
  }
  return byLeaf;
}

function indexedDefinitionCandidatesByLeaf(
  db: ScipDatabase,
  file: string,
): Map<string, IndexedDefinition[]> {
  return TS_DEFINITION_LEAF_CANDIDATES.get(db, file, () => {
    const byLeaf = new Map<string, IndexedDefinition[]>();
    for (const definition of getDefinitionsForFile(db, file)) {
      const leaf = definition.leaf || leafName(definition.symbol);
      if (!leaf) continue;
      let bucket = byLeaf.get(leaf);
      if (!bucket) {
        bucket = [];
        byLeaf.set(leaf, bucket);
      }
      bucket.push({ ...definition, leaf });
    }

    for (const bucket of byLeaf.values()) {
      bucket.sort((left, right) =>
        left.startLine - right.startLine
        || left.endLine - right.endLine
        || left.symbolId - right.symbolId,
      );
    }
    return byLeaf;
  });
}

function nearestDefinition(
  candidates: readonly IndexedDefinition[],
  line: number,
): IndexedDefinition | null {
  let best: IndexedDefinition | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.startLine - line);
    if (
      distance < bestDistance
      || (distance === bestDistance && best && candidate.startLine < best.startLine)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
