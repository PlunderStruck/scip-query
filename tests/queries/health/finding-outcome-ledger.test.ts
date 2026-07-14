import { describe, expect, it } from 'vitest';
import {
  detectorPrecision,
  formatLowResolutionNudges,
  formatUnresolvedStreakLine,
  recordFindingOutcomes,
  trailingResolutionRate,
  type FindingOutcomeRecord,
  type ObservedFinding,
} from '../../../src/queries/health/finding-outcome-ledger.js';

const DAY = 86_400_000;

describe('recordFindingOutcomes (pure)', () => {
  it('creates a still-open record for a newly observed finding', () => {
    const next = recordFindingOutcomes(
      [],
      [{ check: 'doc-reference', findingId: 'A', suppressed: false }],
      ['doc-reference'],
      1000,
    );

    expect(next).toEqual([
      { check: 'doc-reference', findingId: 'A', firstSeen: 1000, lastSeen: 1000, timesShown: 1, outcome: 'still-open' },
    ]);
  });

  it('bumps timesShown and lastSeen when the same finding is observed again', () => {
    const first = recordFindingOutcomes(
      [],
      [{ check: 'doc-reference', findingId: 'A', suppressed: false }],
      ['doc-reference'],
      1000,
    );
    const second = recordFindingOutcomes(
      first,
      [{ check: 'doc-reference', findingId: 'A', suppressed: false }],
      ['doc-reference'],
      2000,
    );

    expect(second).toEqual([
      { check: 'doc-reference', findingId: 'A', firstSeen: 1000, lastSeen: 2000, timesShown: 2, outcome: 'still-open' },
    ]);
  });

  it('marks a previously tracked finding as resolved when its check ran but it was not observed', () => {
    const first = recordFindingOutcomes(
      [],
      [{ check: 'doc-reference', findingId: 'A', suppressed: false }],
      ['doc-reference'],
      1000,
    );
    const second = recordFindingOutcomes(first, [], ['doc-reference'], 2000);

    expect(second).toEqual([
      { check: 'doc-reference', findingId: 'A', firstSeen: 1000, lastSeen: 1000, timesShown: 1, outcome: 'resolved' },
    ]);
  });

  it('leaves records untouched when their check did not run this time', () => {
    const first = recordFindingOutcomes(
      [],
      [{ check: 'doc-reference', findingId: 'A', suppressed: false }],
      ['doc-reference'],
      1000,
    );
    const second = recordFindingOutcomes(first, [], ['echo'], 2000);

    expect(second).toEqual(first);
  });

  it('leaves a missing record untouched while cross-HEAD verification is pending', () => {
    const first = recordFindingOutcomes(
      [],
      [{ check: 'doc-reference', findingId: 'A', suppressed: false }],
      ['doc-reference'],
      1000,
    );
    const second = recordFindingOutcomes(first, [], ['doc-reference'], 2000, new Set(['doc-reference\0A']));

    expect(second).toEqual(first);
  });

  it('records suppressed findings with outcome suppressed', () => {
    const next = recordFindingOutcomes([], [{ check: 'echo', findingId: 'A', suppressed: true }], ['echo'], 1000);

    expect(next[0]?.outcome).toBe('suppressed');
  });
});

describe('detectorPrecision (pure)', () => {
  it('computes resolution/suppression rates and oldest-open age per check', () => {
    const ledger: FindingOutcomeRecord[] = [
      { check: 'doc-reference', findingId: 'A', firstSeen: 0, lastSeen: 0, timesShown: 1, outcome: 'resolved' },
      { check: 'doc-reference', findingId: 'B', firstSeen: 0, lastSeen: 5 * DAY, timesShown: 3, outcome: 'still-open' },
      {
        check: 'doc-reference',
        findingId: 'C',
        firstSeen: 2 * DAY,
        lastSeen: 2 * DAY,
        timesShown: 1,
        outcome: 'suppressed',
      },
    ];

    const stats = detectorPrecision(ledger, 10 * DAY);
    expect(stats).toEqual([
      {
        check: 'doc-reference',
        seen: 3,
        resolved: 1,
        suppressed: 1,
        stillOpen: 1,
        resolutionRate: 1 / 3,
        suppressionRate: 1 / 3,
        oldestOpenAgeDays: 10,
      },
    ]);
  });
});

describe('trailingResolutionRate (pure)', () => {
  it('computes the resolution rate over the most-recently-first-seen window', () => {
    const ledger: FindingOutcomeRecord[] = [
      { check: 'doc-reference', findingId: 'A', firstSeen: 1, lastSeen: 1, timesShown: 1, outcome: 'resolved' },
      { check: 'doc-reference', findingId: 'B', firstSeen: 2, lastSeen: 2, timesShown: 1, outcome: 'still-open' },
      { check: 'doc-reference', findingId: 'C', firstSeen: 3, lastSeen: 3, timesShown: 1, outcome: 'still-open' },
    ];

    expect(trailingResolutionRate(ledger, 'doc-reference', 3)).toBeCloseTo(1 / 3);
    expect(trailingResolutionRate(ledger, 'echo')).toBeNull();
  });
});

describe('formatUnresolvedStreakLine (pure)', () => {
  it('is null when nothing was shown before', () => {
    const ledger: FindingOutcomeRecord[] = [
      { check: 'doc-reference', findingId: 'A', firstSeen: 1000, lastSeen: 1000, timesShown: 1, outcome: 'still-open' },
    ];
    const observed: ObservedFinding[] = [{ check: 'doc-reference', findingId: 'A', suppressed: false }];

    expect(formatUnresolvedStreakLine(ledger, observed, 1000)).toBeNull();
  });

  it('replays a 30-finding, 3-run scenario and reports the unresolved streak', () => {
    const observed: ObservedFinding[] = Array.from({ length: 30 }, (_, index) => ({
      check: 'doc-reference',
      findingId: `SQ${index}`,
      suppressed: false,
    }));

    let ledger: FindingOutcomeRecord[] = [];
    const runTimes = [0, DAY, 2 * DAY];
    for (const now of runTimes) {
      ledger = recordFindingOutcomes(ledger, observed, ['doc-reference'], now);
    }

    const line = formatUnresolvedStreakLine(ledger, observed, runTimes[2]!);
    expect(line).toBe('30 finding(s), 30 shown before and unresolved (oldest: 2 day(s))');
  });
});

describe('formatLowResolutionNudges (pure)', () => {
  it('nudges a check whose trailing resolution rate is below 10%', () => {
    const ledger: FindingOutcomeRecord[] = Array.from({ length: 20 }, (_, index) => ({
      check: 'doc-reference',
      findingId: `SQ${index}`,
      firstSeen: index,
      lastSeen: index,
      timesShown: 1,
      outcome: index === 0 ? 'resolved' : 'still-open',
    }));

    const lines = formatLowResolutionNudges(ledger, ['doc-reference']);
    expect(lines).toEqual([
      "(the doc-reference check's findings are rarely acted on in this repo — consider suppressing with reasons or tuning its config)",
    ]);
  });

  it('does not nudge a check with a healthy resolution rate', () => {
    const ledger: FindingOutcomeRecord[] = Array.from({ length: 10 }, (_, index) => ({
      check: 'echo',
      findingId: `SQ${index}`,
      firstSeen: index,
      lastSeen: index,
      timesShown: 1,
      outcome: index < 5 ? 'resolved' : 'still-open',
    }));

    expect(formatLowResolutionNudges(ledger, ['echo'])).toEqual([]);
  });

  it('does not nudge on a fresh ledger with too few trailing records', () => {
    // A single unresolved finding is technically a 0% resolution rate, but
    // one data point is noise, not a "rarely acted on" signal.
    const ledger: FindingOutcomeRecord[] = [
      { check: 'doc-reference', findingId: 'A', firstSeen: 0, lastSeen: 0, timesShown: 1, outcome: 'still-open' },
    ];

    expect(formatLowResolutionNudges(ledger, ['doc-reference'])).toEqual([]);
  });
});
