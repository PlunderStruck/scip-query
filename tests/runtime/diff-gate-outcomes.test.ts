import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffGateFinding, DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import { computeEffectiveness } from '../../src/queries/health/effectiveness.js';
import { outcomeObserverFromEnvironment, recordDiffGateOutcomes } from '../../src/runtime/diff-gate-outcomes.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { readOutcomeEvents } from '../../src/storage/outcome-events.js';
import { evidenceFixtureDb } from '../fixtures/evidence-fixture.js';
import { summarizeRecordCompatibility } from '../../src/domain/record-compatibility.js';

const tempRoots: string[] = [];

function finding(overrides: Partial<DiffGateFinding> = {}): DiffGateFinding {
  return {
    id: 'SQECHO1',
    check: 'echo',
    severity: 'warning',
    evidence: 'graph-fact',
    message: 'Duplicated behavior changed.',
    why: ['The changed symbol has a structural twin.'],
    remediation: 'Update both implementations or consolidate them.',
    ...overrides,
  };
}

function result(
  findings: DiffGateFinding[],
  base = 'HEAD',
  checksRun: DiffGateResult['checksRun'] = ['echo'],
): DiffGateResult {
  return {
    base,
    changedFiles: [],
    changedSymbols: 0,
    checksRun,
    skipped: [],
    suppressed: [],
    findings,
    attributionNotes: [],
    evidenceTiers: [
      { tier: 'semantic-consumers', state: 'complete', attemptedSymbols: 0 },
      { tier: 'source-fallback-consumers', state: 'complete', attemptedSymbols: 0 },
    ],
  };
}

function openDb(): { db: ScipDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'scip-diff-gate-outcomes-'));
  tempRoots.push(root);
  const dbPath = join(root, 'index.db');
  evidenceFixtureDb(dbPath).write();
  return { db: new ScipDatabase({ projectRoot: root, dbPath }), root };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recordDiffGateOutcomes', () => {
  it('records a caught finding and its later resolution as repository effectiveness', () => {
    const { db, root } = openDb();
    try {
      recordDiffGateOutcomes(db, result([finding()]), {
        now: () => 1_000,
        headCommit: () => 'commit-1',
      });
      recordDiffGateOutcomes(db, result([]), {
        now: () => 2_000,
        headCommit: () => 'commit-1',
      });

      const events = readOutcomeEvents(root).events;
      expect(events.map((event) => event.event)).toEqual(['caught', 'resolved']);
      expect(events).toEqual([
        expect.objectContaining({
          gateRunId: expect.any(String),
          observer: { kind: 'local-agent', authority: 'repository-writable' },
          observation: expect.objectContaining({
            schemaVersion: 2,
            observedSources: [expect.objectContaining({ kind: 'index-generation' })],
          }),
        }),
        expect.objectContaining({
          gateRunId: expect.any(String),
          observer: { kind: 'local-agent', authority: 'repository-writable' },
          observation: expect.objectContaining({
            schemaVersion: 2,
            observedSources: [expect.objectContaining({ kind: 'index-generation' })],
          }),
        }),
      ]);
      expect(computeEffectiveness(events).checks[0]).toMatchObject({ caught: 1, fixed: 1, open: 0 });
    } finally {
      db.close();
    }
  });

  it('records one local increment and one event when the same logical observation is retried', () => {
    const { db, root } = openDb();
    try {
      const runtime = {
        observationId: 'stable-observation',
        now: () => 1_000,
        headCommit: () => 'commit-1',
      };
      const first = recordDiffGateOutcomes(db, result([finding()]), runtime);
      const retry = recordDiffGateOutcomes(db, result([finding()]), runtime);

      expect(first.ledger[0]?.timesShown).toBe(1);
      expect(retry.ledger[0]?.timesShown).toBe(1);
      expect(retry.warning).toBeUndefined();
      expect(readOutcomeEvents(root).events).toEqual([
        expect.objectContaining({ event: 'caught', gateRunId: 'stable-observation' }),
      ]);
    } finally {
      db.close();
    }
  });

  it('records the adjudication policy version on suppressed outcomes', () => {
    const { db, root } = openDb();
    try {
      const suppressed = result([]);
      suppressed.suppressed = [
        {
          finding: finding(),
          suppression: {
            id: 'SQECHO1',
            reason: 'fixture',
            decision: {
              kind: 'automated-adjudication',
              reasonCode: 'detector-counterexample',
              decidedBy: 'agent',
              policyVersion: 1,
              evidence: [{ kind: 'graph', referent: 'scip-query refs x', claim: 'fixture evidence' }],
              invalidateOn: { targetContentChange: false, detectorMajorChange: true },
            },
          },
        },
      ];

      recordDiffGateOutcomes(db, suppressed, {
        observationId: 'suppressed-gate',
        now: () => 1_000,
        headCommit: () => 'commit-1',
      });

      expect(readOutcomeEvents(root).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'caught', gateRunId: 'suppressed-gate' }),
          expect.objectContaining({
            event: 'suppressed',
            gateRunId: 'suppressed-gate',
            suppressionPolicyVersion: 1,
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('keeps local human attribution writable and never infers protected authority from CI', () => {
    expect(
      outcomeObserverFromEnvironment({
        SCIP_QUERY_OUTCOME_OBSERVER_KIND: 'local-human',
        SCIP_QUERY_OUTCOME_OBSERVER_SOURCE: 'terminal',
        CI: 'true',
      }),
    ).toEqual({
      kind: 'local-human',
      authority: 'repository-writable',
      source: 'terminal',
    });
    expect(outcomeObserverFromEnvironment({ CI: 'true' })).toEqual({
      kind: 'local-agent',
      authority: 'repository-writable',
    });
  });

  it('keeps a cross-HEAD disappearance open when no comparable replay is available', () => {
    const { db, root } = openDb();
    try {
      recordDiffGateOutcomes(db, result([finding()]), {
        now: () => 1_000,
        headCommit: () => 'commit-1',
      });
      recordDiffGateOutcomes(db, result([]), {
        now: () => 2_000,
        headCommit: () => 'commit-2',
      });

      expect(computeEffectiveness(readOutcomeEvents(root).events).checks[0]).toMatchObject({
        caught: 1,
        fixed: 0,
        unverified: 0,
        open: 1,
      });
    } finally {
      db.close();
    }
  });

  it('credits a committed repair when a clean replay against the caught base stays clear', () => {
    const { db, root } = openDb();
    try {
      recordDiffGateOutcomes(db, result([finding()]), {
        now: () => 1_000,
        headCommit: () => 'head-1',
        resolveCommit: () => 'head-1',
      });
      recordDiffGateOutcomes(db, result([]), {
        now: () => 2_000,
        headCommit: () => 'head-2',
        resolveCommit: () => 'head-2',
        worktreeIsClean: () => true,
        replayGate: (baseCommit) => result([], baseCommit),
      });

      const events = readOutcomeEvents(root).events;
      expect(events.at(-1)).toMatchObject({
        event: 'resolved',
        commit: 'head-2',
        comparisonBaseCommit: 'head-2',
        verifiedAgainstCommit: 'head-1',
      });
      expect(computeEffectiveness(events).checks[0]).toMatchObject({ fixed: 1, unverified: 0, open: 0 });
    } finally {
      db.close();
    }
  });

  it('keeps a committed defect open when the caught-base replay still reports it', () => {
    const { db, root } = openDb();
    try {
      recordDiffGateOutcomes(db, result([finding()]), {
        now: () => 1_000,
        headCommit: () => 'head-1',
        resolveCommit: () => 'head-1',
      });
      recordDiffGateOutcomes(db, result([]), {
        now: () => 2_000,
        headCommit: () => 'head-2',
        resolveCommit: () => 'head-2',
        worktreeIsClean: () => true,
        replayGate: (baseCommit) => result([finding()], baseCommit),
      });

      expect(readOutcomeEvents(root).events.map((event) => event.event)).toEqual(['caught']);
      expect(computeEffectiveness(readOutcomeEvents(root).events).checks[0]).toMatchObject({ fixed: 0, open: 1 });
    } finally {
      db.close();
    }
  });

  it('defers cross-HEAD verification while the worktree is dirty', () => {
    const { db, root } = openDb();
    try {
      recordDiffGateOutcomes(db, result([finding()]), {
        now: () => 1_000,
        headCommit: () => 'head-1',
        resolveCommit: () => 'head-1',
      });
      let replayed = false;
      recordDiffGateOutcomes(db, result([]), {
        now: () => 2_000,
        headCommit: () => 'head-2',
        resolveCommit: () => 'head-2',
        worktreeIsClean: () => false,
        replayGate: () => {
          replayed = true;
          return result([]);
        },
      });

      expect(replayed).toBe(false);
      expect(computeEffectiveness(readOutcomeEvents(root).events).checks[0]).toMatchObject({ fixed: 0, open: 1 });
    } finally {
      db.close();
    }
  });

  it('keeps the finding open when the stored-base replay cannot run its detector', () => {
    const { db, root } = openDb();
    try {
      recordDiffGateOutcomes(db, result([finding()]), {
        now: () => 1_000,
        headCommit: () => 'head-1',
        resolveCommit: () => 'head-1',
      });
      recordDiffGateOutcomes(db, result([]), {
        now: () => 2_000,
        headCommit: () => 'head-2',
        resolveCommit: () => 'head-2',
        worktreeIsClean: () => true,
        replayGate: (baseCommit) => result([], baseCommit, []),
      });

      expect(readOutcomeEvents(root).events.map((event) => event.event)).toEqual(['caught']);
      expect(computeEffectiveness(readOutcomeEvents(root).events).checks[0]).toMatchObject({ fixed: 0, open: 1 });
    } finally {
      db.close();
    }
  });

  it('uses an unchanged custom comparison base across HEAD changes without replay', () => {
    const { db, root } = openDb();
    try {
      recordDiffGateOutcomes(db, result([finding()], 'origin/main'), {
        now: () => 1_000,
        headCommit: () => 'head-1',
        resolveCommit: () => 'base-1',
      });
      recordDiffGateOutcomes(db, result([], 'origin/main'), {
        now: () => 2_000,
        headCommit: () => 'head-2',
        resolveCommit: () => 'base-1',
        replayGate: () => {
          throw new Error('comparable bases must not replay');
        },
      });

      expect(computeEffectiveness(readOutcomeEvents(root).events).checks[0]).toMatchObject({ fixed: 1, open: 0 });
    } finally {
      db.close();
    }
  });

  it('preserves move classification when replay finds the same symbol under a new id', () => {
    const { db, root } = openDb();
    try {
      recordDiffGateOutcomes(db, result([finding({ symbol: 'sym#fn' })]), {
        now: () => 1_000,
        headCommit: () => 'head-1',
        resolveCommit: () => 'head-1',
      });
      recordDiffGateOutcomes(db, result([]), {
        now: () => 2_000,
        headCommit: () => 'head-2',
        resolveCommit: () => 'head-2',
        worktreeIsClean: () => true,
        replayGate: (baseCommit) => result([finding({ id: 'SQECHO2', symbol: 'sym#fn' })], baseCommit),
      });

      expect(computeEffectiveness(readOutcomeEvents(root).events).checks[0]).toMatchObject({
        caught: 2,
        fixed: 0,
        moved: 1,
        open: 1,
      });
    } finally {
      db.close();
    }
  });

  it('bounds cross-HEAD replay to one historical base and discloses retained work', () => {
    const { db, root } = openDb();
    try {
      const caught = [
        { head: 'head-1', finding: finding({ id: 'SQECHO1' }) },
        { head: 'head-2', finding: finding({ id: 'SQECHO2' }) },
        { head: 'head-3', finding: finding({ id: 'SQECHO3' }) },
      ];
      for (const [index, observation] of caught.entries()) {
        recordDiffGateOutcomes(db, result([observation.finding]), {
          now: () => 1_000 + index,
          headCommit: () => observation.head,
          resolveCommit: () => observation.head,
          worktreeIsClean: () => false,
        });
      }

      const replayed: Array<{ base: string; checks: readonly string[] }> = [];
      const recorded = recordDiffGateOutcomes(db, result([]), {
        now: () => 2_000,
        headCommit: () => 'head-4',
        resolveCommit: () => 'head-4',
        worktreeIsClean: () => true,
        replayGate: (base, checks) => {
          replayed.push({ base, checks });
          return result([], base);
        },
      });

      expect(replayed).toHaveLength(1);
      expect(replayed[0]?.checks).toEqual(['echo']);
      expect(recorded.warning).toContain('bounded to 1 of 3 historical base(s)');
      expect(recorded.warning).toContain('retained 2 finding(s) across 2 base(s)');
      expect(computeEffectiveness(readOutcomeEvents(root).events).checks[0]).toMatchObject({
        caught: 3,
        fixed: 1,
        open: 2,
      });
    } finally {
      db.close();
    }
  });

  it('requests only the detectors needed by the selected replay base', () => {
    const { db } = openDb();
    try {
      const architectureFinding = finding({
        id: 'SQARCH1',
        check: 'architecture',
        message: 'Architecture boundary changed.',
      });
      recordDiffGateOutcomes(db, result([finding(), architectureFinding], 'HEAD', ['echo', 'architecture']), {
        now: () => 1_000,
        headCommit: () => 'head-1',
        resolveCommit: () => 'head-1',
      });

      let requestedChecks: readonly string[] = [];
      recordDiffGateOutcomes(db, result([], 'HEAD', ['echo', 'architecture']), {
        now: () => 2_000,
        headCommit: () => 'head-2',
        resolveCommit: () => 'head-2',
        worktreeIsClean: () => true,
        replayGate: (base, checks) => {
          requestedChecks = checks;
          return result([], base, ['echo', 'architecture']);
        },
      });

      expect(requestedChecks).toEqual(['architecture', 'echo']);
    } finally {
      db.close();
    }
  });

  it('keeps the gate result usable when the repository ledger append fails', () => {
    const { db } = openDb();
    try {
      const recorded = recordDiffGateOutcomes(db, result([finding()]), {
        now: () => 1_000,
        headCommit: () => null,
        appendEvents: () => {
          throw new Error('read-only checkout');
        },
      });

      expect(recorded.ledger).toHaveLength(1);
      expect(recorded.warning).toBe('outcome event ledger not updated: read-only checkout');
    } finally {
      db.close();
    }
  });

  it('defers every missing-finding resolution when committed event history is incomplete', () => {
    const { db, root } = openDb();
    try {
      recordDiffGateOutcomes(db, result([finding()]), {
        now: () => 1_000,
        headCommit: () => 'head-1',
        resolveCommit: () => 'head-1',
      });
      let replayed = false;
      const recorded = recordDiffGateOutcomes(db, result([]), {
        now: () => 2_000,
        headCommit: () => 'head-2',
        resolveCommit: () => 'head-2',
        worktreeIsClean: () => true,
        replayGate: () => {
          replayed = true;
          return result([]);
        },
        readEvents: () => ({
          events: [],
          compatibility: summarizeRecordCompatibility([
            {
              path: '.scipquery/events/future.json',
              state: 'unsupported-future',
              reason: 'unsupported schemaVersion 2',
            },
          ]),
          warnings: ['future record omitted'],
        }),
      });

      expect(replayed).toBe(false);
      expect(recorded.warning).toContain('cross-HEAD outcome verification deferred');
      expect(recorded.warning).toContain('omitted 1');
      expect(computeEffectiveness(readOutcomeEvents(root).events).checks[0]).toMatchObject({ fixed: 0, open: 1 });
    } finally {
      db.close();
    }
  });

  it('records new events while surfacing an incompatible preserved legacy ledger', () => {
    const { db, root } = openDb();
    try {
      const legacyDir = join(root, '.scipquery', 'ledger');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, 'events.jsonl'), '{"schemaVersion":2,"event":"future"}\n');

      const recorded = recordDiffGateOutcomes(db, result([finding()]), {
        now: () => 1_000,
        headCommit: () => 'head-1',
      });

      expect(recorded.warning).toContain('legacy outcome ledger preserved');
      expect(readOutcomeEvents(root)).toMatchObject({
        events: [expect.objectContaining({ findingId: 'SQECHO1', event: 'caught' })],
        compatibility: { complete: false, unsupportedFuture: 1, omitted: 1 },
      });
    } finally {
      db.close();
    }
  });
});
