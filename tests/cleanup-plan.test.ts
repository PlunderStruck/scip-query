import { describe, expect, it } from 'vitest';
import { RemovedRangeIndex } from '../src/queries/cleanup-plan.js';
import { deleteLineRanges, errorKey } from '../src/runtime/cleanup-verify.js';

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

describe('verification line deletion', () => {
  it('removes inclusive 0-indexed ranges, handling overlap and out-of-bounds', () => {
    const content = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].join('\n');

    expect(deleteLineRanges(content, [{ start: 1, end: 2 }])).toBe('l0\nl3\nl4\nl5');
    expect(deleteLineRanges(content, [{ start: 1, end: 3 }, { start: 2, end: 4 }])).toBe('l0\nl5');
    expect(deleteLineRanges(content, [{ start: 4, end: 99 }])).toBe('l0\nl1\nl2\nl3');
    expect(deleteLineRanges(content, [])).toBe(content);
  });

  it('extends truncated ranges until brackets balance so statements are never bisected', () => {
    const content = [
      'const keep = 1;',
      'export const dead = items.map((item) => {', // index says 1-1, real extent 1-3
      '  return item;',
      '});',
      'const alsoKeep = 2;',
    ].join('\n');

    expect(deleteLineRanges(content, [{ start: 1, end: 1 }]))
      .toBe('const keep = 1;\nconst alsoKeep = 2;');
    // Strings containing brackets must not confuse the balance.
    const tricky = ['const a = "}{";', 'const dead = [', '  1,', '];'].join('\n');
    expect(deleteLineRanges(tricky, [{ start: 1, end: 1 }])).toBe('const a = "}{";');
  });
});

describe('verification error identity', () => {
  it('is position-independent so shifted pre-existing errors still match the baseline', () => {
    expect(errorKey("src/app.ts(12,8): error TS1259: Module 'x' can only be default-imported"))
      .toBe(errorKey("src/app.ts(99,8): error TS1259: Module 'x' can only be default-imported"));
    expect(errorKey('error[E0432]: unresolved import --> src/lib.rs:4:5'))
      .toBe(errorKey('error[E0432]: unresolved import --> src/lib.rs:9:1'));
    expect(errorKey("a.ts(1,1): error TS2304: Cannot find name 'x'"))
      .not.toBe(errorKey("a.ts(1,1): error TS2304: Cannot find name 'y'"));
  });
});
