import { describe, expect, it } from 'vitest';
import { stronglyConnectedComponents } from '../../src/analysis/strongly-connected-components.js';

describe('stronglyConnectedComponents', () => {
  it('includes dependency targets that are not graph keys', () => {
    const result = stronglyConnectedComponents(new Map([['source', new Set(['target'])]]));

    expect(result.components).toEqual([['target'], ['source']]);
    expect(result.componentOf.size).toBe(2);
    expect(result.componentOf.get('target')).toBe(0);
    expect(result.componentOf.get('source')).toBe(1);
  });

  it('condenses mutually reachable nodes once and preserves reverse topological order', () => {
    const result = stronglyConnectedComponents(
      new Map([
        ['entry', new Set(['cycle-a'])],
        ['cycle-a', new Set(['cycle-b'])],
        ['cycle-b', new Set(['cycle-a', 'tail'])],
      ]),
    );

    expect(result.components.map((component) => [...component].sort())).toEqual([
      ['tail'],
      ['cycle-a', 'cycle-b'],
      ['entry'],
    ]);
    expect(result.componentOf.get('cycle-a')).toBe(result.componentOf.get('cycle-b'));
  });
});
