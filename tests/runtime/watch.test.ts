import { describe, expect, it } from 'vitest';
import { tempScipPath } from '../../src/runtime/watch.js';

describe('tempScipPath', () => {
  it('preserves the .scip suffix for temporary files', () => {
    expect(tempScipPath('/tmp/index.scip')).toBe('/tmp/index.tmp.scip');
  });

  it('adds a .tmp.scip suffix when the path has no .scip extension', () => {
    expect(tempScipPath('/tmp/index')).toBe('/tmp/index.tmp.scip');
  });
});
