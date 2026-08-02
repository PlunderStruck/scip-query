import { describe, expect, it } from 'vitest';

import type { IndexedDefinition } from '../../../src/domain/types.js';
import { preferCallablePlanSourceCandidates } from '../../../src/queries/internal/plan-source-candidates.js';

describe('plan source candidate specificity', () => {
  it('prefers callable evidence over a module slice for the same role and file', () => {
    const moduleDefinition = definition('src/consumer.ts', 'src:consumer', false);
    const callableDefinition = definition('src/consumer.ts', 'src:consumer:run()', true);
    const barrelDefinition = definition('src/index.ts', 'src:index', false);

    expect(
      preferCallablePlanSourceCandidates([
        { definition: moduleDefinition, role: 'consumer' },
        { definition: callableDefinition, role: 'consumer' },
        { definition: barrelDefinition, role: 'consumer' },
        { definition: moduleDefinition, role: 'reuse-candidate' },
      ]),
    ).toEqual([
      { definition: callableDefinition, role: 'consumer' },
      { definition: barrelDefinition, role: 'consumer' },
      { definition: moduleDefinition, role: 'reuse-candidate' },
    ]);
  });
});

function definition(relativePath: string, symbol: string, isFunctionLike: boolean): IndexedDefinition {
  return {
    symbolId: 1,
    symbol,
    documentId: 1,
    startLine: 0,
    endLine: 4,
    relativePath,
    leaf: symbol,
    parentTypeName: null,
    isFunctionLike,
    isTypeLike: false,
    kind: isFunctionLike ? 12 : null,
    documentation: null,
    enclosingSymbol: null,
  };
}
