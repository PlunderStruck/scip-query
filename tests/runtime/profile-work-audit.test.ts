import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditProfileWork,
  readProfileEvents,
  renderProfileWorkAudit,
  type ProfileEvent,
} from '../../src/runtime/profile-work-audit.js';

describe('profile work audit', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('ranks exact repeats and separates within-run duplication from later-run recomputation', () => {
    const events: ProfileEvent[] = [
      workEvent('consumer-evidence.product', 'set-a', 'run-1', 'computed', 10, 'wrapper-candidates'),
      workEvent('consumer-evidence.product', 'set-a', 'run-1', 'computed', 4, 'wrapper-candidates'),
      workEvent('consumer-evidence.product', 'set-a', 'run-1', 'cache-hit', 1, 'wrapper-candidates'),
      workEvent('consumer-evidence.product', 'set-a', 'run-2', 'computed', 7, 'stale-abstractions'),
      workEvent('consumer-evidence.product', 'set-a', 'run-2', 'computed', 3, 'stale-abstractions'),
      workEvent('consumer-evidence.product', 'set-b', 'run-1', 'computed', 100, 'wrapper-candidates'),
      workEvent('consumer-evidence.classify', 'set-a', 'run-1', 'computed', 2, 'wrapper-candidates'),
      workEvent('consumer-evidence.classify', 'set-a', 'run-1', 'computed', 1, 'wrapper-candidates'),
      { name: 'legacy-span', durationMs: 50 },
      { workIdentity: 'invalid', name: 'broken', durationMs: 3, workOutcome: 'unknown' },
    ];

    const report = auditProfileWork(events, { top: 1 });

    expect(report).toMatchObject({
      profileEvents: 10,
      spanEvents: 10,
      distinctSpanNames: 4,
      instrumentedEvents: 9,
      unclassifiedInstrumentedEvents: 1,
      exactIdentifiedSpanNames: 3,
      workloadIdentifiedEvents: 0,
      workloadIdentifiedSpanNames: 0,
      runCount: 2,
      repeatedGroups: 2,
      largestOpportunityMs: 14,
      repeatedWorkloads: 0,
    });
    expect(report.rows).toEqual([
      {
        spanName: 'consumer-evidence.product',
        workIdentity: 'set-a',
        commands: ['stale-abstractions', 'wrapper-candidates'],
        computations: 4,
        runCount: 2,
        repeatComputations: 3,
        withinRunRepeats: 2,
        crossRunRecomputes: 1,
        totalComputeMs: 24,
        firstComputeMs: 10,
        withinRunAvoidableMs: 7,
        crossRunRecomputeMs: 7,
        estimatedAvoidableMs: 14,
        cacheHits: 1,
        cacheMisses: 0,
        reused: 0,
        skipped: 0,
      },
    ]);
  });

  it('aggregates repeated same-span events within each run before comparing workloads', () => {
    const report = auditProfileWork([
      workloadEvent('typescript.source-file', 'typescript', 'workload-a', 'run-1', 5, 'health'),
      workloadEvent('typescript.source-file', 'typescript', 'workload-a', 'run-1', 7, 'health'),
      workloadEvent('typescript.source-file', 'typescript', 'workload-a', 'run-2', 4, 'health'),
      workloadEvent('typescript.source-file', 'typescript', 'workload-a', 'run-2', 6, 'health'),
      workloadEvent('semantic.references', 'semantic', 'workload-b', 'run-1', 20, 'health'),
    ]);

    expect(report).toMatchObject({
      spanEvents: 5,
      distinctSpanNames: 2,
      workloadIdentifiedEvents: 5,
      workloadIdentifiedSpanNames: 2,
      repeatedWorkloads: 1,
      largestRepeatedWorkloadMs: 10,
    });
    expect(report.workloadRows).toEqual([
      {
        subsystem: 'typescript',
        spanName: 'typescript.source-file',
        subsystemWorkIdentity: 'workload-a',
        commands: ['health'],
        runCount: 2,
        totalEvents: 4,
        firstRunEvents: 2,
        laterRunEvents: 2,
        totalDurationMs: 22,
        firstRunMs: 12,
        laterRunMs: 10,
      },
    ]);
    expect(report.subsystemCoverage).toEqual([
      {
        subsystem: 'typescript',
        events: 4,
        totalDurationMs: 22,
        spanNames: ['typescript.source-file'],
        workloadIdentifiedEvents: 4,
        workloadIdentifiedSpanNames: 1,
        exactIdentifiedEvents: 0,
        exactIdentifiedSpanNames: 0,
      },
      {
        subsystem: 'semantic',
        events: 1,
        totalDurationMs: 20,
        spanNames: ['semantic.references'],
        workloadIdentifiedEvents: 1,
        workloadIdentifiedSpanNames: 1,
        exactIdentifiedEvents: 0,
        exactIdentifiedSpanNames: 0,
      },
    ]);
  });

  it('does not compare run-only or same-name different-input events across runs', () => {
    const report = auditProfileWork([
      { command: 'health', name: 'same-span', durationMs: 90 },
      workEvent('same-span', 'input-a', 'run-1', 'computed', 40, 'health'),
      workEvent('same-span', 'input-b', 'run-1', 'computed', 30, 'health'),
      workloadEvent('same-span', 'same-span', 'run-only-a', 'run-1', 10, 'health', 'run-only'),
      workloadEvent('same-span', 'same-span', 'run-only-a', 'run-2', 8, 'health', 'run-only'),
    ]);

    expect(report).toMatchObject({ profileEvents: 5, instrumentedEvents: 2, repeatedGroups: 0 });
    expect(report.rows).toEqual([]);
    expect(report.workloadRows).toEqual([]);
    expect(renderProfileWorkAudit(report, '/tmp/profile.jsonl')).toContain('No exact repeated computations were found');
  });

  it('reads JSONL with line-specific errors', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-work-audit-'));
    const validPath = join(tempDir, 'valid.jsonl');
    const invalidPath = join(tempDir, 'invalid.jsonl');
    writeFileSync(validPath, '{"name":"one"}\n\n{"name":"two"}\n');
    writeFileSync(invalidPath, '{"name":"one"}\nnot-json\n');

    expect(readProfileEvents(validPath)).toEqual([{ name: 'one' }, { name: 'two' }]);
    expect(() => readProfileEvents(invalidPath)).toThrow(`${invalidPath}:2: invalid profile JSON`);
    expect(readFileSync(validPath, 'utf8')).toContain('"two"');
  });
});

function workEvent(
  name: string,
  workIdentity: string,
  runId: string,
  workOutcome: 'computed' | 'cache-hit',
  durationMs: number,
  command: string,
): ProfileEvent {
  return { name, workIdentity, runId, workOutcome, durationMs, command };
}

function workloadEvent(
  name: string,
  subsystem: string,
  subsystemWorkIdentity: string,
  runId: string,
  durationMs: number,
  command: string,
  workloadIdentityKind: 'published-project' | 'run-only' = 'published-project',
): ProfileEvent {
  return {
    name,
    subsystem,
    subsystemWorkIdentity,
    workloadIdentity: 'top-level-workload',
    workloadIdentityKind,
    runId,
    durationMs,
    command,
  };
}
