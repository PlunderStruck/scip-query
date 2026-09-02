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
    twinDrift: { count: 0, loc: 0 },
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
    drift: {
      count: 0,
      unusedImports: 0,
      architectureViolations: 0,
      layerViolations: 0,
      direct: 0,
      signal: 0,
    },
    complexity: { top: [], extremeCount: 0 },
    gitEvidence: null,
    suppressions: null,
    coverageContracts: { count: 0, loc: 0 },
    ...overrides,
  };
}

describe('health report scoring', () => {
  it('starts from a perfect score when no findings exist', () => {
    const report = buildHealthReport(emptyAnalyses());

    expect(report.score).toBe(100);
  });

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
          commitsScanned: 42,
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

  it('discloses fix-commit validation as a subject regex heuristic', () => {
    const report = buildHealthReport(
      emptyAnalyses({
        dead: { count: 1, loc: 3, files: ['src/dead.ts'] },
        gitEvidence: {
          amplification: null,
          hiddenCoupling: { pairCount: 0, scoreCount: 0, top: [] },
          fileStats: {
            'src/dead.ts': { changes: 2, fixChanges: 1 },
            'src/live.ts': { changes: 3, fixChanges: 1 },
          },
          commitsScanned: 17,
        },
      }),
    );

    expect(report.validation?.validationBasis).toEqual({
      method: 'subject-regex',
      commitsScanned: 17,
    });
  });
});

describe('health report policy calibration', () => {
  it('scales the extreme-complexity pressure threshold with repository size', () => {
    const small = buildHealthReport(emptyAnalyses({ complexity: { top: [], extremeCount: 12 } }));
    const large = buildHealthReport(
      emptyAnalyses({
        statsResult: {
          documents: 8_000,
          symbols: 400_000,
          definitions: 400_000,
          references: 0,
          indexSizeBytes: 0,
          lastBuilt: null,
        },
        complexity: { top: [], extremeCount: 12 },
      }),
    );
    const smallPressure = small.pressure.find((entry) => entry.axis === 'complexity-pressure');
    const largePressure = large.pressure.find((entry) => entry.axis === 'complexity-pressure');
    expect(smallPressure).toEqual(expect.objectContaining({ threshold: 3, extraPenalty: 4 }));
    expect(largePressure).toBeUndefined();
  });

  it('discloses detector policy exclusions and scores component duplicates by weighted count', () => {
    const report = buildHealthReport(
      emptyAnalyses({
        reactComponentDuplicates: {
          count: 12,
          scoreCount: 4,
          loc: 0,
          exclusions: [{ reason: 'ui-kit-pairs', detail: 'kit primitive pairs', count: 3 }],
        },
        complexity: {
          top: [],
          extremeCount: 0,
          exclusions: [{ reason: 'popular-low-branch-callables', detail: 'fan-in only', count: 1 }],
        },
        gitEvidence: {
          amplification: null,
          hiddenCoupling: {
            pairCount: 0,
            scoreCount: 0,
            exclusions: [{ reason: 'doc-sync-pairs', detail: 'doc sync', count: 5 }],
            top: [],
          },
          fileStats: {},
          commitsScanned: 10,
        },
      }),
    );
    expect(report.policyExclusions).toEqual([
      expect.objectContaining({ detector: 'react-component-duplicates', reason: 'ui-kit-pairs', count: 3 }),
      expect.objectContaining({ detector: 'complexity-hotspots', reason: 'popular-low-branch-callables', count: 1 }),
      expect.objectContaining({ detector: 'co-change', reason: 'doc-sync-pairs', count: 5 }),
    ]);
    const deduction = report.scoreBreakdown.find((entry) => entry.axis === 'react-component-duplicates');
    expect(deduction).toEqual(
      expect.objectContaining({ points: 10, detail: expect.stringContaining('4 score-weighted') }),
    );
  });
});
