import { describe, expect, it } from 'vitest';
import { RemovedRangeIndex } from '../src/queries/cleanup-plan.js';

describe('cleanup plan removed-range index', () => {
  it('answers membership per file and line range', () => {
    const index = new RemovedRangeIndex();
    index.add({ file: 'src/a.ts', startLine: 10, endLine: 20 });
    index.add({ file: 'src/a.ts', startLine: 40, endLine: 45 });
    index.add({ file: 'src/b.ts', startLine: 0, endLine: 5 });

    expect(index.contains('src/a.ts', 10)).toBe(true);
    expect(index.contains('src/a.ts', 20)).toBe(true);
    expect(index.contains('src/a.ts', 21)).toBe(false);
    expect(index.contains('src/a.ts', 42)).toBe(true);
    expect(index.contains('src/b.ts', 3)).toBe(true);
    expect(index.contains('src/c.ts', 3)).toBe(false);
  });
});
