import { describe, expect, it } from 'vitest';
import { buildHealthReport } from '../../../src/queries/health/health-report.js';
import type { HealthAnalyses } from '../../../src/queries/health/health-types.js';

function emptyAnalyses(overrides: Partial<HealthAnalyses> = {}): HealthAnalyses {
  return {
    statsResult: {
      documents: 100,
      symbols: 1_000,
      definitions: 1_000,
      references: 0,
      indexSizeBytes: 0,
      lastBuilt: null,
    },
    warnings: [],
    dead: { count: 0, loc: 0 },
    isolated: { count: 0, loc: 0 },
    realCycleCount: 0,
    similarCount: 0,
    duplicateBodies: { count: 0, loc: 0 },
    reactComponentDuplicates: { count: 0, loc: 0 },
    reactHookCandidates: { count: 0, loc: 0 },
    reactLargeComponentPressure: { count: 0, loc: 0 },
    vueComponentDuplicates: { count: 0, loc: 0 },
    vueComposableCandidates: { count: 0, loc: 0 },
    vueLargeViewPressure: { count: 0, loc: 0 },
    extractCount: 0,
    wrappers: { count: 0, loc: 0 },
    passthroughs: { count: 0, loc: 0 },
    stale: { count: 0, loc: 0, unused: 0, singleUse: 0 },
    drift: { count: 0, unusedImports: 0, layerViolations: 0, direct: 0, signal: 0 },
    complexity: { top: [], extremeCount: 0 },
    gitEvidence: null,
    suppressions: null,
    ...overrides,
  };
}

describe('health report scoring', () => {
  it('scores broad or stale hidden coupling by weighted history strength', () => {
    const report = buildHealthReport(
      emptyAnalyses({
        gitEvidence: {
          amplification: null,
          hiddenCoupling: {
            pairCount: 60,
            scoreCount: 15,
            top: [
              {
                fileA: 'docs/api.md',
                fileB: 'src/api.ts',
                together: 20,
                confidence: 0.9,
                focusedTogether: 0,
                broadTogether: 20,
                broadCommitRatio: 1,
                lastTogetherAt: 1,
                recentTogether: 20,
                commitScope: 'broad-sweep',
                recency: 'recent',
                scoreWeight: 0.25,
                subjectContext: {
                  subjectLabels: ['docs'],
                  issueRefs: [],
                  sampleSubjects: ['docs: update api sweep'],
                  externalIssueLabelStatus: 'unavailable',
                },
              },
            ],
          },
          fileStats: {},
        },
      }),
    );

    expect(report.findings.hiddenCouplingPairs).toBe(60);
    expect(report.findings.hiddenCouplingScoreCount).toBe(15);
    expect(report.scoreBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          axis: 'hidden-coupling',
          points: 2,
          detail: '60 co-changing pair(s) without a structural link (15 score-weighted)',
        }),
      ]),
    );
    expect(report.pressure).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ axis: 'hidden-coupling-pressure' })]),
    );
    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'Hidden coupling',
          description: expect.stringContaining('15 score-weighted after broad/stale-history discount'),
        }),
      ]),
    );
  });
});
