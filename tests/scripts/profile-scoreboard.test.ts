import { describe, expect, it } from 'vitest';
import { profileScoreboard } from '../../scripts/profile-scoreboard.mjs';

describe('profile scoreboard script', () => {
  it('groups spans by command, span name, and cache state', () => {
    const rows = profileScoreboard(
      [
        {
          command: 'scip-query health --json',
          name: 'source-facts.product',
          cacheState: 'evidence-cold',
          durationMs: 10,
          files: 2,
        },
        {
          command: 'scip-query health --json',
          name: 'source-facts.product',
          cacheState: 'evidence-cold',
          durationMs: 5,
          files: 3,
        },
        {
          command: 'scip-query health --json',
          name: 'file-dep-graph.product',
          cacheState: 'evidence-warm',
          durationMs: 7,
          edges: 4,
        },
      ],
      { top: 10 },
    );

    expect(rows).toEqual([
      {
        command: 'scip-query health --json',
        spanName: 'source-facts.product',
        cacheState: 'evidence-cold',
        totalDurationMs: 15,
        count: 2,
        numericMetadata: { files: 5 },
      },
      {
        command: 'scip-query health --json',
        spanName: 'file-dep-graph.product',
        cacheState: 'evidence-warm',
        totalDurationMs: 7,
        count: 1,
        numericMetadata: { edges: 4 },
      },
    ]);
  });
});
