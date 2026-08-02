import { describe, expect, it } from 'vitest';

import { renderCompletionHumanResult } from '../../src/runtime/commands/work-state-handlers.js';

describe('completion human output', () => {
  it('shows blocked predicates and bounded reasons without the JSON record envelope', () => {
    const evaluationId = `SQE-${'A'.repeat(32)}`;
    const changeId = `SQC-${'B'.repeat(32)}`;
    const output = renderCompletionHumanResult({
      operation: 'status',
      records: [
        {
          state: 'blocked',
          changeId,
          goalId: `SQG-${'C'.repeat(32)}`,
          evaluationId,
          blockedPredicates: ['goal-fulfilled', 'invariants-preserved'],
          unknownPredicates: ['goal-fulfilled'],
        },
      ],
      summary: {
        evaluations: [
          {
            evaluationId,
            predicates: [
              {
                predicate: 'goal-fulfilled',
                state: 'unknown',
                reasons: ['The behavior probe has not produced a fixed observation.'],
                evidenceReceipts: [{ deliberatelyLargeTransportDetail: 'must not be rendered' }],
              },
              {
                predicate: 'invariants-preserved',
                state: 'disproven',
                reasons: ['The architecture gate found a forbidden dependency.'],
                evidenceReceipts: [],
              },
              {
                predicate: 'policy-permitted',
                state: 'established',
                reasons: ['Not blocked and therefore not part of the repair view.'],
                evidenceReceipts: [],
              },
            ],
          },
        ],
      },
      warnings: [],
      integrityIssues: [],
    }).join('\n');

    expect(output).toContain(`  ${changeId}  blocked`);
    expect(output).toContain('blocked: goal-fulfilled, invariants-preserved');
    expect(output).toContain('unknown: goal-fulfilled');
    expect(output).toContain('goal-fulfilled: unknown — The behavior probe has not produced a fixed observation.');
    expect(output).toContain('invariants-preserved: disproven — The architecture gate found a forbidden dependency.');
    expect(output).not.toContain('policy-permitted');
    expect(output).not.toContain('evidenceReceipts');
    expect(output).not.toContain('deliberatelyLargeTransportDetail');
  });

  it('renders a direct evaluation read with predicate reasons', () => {
    const output = renderCompletionHumanResult({
      state: 'current',
      record: {
        evaluationId: `SQE-${'D'.repeat(32)}`,
        changeId: `SQC-${'E'.repeat(32)}`,
        goalId: `SQG-${'F'.repeat(32)}`,
        context: { contextId: 'fixed-context' },
        decision: { state: 'blocked' },
        predicates: [
          {
            predicate: 'coverage-complete',
            state: 'unknown',
            reasons: ['One bounded consumer scan omitted two consumers.'],
          },
        ],
      },
    }).join('\n');

    expect(output).toContain('Predicates:');
    expect(output).toContain('coverage-complete: unknown — One bounded consumer scan omitted two consumers.');
  });
});
