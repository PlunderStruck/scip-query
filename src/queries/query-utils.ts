import type { IndexedDefinition } from '../domain/types.js';

export function definitionLoc(definition: Pick<IndexedDefinition, 'startLine' | 'endLine'>): number {
  return definition.endLine - definition.startLine + 1;
}

export function applyScanLimit<T>(items: T[], scanLimit: number | undefined): T[] {
  if (typeof scanLimit !== 'number' || scanLimit <= 0 || items.length <= scanLimit) {
    return items;
  }
  return items.slice(0, scanLimit);
}

export function uniqueSymbolFileRows<T extends { symbol: string; file: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = `${row.symbol}|${row.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function mergeMapOfSets<K, V>(...maps: Array<ReadonlyMap<K, ReadonlySet<V>>>): Map<K, Set<V>> {
  const merged = new Map<K, Set<V>>();
  for (const map of maps) {
    for (const [key, values] of map) {
      let bucket = merged.get(key);
      if (!bucket) {
        bucket = new Set();
        merged.set(key, bucket);
      }
      for (const value of values) bucket.add(value);
    }
  }
  return merged;
}
