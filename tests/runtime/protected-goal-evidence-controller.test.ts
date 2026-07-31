import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProtectedWorkAuthorization } from '../../src/domain/protected-work-authorization.js';
import type { ProjectConfig } from '../../src/domain/types.js';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import {
  captureFixedCompletionContext,
  publishStopCompletionEvaluations,
} from '../../src/runtime/completion-evaluation-context.js';
import {
  PROTECTED_GOAL_EVIDENCE_ID_ENV,
  PROTECTED_GOAL_EVIDENCE_ROOT_ENV,
  assertFixedProtectedGoalEvidence,
  evaluateAndWriteProtectedGoalEvidence,
  readConfiguredProtectedGoalEvidence,
} from '../../src/runtime/protected-goal-evidence-controller.js';
import {
  PROTECTED_WORK_AUTHORIZATION_ID_ENV,
  PROTECTED_WORK_AUTHORIZATION_ROOT_ENV,
  readConfiguredProtectedWorkAuthorization,
} from '../../src/runtime/protected-work-authorization-controller.js';
import { readCompletionHistory } from '../../src/storage/autonomous-completion.js';
import {
  activateProtectedWorkAuthorization,
  writeProtectedWorkAuthorization,
} from '../../src/storage/protected-work-authorization.js';

const COLLABORATION_DOMAIN = '79bc01a0-2651-4f7a-b146-aa59bd324143';
const fixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  fixtureDirectories.clear();
});

describe('protected goal evidence controller', () => {
  it('turns the exact pre-authorized evaluator result into a durable completion transition', () => {
    const fixture = goalEvidenceFixture();
    const publication = evaluateAndWriteProtectedGoalEvidence({
      projectRoot: fixture.root,
      protectedRoot: fixture.protectedRoot,
      authorizationId: fixture.authorizationId,
      evaluatorPath: fixture.evaluator,
      toolVersion: '0.20.0',
    });
    const evidence = readConfiguredProtectedGoalEvidence(fixture.root, COLLABORATION_DOMAIN, fixture.authorization, {
      [PROTECTED_GOAL_EVIDENCE_ROOT_ENV]: fixture.protectedRoot,
      [PROTECTED_GOAL_EVIDENCE_ID_ENV]: publication.record.evidenceId,
    })!;
    const lease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.internalEvaluator,
      protectedWorkAuthorization: fixture.authorization,
      protectedGoalEvidence: evidence,
    });
    const [result] = publishStopCompletionEvaluations(lease, passingGate(), {
      toolVersion: '0.20.0',
      now: () => new Date(Date.parse(lease.targetObservation.observedAt) + 1_000).toISOString(),
    });

    expect(result?.evaluation.evaluation.record.decision).toEqual({ state: 'complete' });
    expect(result?.evaluation.transition?.record.to).toBe('complete');
    expect(
      result?.evaluation.evaluation.record.predicates.find((predicate) => predicate.predicate === 'goal-fulfilled'),
    ).toMatchObject({ state: 'established', reasons: [expect.stringContaining(publication.record.evidenceId)] });
    expect(readCompletionHistory(fixture.root).summary.states).toEqual([
      expect.objectContaining({ state: 'complete', changeId: fixture.changeId }),
    ]);
  });

  it('rejects evidence after the candidate repository changes', () => {
    const fixture = goalEvidenceFixture();
    const publication = evaluateAndWriteProtectedGoalEvidence({
      projectRoot: fixture.root,
      protectedRoot: fixture.protectedRoot,
      authorizationId: fixture.authorizationId,
      evaluatorPath: fixture.evaluator,
      toolVersion: '0.20.0',
    });
    const evidence = readConfiguredProtectedGoalEvidence(fixture.root, COLLABORATION_DOMAIN, fixture.authorization, {
      [PROTECTED_GOAL_EVIDENCE_ROOT_ENV]: fixture.protectedRoot,
      [PROTECTED_GOAL_EVIDENCE_ID_ENV]: publication.record.evidenceId,
    })!;
    writeFileSync(join(fixture.root, 'src', 'feature.ts'), 'export const feature = 2;\n');

    expect(() =>
      captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
        evaluatorEntrypoint: fixture.internalEvaluator,
        protectedWorkAuthorization: fixture.authorization,
        protectedGoalEvidence: evidence,
      }),
    ).toThrow(/different repository state/u);
  });

  it('rejects evaluator bytes that were not fixed before candidate work', () => {
    const fixture = goalEvidenceFixture();
    writeFileSync(fixture.evaluator, `${evaluatorSource()}\n// candidate replacement\n`);

    expect(() =>
      evaluateAndWriteProtectedGoalEvidence({
        projectRoot: fixture.root,
        protectedRoot: fixture.protectedRoot,
        authorizationId: fixture.authorizationId,
        evaluatorPath: fixture.evaluator,
        toolVersion: '0.20.0',
      }),
    ).toThrow(/bytes do not match/u);
  });

  it('invalidates a fixed lease when protected receipt bytes move', () => {
    const fixture = goalEvidenceFixture();
    const publication = evaluateAndWriteProtectedGoalEvidence({
      projectRoot: fixture.root,
      protectedRoot: fixture.protectedRoot,
      authorizationId: fixture.authorizationId,
      evaluatorPath: fixture.evaluator,
      toolVersion: '0.20.0',
    });
    const evidence = readConfiguredProtectedGoalEvidence(fixture.root, COLLABORATION_DOMAIN, fixture.authorization, {
      [PROTECTED_GOAL_EVIDENCE_ROOT_ENV]: fixture.protectedRoot,
      [PROTECTED_GOAL_EVIDENCE_ID_ENV]: publication.record.evidenceId,
    })!;
    writeFileSync(evidence.path, `${JSON.stringify(evidence.record)}\n\n`);

    expect(() => assertFixedProtectedGoalEvidence(evidence)).toThrow(/changed while completion/u);
  });

  it('keeps an explicit unknown evaluator result blocked', () => {
    const fixture = goalEvidenceFixture('unknown');
    const publication = evaluateAndWriteProtectedGoalEvidence({
      projectRoot: fixture.root,
      protectedRoot: fixture.protectedRoot,
      authorizationId: fixture.authorizationId,
      evaluatorPath: fixture.evaluator,
      toolVersion: '0.20.0',
    });
    const evidence = readConfiguredProtectedGoalEvidence(fixture.root, COLLABORATION_DOMAIN, fixture.authorization, {
      [PROTECTED_GOAL_EVIDENCE_ROOT_ENV]: fixture.protectedRoot,
      [PROTECTED_GOAL_EVIDENCE_ID_ENV]: publication.record.evidenceId,
    })!;
    const lease = captureFixedCompletionContext(fixture.root, fixture.config, 'block', {
      evaluatorEntrypoint: fixture.internalEvaluator,
      protectedWorkAuthorization: fixture.authorization,
      protectedGoalEvidence: evidence,
    });
    const [result] = publishStopCompletionEvaluations(lease, passingGate(), {
      toolVersion: '0.20.0',
      now: () => new Date(Date.parse(lease.targetObservation.observedAt) + 1_000).toISOString(),
    });

    expect(result?.evaluation.evaluation.record.decision).toEqual(
      expect.objectContaining({
        state: 'blocked',
        unknownPredicates: expect.arrayContaining(['goal-fulfilled', 'invariants-preserved', 'coverage-complete']),
      }),
    );
    expect(result?.evaluation.transition).toBeUndefined();
  });

  it('publishes no receipt when the protected evaluator errors', () => {
    const fixture = goalEvidenceFixture('crash');

    expect(() =>
      evaluateAndWriteProtectedGoalEvidence({
        projectRoot: fixture.root,
        protectedRoot: fixture.protectedRoot,
        authorizationId: fixture.authorizationId,
        evaluatorPath: fixture.evaluator,
        toolVersion: '0.20.0',
      }),
    ).toThrow(/protected evaluator failed/u);
  });
});

function goalEvidenceFixture(evaluatorMode: 'state' | 'unknown' | 'crash' = 'state') {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-goal-evidence-candidate-'));
  const protectedRoot = mkdtempSync(join(tmpdir(), 'scip-query-goal-evidence-protected-'));
  fixtureDirectories.add(root);
  fixtureDirectories.add(protectedRoot);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = 1;\n');
  writeFileSync(join(root, 'src', 'removed.ts'), 'export const removed = true;\n');
  writeFileSync(join(root, '.scipquery.json'), `${JSON.stringify({ collaborationDomainId: COLLABORATION_DOMAIN })}\n`);
  const internalEvaluator = join(root, 'fixed-controller.js');
  writeFileSync(internalEvaluator, 'export const controller = 1;\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=scip-query', '-c', 'user.email=scip-query@example.com', 'commit', '--quiet', '-m', 'base'],
    { cwd: root },
  );
  rmSync(join(root, 'src', 'removed.ts'));
  writeFileSync(join(root, 'candidate-only.txt'), 'untracked evidence input\n');
  const evaluator = join(protectedRoot, 'evaluator.mjs');
  const protectedEvaluatorSource = evaluatorSource(evaluatorMode);
  writeFileSync(evaluator, protectedEvaluatorSource);
  const authorizationRecord = createProtectedWorkAuthorization({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request: {
      principal: 'protected-test-runner',
      promptSha256: digest('authorized request'),
      goal: {
        feature: 'The protected feature is complete',
        invariants: ['The independent evaluator remains fixed'],
        acceptanceScenarios: [
          {
            name: 'exact protected evidence',
            given: ['a fixed goal and evaluator'],
            when: ['the evaluator accepts one fixed worktree'],
            then: ['the controller permits completion for only that worktree'],
          },
        ],
      },
      change: {
        idempotencyKey: 'protected-goal-evidence-test',
        title: 'Exercise protected evidence',
        intendedOutcome: 'One exact evaluator judgment can complete one exact candidate state',
      },
      protectedEvaluator: {
        evaluatorId: 'test:protected-evaluator',
        contractVersion: 1,
        artifactSha256: digest(protectedEvaluatorSource),
      },
      artifactTransitions: [],
    },
    createdAt: '2026-07-31T13:00:00.000Z',
    toolVersion: '0.20.0',
  });
  writeProtectedWorkAuthorization(protectedRoot, root, authorizationRecord);
  activateProtectedWorkAuthorization(root, COLLABORATION_DOMAIN, authorizationRecord);
  const authorization = readConfiguredProtectedWorkAuthorization(root, COLLABORATION_DOMAIN, {
    [PROTECTED_WORK_AUTHORIZATION_ROOT_ENV]: protectedRoot,
    [PROTECTED_WORK_AUTHORIZATION_ID_ENV]: authorizationRecord.authorizationId,
  })!;
  const config: ProjectConfig = {
    projectRoot: root,
    dbPath: join(root, '.scipquery-cache', 'index.db'),
    collaborationDomainId: COLLABORATION_DOMAIN,
    languages: ['typescript'],
  };
  return {
    root,
    protectedRoot,
    evaluator,
    internalEvaluator,
    authorization,
    authorizationId: authorizationRecord.authorizationId,
    changeId: authorizationRecord.change.changeId,
    config,
  };
}

function evaluatorSource(mode: 'state' | 'unknown' | 'crash' = 'state'): string {
  if (mode === 'crash') return "process.stderr.write('evaluator unavailable\\n'); process.exit(2);\n";
  if (mode === 'unknown') {
    const result = {
      goalSatisfied: null,
      invariantsPreserved: null,
      affectedSurfaceReconciled: null,
      missedAffectedArtifacts: [],
      residueDefects: [],
      reintroducedBehaviors: [],
      architectureViolations: [],
    };
    return `process.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)});\n`;
  }
  return [
    "import { existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const root = process.argv[2];',
    "const exactOverlay = existsSync(join(root, 'candidate-only.txt')) && !existsSync(join(root, 'src', 'removed.ts'));",
    'process.stdout.write(`${JSON.stringify({',
    '  goalSatisfied: exactOverlay,',
    '  invariantsPreserved: exactOverlay,',
    '  affectedSurfaceReconciled: exactOverlay,',
    "  missedAffectedArtifacts: exactOverlay ? [] : ['untracked or deleted overlay was absent'],",
    '  residueDefects: [],',
    '  reintroducedBehaviors: [],',
    '  architectureViolations: [],',
    '})}\\n`);',
    '',
  ].join('\n');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
