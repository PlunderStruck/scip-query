import { describe, expect, it } from 'vitest';
import { sourceMayContainCandidateName } from '../../src/source/primitives/source-identifier-prefilter.js';

describe('sourceMayContainCandidateName', () => {
  it('matches simple identifier candidates as exact tokens', () => {
    const candidates = new Set(['Foo']);

    expect(sourceMayContainCandidateName('const value = Foo.create();', candidates)).toBe(true);
    expect(sourceMayContainCandidateName('const value = FooBar.create();', candidates)).toBe(false);
  });

  it('matches non-identifier candidates by raw substring', () => {
    const candidates = new Set(['foo-bar']);

    expect(sourceMayContainCandidateName('dispatch("foo-bar")', candidates)).toBe(true);
    expect(sourceMayContainCandidateName('dispatch("foo_bar")', candidates)).toBe(false);
  });

  it('keeps scanning when no usable candidate names were provided', () => {
    expect(sourceMayContainCandidateName('anything at all', new Set())).toBe(true);
    expect(sourceMayContainCandidateName('anything at all', new Set(['']))).toBe(true);
  });

  it('returns false when source lacks every candidate name', () => {
    const candidates = new Set(['Alpha', 'Beta']);

    expect(sourceMayContainCandidateName('const gamma = 1;', candidates)).toBe(false);
  });
});
