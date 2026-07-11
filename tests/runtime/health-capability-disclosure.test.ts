import { describe, expect, it } from 'vitest';
import type { HealthReport } from '../../src/queries/health/health-report.js';
import { discloseHealthCapabilities } from '../../src/runtime/health-capability-disclosure.js';
import type { ProjectCapabilityReport } from '../../src/runtime/project-readiness.js';

describe('health capability disclosure', () => {
  it('keeps unavailable language capabilities visible instead of implying clean zeros', () => {
    const report = { warnings: ['phase warning'] } as HealthReport;
    const capabilities = {
      languages: ['python'],
      capabilities: [],
      matrix: [
        {
          language: 'python',
          indexing: capability('indexing', 'SCIP indexing', 'available'),
          sourceFacts: capability('source', 'Source fallback', 'available'),
          semantic: capability('semantic', 'Semantic provider', 'unavailable'),
          detectors: capability('detectors', 'Cleanup detectors', 'available'),
          cleanupVerification: capability('checker', 'Cleanup verification', 'unavailable'),
        },
      ],
    } satisfies ProjectCapabilityReport;

    const disclosed = discloseHealthCapabilities(report, capabilities);

    expect(disclosed.capabilities).toBe(capabilities);
    expect(disclosed.scoreInterpretation).toMatchObject({
      status: 'experimental-composite',
      comparableAcrossLanguages: false,
      scope: 'completed-analyses-only',
    });
    expect(disclosed.warnings).toEqual([
      'phase warning',
      expect.stringContaining('not suitable for a public leaderboard'),
      expect.stringContaining(
        'python capability limits: Semantic provider=unavailable, Cleanup verification=unavailable',
      ),
    ]);
  });

  it('discloses syntax-only cleanup verification as partial evidence', () => {
    const report = {} as HealthReport;
    const capabilities = {
      languages: ['python'],
      capabilities: [],
      matrix: [
        {
          language: 'python',
          indexing: capability('indexing', 'SCIP indexing', 'available'),
          sourceFacts: capability('source', 'Source fallback', 'available'),
          semantic: capability('semantic', 'Semantic provider', 'unavailable'),
          detectors: capability('detectors', 'Cleanup detectors', 'available'),
          cleanupVerification: {
            ...capability('checker', 'Cleanup verification', 'available'),
            reason: 'python3 -m compileall (syntax only)',
          },
        },
      ],
    } satisfies ProjectCapabilityReport;

    expect(discloseHealthCapabilities(report, capabilities).warnings).toContain(
      'python capability limits: Semantic provider=unavailable, Cleanup verification=partial (syntax only). Unsupported analyses are not clean zeros.',
    );
  });
});

function capability(
  id: string,
  label: string,
  status: 'available' | 'partial' | 'unavailable',
): ProjectCapabilityReport['matrix'][number]['indexing'] {
  return { id, label, status, evidence: 'heuristic', reason: `${label} is ${status}.` };
}
