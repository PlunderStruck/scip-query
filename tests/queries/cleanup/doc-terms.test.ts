import { describe, expect, it } from 'vitest';
import { matchingDocTerms } from '../../../src/queries/cleanup/doc-terms.js';

describe('doc terms', () => {
  it('returns only terms present in the candidate text', () => {
    expect(matchingDocTerms('declaredCouplings links src/a.ts to docs.', ['declaredCouplings', 'missing'])).toEqual([
      'declaredCouplings',
    ]);
  });
});
