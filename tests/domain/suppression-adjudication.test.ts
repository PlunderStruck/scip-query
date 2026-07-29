import { describe, expect, it } from 'vitest';
import type { FindingSuppression } from '../../src/domain/types.js';
import {
  automaticSuppressionRateIsAnomalous,
  evaluateSuppressionAdjudication,
  type SuppressionAdjudicationFinding,
} from '../../src/domain/suppression-adjudication.js';

const finding: SuppressionAdjudicationFinding = {
  id: 'SQEXACT',
  check: 'incomplete-migration',
  evidence: 'heuristic',
  actionTier: 'signal',
  file: 'src/example.ts',
};

describe('automatic suppression adjudication', () => {
  it('accepts one exact, evidenced, content-invalidating decision without human approval', () => {
    const result = evaluateSuppressionAdjudication(automatedSuppression(), finding, {
      now: Date.parse('2026-07-28T00:00:00.000Z'),
      contentHash: () => 'hash-a',
    });

    expect(result).toEqual({ kind: 'accepted' });
  });

  it('routes prose-only legacy and broad decisions to policy escalation', () => {
    expect(evaluateSuppressionAdjudication({ id: finding.id, reason: 'looks fine' }, finding, runtime())).toMatchObject(
      {
        kind: 'escalated',
        reasons: expect.arrayContaining(['legacy-unadjudicated']),
      },
    );
    expect(
      evaluateSuppressionAdjudication(
        { ...automatedSuppression(), id: undefined, check: finding.check, file: finding.file },
        finding,
        runtime(),
      ),
    ).toMatchObject({
      kind: 'escalated',
      reasons: expect.arrayContaining(['exact-finding-id-required']),
    });
  });

  it('reopens a decision when its cited source content changes', () => {
    expect(
      evaluateSuppressionAdjudication(automatedSuppression(), finding, {
        now: Date.parse('2026-07-28T00:00:00.000Z'),
        contentHash: () => 'hash-b',
      }),
    ).toEqual({
      kind: 'invalidated',
      reasons: ['counterevidence-content-changed:src/example.ts'],
    });
  });

  it('rejects expired decisions and graph facts without direct counterevidence', () => {
    expect(
      evaluateSuppressionAdjudication(
        { ...automatedSuppression(), expiresAt: '2026-07-27T00:00:00.000Z' },
        finding,
        runtime(),
      ),
    ).toEqual({ kind: 'expired', reasons: ['suppression-expired'] });

    expect(
      evaluateSuppressionAdjudication(
        automatedSuppression({
          decision: {
            ...automatedSuppression().decision!,
            evidence: [
              {
                kind: 'test',
                referent: 'tests/example.test.ts',
                claim: 'The fixture covers this.',
                contentHash: 'hash-a',
              },
            ],
          },
        }),
        { ...finding, evidence: 'graph-fact', actionTier: 'direct' },
        runtime(),
      ),
    ).toMatchObject({
      kind: 'escalated',
      reasons: expect.arrayContaining(['direct-counterevidence-required']),
    });
  });

  it('routes only suppression bursts and high-volume near-total waivers to calibration', () => {
    expect(automaticSuppressionRateIsAnomalous(24, 25)).toBe(true);
    expect(automaticSuppressionRateIsAnomalous(22, 25)).toBe(false);
    expect(automaticSuppressionRateIsAnomalous(101, 500)).toBe(true);
    expect(automaticSuppressionRateIsAnomalous(20, 20)).toBe(false);
  });
});

function automatedSuppression(overrides: Partial<FindingSuppression> = {}): FindingSuppression {
  return {
    id: finding.id,
    check: finding.check,
    file: finding.file,
    reason: 'Compatibility surface remains intentionally supported.',
    decision: {
      kind: 'automated-adjudication',
      reasonCode: 'compatibility-shim',
      decidedBy: 'agent',
      policyVersion: 1,
      evidence: [
        {
          kind: 'source',
          referent: 'src/example.ts',
          claim: 'The v1 export is still consumed externally.',
          contentHash: 'hash-a',
        },
      ],
      invalidateOn: {
        targetContentChange: true,
        detectorMajorChange: true,
      },
    },
    ...overrides,
  };
}

function runtime() {
  return {
    now: Date.parse('2026-07-28T00:00:00.000Z'),
    contentHash: () => 'hash-a',
  };
}
