import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Windows SCIP sidecar documentation', () => {
  it('keeps the checked-in README and its generator on the npm-sidecar release path', () => {
    const readme = readFileSync('packages/scip-windows/README.md', 'utf8');
    const generator = readFileSync('scripts/build-scip-windows.mjs', 'utf8');

    for (const content of [readme, generator]) {
      expect(content).toContain('scip-query-scip-windows');
      expect(content).toContain('optional dependency');
      expect(content).not.toContain('scip-windows-assets.ts');
      expect(content).not.toContain('GitHub release asset');
    }
  });
});
