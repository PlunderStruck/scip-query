import { describe, expect, it } from 'vitest';
import {
  behaviorSimilarity,
  evaluatePressure,
  overlapGate,
} from '../../../src/queries/internal/frontend-behavior-evidence.js';

describe('frontend behavior evidence helpers', () => {
  it('damps subset overlap so tiny profiles do not score as exact duplicates', () => {
    const small = new Set(Array.from({ length: 6 }, (_entry, index) => `token:${index}`));
    const large = new Set(Array.from({ length: 80 }, (_entry, index) => `token:${index}`));

    expect(behaviorSimilarity(small, large)).toBeLessThan(0.9);
  });

  it('reports the first satisfied overlap gate clause', () => {
    const result = overlapGate(
      [
        { name: 'component', count: 0 },
        { name: 'shape', count: 4 },
      ],
      [
        { min: { component: 1 }, reason: 'shared custom component' },
        { min: { shape: 4 }, reason: 'shared structure' },
      ],
    );

    expect(result).toEqual(
      expect.objectContaining({
        pass: true,
        reason: 'shared structure',
        counts: expect.objectContaining({ shape: 4 }),
      }),
    );
  });

  it('evaluates pressure axes from data tables', () => {
    const profile = { lines: 120, tokens: 45 };
    const result = evaluatePressure(
      profile,
      [
        {
          axis: 'lines',
          value: (entry) => entry.lines,
          qualifies: (_entry, value) => value >= 100,
          reason: (_entry, value) => `${value} line(s)`,
        },
        {
          axis: 'tokens',
          value: (entry) => entry.tokens,
          weightedValue: (_entry, value) => value * 3,
          qualifies: (_entry, value) => value >= 40,
          reason: (_entry, value) => `${value} token(s)`,
        },
      ],
      'lines',
    );

    expect(result).toEqual({
      dominantPressure: 'tokens',
      pressureKinds: ['lines', 'tokens'],
      reasons: ['120 line(s)', '45 token(s)'],
    });
  });

  it('selects the dominant pressure only from axes that qualified', () => {
    const profile = { fileLines: 700, structureTokens: 80 };
    const result = evaluatePressure(
      profile,
      [
        {
          axis: 'file',
          value: (entry) => entry.fileLines,
          qualifies: (_entry, value) => value >= 800,
          reason: (_entry, value) => `${value} file line(s)`,
        },
        {
          axis: 'structure',
          value: (entry) => entry.structureTokens,
          weightedValue: (_entry, value) => value * 3,
          qualifies: (_entry, value) => value >= 80,
          reason: (_entry, value) => `${value} structure token(s)`,
        },
      ],
      'file',
    );

    expect(result).toEqual({
      dominantPressure: 'structure',
      pressureKinds: ['structure'],
      reasons: ['80 structure token(s)'],
    });
  });
});
