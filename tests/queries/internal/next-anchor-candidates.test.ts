import { describe, expect, it } from 'vitest';
import {
  coverageDiverseNextAnchors,
  type RankedNextAnchor,
} from '../../../src/queries/internal/next-anchor-candidates.js';
import type { ConnectedBehaviorStep } from '../../../src/queries/internal/connected-behavior.js';

describe('next-anchor target selection', () => {
  it('reserves a semantic continuation for a causal connector and prevents one anchor from monopolizing the budget', () => {
    const steps = [
      step('anchor-a', 'anchor'),
      step('connector', 'connector'),
      step('anchor-b', 'anchor'),
      step('junction', 'junction'),
    ];
    const candidates = [
      candidate('a-1', 'anchor-a', 200),
      candidate('a-2', 'anchor-a', 190),
      candidate('a-3', 'anchor-a', 180),
      candidate('b-1', 'anchor-b', 170),
      candidate('junction-1', 'junction', 160),
      candidate('connector-1', 'connector', 150),
      candidate('connector-2', 'connector', 140),
    ];

    expect(coverageDiverseNextAnchors(candidates, steps, 4).map((item) => item.anchor.id)).toEqual([
      'connector-1',
      'a-1',
      'b-1',
      'a-2',
    ]);
  });
});

function step(id: string, role: ConnectedBehaviorStep['role']): ConnectedBehaviorStep {
  return { id, nodeId: id, order: 0, role, kind: 'symbol', label: id, location: null, behavior: null };
}

function candidate(id: string, fromStepId: string, priority: number): RankedNextAnchor {
  return {
    priority,
    anchor: {
      id,
      status: 'exact',
      source: 'graph-call',
      fromStepId,
      fromLabel: fromStepId,
      callsite: {
        file: 'src/example.ts',
        line: 0,
        endLine: 0,
        text: `${id}()`,
        signals: ['call'],
        calleeLeaf: id,
      },
      alternatives: [{ symbol: id, label: id, file: 'src/target.ts', line: 0, endLine: 0 }],
      alternativeCount: 1,
      evidence: [],
    },
  };
}
