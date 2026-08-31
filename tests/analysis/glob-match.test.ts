import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { globLiteralPrefix, listGlobMatches } from '../../src/analysis/glob-match.js';
import { matchesPathGlob } from '../../src/domain/path-glob.js';

describe('matchesPathGlob', () => {
  it('matches immediate children with a trailing /*', () => {
    expect(matchesPathGlob('skills/*', 'skills/scip-query')).toBe(true);
    expect(matchesPathGlob('skills/*', 'skills/scip-query/SKILL.md')).toBe(false);
    expect(matchesPathGlob('skills/*', 'other/scip-query')).toBe(false);
  });

  it('matches any depth with a trailing /**', () => {
    expect(matchesPathGlob('docs/plans/**', 'docs/plans')).toBe(true);
    expect(matchesPathGlob('docs/plans/**', 'docs/plans/2026-07-01-plan.md')).toBe(true);
    expect(matchesPathGlob('docs/plans/**', 'docs/plans/nested/deep/file.md')).toBe(true);
    expect(matchesPathGlob('docs/plans/**', 'docs/other/file.md')).toBe(false);
  });

  it('treats a plain pattern as an exact match', () => {
    expect(matchesPathGlob('README.md', 'README.md')).toBe(true);
    expect(matchesPathGlob('README.md', 'docs/README.md')).toBe(false);
  });
});

describe('globLiteralPrefix', () => {
  it('strips the trailing glob segment', () => {
    expect(globLiteralPrefix('skills/*')).toBe('skills');
    expect(globLiteralPrefix('docs/plans/**')).toBe('docs/plans');
    expect(globLiteralPrefix('README.md')).toBe('README.md');
  });
});

describe('listGlobMatches', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'scip-glob-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(root, 'skills', 'beta'), { recursive: true });
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '# a\n');
    writeFileSync(join(root, 'skills', 'beta', 'SKILL.md'), '# b\n');
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'p1.md'), 'p1\n');
    mkdirSync(join(root, 'docs', 'plans', 'nested'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'nested', 'p2.md'), 'p2\n');
    return root;
  }

  it('lists immediate children only for a single-star pattern', () => {
    const root = fixture();
    expect(listGlobMatches(root, 'skills/*')).toEqual(['skills/alpha', 'skills/beta']);
  });

  it('lists every nested path for a double-star pattern', () => {
    const root = fixture();
    expect(listGlobMatches(root, 'docs/plans/**')).toEqual([
      'docs/plans/nested',
      'docs/plans/nested/p2.md',
      'docs/plans/p1.md',
    ]);
  });
});
