import { describe, expect, it } from 'vitest';
import { scoreSymbolCandidate } from '../../src/symbols/symbol-lookup.js';

const row = {
  symbol_id: 1,
  symbol: 'scip-typescript npm pkg 1.0.0 src/`nested.ts`/buildMap().',
  display_name: 'buildMap',
  relative_path: 'src/nested.ts',
  start_line: 2,
  end_line: 12,
};
const patterns = [
  ['buildMap', 'buildMap', ['buildMap']],
  ['buildMap()', 'buildMap', ['buildMap']],
  ['BuildMap', 'BuildMap', ['BuildMap']],
  ['nested/buildMap', 'nested/buildMap', ['nested', 'buildMap']],
  ['src:nested:buildMap', 'src:nested:buildMap', ['src', 'nested', 'buildMap']],
  ['nested.ts', 'nested.ts', ['nested', 'ts']],
  ['unmatched', 'unmatched', ['unmatched']],
  [' buildMap ', 'buildMap', ['buildMap']],
] as const;

describe('symbol score contract', () => {
  it('preserves additive weights across exact, case-folded, qualified, and partial matches', () => {
    const scores = patterns.map(([original, cleaned, tokens]) =>
      scoreSymbolCandidate(row, original, cleaned, [...tokens]),
    );
    expect(scores).toEqual([5350, 7125, 3010, 1360, 275, 1255, -10, 5350]);
  });
});
