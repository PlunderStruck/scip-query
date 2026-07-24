import { describe, expect, it } from 'vitest';
import {
  createCandidateNameMatcher,
  sourceMayContainCandidateName,
} from '../../src/source/primitives/source-identifier-prefilter.js';

describe('source identifier prefilter', () => {
  it('treats empty candidate sets as an unconstrained match', () => {
    const candidates = new Set<string>();
    const matcher = createCandidateNameMatcher(candidates);

    expect(sourceMayContainCandidateName('const value = 1;', candidates)).toBe(true);
    expect(sourceMayContainCandidateName('const value = 1;', matcher)).toBe(true);
  });

  it('matches simple identifier tokens through the raw set and reusable matcher paths', () => {
    const candidates = new Set(['renderGuide', 'unusedName']);
    const matcher = createCandidateNameMatcher(candidates);
    const source = 'export function renderGuide() { return null; }';

    expect(sourceMayContainCandidateName(source, candidates)).toBe(true);
    expect(sourceMayContainCandidateName(source, matcher)).toBe(true);
  });

  it('rejects absent identifiers through both paths', () => {
    const candidates = new Set(['renderGuide']);
    const matcher = createCandidateNameMatcher(candidates);
    const source = 'export function renderMap() { return null; }';

    expect(sourceMayContainCandidateName(source, candidates)).toBe(false);
    expect(sourceMayContainCandidateName(source, matcher)).toBe(false);
  });

  it('preserves non-identifier candidate substring fallback', () => {
    const candidates = new Set(['data-testid']);
    const matcher = createCandidateNameMatcher(candidates);
    const source = '<button data-testid="save">Save</button>';

    expect(sourceMayContainCandidateName(source, candidates)).toBe(true);
    expect(sourceMayContainCandidateName(source, matcher)).toBe(true);
  });

  it('treats candidate sets containing only empty strings as unconstrained', () => {
    const candidates = new Set(['']);
    const matcher = createCandidateNameMatcher(candidates);

    expect(sourceMayContainCandidateName('const value = 1;', candidates)).toBe(true);
    expect(sourceMayContainCandidateName('const value = 1;', matcher)).toBe(true);
  });
});
