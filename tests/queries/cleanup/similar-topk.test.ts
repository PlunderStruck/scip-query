import { describe, expect, it } from 'vitest';
import { computeIdf } from '../../../src/analysis/similarity.js';
import {
  buildCalleeFingerprintIndex,
  candidateFingerprintsForTarget,
  classifySimilarityEvidence,
  insertTopSimilarResult,
  targetSpecificIdfWeights,
  type RankedSimilarResult,
  type SymbolFingerprint,
  type SimilarSymbolResult,
} from '../../../src/queries/cleanup/similar.js';

function result(name: string, similarity: number): SimilarSymbolResult {
  return {
    symbolA: `${name}.a`,
    shortNameA: `${name}.a`,
    fileA: `${name}.ts`,
    symbolB: `${name}.b`,
    shortNameB: `${name}.b`,
    fileB: `${name}.ts`,
    similarity,
    similarityBasis: 'callees',
    sharedCallees: [],
    uniqueToA: [],
    uniqueToB: [],
    ...classifySimilarityEvidence([], 'callees'),
  };
}

function fingerprint(symbol: string, callees: readonly string[]): SymbolFingerprint {
  return {
    symbol,
    file: `${symbol}.ts`,
    callees: new Set(callees),
    paramCount: 0,
  };
}

describe('similarAll top-k collector', () => {
  it('keeps exact top scores without displacing earlier equal-score ties', () => {
    const top: RankedSimilarResult[] = [];

    insertTopSimilarResult(top, result('first', 0.7), 2, 0);
    insertTopSimilarResult(top, result('second', 0.6), 2, 1);
    insertTopSimilarResult(top, result('third', 0.9), 2, 2);
    insertTopSimilarResult(top, result('fourth', 0.7), 2, 3);

    const ranked = [...top]
      .sort((a, b) => b.result.similarity - a.result.similarity || a.order - b.order)
      .map((entry) => entry.result.shortNameA);

    expect(ranked).toEqual(['third.a', 'first.a']);
  });

  it('uses rare shared callees to prune targeted similarity candidates', () => {
    const rareMatch = fingerprint('rare-match', ['common', 'rare', 'domain']);
    const commonOnly = Array.from({ length: 9 }, (_, index) =>
      fingerprint(`common-${index}`, ['common', `left-${index}`, `right-${index}`]),
    );
    const index = buildCalleeFingerprintIndex([rareMatch, ...commonOnly]);

    const candidates = candidateFingerprintsForTarget(fingerprint('target', ['common', 'rare']), index);

    expect(candidates.map((candidate) => candidate.symbol)).toEqual(['rare-match']);
    expect(index.docFreq.get('common')).toBe(10);
    expect(index.ubiquityThreshold).toBe(8);
  });

  it('falls back to the full corpus when every target overlap is ubiquitous', () => {
    const commonOnly = Array.from({ length: 9 }, (_, index) =>
      fingerprint(`common-${index}`, ['common', `left-${index}`, `right-${index}`]),
    );
    const index = buildCalleeFingerprintIndex(commonOnly);

    const candidates = candidateFingerprintsForTarget(fingerprint('target', ['common']), index);

    expect(candidates.map((candidate) => candidate.symbol)).toEqual(commonOnly.map((candidate) => candidate.symbol));
  });

  it('derives target-specific IDF weights equal to the target-plus-corpus corpus walk', () => {
    const target = fingerprint('target', ['rare', 'shared', 'target-only']);
    const corpus = [
      fingerprint('first', ['rare', 'shared']),
      fingerprint('second', ['shared', 'common']),
      fingerprint('third', ['common']),
    ];
    const index = buildCalleeFingerprintIndex(corpus);

    expect(targetSpecificIdfWeights(target, index)).toEqual(computeIdf([target, ...corpus].map((fp) => fp.callees)));
  });

  it('classifies concrete domain behavior as direct evidence', () => {
    expect(
      classifySimilarityEvidence(
        [
          'src:workflows:horses:createHorseRecord()',
          'src:workflows:horses:validateHorseStatus()',
          'src:audit:writeAuditLog()',
        ],
        'callees',
      ),
    ).toEqual(
      expect.objectContaining({
        evidenceClass: 'domain-behavior',
        actionTier: 'direct',
        recommendation: expect.stringContaining('extract/reuse'),
      }),
    );
  });

  it('classifies access and query scaffolding as a signal', () => {
    expect(
      classifySimilarityEvidence(
        ['src:auth:getSession()', 'src:db:prisma:findMany()', 'src:routes:guardRoute()'],
        'callees',
      ),
    ).toEqual(
      expect.objectContaining({
        evidenceClass: 'access-query-scaffolding',
        actionTier: 'signal',
        recommendation: expect.stringContaining('access/query scaffolding'),
      }),
    );
  });

  it('keeps strong domain behavior direct when persistence scaffolding is shared too', () => {
    expect(
      classifySimilarityEvidence(
        [
          'src:effect:tryPrisma:tryPrisma',
          'src:effect:errors:NotFoundError',
          'src:workflows:facilities:ensureServicePlanInStableEffect',
          'src:workflows:facilities:ensureSlotWindowFreeEffect',
          'src:effect:errors:ConflictError',
          'src:workflows:facilities:tryPrismaFacilityWrite',
        ],
        'callees',
      ),
    ).toEqual(
      expect.objectContaining({
        evidenceClass: 'domain-behavior',
        actionTier: 'direct',
        evidenceClassReasons: expect.arrayContaining([
          expect.stringContaining('domain behavior verbs: ensure, write'),
          expect.stringContaining('domain-specific terms: service, plan, stable, slot, window'),
        ]),
      }),
    );
  });

  it('classifies generic source-token overlap as scaffolding', () => {
    expect(classifySimilarityEvidence(['bytes', 'crypto', 'hex', 'random', 'token'], 'source-tokens')).toEqual(
      expect.objectContaining({
        evidenceClass: 'framework-scaffolding',
        actionTier: 'signal',
        evidenceClassReasons: expect.arrayContaining(['shared source tokens are generic scaffolding']),
      }),
    );
  });

  it('classifies uncategorized callee overlap as structural signal', () => {
    expect(
      classifySimilarityEvidence(
        ['synth_runner::physics::projectile_obstacle_overlap', 'synth_runner::spawning::predict_spawn_x'],
        'callees',
      ),
    ).toEqual(
      expect.objectContaining({
        evidenceClass: 'structural-overlap',
        actionTier: 'signal',
        evidenceClassReasons: expect.arrayContaining([
          'shared callees overlap has no recognized domain or scaffolding category',
        ]),
        recommendation: expect.stringContaining('inspect names and behavior'),
      }),
    );
  });
});
