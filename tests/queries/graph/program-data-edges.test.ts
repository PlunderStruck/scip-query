import { describe, expect, it } from 'vitest';

import type { IndexedDefinition } from '../../../src/domain/types.js';
import { programDataElementsForParameterFlow } from '../../../src/queries/graph/program-data-edges.js';
import type { CallParameterValueFlow } from '../../../src/symbols/graph/value-flow.js';

function definition(symbolId: number, symbol: string, leaf: string, relativePath: string): IndexedDefinition {
  return {
    documentId: symbolId,
    symbolId,
    symbol,
    leaf,
    relativePath,
    startLine: 0,
    endLine: 2,
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: 12,
    documentation: null,
    enclosingSymbol: null,
  };
}

describe('canonical program data edges', () => {
  it('projects proved parameter transfers and accounts for unresolved arguments', () => {
    const caller = definition(1, 'caller-symbol', 'caller', 'src/caller.ts');
    const callee = definition(2, 'callee-symbol', 'callee', 'src/callee.ts');
    const flow: CallParameterValueFlow = {
      caller,
      callee,
      call: { file: 'src/caller.ts', startLine: 1, endLine: 1 },
      transfers: [
        {
          callerPosition: 0,
          calleePosition: 1,
          argumentText: 'payload',
          proof: { file: 'src/caller.ts', startLine: 1, endLine: 1 },
        },
      ],
      unknown: [
        {
          calleePosition: 0,
          argumentText: 'makeId()',
          reason: 'argument-not-direct-parameter',
          proof: { file: 'src/caller.ts', startLine: 1, endLine: 1 },
        },
      ],
    };

    const result = programDataElementsForParameterFlow(flow);

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'parameter', label: 'caller parameter 0' }),
        expect.objectContaining({ kind: 'parameter', label: 'callee parameter 1' }),
        expect.objectContaining({ kind: 'argument-expression', label: 'makeId()' }),
      ]),
    );
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'data-transfer',
          disposition: 'folded',
          semantics: [
            {
              family: 'data',
              subtype: 'argument-to-parameter',
              attributes: { argumentText: 'payload', callerPosition: 0, calleePosition: 1 },
            },
          ],
        }),
        expect.objectContaining({
          kind: 'data-transfer',
          disposition: 'unsupported',
          semantics: [
            {
              family: 'data',
              subtype: 'argument-to-parameter',
              attributes: { argumentText: 'makeId()', calleePosition: 0 },
            },
          ],
        }),
      ]),
    );
    expect(result.frontiers).toEqual([
      expect.objectContaining({
        kind: 'data-transfer',
        direction: 'unresolved',
        disposition: 'unsupported',
        reason: 'argument-not-direct-parameter',
      }),
    ]);
  });
});
