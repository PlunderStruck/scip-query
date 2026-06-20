import type { IndexedDefinition } from '../domain/types.js';

export function definitionLoc(definition: Pick<IndexedDefinition, 'startLine' | 'endLine'>): number {
  return definition.endLine - definition.startLine + 1;
}
