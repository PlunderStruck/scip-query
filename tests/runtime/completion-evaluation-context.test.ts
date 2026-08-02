import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectConfig } from '../../src/domain/types.js';
import { createProtectedWorkAuthorization } from '../../src/domain/protected-work-authorization.js';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import {
  CompletionEvaluationContextMovedError,
  assertFixedCompletionContext,
  captureFixedCompletionContext,
  publishStopCompletionEvaluations,
  protectedWorkAuthorizationReferents,
  repositoryPolicyAuthorizedReferents,
  stopCompletionEvaluationRequest,
} from '../../src/runtime/completion-evaluation-context.js';
import {
  PROTECTED_WORK_AUTHORIZATION_ID_ENV,
  PROTECTED_WORK_AUTHORIZATION_ROOT_ENV,
  readConfiguredProtectedWorkAuthorization,
} from '../../src/runtime/protected-work-authorization-controller.js';
import { readCompletionHistory } from '../../src/storage/autonomous-completion.js';
import { createAttemptRecordFile } from '../../src/storage/autonomous-work-ledger.js';
import { readObligationLifecycle } from '../../src/storage/autonomous-work-obligations.js';
import {
  createGoalRecordFile,
  createIntendedChangeRecordFile,
  readIntendedChangeRecords,
} from '../../src/storage/autonomous-work-state.js';
import {
  activateProtectedWorkAuthorization,
  writeProtectedWorkAuthorization,
} from '../../src/storage/protected-work-authorization.js';

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
    const fixedAuthority = {
      predecessor: { kind: 'git-tree' as const, treeOid: 'a'.repeat(40) },
      changedPaths: ['src/feature.ts'],
    };
    const left = stopCompletionEvaluationRequest(fixture.root, context, passingGate(), fixedAuthority);
    const right = stopCompletionEvaluationRequest(fixture.root, context, passingGate(), fixedAuthority);

    expect(left).toEqual(right);
    expect(left.context.policyId).toBe(context.contextSnapshotId);
    expect(left.context.evaluatorVersion).toBe(context.evaluator.buildIdentity);
    expect(context.protectedArtifacts.rules.find((rule) => rule.class === 'evaluator')?.selectors).toEqual([
      'fixed-evaluator.js',
    ]);
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
        unknownPredicates: [
          'goal-fulfilled',
          'invariants-preserved',
          'evidence-compatible',
          'coverage-complete',
          'obligations-reconciled',
          'policy-permitted',
        ],
      }),
    );
    expect(second[0]?.context.publication).toBe('existing');
    expect(second[0]?.evaluation.evaluation.publication).toBe('existing');
    expect(readCompletionHistory(fixture.root).integrityIssues).toEqual([]);
  });

  it('admits a qualified architecture obligation before evaluating the same stop', () => {
    const fixture = contextFixture();
    fixture.config.architecture = {
      boundaries: [
        { name: 'feature', paths: ['src/feature.ts'] },
        { name: 'runtime', paths: ['src/runtime/**'] },
      ],
      allowedDependencies: { feature: [], runtime: ['feature'] },
      requireCompletePolicy: true,
    };
    const lease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    const gate = passingGate();
    gate.findings = [
      {
        id: 'SQ-ARCH-SAME-STOP',
        check: 'architecture',
        severity: 'error',
        evidence: 'baseline',
        actionTier: 'direct',
        confidence: 1,
        file: 'src/feature.ts',
        relatedFiles: ['src/runtime/start.ts'],
        sourceAnalyzer: 'architecture',
        rootCauseKey: 'forbidden-edge:feature:runtime',
        message: 'feature depends on forbidden runtime code',
        why: ['The declared architecture rejects feature -> runtime.'],
        remediation: 'Remove the forbidden feature-to-runtime dependency.',
      },
    ];

    const [published] = publishStopCompletionEvaluations(lease, gate, {
      toolVersion: '0.20.0',
      now: () => '2026-07-30T12:05:00.000Z',
    });

    expect(published?.admissions).toEqual([
      expect.objectContaining({
        obligation: expect.objectContaining({ publication: 'created' }),
      }),
    ]);
    expect(
      published?.evaluation.evaluation.record.predicates.find(
        (predicate) => predicate.predicate === 'obligations-reconciled',
      ),
    ).toMatchObject({ state: 'unknown' });
    expect(readObligationLifecycle(fixture.root).summary.liveObligationIds).toHaveLength(1);
  });

  it('reconciles a prior detector obligation when a later complete gate no longer observes it', () => {
    const fixture = contextFixture();
    fixture.config.architecture = {
      boundaries: [
        { name: 'feature', paths: ['src/feature.ts'] },
        { name: 'runtime', paths: ['src/runtime/**'] },
      ],
      allowedDependencies: { feature: [], runtime: ['feature'] },
      requireCompletePolicy: true,
    };
    const firstLease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    const firstGate = passingGate();
    firstGate.findings = [
      {
        id: 'SQ-ARCH-RECONCILE',
        check: 'architecture',
        severity: 'error',
        evidence: 'baseline',
        actionTier: 'direct',
        confidence: 1,
        file: 'src/feature.ts',
        relatedFiles: ['src/runtime/start.ts'],
        sourceAnalyzer: 'architecture',
        rootCauseKey: 'forbidden-edge:feature:runtime',
        message: 'feature depends on forbidden runtime code',
        why: ['The declared architecture rejects feature -> runtime.'],
        remediation: 'Remove the forbidden feature-to-runtime dependency.',
      },
    ];
    publishStopCompletionEvaluations(firstLease, firstGate, {
      toolVersion: '0.20.0',
      now: () => firstLease.targetObservation.observedAt,
    });

    const laterLease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    const [later] = publishStopCompletionEvaluations(laterLease, passingGate(), {
      toolVersion: '0.20.0',
      now: () => new Date(Date.parse(laterLease.targetObservation.observedAt) + 1_000).toISOString(),
    });

    expect(later?.reconciliations).toEqual([
      expect.objectContaining({
        publication: 'created',
        record: expect.objectContaining({
          to: 'invalidated',
          reason: 'premise-disproven',
        }),
      }),
    ]);
    const lifecycle = readObligationLifecycle(fixture.root);
    expect(lifecycle.integrityIssues).toEqual([]);
    expect(lifecycle.summary.liveObligationIds).toEqual([]);
    expect(lifecycle.summary.invalidatedObligationIds).toHaveLength(1);
    const reconciledRequest = stopCompletionEvaluationRequest(fixture.root, later!.context.record, passingGate(), {
      predecessor: { kind: 'git-tree', treeOid: 'a'.repeat(40) },
      changedPaths: ['src/feature.ts'],
    });
    expect(
      reconciledRequest.predicates.find((predicate) => predicate.predicate === 'obligations-reconciled'),
    ).toMatchObject({ state: 'established' });
  });

  it('keeps a prior obligation live when its producer coverage is incomplete', () => {
    const fixture = contextFixture();
    fixture.config.architecture = {
      boundaries: [{ name: 'feature', paths: ['src/feature.ts'] }],
      allowedDependencies: { feature: [] },
      requireCompletePolicy: true,
    };
    const firstLease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    const firstGate = passingGate();
    firstGate.findings = [
      {
        id: 'SQ-ARCH-INCOMPLETE',
        check: 'architecture',
        severity: 'error',
        evidence: 'baseline',
        actionTier: 'direct',
        confidence: 1,
        file: 'src/feature.ts',
        sourceAnalyzer: 'architecture',
        rootCauseKey: 'unmapped-file:src/feature.ts',
        message: 'feature is not covered',
        why: ['Complete coverage is required.'],
        remediation: 'Map src/feature.ts to exactly one declared boundary.',
      },
    ];
    publishStopCompletionEvaluations(firstLease, firstGate, {
      toolVersion: '0.20.0',
      now: () => firstLease.targetObservation.observedAt,
    });

    const laterLease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    const incompleteGate = passingGate();
    incompleteGate.skipped = [{ check: 'architecture', reason: 'coverage unavailable' }];
    const [later] = publishStopCompletionEvaluations(laterLease, incompleteGate, {
      toolVersion: '0.20.0',
      now: () => new Date(Date.parse(laterLease.targetObservation.observedAt) + 1_000).toISOString(),
    });

    expect(later?.reconciliations).toEqual([]);
    expect(readObligationLifecycle(fixture.root).summary.liveObligationIds).toHaveLength(1);
  });

  it('does not treat an advisory-only diff signal as an invariant contradiction', () => {
    const fixture = contextFixture();
    const context = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    }).records[0]!;
    const gate = passingGate();
    gate.findings = [
      {
        id: 'SQ-ADVISORY',
        check: 'twin-partner',
        severity: 'warning',
        evidence: 'heuristic',
        actionTier: 'signal',
        advisory: true,
        message: 'review a possible twin',
        why: ['The relationship is descriptive.'],
        remediation: 'Review the possible twin if useful.',
      },
    ];

    const request = stopCompletionEvaluationRequest(fixture.root, context, gate);

    expect(request.predicates.find((predicate) => predicate.predicate === 'invariants-preserved')).toMatchObject({
      state: 'unknown',
    });
  });

  it('keeps an unresolved operation effect incompatible with completion evidence', () => {
    const fixture = contextFixture();
    const change = readIntendedChangeRecords(fixture.root).records[0]!;
    createAttemptRecordFile(
      fixture.root,
      COLLABORATION_DOMAIN,
      {
        changeId: change.changeId,
        idempotencyKey: 'interrupted-side-effect',
        intendedCondition: 'The repository write has one known effect',
        action: {
          family: 'repository-write',
          summary: 'Apply one external mutation',
          effectClass: 'non-idempotent-write',
        },
        evidenceReceipts: [],
        observedEffect: 'The process ended before its effect was observed',
        outcome: 'unknown',
      },
      { toolVersion: '0.20.0', now: () => '2026-07-30T12:02:00.000Z' },
    );
    const context = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    }).records[0]!;

    const request = stopCompletionEvaluationRequest(fixture.root, context, passingGate(), {
      predecessor: { kind: 'git-tree', treeOid: 'a'.repeat(40) },
      changedPaths: ['src/feature.ts'],
    });

    expect(request.predicates.find((predicate) => predicate.predicate === 'evidence-compatible')).toMatchObject({
      state: 'unknown',
      reasons: [expect.stringContaining('1 unresolved effect')],
    });
  });

  it('names and blocks a changed suppression when the gate relies on it', () => {
    const fixture = contextFixture();
    const context = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    }).records[0]!;
    const gate = passingGate();
    gate.suppressed = [{} as DiffGateResult['suppressed'][number]];

    const request = stopCompletionEvaluationRequest(fixture.root, context, gate, {
      predecessor: { kind: 'git-tree', treeOid: 'a'.repeat(40) },
      changedPaths: ['.scipquery/suppressions/SQS-example.json'],
    });

    expect(request.authority?.candidateControlled).toEqual([
      expect.objectContaining({
        class: 'suppression',
        paths: ['.scipquery/suppressions/SQS-example.json'],
      }),
    ]);
    expect(request.authority?.violations).toEqual([
      expect.objectContaining({
        class: 'suppression',
        predicates: ['invariants-preserved', 'policy-permitted'],
      }),
    ]);
    expect(request.predicates.find((predicate) => predicate.predicate === 'policy-permitted')).toEqual(
      expect.objectContaining({
        state: 'unknown',
        reasons: expect.arrayContaining([expect.stringContaining('suppression changed by this candidate')]),
      }),
    );
  });

  it('blocks every non-disproven judgment produced by a changed evaluator', () => {
    const fixture = contextFixture();
    const context = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    }).records[0]!;

    const request = stopCompletionEvaluationRequest(fixture.root, context, passingGate(), {
      predecessor: { kind: 'git-tree', treeOid: 'a'.repeat(40) },
      changedPaths: ['fixed-evaluator.js'],
    });

    expect(request.authority?.violations).toEqual([
      expect.objectContaining({
        class: 'evaluator',
        predicates: [
          'goal-fulfilled',
          'invariants-preserved',
          'evidence-compatible',
          'coverage-complete',
          'obligations-reconciled',
          'policy-permitted',
        ],
      }),
    ]);
    expect(request.predicates).toEqual(
      expect.arrayContaining(
        COMPLETION_PREDICATE_NAMES.map((predicate) =>
          expect.objectContaining({
            predicate,
            state: 'unknown',
          }),
        ),
      ),
    );
  });

  it('authorizes only the exact goal, intended change, and protected byte transitions fixed before candidate work', () => {
    const fixture = authorizedContextFixture();
    const lease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
      protectedWorkAuthorization: fixture.authorizationLease,
    });
    const context = lease.records[0]!;

    const referents = protectedWorkAuthorizationReferents(fixture.root, context, lease.authority);
    const request = stopCompletionEvaluationRequest(fixture.root, context, passingGate(), lease.authority);

    expect(context.changeRecordDigest).toBe(context.protectedWorkAuthorization?.changeRecordDigest);
    expect(context.protectedWorkAuthorization).toMatchObject({
      authorizationId: fixture.authorizationLease.record.authorizationId,
      recordSha256: fixture.authorizationLease.recordSha256,
    });
    expect(referents).toMatchObject({
      goal: expect.stringContaining(fixture.authorizationLease.record.authorizationId),
      configuration: expect.stringContaining(fixture.authorizationLease.record.authorizationId),
    });
    expect(request.authority?.fixedOrAuthorized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ class: 'goal', referent: referents.goal }),
        expect.objectContaining({ class: 'configuration', referent: referents.configuration }),
      ]),
    );
    expect(request.authority?.violations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ class: 'goal' }),
        expect.objectContaining({ class: 'configuration' }),
      ]),
    );
    expect(() =>
      assertFixedCompletionContext(lease, fixture.config, { evaluatorEntrypoint: fixture.evaluator }),
    ).not.toThrow();
  });

  it('keeps a protected configuration candidate-controlled when its successor bytes differ from the grant', () => {
    const fixture = authorizedContextFixture();
    writeFileSync(
      join(fixture.root, '.scipquery.json'),
      `${JSON.stringify({ collaborationDomainId: COLLABORATION_DOMAIN, watch: { enabled: false } })}\n`,
    );
    const lease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
      protectedWorkAuthorization: fixture.authorizationLease,
    });
    const context = lease.records[0]!;

    const referents = protectedWorkAuthorizationReferents(fixture.root, context, lease.authority);
    const request = stopCompletionEvaluationRequest(fixture.root, context, passingGate(), lease.authority);

    expect(referents.goal).toContain(fixture.authorizationLease.record.authorizationId);
    expect(referents.configuration).toBeUndefined();
    expect(request.authority?.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ class: 'configuration' })]),
    );
    expect(request.predicates.find((predicate) => predicate.predicate === 'policy-permitted')).toMatchObject({
      state: 'unknown',
    });
  });

  it('authorizes a configuration edit whose only effect is to remove architecture permissions', () => {
    const fixture = contextFixture();
    const predecessorArchitecture = {
      boundaries: [
        { name: 'feature', paths: ['src/feature.ts'] },
        { name: 'runtime', paths: ['src/runtime/**'] },
      ],
      allowedDependencies: { feature: ['runtime'], runtime: ['feature'] },
      requireCompletePolicy: true,
    };
    writeFileSync(
      join(fixture.root, '.scipquery.json'),
      `${JSON.stringify({ collaborationDomainId: COLLABORATION_DOMAIN, architecture: predecessorArchitecture })}\n`,
    );
    execFileSync('git', ['init', '--quiet'], { cwd: fixture.root });
    execFileSync('git', ['add', '.'], { cwd: fixture.root });
    execFileSync(
      'git',
      ['-c', 'user.name=scip-query', '-c', 'user.email=scip-query@example.com', 'commit', '--quiet', '-m', 'base'],
      { cwd: fixture.root },
    );
    const successorArchitecture = structuredClone(predecessorArchitecture);
    successorArchitecture.allowedDependencies.feature = [];
    fixture.config.architecture = successorArchitecture;
    writeFileSync(
      join(fixture.root, '.scipquery.json'),
      `${JSON.stringify({ collaborationDomainId: COLLABORATION_DOMAIN, architecture: successorArchitecture })}\n`,
    );

    const lease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
    });
    expect(lease.authority.changedPaths).toContain('.scipquery.json');
    expect(repositoryPolicyAuthorizedReferents(fixture.root, lease.authority)).toEqual({
      configuration: expect.stringContaining('repository-policy:monotonic-architecture-tightening:'),
    });
    const request = stopCompletionEvaluationRequest(fixture.root, lease.records[0]!, passingGate(), lease.authority);

    expect(request.authority?.fixedOrAuthorized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          class: 'configuration',
          referent: expect.stringContaining('repository-policy:monotonic-architecture-tightening:'),
        }),
      ]),
    );
    expect(request.authority?.violations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ class: 'configuration' })]),
    );
  });

  it('withholds class-wide goal authority when the candidate also changes an ungranted goal', () => {
    const fixture = authorizedContextFixture();
    const lease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
      protectedWorkAuthorization: fixture.authorizationLease,
    });
    const context = lease.records[0]!;
    const widenedAuthority = {
      ...lease.authority,
      changedPaths: [...lease.authority.changedPaths, `.scipquery/goals/SQG-${'F'.repeat(32)}.json`],
    };

    const referents = protectedWorkAuthorizationReferents(fixture.root, context, widenedAuthority);
    const request = stopCompletionEvaluationRequest(fixture.root, context, passingGate(), widenedAuthority);

    expect(referents.goal).toBeUndefined();
    expect(request.authority?.violations).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'goal' })]));
  });

  it('discards the completion context when protected authorization bytes move after capture', () => {
    const fixture = authorizedContextFixture();
    const lease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.evaluator,
      protectedWorkAuthorization: fixture.authorizationLease,
    });
    writeFileSync(fixture.authorizationLease.path, `${JSON.stringify(fixture.authorizationLease.record)}\n\n`);

    expect(() =>
      assertFixedCompletionContext(lease, fixture.config, { evaluatorEntrypoint: fixture.evaluator }),
    ).toThrow(CompletionEvaluationContextMovedError);
  });
});

const COMPLETION_PREDICATE_NAMES = [
  'goal-fulfilled',
  'invariants-preserved',
  'evidence-compatible',
  'coverage-complete',
  'obligations-reconciled',
  'policy-permitted',
] as const;

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

function authorizedContextFixture() {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-authorized-completion-'));
  const protectedRoot = mkdtempSync(join(tmpdir(), 'scip-query-protected-completion-'));
  fixtureDirectories.add(root);
  fixtureDirectories.add(protectedRoot);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = 1;\n');
  const evaluator = join(root, 'fixed-evaluator.js');
  writeFileSync(evaluator, 'export const evaluator = 1;\n');
  const predecessorConfig = `${JSON.stringify({ collaborationDomainId: COLLABORATION_DOMAIN, watch: { autoRefresh: true } })}\n`;
  const successorConfig = `${JSON.stringify({ collaborationDomainId: COLLABORATION_DOMAIN, watch: { autoRefresh: false } })}\n`;
  writeFileSync(join(root, '.scipquery.json'), predecessorConfig);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=scip-query', '-c', 'user.email=scip-query@example.com', 'commit', '--quiet', '-m', 'base'],
    { cwd: root },
  );
  const authorization = createProtectedWorkAuthorization({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request: {
      principal: 'repository-owner',
      promptSha256: createHash('sha256').update('authorized prompt').digest('hex'),
      goal: {
        feature: 'One protected change reaches autonomous completion',
        invariants: ['Only fixed intent and exact protected bytes can authorize completion'],
        acceptanceScenarios: [
          {
            name: 'fixed completion authority',
            given: ['the principal fixed an external work authorization'],
            when: ['the candidate reaches Stop'],
            then: ['the exact goal and configuration transition have independent authority'],
          },
        ],
      },
      change: {
        idempotencyKey: 'authorized-completion-context',
        title: 'Exercise protected completion authority',
        intendedOutcome: 'The completion firewall accepts only the fixed authorization consequences',
      },
      artifactTransitions: [
        {
          class: 'configuration',
          path: '.scipquery.json',
          predecessorDigest: createHash('sha256').update(predecessorConfig).digest('hex'),
          successorDigest: createHash('sha256').update(successorConfig).digest('hex'),
        },
      ],
    },
    createdAt: '2026-07-31T12:00:00.000Z',
    toolVersion: '0.20.0',
  });
  writeProtectedWorkAuthorization(protectedRoot, root, authorization);
  activateProtectedWorkAuthorization(root, COLLABORATION_DOMAIN, authorization);
  writeFileSync(join(root, '.scipquery.json'), successorConfig);
  const authorizationLease = readConfiguredProtectedWorkAuthorization(root, COLLABORATION_DOMAIN, {
    [PROTECTED_WORK_AUTHORIZATION_ROOT_ENV]: protectedRoot,
    [PROTECTED_WORK_AUTHORIZATION_ID_ENV]: authorization.authorizationId,
  })!;
  const config: ProjectConfig = {
    projectRoot: root,
    dbPath: join(root, '.scipquery-cache', 'index.db'),
    collaborationDomainId: COLLABORATION_DOMAIN,
    languages: ['typescript'],
  };
  return { root, config, evaluator, authorizationLease };
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
