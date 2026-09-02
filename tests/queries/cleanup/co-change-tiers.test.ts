import { describe, expect, it } from 'vitest';
import { coChangeActionTier } from '../../../src/queries/cleanup/co-change.js';

describe('coChangeActionTier', () => {
  it('keeps pairs with focused co-changes as direct findings', () => {
    expect(coChangeActionTier({ focusedTogether: 3, recency: 'recent' }, 'same-feature')).toEqual({
      actionTier: 'direct',
      tierReason: '3 focused co-change(s)',
    });
    expect(coChangeActionTier({ focusedTogether: 5, recency: 'stale' }, 'unknown').actionTier).toBe('direct');
    expect(coChangeActionTier({ focusedTogether: 1, recency: 'recent' }, 'unknown').actionTier).toBe('direct');
  });

  it('demotes sweep-only, stale, and configuration pairs to signal tier', () => {
    expect(coChangeActionTier({ focusedTogether: 0, recency: 'recent' }, 'same-feature')).toEqual({
      actionTier: 'signal',
      tierReason: 'every shared commit was a broad sweep; no focused change touched both files',
    });
    expect(coChangeActionTier({ focusedTogether: 2, recency: 'stale' }, 'same-feature').actionTier).toBe('signal');
    expect(coChangeActionTier({ focusedTogether: 4, recency: 'recent' }, 'config-code').actionTier).toBe('signal');
    expect(coChangeActionTier({ focusedTogether: 4, recency: 'recent' }, 'doc-code').actionTier).toBe('signal');
  });
});
