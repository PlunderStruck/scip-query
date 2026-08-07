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

  it('preserves mechanically derived property and return values as distinct data subtypes', () => {
    const caller = definition(1, 'caller-symbol', 'caller', 'src/caller.ts');
    const callee = definition(2, 'callee-symbol', 'callee', 'src/callee.ts');
    const baseFlow: CallParameterValueFlow = {
      caller,
      callee,
      call: { file: 'src/caller.ts', startLine: 1, endLine: 1 },
      transfers: [],
      unknown: [
        {
          calleePosition: 0,
          argumentText: 'METHODS.create',
          reason: 'argument-not-direct-parameter',
          proof: { file: 'src/caller.ts', startLine: 1, endLine: 1 },
        },
      ],
    };

    const property = programDataElementsForParameterFlow(
      baseFlow,
      new Map([
        [
          0,
          {
            value: 'POST',
            evidence: 'constant' as const,
            term: { kind: 'literal' as const, value: 'POST' },
            precision: 'literal' as const,
            derivation: {
              kind: 'mechanically-derived' as const,
              rule: 'member-constant',
              ruleVersion: '1',
              inputFactIds: ['method-symbol'],
              sourceSpans: [{ file: 'src/constants.ts', startLine: 3, endLine: 3 }],
            },
          },
        ],
      ]),
    );
    expect(property.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          disposition: 'folded',
          semantics: [expect.objectContaining({ family: 'data', subtype: 'property-to-parameter' })],
          evidence: [
            expect.objectContaining({
              method: 'static-value:member-constant',
              strength: 'derived',
              location: { file: 'src/constants.ts', line: 3, endLine: 3 },
            }),
          ],
        }),
      ]),
    );
    expect(property.frontiers).toEqual([]);

    const returned = programDataElementsForParameterFlow(
      baseFlow,
      new Map([
        [
          0,
          {
            value: 'queued',
            evidence: 'constant' as const,
            term: { kind: 'literal' as const, value: 'queued' },
            precision: 'literal' as const,
            derivation: {
              kind: 'mechanically-derived' as const,
              rule: 'bounded-call-return',
              ruleVersion: '1',
              inputFactIds: ['factory-symbol'],
              sourceSpans: [{ file: 'src/factory.ts', startLine: 5, endLine: 5 }],
            },
          },
        ],
      ]),
    );
    expect(returned.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semantics: [expect.objectContaining({ family: 'data', subtype: 'return-to-parameter' })],
        }),
      ]),
    );
  });
});
