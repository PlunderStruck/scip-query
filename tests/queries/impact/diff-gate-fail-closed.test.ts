import { describe, expect, it } from 'vitest';
import { diffGateFailedClosed, diffGateFailureReason } from '../../../src/queries/impact/diff-gate.js';
import { GIT_DIFF_UNAVAILABLE_NOTE } from '../../../src/queries/impact/diff-impact.js';
import type { DiffGateResult } from '../../../src/queries/impact/diff-gate.js';

// Encodes the 2026-07-01 Vega calibration blocker: on an 8,099-file commit,
// git diff overflowed the exec buffer, the bare catch returned an empty
// plan, and the gate exited 0 having run ZERO checks — a gate that fails
// open. CLI wiring (plain exit 1, --json exitCode 1 + gateError, hook exit 2)
// was verified live; this pins the detection predicate.
describe('diff-gate fails closed', () => {
  const base: Omit<DiffGateResult, 'checksRun' | 'note'> = {
    base: 'HEAD',
    changedFiles: [],
    changedSymbols: 0,
    skipped: [],
    suppressed: [],
    findings: [],
    attributionNotes: [],
    evidenceTiers: [
      { tier: 'semantic-consumers', state: 'complete', attemptedSymbols: 0 },
      { tier: 'source-fallback-consumers', state: 'complete', attemptedSymbols: 0 },
    ],
    rootCauseGroups: [],
  } as unknown as Omit<DiffGateResult, 'checksRun' | 'note'>;

  it('detects a run where git diff was unavailable and zero checks ran', () => {
    const failed = { ...base, checksRun: [], note: GIT_DIFF_UNAVAILABLE_NOTE } as DiffGateResult;
    expect(diffGateFailedClosed(failed)).toBe(true);
  });

  it('does not trip on a healthy empty diff or a completed run', () => {
    const emptyDiff = { ...base, checksRun: [], note: 'No changed files found.' } as DiffGateResult;
    expect(diffGateFailedClosed(emptyDiff)).toBe(false);
    const completed = {
      ...base,
      checksRun: ['echo'],
      note: undefined,
    } as unknown as DiffGateResult;
    expect(diffGateFailedClosed(completed)).toBe(false);
  });

  it('fails closed when required consumer evidence degraded even if other checks ran', () => {
    const failed = {
      ...base,
      checksRun: ['echo', 'co-change-partner'],
      evidenceTiers: [
        {
          tier: 'semantic-consumers',
          state: 'failed',
          attemptedSymbols: 4,
          reason: 'semantic provider crashed',
        },
        { tier: 'source-fallback-consumers', state: 'complete', attemptedSymbols: 4 },
      ],
    } as DiffGateResult;

    expect(diffGateFailedClosed(failed)).toBe(true);
    expect(diffGateFailureReason(failed)).toContain('semantic-consumers');
    expect(diffGateFailureReason(failed)).toContain('semantic provider crashed');
  });
});
