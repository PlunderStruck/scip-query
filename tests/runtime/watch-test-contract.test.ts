import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WATCHER_TEST_FILES = [
  'tests/runtime/watch.test.ts',
  'tests/runtime/worktree-watch-service.integration.test.ts',
] as const;

describe('watcher test seam contract', () => {
  it('forbids tests from casting through Watcher private members', () => {
    const violations = WATCHER_TEST_FILES.flatMap((file) => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      return source
        .split('\n')
        .map((line, index) => ({ file, line: index + 1, text: line.trim() }))
        .filter(({ text }) => text.includes('as unknown as'));
    });

    expect(violations).toEqual([]);
  });
});
