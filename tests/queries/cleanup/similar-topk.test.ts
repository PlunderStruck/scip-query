import { describe, expect, it } from 'vitest';
import { insertTopSimilarResult, type RankedSimilarResult, type SimilarSymbolResult } from '../../../src/queries/cleanup/similar.js';

function result(name: string, similarity: number): SimilarSymbolResult {
  return {
    symbolA: `${name}.a`,
    shortNameA: `${name}.a`,
    fileA: `${name}.ts`,
    symbolB: `${name}.b`,
    shortNameB: `${name}.b`,
    fileB: `${name}.ts`,
    similarity,
    similarityBasis: 'callees',
    sharedCallees: [],
    uniqueToA: [],
    uniqueToB: [],
  };
}

describe('similarAll top-k collector', () => {
  it('keeps exact top scores without displacing earlier equal-score ties', () => {
    const top: RankedSimilarResult[] = [];

    insertTopSimilarResult(top, result('first', 0.7), 2, 0);
    insertTopSimilarResult(top, result('second', 0.6), 2, 1);
    insertTopSimilarResult(top, result('third', 0.9), 2, 2);
    insertTopSimilarResult(top, result('fourth', 0.7), 2, 3);

    const ranked = [...top]
      .sort((a, b) => b.result.similarity - a.result.similarity || a.order - b.order)
      .map((entry) => entry.result.shortNameA);

    expect(ranked).toEqual(['third.a', 'first.a']);
  });
});
