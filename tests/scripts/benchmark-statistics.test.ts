import { expect, it } from 'vitest';
import { summarizeTimings } from '../../scripts/benchmark-statistics.js';

it('summarizes odd and even samples with the mathematical median', () => {
  const samples = [8, 2, 4, 10];
  expect(summarizeTimings(samples)).toEqual({ iterations: 4, min: 2, median: 6, max: 10 });
  expect(samples).toEqual([8, 2, 4, 10]);
  expect(summarizeTimings([8, 2, 4])).toEqual({ iterations: 3, min: 2, median: 4, max: 8 });
});

it('preserves the empty-sample convention and rounds only the resulting statistics', () => {
  expect(summarizeTimings([])).toEqual({ iterations: 0, min: 0, median: 0, max: 0 });
  expect(summarizeTimings([1.2344, 1.2345])).toEqual({ iterations: 2, min: 1.234, median: 1.234, max: 1.234 });
});
