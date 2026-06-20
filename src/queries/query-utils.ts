import type { IndexedDefinition } from '../domain/types.js';
import { definitionLoc } from '../symbols/definition-loc.js';

export { definitionLoc } from '../symbols/definition-loc.js';

export function compareDefinitionsBySmallestLoc(left: IndexedDefinition, right: IndexedDefinition): number {
  return definitionLoc(left) - definitionLoc(right) || left.relativePath.localeCompare(right.relativePath);
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
