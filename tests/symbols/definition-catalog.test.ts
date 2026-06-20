import { describe, expect, it } from 'vitest';
import { findEnclosingDefinition } from '../../src/symbols/definition-catalog.js';
import type { IndexedDefinition } from '../../src/domain/types.js';

function definition(
  symbol: string,
  startLine: number,
  endLine: number,
  symbolId: number,
): IndexedDefinition {
  return {
    symbol,
    symbolId,
    documentId: 1,
    startLine,
    endLine,
    relativePath: 'src/example.ts',
    leaf: symbol,
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: 12,
    documentation: null,
    enclosingSymbol: null,
  };
}

describe('definition catalog line ownership', () => {
  it('returns the smallest containing definition while preserving equal-span ties', () => {
    const outer = definition('outer', 0, 10, 1);
    const inner = definition('inner', 3, 5, 2);
    const equalFirst = definition('equalFirst', 7, 8, 3);
    const equalSecond = definition('equalSecond', 7, 8, 4);

    const definitions = [outer, inner, equalFirst, equalSecond];

    expect(findEnclosingDefinition(definitions, 4)).toBe(inner);
    expect(findEnclosingDefinition(definitions, 7)).toBe(equalFirst);
    expect(findEnclosingDefinition(definitions, 1)).toBe(outer);
    expect(findEnclosingDefinition(definitions, 99)).toBeNull();
  });
});
