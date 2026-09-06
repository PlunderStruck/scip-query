import { describe, expect, it } from 'vitest';
import { normalizeOccurrenceRange } from '../../src/domain/scip-range.js';

describe('SCIP source coordinate coverage', () => {
  it('uses an undeclared encoding only while all preceding characters are ASCII', () => {
    for (const encoding of [undefined, null, '']) {
      expect(normalizeOccurrenceRange([0, 1, 5], encoding, ['alpha😀'])).toEqual({
        startLine: 0,
        startColumn: 1,
        endLine: 0,
        endColumn: 5,
      });
      expect(normalizeOccurrenceRange([0, 5, 7], encoding, ['alpha😀'])).toBeUndefined();
    }
  });

  it('rejects an unsupported declared encoding even for ASCII text', () => {
    expect(normalizeOccurrenceRange([0, 0, 3], 'unknown-encoding', ['abc'])).toBeUndefined();
  });

  it('rejects offsets inside a UTF-8 code point and coordinates outside the available source', () => {
    expect(normalizeOccurrenceRange([0, 1, 4], 'UTF-8', ['😀x'])).toBeUndefined();
    expect(normalizeOccurrenceRange([0, 0, 9], 'UTF-32', ['😀x'])).toBeUndefined();
    expect(normalizeOccurrenceRange([0, 0, 9], 'UTF-16', ['😀x'])).toBeUndefined();
    expect(normalizeOccurrenceRange([1, 0, 1], 'UTF-16', ['abc'])).toBeUndefined();
    expect(normalizeOccurrenceRange([0, -1, 1], 'UTF-16', ['abc'])).toBeUndefined();
  });
});
