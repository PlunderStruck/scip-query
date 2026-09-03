import { describe, expect, it } from 'vitest';
import { promoteSiblingSimilarity, type SimilarEvidenceClassification } from '../../../src/queries/cleanup/similar.js';

const signal = (evidenceClass: SimilarEvidenceClassification['evidenceClass']): SimilarEvidenceClassification => ({
  evidenceClass,
  actionTier: 'signal',
  evidenceClassReasons: ['access/query scaffolding: prisma'],
  recommendation: 'compare',
});

describe('promoteSiblingSimilarity', () => {
  it('reports same-file siblings sharing half their callees as direct whatever the vocabulary', () => {
    const promoted = promoteSiblingSimilarity(signal('access-query-scaffolding'), {
      similarity: 0.94,
      sharedCount: 6,
      sameFile: true,
    });
    expect(promoted.actionTier).toBe('direct');
    expect(promoted.evidenceClass).toBe('access-query-scaffolding');
    expect(promoted.evidenceClassReasons.at(-1)).toBe('same-file siblings share 6 callees at similarity 0.94');
    expect(promoted.recommendation).toContain('Sibling functions in one file');
    expect(
      promoteSiblingSimilarity(signal('mixed'), { similarity: 0.55, sharedCount: 4, sameFile: true }).actionTier,
    ).toBe('direct');
  });

  it('reports cross-file mixed evidence as direct only at high overlap', () => {
    expect(
      promoteSiblingSimilarity(signal('mixed'), { similarity: 0.6, sharedCount: 4, sameFile: false }).actionTier,
    ).toBe('direct');
    expect(
      promoteSiblingSimilarity(signal('mixed'), { similarity: 0.44, sharedCount: 11, sameFile: false }).actionTier,
    ).toBe('signal');
  });

  it('leaves cross-file scaffolding pairs, thin overlaps, and direct rows alone', () => {
    const handlers = signal('access-query-scaffolding');
    expect(promoteSiblingSimilarity(handlers, { similarity: 0.82, sharedCount: 4, sameFile: false })).toBe(handlers);
    expect(promoteSiblingSimilarity(handlers, { similarity: 0.45, sharedCount: 4, sameFile: true })).toBe(handlers);
    expect(promoteSiblingSimilarity(handlers, { similarity: 0.9, sharedCount: 3, sameFile: true })).toBe(handlers);
    const direct: SimilarEvidenceClassification = { ...signal('domain-behavior'), actionTier: 'direct' };
    expect(promoteSiblingSimilarity(direct, { similarity: 0.9, sharedCount: 8, sameFile: true })).toBe(direct);
  });
});
