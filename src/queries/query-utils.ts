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
