import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SymbolInformation_Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { health } from '../../../src/queries/health/health.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

/**
 * Q1: health should surface twin-drift (same/near-name functions with
 * diverged or identical bodies) as its own dimension. `withSecond` toggles
 * between a divergent-twin second function (escapeRegex/escapeRegExp — the
 * same near-name fixture `tests/queries/cleanup/twin-drift.test.ts` proves
 * classifies as 'divergent') and an unrelated second function of the same
 * shape (formatDate) so the two fixtures carry identical dead/isolated
 * symbol pressure and differ only in the twin-drift signal.
 */
function buildFixtureDb(root: string, opts: { twin: boolean }): ScipDatabase {
  const projectRoot = join(root, 'project');
  const secondBody = opts.twin
    ? ['export function escapeRegExp(value: string) {', "  return value.replace(/[.*+?^${}()\\\\]/g, '\\\\-');", '}']
    : ['export function formatDate(value: string) {', "  return value.replace(/[0-9]/g, '#');", '}'];
  const secondName = opts.twin ? 'escapeRegExp' : 'formatDate';

  writeFixtureFiles(projectRoot, {
    'src/a.ts': [
      'export function escapeRegex(value: string) {',
      "  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
      '}',
    ],
    'src/b.ts': secondBody,
  });

  const dbPath = join(root, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/a.ts')
    .document(2, 'typescript', 'src/b.ts')
    .symbol(
      1,
      'scip-typescript npm fixture 1.0.0 src/`a.ts`/escapeRegex().',
      'escapeRegex',
      SymbolInformation_Kind.Function,
    )
    .symbol(
      2,
      `scip-typescript npm fixture 1.0.0 src/\`b.ts\`/${secondName}().`,
      secondName,
      SymbolInformation_Kind.Function,
    )
    .definition(1, 1, 1, 0, 0, 2, 1)
    .definition(2, 2, 2, 0, 0, 2, 1)
    .chunk(1, 1, 0, 2)
    .chunk(2, 2, 0, 2)
    .write();

  return new ScipDatabase({ dbPath, projectRoot, indexPath: join(root, 'index.scip') });
}

describe('health twin-drift dimension', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('reports a divergent twin pair as a twin-drift finding', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-twin-drift-'));
    const db = buildFixtureDb(tempDir, { twin: true });
    try {
      const report = health(db, { full: true });
      expect(report.findings.twinDriftGroups).toBe(1);
      expect(report.findings.twinDriftLoc).toBeGreaterThan(0);
      expect(report.actions).toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'Drifted twin implementations' })]),
      );
    } finally {
      db.close();
    }
  });

  it('does not report twin-drift for unrelated same-shape functions', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-twin-drift-'));
    const db = buildFixtureDb(tempDir, { twin: false });
    try {
      const report = health(db, { full: true });
      expect(report.findings.twinDriftGroups).toBe(0);
    } finally {
      db.close();
    }
  });

  it('scores a repo with a divergent twin pair below an otherwise-identical repo without one', () => {
    const withTempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-twin-drift-with-'));
    const withoutTempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-twin-drift-without-'));
    const withDb = buildFixtureDb(withTempDir, { twin: true });
    const withoutDb = buildFixtureDb(withoutTempDir, { twin: false });
    try {
      const withReport = health(withDb, { full: true });
      const withoutReport = health(withoutDb, { full: true });

      // Same dead/isolated symbol pressure in both fixtures (two unused
      // exported functions each) — the score gap is attributable to
      // twin-drift, not a confound from a different symbol count.
      expect(withReport.findings.deadSymbols).toBe(withoutReport.findings.deadSymbols);
      expect(withReport.findings.isolatedSymbols).toBe(withoutReport.findings.isolatedSymbols);

      expect(withReport.findings.twinDriftGroups).toBeGreaterThan(withoutReport.findings.twinDriftGroups);
      expect(withReport.hygieneScore).toBeLessThanOrEqual(withoutReport.hygieneScore);
      expect(withReport.score).toBeLessThanOrEqual(withoutReport.score);
    } finally {
      withDb.close();
      withoutDb.close();
      rmSync(withTempDir, { recursive: true, force: true });
      rmSync(withoutTempDir, { recursive: true, force: true });
    }
  });
});
