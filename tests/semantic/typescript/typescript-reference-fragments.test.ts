import { describe, expect, it } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import {
  assembleReferenceFragments,
  compareReferenceFragmentMaps,
  createReferenceFragmentAccumulator,
  referenceFragmentsFromDefinitionMap,
} from '../../../src/semantic/typescript/reference-fragments.js';
import {
  relieveFragmentHeapPressure,
  typeScriptReferenceFragmentBatches,
} from '../../../src/semantic/typescript/reference-fragment-shadow.js';

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
      callerFiles: {
        passed: true,
        expectedCount: 3,
        actualCount: 3,
        missing: [],
        extra: [],
      },
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
      callerFiles: {
        passed: false,
        expectedCount: 3,
        actualCount: 1,
        missing: ['pkg alpha().\u0000src/b.ts', 'pkg beta().\u0000src/b.ts'],
        extra: [],
      },
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

  it('bounds compiler-backed reference fragment requests', () => {
    const files = Array.from({ length: 257 }, (_, index) => `src/file-${index}.ts`);

    expect(typeScriptReferenceFragmentBatches(files).map((batch) => batch.length)).toEqual([128, 128, 1]);
    expect(typeScriptReferenceFragmentBatches([])).toEqual([]);
  });

  it('assembles batches without retaining a file-to-fragments map', () => {
    const fragments = referenceFragmentsFromDefinitionMap(definitions, expected, ['src/a.ts', 'src/b.ts']);
    const accumulator = createReferenceFragmentAccumulator(definitions);

    accumulator.add(fragments.get('src/a.ts') ?? []);
    accumulator.add(fragments.get('src/b.ts') ?? []);

    expect(accumulator.finish()).toEqual(expected);
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

describe('fragment batch heap pressure', () => {
  function probe(fractions: number[], collected = true) {
    const calls = { collect: 0, release: 0 };
    return {
      calls,
      probe: {
        heapUsedFraction: () => fractions.shift() ?? 0,
        collect: () => {
          calls.collect += 1;
          return collected;
        },
        release: () => {
          calls.release += 1;
        },
      },
    };
  }

  it('leaves a session alone below the threshold', () => {
    const { probe: p, calls } = probe([0.5]);
    expect(relieveFragmentHeapPressure(p, 0.75)).toBe(false);
    expect(calls).toEqual({ collect: 0, release: 0 });
  });

  it('collects first and keeps the session when garbage was the pressure', () => {
    const { probe: p, calls } = probe([0.9, 0.4]);
    expect(relieveFragmentHeapPressure(p, 0.75)).toBe(false);
    expect(calls).toEqual({ collect: 1, release: 0 });
  });

  it('releases the session when live state stays above the threshold after a collection', () => {
    const { probe: p, calls } = probe([0.9, 0.85]);
    expect(relieveFragmentHeapPressure(p, 0.75)).toBe(true);
    expect(calls).toEqual({ collect: 1, release: 1 });
  });

  it('releases without a second measurement when no collector is available', () => {
    const { probe: p, calls } = probe([0.9, 0.1], false);
    expect(relieveFragmentHeapPressure(p, 0.75)).toBe(true);
    expect(calls).toEqual({ collect: 1, release: 1 });
  });
});
