import { describe, expect, it } from 'vitest';
import {
  formatRecordCompatibilityWarning,
  summarizeRecordCompatibility,
} from '../../src/domain/record-compatibility.js';

describe('record compatibility summary', () => {
  it('counts every candidate exactly once and keeps path-specific omissions', () => {
    const summary = summarizeRecordCompatibility([
      { path: 'legacy.json', state: 'legacy' },
      { path: 'current.json', state: 'current' },
      { path: 'old.json', state: 'unsupported-older', reason: 'schemaVersion 0' },
      { path: 'future.json', state: 'unsupported-future', reason: 'schemaVersion 2' },
      { path: 'broken.json', state: 'malformed', reason: 'malformed JSON' },
    ]);

    expect(summary).toEqual({
      complete: false,
      total: 5,
      accepted: 2,
      legacy: 1,
      current: 1,
      unsupportedOlder: 1,
      unsupportedFuture: 1,
      malformed: 1,
      omitted: 3,
      issues: [
        { path: 'old.json', state: 'unsupported-older', reason: 'schemaVersion 0' },
        { path: 'future.json', state: 'unsupported-future', reason: 'schemaVersion 2' },
        { path: 'broken.json', state: 'malformed', reason: 'malformed JSON' },
      ],
    });
    expect(summary.accepted + summary.omitted).toBe(summary.total);
    expect(formatRecordCompatibilityWarning('Evidence', summary)).toContain('accepted 2 of 5 record(s); omitted 3');
  });

  it('reports complete coverage for empty and fully readable candidate sets', () => {
    for (const observations of [
      [],
      [
        { path: 'legacy.json', state: 'legacy' as const },
        { path: 'current.json', state: 'current' as const },
      ],
    ]) {
      const summary = summarizeRecordCompatibility(observations);
      expect(summary.complete).toBe(true);
      expect(summary.omitted).toBe(0);
      expect(formatRecordCompatibilityWarning('Evidence', summary)).toBeUndefined();
    }
  });
});
