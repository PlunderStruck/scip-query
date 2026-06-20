import { describe, it, expect } from 'vitest';
import { createGitignoreFilter } from '../../src/source/gitignore-filter.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('createGitignoreFilter', () => {
  it('respects .gitignore patterns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-test-'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n*.pyc\n');

    const filter = createGitignoreFilter(dir);

    expect(filter.isIgnored('node_modules/foo/bar.js')).toBe(true);
    expect(filter.isIgnored('dist/index.js')).toBe(true);
    expect(filter.isIgnored('foo.pyc')).toBe(true);
    expect(filter.isIgnored('src/app.ts')).toBe(false);
    expect(filter.isIgnored('lib/utils.py')).toBe(false);
  });

  it('uses defaults when no .gitignore exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-test-'));

    const filter = createGitignoreFilter(dir);

    // Defaults should exclude common dependency/build dirs
    expect(filter.isIgnored('node_modules/foo.js')).toBe(true);
    expect(filter.isIgnored('dist/bundle.js')).toBe(true);
    expect(filter.isIgnored('target/debug/main')).toBe(true);
    expect(filter.isIgnored('__pycache__/foo.pyc')).toBe(true);
    expect(filter.isIgnored('.venv/lib/site-packages/foo.py')).toBe(true);

    // Source files should NOT be excluded
    expect(filter.isIgnored('src/main.rs')).toBe(false);
    expect(filter.isIgnored('app/models/user.rb')).toBe(false);
  });

  it('filters an array of paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-test-'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');

    const filter = createGitignoreFilter(dir);
    const paths = ['src/app.ts', 'node_modules/foo/index.js', 'lib/utils.ts'];
    const filtered = filter.filter(paths);

    expect(filtered).toEqual(['src/app.ts', 'lib/utils.ts']);
  });

  it('does not throw when a query path resolves outside the project root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-test-'));
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');

    const filter = createGitignoreFilter(join(dir, 'apps', 'web'));

    expect(() => filter.isIgnored('../../packages/shared/src/constants.ts')).not.toThrow();
    expect(filter.isIgnored('../../packages/shared/src/constants.ts')).toBe(false);
  });
});
