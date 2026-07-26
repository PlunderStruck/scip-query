import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toRelative } from '../../../src/semantic/typescript/semantic-locations.js';

describe('TypeScript semantic location paths', () => {
  it('relates canonical compiler paths to a symlink-spelled project root', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-query-semantic-path-'));
    try {
      const canonicalRoot = join(fixtureRoot, 'canonical');
      const aliasRoot = join(fixtureRoot, 'alias');
      mkdirSync(join(canonicalRoot, 'src'), { recursive: true });
      writeFileSync(join(canonicalRoot, 'src/a.ts'), 'export const a = 1;\n');
      symlinkSync(canonicalRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');

      expect(toRelative(aliasRoot, join(canonicalRoot, 'src/a.ts'))).toBe('src/a.ts');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
