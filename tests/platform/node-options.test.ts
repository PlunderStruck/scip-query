import { describe, expect, it } from 'vitest';
import { inheritedMaxOldSpaceMb, nodeOptionsWithMaxOldSpace } from '../../src/platform/node-options.js';

describe('child NODE_OPTIONS', () => {
  it('keeps the parent flags and replaces only the heap bound', () => {
    expect(nodeOptionsWithMaxOldSpace('--require /tmp/probe.cjs --max-old-space-size=1024', 4096)).toBe(
      '--require /tmp/probe.cjs --max-old-space-size=4096',
    );
    expect(nodeOptionsWithMaxOldSpace(undefined, 2048)).toBe('--max-old-space-size=2048');
    expect(nodeOptionsWithMaxOldSpace('--max_old_space_size 512', 2048)).toBe('--max-old-space-size=2048');
  });

  it('reads an inherited heap bound', () => {
    expect(inheritedMaxOldSpaceMb('--inspect --max-old-space-size=3072')).toBe(3072);
    expect(inheritedMaxOldSpaceMb('--inspect')).toBeUndefined();
  });
});
