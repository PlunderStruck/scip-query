import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPlanContractRecord, type PlanContractRequest } from '../../../src/change-control/plan-contract.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../../src/domain/observation-receipt.js';
import { planRetirementResidue } from '../../../src/queries/impact/plan-retirement-residue.js';

const DOMAIN = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('plan retirement residue', () => {
  it('reports a reachable retired identity even when a public barrel keeps it looking intentional', () => {
    const root = fixture();
    write(root, 'src/legacy.ts', 'export function legacyRetry() { return 5_000; }\n');
    write(root, 'src/index.ts', "export { legacyRetry } from './legacy.js';\n");

    const result = planRetirementResidue(root, [record(contract())]);

    expect(result.coverage.state).toBe('complete');
    expect(result.evaluations).toMatchObject([
      {
        itemId: 'legacy',
        disposition: 'contradiction',
        occurrences: [{ file: 'src/index.ts' }, { file: 'src/legacy.ts' }],
      },
    ]);
  });

  it('accepts a survivor only when a current repository policy source authorizes its role', () => {
    const root = fixture();
    write(root, 'src/legacy.ts', 'export function legacyRetry() { return 5_000; }\n');
    write(root, 'AGENTS.md', 'Public API policy: keep legacyRetry as a supported external compatibility name.\n');
    const plan = contract();
    plan.allowedSurvivors = [
      {
        id: 'compat',
        referent: 'legacyRetry',
        authority: 'repository-policy',
        authorityReferent: 'AGENTS.md#keep legacyRetry',
        currentRole: 'supported external compatibility name',
        evidenceIds: ['search'],
      },
    ];

    expect(planRetirementResidue(root, [record(plan)]).evaluations).toMatchObject([
      { disposition: 'supported-survivor', survivor: { id: 'compat' } },
    ]);

    plan.allowedSurvivors = [{ ...plan.allowedSurvivors[0]!, authorityReferent: 'AGENTS.md#missing policy' }];
    expect(planRetirementResidue(root, [record(plan)]).evaluations).toMatchObject([{ disposition: 'contradiction' }]);
  });

  it('keeps responsibility-only retirement evidence partial instead of guessing that behavior is gone', () => {
    const root = fixture();
    const plan = contract();
    plan.retirements = [
      {
        ...plan.retirements[0]!,
        kind: 'responsibility',
        referent: 'fixed delay behavior',
      },
    ];

    const result = planRetirementResidue(root, [record(plan)]);
    expect(result.coverage.state).toBe('partial');
    expect(result.evaluations).toMatchObject([{ disposition: 'insufficient-evidence' }]);
  });

  it('treats a deleted tracked file as absent instead of omitted coverage', () => {
    const root = fixture();
    write(root, 'src/legacy.ts', 'export function legacyRetry() { return 5_000; }\n');
    execFileSync('git', ['-C', root, 'init', '--quiet']);
    execFileSync('git', ['-C', root, 'add', 'plan.md', 'src/legacy.ts']);
    unlinkSync(join(root, 'src/legacy.ts'));

    const result = planRetirementResidue(root, [record(contract())]);

    expect(result.coverage).toMatchObject({ state: 'complete', omitted: [] });
    expect(result.evaluations).toEqual([]);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-plan-retirement-'));
  roots.push(root);
  write(root, 'plan.md', '# Plan source mentions legacyRetry but is not current product code.\n');
  return root;
}

function contract(): PlanContractRequest {
  return {
    schemaVersion: 1,
    goalId: 'SQG-0123456789ABCDEF0123456789ABCDEF',
    changeId: 'SQC-0123456789ABCDEF0123456789ABCDEF',
    workflowClass: 'relational',
    affectedSeeds: [],
    preserve: [],
    retirements: [
      {
        id: 'legacy',
        kind: 'identity',
        referent: 'legacyRetry',
        responsibility: 'fixed retry delay',
        condition: 'The old identity no longer remains reachable',
        evidenceIds: ['search'],
      },
    ],
    allowedSurvivors: [],
    reuseAuthorities: [],
    architecture: [],
    completionEvidence: [{ id: 'search', description: 'Search the retirement closure' }],
    slices: [],
  };
}

function record(request: PlanContractRequest) {
  return createPlanContractRecord({
    collaborationDomainId: DOMAIN,
    request,
    source: { path: 'plan.md', sha256: 'a'.repeat(64) },
    compiledAgainst: receipt(),
    createdAt: '2026-08-01T12:00:00.000Z',
    toolVersion: '0.20.0',
  });
}

function receipt(): ObservationReceiptV2 {
  const content = createObservationIdentity('repository-content', 1, 'pre-edit');
  return {
    schemaVersion: 2,
    observedAt: '2026-08-01T12:00:00.000Z',
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, DOMAIN),
      wholeContent: content,
    },
    observedSources: [{ kind: 'repository-snapshot', identity: content }],
    stabilityProofs: [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }],
  };
}

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
