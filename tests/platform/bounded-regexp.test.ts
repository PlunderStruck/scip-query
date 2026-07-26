import { describe, expect, it } from 'vitest';
import {
  compileBoundedRegExp,
  MAX_CONFIG_REGEXP_PATTERN_CHARACTERS,
  RegExpPatternBudgetError,
} from '../../src/platform/bounded-regexp.js';

describe('bounded repository regular expressions', () => {
  it('compiles patterns at the configured boundary', () => {
    const pattern = `^${'a'.repeat(MAX_CONFIG_REGEXP_PATTERN_CHARACTERS - 2)}$`;
    expect(compileBoundedRegExp(pattern, 'test pattern').test('a')).toBe(false);
  });

  it('rejects oversized patterns with a typed, actionable error', () => {
    const pattern = 'a'.repeat(MAX_CONFIG_REGEXP_PATTERN_CHARACTERS + 1);

    expect(() => compileBoundedRegExp(pattern, 'entryRoots.symbolPatterns[0]')).toThrow(RegExpPatternBudgetError);
    expect(() => compileBoundedRegExp(pattern, 'entryRoots.symbolPatterns[0]')).toThrow(
      /entryRoots\.symbolPatterns\[0\].*4097 characters.*4096 characters/u,
    );
  });

  it('preserves native invalid-pattern diagnostics below the size limit', () => {
    expect(() => compileBoundedRegExp('[', 'test pattern')).toThrow(SyntaxError);
  });
});
