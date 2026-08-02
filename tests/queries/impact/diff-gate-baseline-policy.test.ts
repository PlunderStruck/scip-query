import { describe, expect, it } from 'vitest';

import { baselineFindingMetadata } from '../../../src/queries/impact/diff-gate-baseline-policy.js';

describe('architecture baseline finding policy', () => {
  it.each([
    [
      'architecture:stale-allowance:runtime:domain',
      'stale architecture allowance',
      'In .scipquery.json, remove domain from runtime',
    ],
    ['architecture:boundary-limit:files:runtime', 'architecture boundary limit violation', "Reduce runtime's files"],
    [
      'architecture:test-boundary:tests%2Fruntime.test.ts:storage',
      'test boundary violation',
      'Exercise tests/runtime.test.ts',
    ],
    ['architecture:unmapped-file:scripts%2Fgenerate.ts', 'unmapped architecture file', 'Assign scripts/generate.ts'],
    [
      'architecture:ambiguous-file:src%2Ffeature.ts:domain|runtime',
      'ambiguous architecture file',
      'Narrow the boundary path rules',
    ],
  ])('gives %s an actionable declared-policy explanation', (finding, label, remediation) => {
    const metadata = baselineFindingMetadata(finding);

    expect(metadata).toMatchObject({
      sourceAnalyzer: 'architecture',
      actionTier: 'direct',
      label,
      remediation: expect.stringContaining(remediation),
    });
  });
});
