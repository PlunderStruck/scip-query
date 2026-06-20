import { describe, it, expect } from 'vitest';
import {
  computeIdf,
  containment,
  difference,
  getMedianIdf,
  intersection,
  jaccard,
  weightedCosine,
} from '../../src/analysis/similarity.js';

describe('similarity kernel', () => {
  describe('intersection / difference', () => {
    it('intersection returns shared elements', () => {
      const out = intersection(new Set([1, 2, 3]), new Set([2, 3, 4]));
      expect([...out].sort()).toEqual([2, 3]);
    });

    it('difference returns left-only elements', () => {
      const out = difference(new Set([1, 2, 3]), new Set([2, 3, 4]));
      expect([...out]).toEqual([1]);
    });
  });

  describe('jaccard', () => {
    it('returns 1 for identical sets', () => {
      expect(jaccard(new Set([1, 2]), new Set([1, 2]))).toBe(1);
    });

    it('returns 0 for disjoint sets', () => {
      expect(jaccard(new Set([1, 2]), new Set([3, 4]))).toBe(0);
    });

    it('returns 0 for two empty sets (no division by zero)', () => {
      expect(jaccard(new Set(), new Set())).toBe(0);
    });

    it('matches |A∩B|/|A∪B|', () => {
      // {1,2,3} ∩ {2,3,4} = {2,3}; union = {1,2,3,4}; 2/4 = 0.5
      expect(jaccard(new Set([1, 2, 3]), new Set([2, 3, 4]))).toBeCloseTo(0.5, 6);
    });
  });

  describe('containment', () => {
    it('returns 0 for an empty A (no division by zero)', () => {
      expect(containment(new Set(), new Set([1, 2]))).toBe(0);
    });

    it('returns 1 when A is fully inside B, regardless of B extras', () => {
      expect(containment(new Set([1, 2]), new Set([1, 2, 3, 4]))).toBe(1);
    });

    it('returns the contained fraction of A', () => {
      // {1,2,3,4} ∩ {1,2} = {1,2}; 2/|A| = 2/4
      expect(containment(new Set([1, 2, 3, 4]), new Set([1, 2]))).toBeCloseTo(0.5, 6);
    });

    it('is asymmetric (unlike jaccard)', () => {
      const small = new Set([1, 2]);
      const big = new Set([1, 2, 3, 4]);
      expect(containment(small, big)).toBe(1);
      expect(containment(big, small)).toBeCloseTo(0.5, 6);
    });
  });

  describe('computeIdf', () => {
    it('returns empty map for empty corpus', () => {
      expect(computeIdf([])).toEqual(new Map());
    });

    it('a feature in every document gets weight log(1) = 0', () => {
      const idf = computeIdf([new Set(['a']), new Set(['a']), new Set(['a'])]);
      expect(idf.get('a')).toBeCloseTo(0, 6);
    });

    it('a unique feature gets the maximum weight log(N)', () => {
      const idf = computeIdf([new Set(['a', 'unique']), new Set(['a']), new Set(['a'])]);
      expect(idf.get('unique')).toBeCloseTo(Math.log(3), 6);
    });
  });

  describe('weightedCosine', () => {
    it('returns 0 for disjoint sets', () => {
      const idf = new Map([
        ['a', 1],
        ['b', 1],
      ]);
      expect(weightedCosine(new Set(['a']), new Set(['b']), idf).similarity).toBe(0);
    });

    it('returns 1 for identical sets with non-zero weight', () => {
      const idf = new Map([
        ['a', 1],
        ['b', 0.5],
      ]);
      const r = weightedCosine(new Set(['a', 'b']), new Set(['a', 'b']), idf);
      expect(r.similarity).toBeCloseTo(1, 6);
    });

    it('splits shared features around the median IDF', () => {
      // Three features with weights 0.1, 0.5, 0.9. Median = 0.5; "significant"
      // means ≥ 0.5, so b and c, while a is "trivial".
      const idf = new Map([
        ['a', 0.1],
        ['b', 0.5],
        ['c', 0.9],
      ]);
      const r = weightedCosine(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']), idf);
      expect(r.significantShared.sort()).toEqual(['b', 'c']);
      expect(r.trivialShared).toEqual(['a']);
    });

    it('zero-weight feature contributes nothing to the cosine', () => {
      // 'shared' has weight 0 (every doc has it); only the unique-shared
      // feature 'rare' actually drives similarity.
      const idf = new Map([
        ['shared', 0],
        ['rare', 2],
      ]);
      const r = weightedCosine(new Set(['shared', 'rare']), new Set(['shared', 'rare']), idf);
      expect(r.similarity).toBeCloseTo(1, 6);
      expect(r.significantShared).toEqual(['rare']);
    });
  });

  describe('getMedianIdf', () => {
    it('returns 0 for empty IDF map', () => {
      expect(getMedianIdf(new Map())).toBe(0);
    });

    it('odd count returns the middle value', () => {
      expect(
        getMedianIdf(
          new Map([
            ['a', 1],
            ['b', 3],
            ['c', 5],
          ]),
        ),
      ).toBe(3);
    });

    it('even count returns the mean of the two middles', () => {
      expect(
        getMedianIdf(
          new Map([
            ['a', 1],
            ['b', 2],
            ['c', 3],
            ['d', 4],
          ]),
        ),
      ).toBe(2.5);
    });
  });
});
