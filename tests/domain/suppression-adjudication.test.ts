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

  it('requires and invalidates evidence for every file in a multi-site finding', () => {
    const multiSite = { ...finding, targetFiles: ['src/example.ts', 'src/other.ts'] };
    const suppression = automatedSuppression();
    expect(evaluateSuppressionAdjudication(suppression, multiSite, runtime())).toMatchObject({
      kind: 'escalated',
      reasons: expect.arrayContaining(['target-content-evidence-required:src/other.ts']),
    });

    suppression.decision!.evidence.push({
      kind: 'source',
      referent: 'src/other.ts',
      claim: 'The second target also implements the reviewed compatibility contract.',
      contentHash: 'hash-a',
    });
    expect(evaluateSuppressionAdjudication(suppression, multiSite, runtime())).toEqual({ kind: 'accepted' });
    expect(
      evaluateSuppressionAdjudication(suppression, multiSite, {
        ...runtime(),
        contentHash: (file) => (file === 'src/other.ts' ? 'hash-b' : 'hash-a'),
      }),
    ).toEqual({ kind: 'invalidated', reasons: ['counterevidence-content-changed:src/other.ts'] });
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

  it('checks expiry before reading evidence and reports changed content before policy escalation', () => {
    const invalidPolicy = automatedSuppression({ id: 'different-finding' });
    invalidPolicy.decision!.policyVersion = 2 as 1;
    const changedRuntime = { ...runtime(), contentHash: () => 'hash-b' };
    expect(evaluateSuppressionAdjudication(invalidPolicy, finding, changedRuntime)).toEqual({
      kind: 'invalidated',
      reasons: ['counterevidence-content-changed:src/example.ts'],
    });
    expect(
      evaluateSuppressionAdjudication({ ...invalidPolicy, expiresAt: '2026-07-27T00:00:00.000Z' }, finding, {
        ...runtime(),
        contentHash: () => {
          throw new Error('Expired evidence must not be read.');
        },
      }),
    ).toEqual({ kind: 'expired', reasons: ['suppression-expired'] });
  });

  it('keeps missing target coverage and missing evidence hashes as separate diagnostics', () => {
    const suppression = automatedSuppression();
    delete suppression.decision!.evidence[0]!.contentHash;
    expect(evaluateSuppressionAdjudication(suppression, finding, runtime())).toEqual({
      kind: 'escalated',
      reasons: [
        'target-content-evidence-required:src/example.ts',
        'counterevidence-content-hash-required:src/example.ts',
      ],
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
