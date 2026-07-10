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

function finding(): DiffGateFinding {
  return {
    id: 'SQECHO1',
    check: 'echo',
    severity: 'warning',
    evidence: 'graph-fact',
    message: 'Duplicated behavior changed.',
    why: ['The changed symbol has a structural twin.'],
    remediation: 'Update both implementations or consolidate them.',
  };
}

function result(findings: DiffGateFinding[]): DiffGateResult {
  return {
    base: 'HEAD',
    changedFiles: [],
    changedSymbols: 0,
    checksRun: ['echo'],
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
        headCommit: () => 'commit-2',
      });

      const events = readOutcomeEvents(root);
      expect(events.map((event) => event.event)).toEqual(['caught', 'resolved']);
      expect(computeEffectiveness(events).checks[0]).toMatchObject({ caught: 1, fixed: 1, open: 0 });
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
