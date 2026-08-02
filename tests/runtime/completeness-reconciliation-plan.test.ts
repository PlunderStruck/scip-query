import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PlanContractRequest } from '../../src/change-control/plan-contract.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import { reconcileCompletenessObligations } from '../../src/runtime/completeness-reconciliation.js';
import {
  createObligationAdmissionFile,
  readObligationLifecycle,
} from '../../src/storage/autonomous-work-obligations.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';
import { createPlanContractRecordFile } from '../../src/storage/plan-contract.js';
import { planContractObligationRequests } from '../../src/change-control/plan-contract.js';

const DOMAIN = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('plan obligation reconciliation', () => {
  it('fulfills retirement and architecture obligations only when their fixed producers complete cleanly', () => {
    const state = repository();
    const clean = gate();

    const reconciled = reconcileCompletenessObligations({
      projectRoot: state.root,
      collaborationDomainId: DOMAIN,
      changeId: state.changeId,
      diffGate: clean,
      receipt: receipt('post'),
      planContracts: [state.plan],
      options: transitionOptions(),
    });

    expect(reconciled).toHaveLength(3);
    expect(readObligationLifecycle(state.root, state.changeId).summary.fulfilledObligationIds).toHaveLength(3);
  });

  it('keeps the exact retirement obligation live while its plan contradiction remains', () => {
    const state = repository();
    const blocked = gate({
      id: 'SQ-PLAN',
      check: 'new-dead',
      severity: 'error',
      evidence: 'baseline',
      actionTier: 'direct',
      confidence: 1,
      file: 'src/legacy.ts',
      relatedFiles: ['src/legacy.ts'],
      sourceAnalyzer: 'plan-retirement-residue',
      rootCauseKey: `plan-retirement:${state.plan.planId}:legacy`,
      message: 'legacy remains',
      why: ['fixed plan contradiction'],
      remediation: 'remove legacy',
    });

    reconcileCompletenessObligations({
      projectRoot: state.root,
      collaborationDomainId: DOMAIN,
      changeId: state.changeId,
      diffGate: blocked,
      receipt: receipt('post'),
      planContracts: [state.plan],
      options: transitionOptions(),
    });

    const lifecycle = readObligationLifecycle(state.root, state.changeId).summary;
    expect(lifecycle.fulfilledObligationIds).toHaveLength(2);
    expect(lifecycle.liveObligationIds).toHaveLength(1);
  });

  it('keeps the exact reuse obligation live while a named consumer does not delegate', () => {
    const state = repository();
    const blocked = gate({
      id: 'SQ-REUSE',
      check: 'new-dead',
      severity: 'error',
      evidence: 'graph-fact',
      actionTier: 'direct',
      confidence: 1,
      sourceAnalyzer: 'plan-reuse-authority',
      rootCauseKey: `plan-reuse:${state.plan.planId}:outcome-owner`,
      message: 'one consumer keeps outcome effects local',
      why: ['compiler graph has no delegation edge'],
      remediation: 'delegate to applyOutcome',
    });

    reconcileCompletenessObligations({
      projectRoot: state.root,
      collaborationDomainId: DOMAIN,
      changeId: state.changeId,
      diffGate: blocked,
      receipt: receipt('post'),
      planContracts: [state.plan],
      options: transitionOptions(),
    });

    const lifecycle = readObligationLifecycle(state.root, state.changeId).summary;
    expect(lifecycle.fulfilledObligationIds).toHaveLength(2);
    expect(lifecycle.liveObligationIds).toHaveLength(1);
  });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'scip-plan-reconcile-'));
  roots.push(root);
  const goal = createGoalRecordFile(
    root,
    DOMAIN,
    {
      feature: 'A migration reaches coherent completion',
      invariants: ['Architecture remains valid'],
      acceptanceScenarios: [
        {
          name: 'Legacy identity is retired',
          given: ['A legacy identity exists'],
          when: ['The migration completes'],
          then: ['The legacy identity is absent'],
        },
      ],
      authorization: { kind: 'repository-delegation', principal: 'repository-owner', source: 'test' },
    },
    options(),
  ).record;
  const change = createIntendedChangeRecordFile(
    root,
    DOMAIN,
    {
      goalId: goal.goalId,
      idempotencyKey: 'migration',
      title: 'Migration',
      intendedOutcome: 'Retire the legacy identity',
    },
    options(),
  ).record;
  const request: PlanContractRequest = {
    schemaVersion: 1,
    goalId: goal.goalId,
    changeId: change.changeId,
    workflowClass: 'relational',
    affectedSeeds: [
      { id: 'relay', kind: 'symbol', referent: 'relayOutcome', role: 'first outcome consumer' },
      { id: 'sweeper', kind: 'symbol', referent: 'sweeperOutcome', role: 'second outcome consumer' },
    ],
    preserve: [],
    retirements: [
      {
        id: 'legacy',
        kind: 'identity',
        referent: 'legacyRetry',
        responsibility: 'fixed delay',
        condition: 'Remove the legacy identity',
        evidenceIds: ['closure'],
      },
    ],
    allowedSurvivors: [],
    reuseAuthorities: [
      {
        id: 'outcome-owner',
        referent: 'applyOutcome',
        responsibility: 'delivery outcome effects',
        consumerSeedIds: ['relay', 'sweeper'],
        condition: 'Both affected consumers delegate delivery outcome effects to applyOutcome',
        evidenceIds: ['reuse-graph'],
      },
    ],
    architecture: [
      {
        id: 'owner',
        predicate: 'configured-policy-clean',
        condition: 'Keep the configured architecture policy clean',
        evidenceIds: ['gate'],
      },
    ],
    completionEvidence: [
      { id: 'closure', description: 'Check retirement closure' },
      { id: 'gate', description: 'Run architecture gate' },
      { id: 'reuse-graph', description: 'Check compiler-resolved delegation calls' },
    ],
    slices: [],
  };
  const plan = createPlanContractRecordFile(
    root,
    DOMAIN,
    request,
    { path: 'plan.md', sha256: 'a'.repeat(64) },
    receipt('pre'),
    options(),
  ).record;
  for (const obligation of planContractObligationRequests(plan)) {
    createObligationAdmissionFile(root, DOMAIN, obligation, options());
  }
  return { root, changeId: change.changeId, plan };
}

function gate(finding?: DiffGateResult['findings'][number]): DiffGateResult {
  return {
    base: 'HEAD',
    changedFiles: ['src/current.ts'],
    changedSymbols: 1,
    checksRun: ['architecture', 'new-dead'],
    skipped: [],
    suppressed: [],
    policyEscalations: [],
    outcome: finding ? 'findings' : 'pass',
    suppressionSummary: {
      automaticSuppressionCount: 0,
      policyEscalationCount: 0,
      expiredCount: 0,
      invalidatedCount: 0,
      legacyUnadjudicatedCount: 0,
    },
    findings: finding ? [finding] : [],
    attributionNotes: [],
    evidenceTiers: [],
    rootCauseGroups: [],
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

function receipt(value: string): ObservationReceiptV2 {
  const content = createObservationIdentity('repository-content', 1, value);
  return {
    schemaVersion: 2,
    observedAt: value === 'post' ? '2026-08-01T12:01:00.000Z' : '2026-08-01T12:00:00.000Z',
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, DOMAIN),
      wholeContent: content,
    },
    observedSources: [{ kind: 'repository-snapshot', identity: content }],
    stabilityProofs: [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }],
  };
}

function options() {
  return { toolVersion: '0.20.0', now: () => '2026-08-01T12:00:00.000Z' };
}

function transitionOptions() {
  return { toolVersion: '0.20.0', now: () => '2026-08-01T12:02:00.000Z' };
}
