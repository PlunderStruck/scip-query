import { describe, expect, it } from 'vitest';
import { computeEffectiveness, parseSinceMs } from '../../src/queries/health/effectiveness.js';
import type { OutcomeEvent } from '../../src/domain/finding-outcomes.js';

const DAY = 86_400_000;

function event(overrides: Partial<OutcomeEvent>): OutcomeEvent {
  return { ts: 0, check: 'echo', findingId: 'SQAAA', event: 'caught', commit: 'c1', ...overrides };
}

describe('computeEffectiveness', () => {
  it('classifies fixed vs suppressed vs open as repository-writable handling telemetry', () => {
    const events: OutcomeEvent[] = [
      // fixed after 2 days
      event({ ts: 0, findingId: 'SQFIX' }),
      event({ ts: 2 * DAY, findingId: 'SQFIX', event: 'resolved', commit: 'c1' }),
      // suppressed = not a fix
      event({ ts: 0, findingId: 'SQSUP' }),
      event({ ts: DAY, findingId: 'SQSUP', event: 'suppressed', commit: 'c2' }),
      // still open
      event({ ts: 0, findingId: 'SQOPEN' }),
    ];

    const report = computeEffectiveness(events);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({
      check: 'echo',
      caught: 3,
      fixed: 1,
      suppressed: 1,
      open: 1,
      moved: 0,
      unverified: 0,
      authority: 'local-writable-telemetry',
      resolutionVsSuppressionRate: 0.5,
      precision: null,
      medianDaysToFix: 2,
    });
    expect(report.authority).toBe('local-writable-telemetry');
    expect(report.anomalies.map((anomaly) => anomaly.code)).toEqual([
      'legacy-provenance-missing',
      'gate-run-identity-missing',
    ]);
  });

  it('a reopened finding ends as open, not fixed', () => {
    const events: OutcomeEvent[] = [
      event({ ts: 0 }),
      event({ ts: 1, event: 'resolved' }),
      event({ ts: 2, event: 'reopened' }),
    ];
    const report = computeEffectiveness(events);
    expect(report.checks[0]).toMatchObject({ caught: 1, fixed: 0, open: 1, reopened: 1 });
  });

  it('does not call a cross-HEAD disappearance fixed', () => {
    const events: OutcomeEvent[] = [
      event({ ts: 0, findingId: 'SQABSORBED', commit: 'c1' }),
      event({ ts: DAY, findingId: 'SQABSORBED', event: 'resolved', commit: 'c2' }),
    ];

    expect(computeEffectiveness(events).checks[0]).toMatchObject({
      caught: 1,
      fixed: 0,
      unverified: 1,
      precision: null,
      medianDaysToFix: null,
    });
  });

  it('credits a committed fix when both runs preserve the same resolved comparison base', () => {
    const events: OutcomeEvent[] = [
      event({ ts: 0, findingId: 'SQCOMMITTED', commit: 'head-1', comparisonBaseCommit: 'base-1' }),
      event({
        ts: DAY,
        findingId: 'SQCOMMITTED',
        event: 'resolved',
        commit: 'head-2',
        comparisonBaseCommit: 'base-1',
      }),
    ];

    expect(computeEffectiveness(events).checks[0]).toMatchObject({
      fixed: 1,
      unverified: 0,
      resolutionVsSuppressionRate: 1,
      precision: null,
    });
  });

  it('credits a default-base committed fix only when a clean replay records proof', () => {
    const events: OutcomeEvent[] = [
      event({ ts: 0, findingId: 'SQREPLAYED', commit: 'head-1', comparisonBaseCommit: 'head-1' }),
      event({
        ts: DAY,
        findingId: 'SQREPLAYED',
        event: 'resolved',
        commit: 'head-2',
        comparisonBaseCommit: 'head-2',
        verifiedAgainstCommit: 'head-1',
      }),
    ];

    expect(computeEffectiveness(events).checks[0]).toMatchObject({
      fixed: 1,
      unverified: 0,
      resolutionVsSuppressionRate: 1,
      precision: null,
    });
  });

  it('does not accept replay proof for a different comparison lifecycle', () => {
    const events: OutcomeEvent[] = [
      event({ ts: 0, findingId: 'SQWRONGBASE', commit: 'head-1', comparisonBaseCommit: 'base-1' }),
      event({
        ts: DAY,
        findingId: 'SQWRONGBASE',
        event: 'resolved',
        commit: 'head-2',
        comparisonBaseCommit: 'head-2',
        verifiedAgainstCommit: 'other-base',
      }),
    ];

    expect(computeEffectiveness(events).checks[0]).toMatchObject({ fixed: 0, unverified: 1 });
  });

  it('does not verify a resolution without Git commit evidence', () => {
    const events: OutcomeEvent[] = [
      event({ ts: 0, findingId: 'SQNOGIT', commit: null }),
      event({ ts: DAY, findingId: 'SQNOGIT', event: 'resolved', commit: null }),
    ];

    expect(computeEffectiveness(events).checks[0]).toMatchObject({ fixed: 0, unverified: 1 });
  });

  it('reclassifies a rename as moved: resolved id whose symbol re-caught at the same commit', () => {
    const events: OutcomeEvent[] = [
      event({ ts: 0, findingId: 'SQOLD', symbol: 'sym#fn', commit: 'c1' }),
      // rename commit: old id resolves, same symbol caught under a new id
      event({ ts: DAY, findingId: 'SQOLD', event: 'resolved', commit: 'c9' }),
      event({ ts: DAY, findingId: 'SQNEW', symbol: 'sym#fn', commit: 'c9' }),
    ];
    const report = computeEffectiveness(events);
    const check = report.checks[0];
    expect(check.moved).toBe(1);
    expect(check.fixed).toBe(0);
    // the new id is still an open finding
    expect(check.open).toBe(1);
    expect(check.caught).toBe(2);
  });

  it('a disappearance after a commit stays unverified even when an unrelated symbol was caught', () => {
    const events: OutcomeEvent[] = [
      event({ ts: 0, findingId: 'SQOLD', symbol: 'sym#fn', commit: 'c1' }),
      event({ ts: DAY, findingId: 'SQOLD', event: 'resolved', commit: 'c9' }),
      event({ ts: DAY, findingId: 'SQNEW', symbol: 'sym#other', commit: 'c9' }),
    ];
    const report = computeEffectiveness(events);
    expect(report.checks[0].fixed).toBe(0);
    expect(report.checks[0].unverified).toBe(1);
    expect(report.checks[0].moved).toBe(0);
  });

  it('windows by when the finding was caught, still crediting later fixes', () => {
    const events: OutcomeEvent[] = [
      // old finding, fixed inside the window — excluded (caught before window)
      event({ ts: 0, findingId: 'SQOLD' }),
      event({ ts: 10 * DAY, findingId: 'SQOLD', event: 'resolved' }),
      // new finding caught in window, fixed after — included
      event({ ts: 9 * DAY, findingId: 'SQNEW' }),
      event({ ts: 12 * DAY, findingId: 'SQNEW', event: 'resolved', commit: 'c1' }),
    ];
    const report = computeEffectiveness(events, { sinceMs: 8 * DAY });
    expect(report.checks[0]).toMatchObject({ caught: 1, fixed: 1 });
  });

  it('filters by check and groups multiple checks separately', () => {
    const events: OutcomeEvent[] = [
      event({ ts: 0, check: 'echo', findingId: 'SQA' }),
      event({ ts: 0, check: 'new-dead', findingId: 'SQB' }),
      event({ ts: 1, check: 'new-dead', findingId: 'SQB', event: 'resolved', commit: 'c1' }),
    ];
    expect(computeEffectiveness(events).checks.map((c) => c.check)).toEqual(['echo', 'new-dead']);
    const only = computeEffectiveness(events, { check: 'new-dead' });
    expect(only.checks).toHaveLength(1);
    expect(only.checks[0]).toMatchObject({ check: 'new-dead', fixed: 1 });
  });

  it('handles an empty ledger', () => {
    const report = computeEffectiveness([]);
    expect(report).toMatchObject({
      totalEvents: 0,
      windowStart: null,
      authority: 'no-data',
      anomalies: [],
      checks: [],
      provenance: {
        distinctGateRuns: 0,
        legacyUnknownEvents: 0,
        missingGateRunIdEvents: 0,
      },
    });
  });

  it('reserves precision for protected external evaluation', () => {
    const protectedObserver = {
      kind: 'protected-ci' as const,
      authority: 'protected-external' as const,
      source: 'protected-calibration-corpus',
    };
    const events: OutcomeEvent[] = [
      event({ findingId: 'SQFIX', gateRunId: 'gate-1', observer: protectedObserver }),
      event({
        ts: DAY,
        findingId: 'SQFIX',
        event: 'resolved',
        gateRunId: 'gate-2',
        observer: protectedObserver,
      }),
      event({ findingId: 'SQSUP', gateRunId: 'gate-1', observer: protectedObserver }),
      event({
        ts: DAY,
        findingId: 'SQSUP',
        event: 'suppressed',
        gateRunId: 'gate-2',
        observer: protectedObserver,
      }),
    ];

    const report = computeEffectiveness(events, { protectedGateRunIds: new Set(['gate-1', 'gate-2']) });
    expect(report).toMatchObject({
      authority: 'protected-external-evaluation',
      provenance: {
        protectedCiEvents: 4,
        protectedExternalEvents: 4,
        attestedProtectedEvents: 4,
        unattestedProtectedClaims: 0,
        distinctGateRuns: 2,
      },
      anomalies: [],
    });
    expect(report.checks[0]).toMatchObject({
      authority: 'protected-external-evaluation',
      resolutionVsSuppressionRate: 0.5,
      precision: 0.5,
    });
  });

  it('does not publish precision when protected and writable observations are mixed', () => {
    const events: OutcomeEvent[] = [
      event({
        findingId: 'SQFIX',
        gateRunId: 'gate-1',
        observer: { kind: 'local-human', authority: 'repository-writable' },
      }),
      event({
        ts: DAY,
        findingId: 'SQFIX',
        event: 'resolved',
        gateRunId: 'gate-2',
        observer: { kind: 'protected-ci', authority: 'protected-external' },
      }),
    ];

    const report = computeEffectiveness(events, { protectedGateRunIds: new Set(['gate-2']) });
    expect(report.authority).toBe('mixed-authority-telemetry');
    expect(report.checks[0]).toMatchObject({
      authority: 'mixed-authority-telemetry',
      resolutionVsSuppressionRate: 1,
      precision: null,
    });
    expect(report.anomalies.map((anomaly) => anomaly.code)).toContain('mixed-observer-authority');
  });

  it('does not let a repository event self-assert protected evaluation authority', () => {
    const protectedClaim = { kind: 'protected-ci' as const, authority: 'protected-external' as const };
    const events: OutcomeEvent[] = [
      event({ findingId: 'SQFIX', gateRunId: 'gate-1', observer: protectedClaim }),
      event({ ts: DAY, findingId: 'SQFIX', event: 'resolved', gateRunId: 'gate-2', observer: protectedClaim }),
    ];

    const report = computeEffectiveness(events);
    expect(report.authority).toBe('local-writable-telemetry');
    expect(report.checks[0]).toMatchObject({ precision: null, resolutionVsSuppressionRate: 1 });
    expect(report.provenance).toMatchObject({ attestedProtectedEvents: 0, unattestedProtectedClaims: 2 });
    expect(report.anomalies.map((anomaly) => anomaly.code)).toContain('unattested-protected-claim');
  });
});

describe('parseSinceMs', () => {
  const now = 100 * DAY;

  it('parses day and week windows', () => {
    expect(parseSinceMs('30d', now)).toBe(70 * DAY);
    expect(parseSinceMs('2w', now)).toBe(86 * DAY);
  });

  it('parses ISO dates and rejects garbage', () => {
    expect(parseSinceMs('1970-01-11', now)).toBe(10 * DAY);
    expect(parseSinceMs('soon', now)).toBeNull();
  });
});
