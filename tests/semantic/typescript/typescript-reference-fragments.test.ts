import { describe, expect, it } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import {
  assembleReferenceFragments,
  compareReferenceFragmentMaps,
  referenceFragmentsFromDefinitionMap,
} from '../../../src/semantic/typescript/reference-fragments.js';

describe('TypeScript reference fragments', () => {
  const alpha = definition(1, 'pkg alpha().', 'alpha', 'src/api.ts');
  const beta = definition(2, 'pkg beta().', 'beta', 'src/api.ts');
  const definitions = [alpha, beta];
  const expected = new Map([
    [
      alpha.symbolId,
      [
        { file: 'src/a.ts', line: 2, column: 3 },
        { file: 'src/b.ts', line: 4, column: 5 },
      ],
    ],
    [beta.symbolId, [{ file: 'src/b.ts', line: 7, column: 1 }]],
  ]);

  it('round-trips definition-centric answers through origin-file fragments', () => {
    const fragments = referenceFragmentsFromDefinitionMap(definitions, expected, ['src/b.ts', 'src/a.ts']);
    expect([...fragments.keys()]).toEqual(['src/b.ts', 'src/a.ts']);
    expect(assembleReferenceFragments(definitions, fragments)).toEqual(expected);
    expect(
      compareReferenceFragmentMaps(definitions, expected, assembleReferenceFragments(definitions, fragments)),
    ).toEqual({
      passed: true,
      expectedCount: 3,
      actualCount: 3,
      missing: [],
      extra: [],
    });
  });

  it('reports the exact fact when one origin fragment is omitted', () => {
    const fragments = referenceFragmentsFromDefinitionMap(definitions, expected, ['src/a.ts', 'src/b.ts']);
    fragments.delete('src/b.ts');
    const comparison = compareReferenceFragmentMaps(
      definitions,
      expected,
      assembleReferenceFragments(definitions, fragments),
    );
    expect(comparison).toEqual({
      passed: false,
      expectedCount: 3,
      actualCount: 1,
      missing: ['pkg alpha().\u0000src/b.ts\u00004\u00005', 'pkg beta().\u0000src/b.ts\u00007\u00001'],
      extra: [],
    });
  });

  it('deduplicates and ignores fragments for definitions outside the request', () => {
    const fragments = new Map([
      [
        'src/a.ts',
        [
          { targetSymbol: alpha.symbol, location: { file: 'src/a.ts', line: 2, column: 3 } },
          { targetSymbol: alpha.symbol, location: { file: 'src/a.ts', line: 2, column: 3 } },
          { targetSymbol: 'pkg outside().', location: { file: 'src/a.ts', line: 9, column: 0 } },
        ],
      ],
    ]);
    expect(assembleReferenceFragments([alpha], fragments)).toEqual(
      new Map([[alpha.symbolId, [{ file: 'src/a.ts', line: 2, column: 3 }]]]),
    );
  });
});

function definition(symbolId: number, symbol: string, leaf: string, relativePath: string): IndexedDefinition {
  return {
    symbolId,
    documentId: 1,
    symbol,
    leaf,
    relativePath,
    startLine: symbolId,
    endLine: symbolId,
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: 12,
    documentation: null,
    enclosingSymbol: null,
  };
}
