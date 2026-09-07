import { describe, expect, it, vi } from 'vitest';
import { renderHealthReport } from '../../../src/runtime/cli-support.js';
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
    detectorEvidence: [],
    cycleExclusions: [],
    dead: { count: 0, loc: 0 },
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
    passthroughs: { count: 0, loc: 0 },
    drift: {
      count: 0,
      unusedImports: 0,
      architectureViolations: 0,
      layerViolations: 0,
      direct: 0,
      signal: 0,
    },
    gitEvidence: null,
    suppressions: null,
    coverageContracts: { count: 0, loc: 0 },
    ...overrides,
  };
}

describe('health report findings', () => {
  it('counts each no-observed-reference candidate once in cleanup totals', () => {
    const report = buildHealthReport(emptyAnalyses({ dead: { count: 2, loc: 7 } }));
    expect(report.axes.deletable).toEqual({ symbols: 2, loc: 7 });
    expect(report.findings).not.toHaveProperty('isolatedSymbols');
    expect(report.actions.filter((action) => action.category === 'Dead code')).toHaveLength(1);
  });

  it('reports empty findings without an architectural grade', () => {
    const report = buildHealthReport(emptyAnalyses());

    expect(report.actions).toEqual([]);
    for (const key of ['score', 'riskScore', 'hygieneScore', 'scoreBreakdown', 'pressure']) {
      expect(report).not.toHaveProperty(key);
    }
  });

  it('discloses broad or stale hidden coupling with weighted history strength', () => {
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
    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'Hidden coupling',
          description: expect.stringContaining('combined pair weight 15 after broad/stale-history discount'),
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
  it('discloses detector policy exclusions and component duplicate counts', () => {
    const report = buildHealthReport(
      emptyAnalyses({
        reactComponentDuplicates: {
          count: 12,
          scoreCount: 4,
          loc: 0,
          exclusions: [{ reason: 'ui-kit-pairs', detail: 'kit primitive pairs', count: 3 }],
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
      expect.objectContaining({ detector: 'co-change', reason: 'doc-sync-pairs', count: 5 }),
    ]);
  });
});

describe('health report rendering', () => {
  it.each([false, true])('preserves the no-action qualification with warnings=%s', (hasWarnings) => {
    const report = buildHealthReport(emptyAnalyses({ warnings: hasWarnings ? ['Provider unavailable'] : [] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      renderHealthReport(report);
      const output = log.mock.calls.map(([line]) => line).join('\n');
      expect(output).toContain(
        hasWarnings
          ? 'No findings from completed analyses. Review warnings before interpreting this result as clean.'
          : 'No findings from completed analyses. Review coverage before drawing conclusions.',
      );
      expect(output.includes('  Warnings:')).toBe(hasWarnings);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps positive finding rows in order with units and weighted counts', () => {
    const report = buildHealthReport(emptyAnalyses());
    Object.assign(report.findings, {
      deadSymbols: 2,
      deadLoc: 7,
      cycles: 3,
      similarPairs: 4,
      twinDriftGroups: 5,
      reactComponentDuplicatePairs: 6,
      reactHookCandidatePairs: 7,
      reactHookCandidateScoreCount: 2.5,
      reactLargeComponentPressureFiles: 8,
      vueComponentDuplicatePairs: 9,
      vueComposableCandidatePairs: 10,
      vueComposableCandidateScoreCount: 10,
      vueLargeViewPressureFiles: 11,
      passthroughs: 12,
      driftedFiles: 13,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      renderHealthReport(report);
      const lines = log.mock.calls.map(([line]) => line);
      const start = lines.indexOf('  Findings:');
      expect(lines.slice(start + 1, start + 13)).toEqual([
        '    Dead code:            2 symbols (7 LOC)',
        '    Circular deps:        3',
        '    Similar pairs:        4',
        '    Drifted twins:        5 group(s)',
        '    React components:     6 duplicate pair(s)',
        '    React hook reuse:     7 (combined pair weight 2.5) candidate pair(s)',
        '    React large comps:    8 component(s)',
        '    Vue components:       9 duplicate pair(s)',
        '    Vue composables:      10 candidate pair(s)',
        '    Vue large views:      11 file(s)',
        '    Passthroughs:         12',
        '    Pattern drift:        13 files',
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
