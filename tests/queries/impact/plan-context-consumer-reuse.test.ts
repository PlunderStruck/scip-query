import { describe, expect, it } from 'vitest';
import {
  discoverAffectedConsumerReuse,
  type PlanContextAffectedConsumer,
} from '../../../src/queries/impact/plan-context.js';
import type { SimilarSymbolResult } from '../../../src/queries/cleanup/similar.js';

describe('plan-context affected-consumer reuse', () => {
  it('finds shared owners from bounded consumer evidence without treating consumers or the target as owners', () => {
    const target = symbol('changedCapability');
    const highUseConsumer = consumer('composeInvoice', 'src/billing/compose.ts', 3);
    const secondConsumer = consumer('publishInvoice', 'src/billing/publish.ts', 2);
    const omittedConsumer = consumer('archiveInvoice', 'src/billing/archive.ts', 1);
    const sharedOwner = symbol('applyInvoiceOutcome');
    const weakerOwner = symbol('formatInvoiceResult');
    const incidentalMatch = symbol('readInvoiceMetadata');

    const result = discoverAffectedConsumerReuse(
      {
        referencedBy: [...references(highUseConsumer), ...references(secondConsumer), ...references(omittedConsumer)],
      },
      target,
      (consumerSymbol) => {
        if (consumerSymbol === highUseConsumer.symbol) {
          return [
            similarity(highUseConsumer.symbol, secondConsumer.symbol, 0.96, 'direct'),
            similarity(highUseConsumer.symbol, target, 0.91, 'direct'),
            similarity(highUseConsumer.symbol, highUseConsumer.symbol, 0.9, 'direct'),
            similarity(highUseConsumer.symbol, sharedOwner, 0.78, 'direct'),
          ];
        }
        return [
          similarity(secondConsumer.symbol, sharedOwner, 0.84, 'direct'),
          similarity(weakerOwner, secondConsumer.symbol, 0.72, 'signal'),
          similarity(secondConsumer.symbol, incidentalMatch, 0.45, 'signal'),
        ];
      },
      {
        consumerLimit: 2,
        perConsumerSearchLimit: 5,
        perConsumerCandidateLimit: 3,
        candidateLimit: 4,
      },
    );

    expect(result.coverage).toEqual({
      totalConsumers: 3,
      analyzedConsumers: 2,
      omittedConsumers: 1,
      perConsumerSearchLimit: 5,
      perConsumerCandidateLimit: 3,
      candidateLimit: 4,
      returnedCandidates: 2,
    });
    expect(result.candidates.map((item) => item.candidate.symbolB)).toEqual([sharedOwner, weakerOwner]);
    expect(result.candidates.some((item) => item.candidate.symbolB === incidentalMatch)).toBe(false);
    expect(result.candidates[0]?.candidate.similarity).toBe(0.84);
    expect(result.candidates[0]?.consumers.map((item) => item.symbol)).toEqual([
      highUseConsumer.symbol,
      secondConsumer.symbol,
    ]);
    expect(
      result.candidates.flatMap((item) => item.consumers).some((item) => item.symbol === omittedConsumer.symbol),
    ).toBe(false);
  });

  it('discloses an empty scan when references are top-level rather than inventing a consumer', () => {
    const result = discoverAffectedConsumerReuse(
      {
        referencedBy: [
          {
            relativePath: 'src/register.ts',
            line: 4,
            enclosingSymbol: null,
            enclosingShort: '(top-level)',
          },
        ],
      },
      symbol('changedCapability'),
      () => {
        throw new Error('top-level references must not be scanned as function consumers');
      },
    );

    expect(result.candidates).toEqual([]);
    expect(result.coverage.totalConsumers).toBe(0);
    expect(result.coverage.analyzedConsumers).toBe(0);
  });
});

function consumer(shortName: string, file: string, referenceCount: number): PlanContextAffectedConsumer {
  return { symbol: symbol(shortName), shortName, file, referenceCount };
}

function references(consumerValue: PlanContextAffectedConsumer) {
  return Array.from({ length: consumerValue.referenceCount }, (_, index) => ({
    relativePath: consumerValue.file,
    line: index + 1,
    enclosingSymbol: consumerValue.symbol,
    enclosingShort: consumerValue.shortName,
  }));
}

function symbol(shortName: string): string {
  return `scip-typescript npm neutral 1.0.0 src/\`${shortName}.ts\`/${shortName}().`;
}

function similarity(
  symbolA: string,
  symbolB: string,
  score: number,
  actionTier: SimilarSymbolResult['actionTier'],
): SimilarSymbolResult {
  return {
    symbolA,
    shortNameA: shortName(symbolA),
    fileA: fileName(symbolA),
    symbolB,
    shortNameB: shortName(symbolB),
    fileB: fileName(symbolB),
    similarity: score,
    similarityBasis: 'callees',
    sharedCallees: ['sharedStep'],
    uniqueToA: [],
    uniqueToB: [],
    evidenceClass: actionTier === 'direct' ? 'domain-behavior' : 'structural-overlap',
    actionTier,
    evidenceClassReasons: ['neutral fixture evidence'],
    recommendation: 'Inspect the existing behavior before choosing an owner.',
  };
}

function shortName(value: string): string {
  return /\/([^/]+)\(\)\.$/.exec(value)?.[1] ?? value;
}

function fileName(value: string): string {
  return /src\/`([^`]+)`/.exec(value)?.[1] ?? 'src/unknown.ts';
}
