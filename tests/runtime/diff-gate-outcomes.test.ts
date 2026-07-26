import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffGateFinding, DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import { computeEffectiveness } from '../../src/queries/health/effectiveness.js';
import { recordDiffGateOutcomes } from '../../src/runtime/diff-gate-outcomes.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { readOutcomeEvents } from '../../src/storage/outcome-events.js';
import { evidenceFixtureDb } from '../fixtures/evidence-fixture.js';

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

      const events = readOutcomeEvents(root);
      expect(events.map((event) => event.event)).toEqual(['caught', 'resolved']);
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
      expect(readOutcomeEvents(root).map((event) => event.event)).toEqual(['caught']);
    } finally {
      db.close();
    }
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

      expect(computeEffectiveness(readOutcomeEvents(root)).checks[0]).toMatchObject({
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

      const events = readOutcomeEvents(root);
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

      expect(readOutcomeEvents(root).map((event) => event.event)).toEqual(['caught']);
      expect(computeEffectiveness(readOutcomeEvents(root)).checks[0]).toMatchObject({ fixed: 0, open: 1 });
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
      expect(computeEffectiveness(readOutcomeEvents(root)).checks[0]).toMatchObject({ fixed: 0, open: 1 });
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

      expect(readOutcomeEvents(root).map((event) => event.event)).toEqual(['caught']);
      expect(computeEffectiveness(readOutcomeEvents(root)).checks[0]).toMatchObject({ fixed: 0, open: 1 });
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

      expect(computeEffectiveness(readOutcomeEvents(root)).checks[0]).toMatchObject({ fixed: 1, open: 0 });
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

      expect(computeEffectiveness(readOutcomeEvents(root)).checks[0]).toMatchObject({
        caught: 2,
        fixed: 0,
        moved: 1,
        open: 1,
      });
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
});
