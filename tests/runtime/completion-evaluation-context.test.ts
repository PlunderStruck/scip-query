import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectConfig } from '../../src/domain/types.js';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import {
  CompletionEvaluationContextMovedError,
  assertFixedCompletionContext,
  captureFixedCompletionContext,
  publishStopCompletionEvaluations,
  stopCompletionEvaluationRequest,
} from '../../src/runtime/completion-evaluation-context.js';
import { readCompletionHistory } from '../../src/storage/autonomous-completion.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const fixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  fixtureDirectories.clear();
});

describe('fixed completion evaluation context', () => {
  it('rejects a result when repository content moves during evaluation', () => {
    const fixture = contextFixture();
    const lease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });

    writeFileSync(join(fixture.root, 'src', 'feature.ts'), 'export const feature = 2;\n');

    expect(() =>
      assertFixedCompletionContext(lease, fixture.config, {
        evaluatorEntrypoint: fixture.evaluator,
      }),
    ).toThrow(CompletionEvaluationContextMovedError);
  });

  it('replays one captured context into the same pure controller request and distinguishes a later target', () => {
    const fixture = contextFixture();
    const first = captureFixedCompletionContext(fixture.root, fixture.config, 'feedback', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    const context = first.records[0]!;
    const left = stopCompletionEvaluationRequest(fixture.root, context, passingGate());
    const right = stopCompletionEvaluationRequest(fixture.root, context, passingGate());

    expect(left).toEqual(right);
    expect(left.context.policyId).toBe(context.contextSnapshotId);
    expect(left.context.evaluatorVersion).toBe(context.evaluator.buildIdentity);
    expect(left.predicates.find((predicate) => predicate.predicate === 'goal-fulfilled')?.state).toBe('unknown');
    expect(left.predicates.find((predicate) => predicate.predicate === 'coverage-complete')?.state).toBe('established');

    writeFileSync(join(fixture.root, 'src', 'feature.ts'), 'export const feature = 3;\n');
    const later = captureFixedCompletionContext(fixture.root, fixture.config, 'feedback', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    expect(later.records[0]?.contextSnapshotId).not.toBe(context.contextSnapshotId);
    expect(later.targetObservation.facts.wholeContent?.digest).not.toBe(
      first.targetObservation.facts.wholeContent?.digest,
    );
  });

  it('does not let derived completion records recursively change candidate content identity', () => {
    const fixture = contextFixture();
    const first = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    mkdirSync(join(fixture.root, '.scipquery', 'completion-contexts'), { recursive: true });
    mkdirSync(join(fixture.root, '.scipquery', 'completion-evaluations'), { recursive: true });
    writeFileSync(join(fixture.root, '.scipquery', 'completion-contexts', 'derived.json'), '{}\n');
    writeFileSync(join(fixture.root, '.scipquery', 'completion-evaluations', 'derived.json'), '{}\n');
    const second = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });

    expect(second.targetObservation.facts.wholeContent).toEqual(first.targetObservation.facts.wholeContent);
    expect(second.records[0]?.contextSnapshotId).toBe(first.records[0]?.contextSnapshotId);
  });

  it('publishes one replay-stable context and blocked controller judgment without metadata commands', () => {
    const fixture = contextFixture();
    const firstLease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    const evaluatedAt = new Date(Date.parse(firstLease.targetObservation.observedAt) + 1_000).toISOString();
    assertFixedCompletionContext(firstLease, fixture.config, {
      evaluatorEntrypoint: fixture.evaluator,
    });
    const first = publishStopCompletionEvaluations(firstLease, passingGate(), {
      toolVersion: '0.20.0',
      now: () => evaluatedAt,
    });
    const secondLease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    const second = publishStopCompletionEvaluations(secondLease, passingGate(), {
      toolVersion: '99.0.0',
      now: () => evaluatedAt,
    });

    expect(first[0]?.context.publication).toBe('created');
    expect(first[0]?.evaluation.evaluation.publication).toBe('created');
    expect(first[0]?.evaluation.evaluation.record.decision).toEqual(
      expect.objectContaining({
        state: 'blocked',
        unknownPredicates: ['goal-fulfilled', 'invariants-preserved'],
      }),
    );
    expect(second[0]?.context.publication).toBe('existing');
    expect(second[0]?.evaluation.evaluation.publication).toBe('existing');
    expect(readCompletionHistory(fixture.root).integrityIssues).toEqual([]);
  });
});

function contextFixture(): { root: string; config: ProjectConfig; evaluator: string } {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-fixed-completion-'));
  fixtureDirectories.add(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = 1;\n');
  const evaluator = join(root, 'fixed-evaluator.js');
  writeFileSync(evaluator, 'export const evaluator = 1;\n');
  const goal = createGoalRecordFile(
    root,
    COLLABORATION_DOMAIN,
    {
      feature: 'One repository change reaches protected completion',
      invariants: ['Unknown evidence remains unknown'],
      acceptanceScenarios: [
        {
          name: 'Fixed context',
          given: ['one captured repository state'],
          when: ['the repository moves during evaluation'],
          then: ['the result is discarded'],
        },
      ],
      authorization: {
        kind: 'repository-delegation',
        principal: 'repository-owner',
        source: 'codex-task',
      },
    },
    { toolVersion: '0.20.0', now: () => '2026-07-30T12:00:00.000Z' },
  ).record;
  createIntendedChangeRecordFile(
    root,
    COLLABORATION_DOMAIN,
    {
      goalId: goal.goalId,
      idempotencyKey: 'fixed-context-runtime-test',
      title: 'Fix evaluation inputs',
      intendedOutcome: 'A completion result names exactly the state it evaluated',
    },
    { toolVersion: '0.20.0', now: () => '2026-07-30T12:00:01.000Z' },
  );
  const config: ProjectConfig = {
    projectRoot: root,
    dbPath: join(root, '.scipquery-cache', 'index.db'),
    collaborationDomainId: COLLABORATION_DOMAIN,
    languages: ['typescript'],
  };
  return { root, config, evaluator };
}

function passingGate(): DiffGateResult {
  return {
    base: 'HEAD',
    changedFiles: ['src/feature.ts'],
    changedSymbols: 1,
    checksRun: [
      'echo',
      'incomplete-migration',
      'co-change-partner',
      'twin-partner',
      'coverage-contract',
      'architecture',
      'doc-reference',
      'unused-params',
      'new-dead',
      'baseline',
    ],
    skipped: [],
    suppressed: [],
    findings: [],
    attributionNotes: [],
    evidenceTiers: [],
    recordCompatibility: {
      suppressions: {
        complete: true,
        total: 0,
        accepted: 0,
        legacy: 0,
        current: 0,
        unsupportedOlder: 0,
        unsupportedFuture: 0,
        malformed: 0,
        omitted: 0,
        issues: [],
      },
    },
  };
}
