import { describe, expect, it } from 'vitest';
import { rowIdentity, scoreLabels, type DetectorLabelSet } from '../../scripts/score-detector-labels.js';

describe('score-detector-labels', () => {
  const labelSet: DetectorLabelSet = {
    detector: 'react-component-duplicates',
    repository: 'fixture',
    identity: 'pair',
    labels: [
      { id: 'src/A.tsx#A|src/B.tsx#B', verdict: 'true', reason: 'copied widget' },
      { id: 'src/C.tsx#C|src/D.tsx#D', verdict: 'true', reason: 'copied panel' },
      { id: 'src/E.tsx#E|src/F.tsx#F', verdict: 'false', reason: 'kit primitives' },
      { id: 'src/G.tsx#G|src/H.tsx#H', verdict: 'false', reason: 'route scaffolding' },
    ],
  };
  const dump = {
    result: [
      { fileA: 'src/B.tsx', componentA: 'B', fileB: 'src/A.tsx', componentB: 'A', actionTier: 'signal' },
      { fileA: 'src/G.tsx', componentA: 'G', fileB: 'src/H.tsx', componentB: 'H', actionTier: 'support' },
      { fileA: 'src/X.tsx', componentA: 'X', fileB: 'src/Y.tsx', componentB: 'Y', actionTier: 'signal' },
    ],
  };

  it('derives order-independent pair identities', () => {
    expect(rowIdentity('pair', dump.result[0]!)).toBe('src/A.tsx#A|src/B.tsx#B');
    expect(rowIdentity('symbol', { file: 'src/a.ts', shortName: 'a()' })).toBe('src/a.ts#a()');
    expect(rowIdentity('group', { leaf: 'chunk', members: [{ file: 'b.ts' }, { file: 'a.ts' }] })).toBe(
      'chunk|a.ts,b.ts',
    );
  });

  it('separates signal hits, support demotions, and absences per verdict', () => {
    const score = scoreLabels(labelSet, dump);
    expect(score).toEqual(
      expect.objectContaining({
        dumpRows: 3,
        labeledRows: 4,
        present: { true: 1, false: 0, uncertain: 0 },
        demoted: { true: 0, false: 1, uncertain: 0 },
        absent: { true: 1, false: 1, uncertain: 0 },
        precision: 1,
        recall: 0.5,
        unlabeledRows: 1,
      }),
    );
    expect(score.missingTrue.map((label) => label.id)).toEqual(['src/C.tsx#C|src/D.tsx#D']);
    expect(score.retainedFalse).toEqual([]);
  });
});
