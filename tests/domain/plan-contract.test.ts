import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createPlanContractRecord,
  decodePlanContractInput,
  decodePlanContractRecord,
  decodePlanContractRequest,
  extractPlanContractRequest,
  planContractObligationRequests,
  type PlanContractRequest,
} from '../../src/change-control/plan-contract.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';

const GOAL_ID = 'SQG-0123456789ABCDEF0123456789ABCDEF';
const CHANGE_ID = 'SQC-0123456789ABCDEF0123456789ABCDEF';
const DOMAIN = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';

describe('plan contract', () => {
  it('extracts one structured contract from a readable Markdown plan', () => {
    const extracted = extractPlanContractRequest(
      `# Retry migration\n\nExplain the approach here.\n\n\`\`\`scip-query-plan\n${JSON.stringify(
        request(),
        null,
        2,
      )}\n\`\`\`\n`,
    );

    expect(extracted.ok).toBe(true);
    if (extracted.ok) expect(extracted.request.retirements[0]?.referent).toBe('legacyRetry');
  });

  it('accepts one inline goal and intended change instead of requiring pre-created record identities', () => {
    const decoded = decodePlanContractInput({
      ...request(),
      goalId: undefined,
      changeId: undefined,
      goal: {
        feature: 'A retry migration reaches coherent completion',
        invariants: ['Unrelated behavior remains true'],
        acceptanceScenarios: [
          {
            name: 'Legacy retry is retired',
            given: ['A legacy retry path exists'],
            when: ['The migration completes'],
            then: ['The old path no longer remains reachable'],
          },
        ],
        authorization: { kind: 'repository-delegation', principal: 'repository-owner', source: 'user-request' },
      },
      change: {
        idempotencyKey: 'retry-migration',
        title: 'Retry migration',
        intendedOutcome: 'The legacy retry path is retired',
      },
    });

    expect(decoded).toMatchObject({
      ok: true,
      request: {
        goal: { feature: 'A retry migration reaches coherent completion' },
        change: { idempotencyKey: 'retry-migration' },
      },
    });
    expect(
      decodePlanContractInput({
        ...request(),
        goal: { feature: 'mixed modes are invalid' },
        change: { idempotencyKey: 'mixed' },
      }),
    ).toMatchObject({ ok: false });
  });

  it('expands concise Gherkin authoring into the strict v1 plan input', () => {
    const decoded = decodePlanContractInput({
      schemaVersion: 1,
      form: 'compact',
      goal: {
        feature: 'Retry migration completes without residue',
        invariants: ['Permanent failures keep their current outcome'],
        scenario: {
          name: 'Legacy retry is retired',
          given: 'A legacy retry path exists',
          when: 'The migration completes',
          then: 'The old path no longer remains reachable',
        },
      },
      change: { key: 'retry-migration', outcome: 'Only the current retry policy remains' },
      class: 'relational',
      seeds: [
        { id: 'entry', kind: 'symbol', referent: 'queueDelivery', role: 'entry point' },
        { id: 'drain', kind: 'symbol', referent: 'drainDelivery', role: 'second entry point' },
      ],
      preserve: [{ condition: 'Permanent failures keep their current outcome', evidence: ['tests'] }],
      retire: [
        {
          kind: 'identity',
          referent: 'legacyRetry',
          responsibility: 'fixed retry delay',
          condition: 'The old identity is unreachable and no longer communicates current design',
          evidence: ['search'],
        },
      ],
      reuse: [
        {
          referent: 'applyDeliveryOutcome',
          responsibility: 'delivery outcome effects',
          consumers: ['entry', 'drain'],
          condition: 'Both entries delegate outcome effects to the existing owner',
          evidence: ['gate'],
        },
      ],
      architecture: [{ condition: 'Configured architecture rules remain clean', evidence: ['gate'] }],
      evidence: {
        tests: { description: 'Run focused tests', command: 'npm test' },
        search: 'Search the fixed retirement closure',
        gate: { description: 'Run the configured gate', command: 'scip-query diff-gate' },
      },
    });

    expect(decoded).toMatchObject({
      ok: true,
      request: {
        workflowClass: 'relational',
        goal: {
          feature: 'Retry migration completes without residue',
          acceptanceScenarios: [
            {
              name: 'Legacy retry is retired',
              given: ['A legacy retry path exists'],
              when: ['The migration completes'],
              then: ['The old path no longer remains reachable'],
            },
          ],
          authorization: { kind: 'repository-delegation', principal: 'repository-owner' },
        },
        change: {
          idempotencyKey: 'retry-migration',
          title: 'Retry migration completes without residue',
          intendedOutcome: 'Only the current retry policy remains',
        },
        affectedSeeds: [{ id: 'drain' }, { id: 'entry' }],
        preserve: [{ id: 'preserve-1', evidenceIds: ['tests'] }],
        retirements: [{ id: 'retire-1', referent: 'legacyRetry', evidenceIds: ['search'] }],
        reuseAuthorities: [{ id: 'reuse-1', referent: 'applyDeliveryOutcome', consumerSeedIds: ['drain', 'entry'] }],
        architecture: [{ id: 'architecture-1', predicate: 'configured-policy-clean', evidenceIds: ['gate'] }],
        completionEvidence: [{ id: 'gate' }, { id: 'search' }, { id: 'tests' }],
        slices: [],
      },
    });
  });

  it('expands compact continuation input without creating another inline goal or change', () => {
    const decoded = decodePlanContractInput({
      schemaVersion: 1,
      form: 'compact',
      goalId: GOAL_ID,
      changeId: CHANGE_ID,
      class: 'relational',
      seeds: [{ id: 'entry', kind: 'symbol', referent: 'queueDelivery', role: 'entry point' }],
      preserve: [{ condition: 'Current outcomes remain true', evidence: ['tests'] }],
      evidence: { tests: 'Run focused tests' },
    });

    expect(decoded).toMatchObject({
      ok: true,
      request: {
        goalId: GOAL_ID,
        changeId: CHANGE_ID,
        workflowClass: 'relational',
      },
    });
    if (decoded.ok) {
      expect('goal' in decoded.request).toBe(false);
      expect('change' in decoded.request).toBe(false);
    }
  });

  it('rejects mixed or incomplete compact work references', () => {
    const base = {
      schemaVersion: 1,
      form: 'compact',
      class: 'relational',
      seeds: [{ id: 'entry', kind: 'symbol', referent: 'queueDelivery', role: 'entry point' }],
      preserve: [{ condition: 'Current outcomes remain true', evidence: ['tests'] }],
      evidence: { tests: 'Run focused tests' },
    };
    expect(
      decodePlanContractInput({
        ...base,
        goalId: GOAL_ID,
        changeId: CHANGE_ID,
        goal: { feature: 'Mixed input' },
        change: { key: 'mixed', outcome: 'Mixed input' },
      }),
    ).toMatchObject({ ok: false });
    expect(decodePlanContractInput({ ...base, goalId: GOAL_ID })).toMatchObject({ ok: false });
  });

  it('still applies strict relationship validation after compact expansion', () => {
    const decoded = decodePlanContractInput({
      schemaVersion: 1,
      form: 'compact',
      goal: {
        feature: 'A complete change',
        invariants: ['Current behavior is preserved'],
        scenario: { name: 'Complete', given: 'Current state', when: 'Work ends', then: 'Goal holds' },
      },
      change: { key: 'complete-change', outcome: 'The goal holds' },
      class: 'relational',
      seeds: [{ id: 'entry', kind: 'symbol', referent: 'entry', role: 'entry point' }],
      preserve: [{ condition: 'Current behavior is preserved', evidence: ['missing'] }],
      evidence: { tests: 'Run focused tests' },
    });

    expect(decoded).toMatchObject({ ok: false });
    if (!decoded.ok) expect(decoded.error).toContain('references missing completion evidence: missing');
  });

  it('rejects missing, repeated, malformed, and direct-work contracts', () => {
    expect(extractPlanContractRequest('# no contract')).toMatchObject({ ok: false });
    const fence = `\`\`\`scip-query-plan\n${JSON.stringify(request())}\n\`\`\``;
    expect(extractPlanContractRequest(`${fence}\n${fence}`)).toMatchObject({ ok: false });
    expect(extractPlanContractRequest('```scip-query-plan\n{bad}\n```')).toMatchObject({ ok: false });
    expect(decodePlanContractRequest({ ...request(), workflowClass: 'direct' })).toMatchObject({ ok: false });
  });

  it('reports independent plan defects in one validation response', () => {
    const decoded = decodePlanContractRequest({
      ...request(),
      retirements: [
        {
          id: 'old-surface',
          kind: 'legacy-surface',
          referent: '',
          responsibility: '',
          condition: '',
          evidenceIds: 'not-an-array',
        },
      ],
      reuseAuthorities: [
        {
          id: 'shared-owner',
          referent: '',
          responsibility: '',
          consumerSeedIds: ['entry'],
          condition: '',
          evidenceIds: 'not-an-array',
        },
      ],
      completionEvidence: [{ id: 'tests', description: '' }],
      slices: [
        { id: 'first', outcome: '', evidenceIds: ['tests'] },
        { id: 'second', outcome: '', evidenceIds: ['tests'] },
      ],
    });

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toContain('plan contract has');
    expect(decoded.error).toContain('retirements[0]');
    expect(decoded.error).toContain('reuseAuthorities[0]');
    expect(decoded.error).toContain('shared-owner condition');
    expect(decoded.error).toContain('shared-owner evidenceIds must be an array of item ids');
    expect(decoded.error).toContain('shared-owner referent');
    expect(decoded.error).toContain('shared-owner responsibility');
    expect(decoded.error).toContain('shared-owner must name at least two affected consumer seed ids');
    expect(decoded.error).toContain('completionEvidence[0]');
    expect(decoded.error).toContain(
      'slices: relational plan contracts keep one coherent slice; use sustained when ordered slices are required',
    );
    expect(decoded.error).toContain('slices[0]');
    expect(decoded.error).toContain('slices[1]');
  });

  it('requires every completion condition to name existing evidence and every survivor to cite non-plan authority', () => {
    expect(
      decodePlanContractRequest({
        ...request(),
        retirements: [{ ...request().retirements[0]!, evidenceIds: ['missing'] }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      decodePlanContractRequest({
        ...request(),
        allowedSurvivors: [
          {
            id: 'compat',
            referent: 'legacyRetry',
            authority: 'plan',
            authorityReferent: 'this plan',
            currentRole: 'compatibility',
            evidenceIds: ['search'],
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  it('creates a content-identified record and rejects semantic mutation', () => {
    const record = recordFor(request());
    expect(decodePlanContractRecord(record)).toMatchObject({ state: 'current', record: { planId: record.planId } });
    expect(decodePlanContractRecord({ ...record, workflowClass: 'sustained' })).toMatchObject({ state: 'malformed' });
  });

  it('derives useful obligations in the same action without turning evidence routes into ceremony', () => {
    const obligations = planContractObligationRequests(recordFor(request()));

    expect(obligations.map((entry) => entry.category)).toEqual(['architecture', 'residue', 'verification']);
    expect(obligations.every((entry) => entry.evidenceReceipts.length === 1)).toBe(true);
    expect(obligations.some((entry) => entry.source.kind === 'agent-discovery')).toBe(true);
    expect(obligations.some((entry) => entry.title.includes('search'))).toBe(false);
  });

  it('publishes request and immutable-record schemas with distinct closed surfaces', () => {
    const schemas = join(process.cwd(), 'docs', 'schemas');
    const requestSchema = JSON.parse(readFileSync(join(schemas, 'plan-contract.schema.json'), 'utf8')) as {
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };
    const recordSchema = JSON.parse(readFileSync(join(schemas, 'plan-contract-record.schema.json'), 'utf8')) as {
      properties: Record<string, { const?: unknown; $ref?: string }>;
      additionalProperties: boolean;
    };

    expect(requestSchema.properties['schemaVersion']?.const).toBe(1);
    expect(requestSchema.properties['kind']).toBeUndefined();
    expect(requestSchema.additionalProperties).toBe(false);
    expect(recordSchema.properties['kind']?.const).toBe('scip-query-plan-contract');
    expect(recordSchema.properties['affectedSeeds']?.$ref).toBe(
      './plan-contract.schema.json#/properties/affectedSeeds',
    );
    expect(recordSchema.additionalProperties).toBe(false);
  });
});

function request(): PlanContractRequest {
  return {
    schemaVersion: 1,
    goalId: GOAL_ID,
    changeId: CHANGE_ID,
    workflowClass: 'relational',
    affectedSeeds: [
      { id: 'entry', kind: 'symbol', referent: 'queueDelivery', role: 'entry point' },
      { id: 'drain', kind: 'symbol', referent: 'drainDelivery', role: 'second affected entry point' },
    ],
    preserve: [
      {
        id: 'outcomes',
        condition: 'Success and permanent failures keep their current outcomes',
        evidenceIds: ['tests'],
      },
    ],
    retirements: [
      {
        id: 'legacy',
        kind: 'identity',
        referent: 'legacyRetry',
        responsibility: 'fixed retry delay',
        condition: 'The legacy retry identity no longer remains reachable or communicates current design',
        evidenceIds: ['search'],
      },
    ],
    allowedSurvivors: [],
    reuseAuthorities: [
      {
        id: 'outcome-owner',
        referent: 'applyDeliveryOutcome',
        responsibility: 'delivery outcome effects',
        consumerSeedIds: ['drain', 'entry'],
        condition: 'Affected delivery entries delegate outcome effects to applyDeliveryOutcome',
        evidenceIds: ['architecture'],
      },
    ],
    architecture: [
      {
        id: 'owner',
        predicate: 'configured-policy-clean',
        condition: 'Retry policy remains in the core boundary',
        evidenceIds: ['architecture'],
      },
    ],
    completionEvidence: [
      { id: 'tests', description: 'Run focused outcome tests', command: 'npm test' },
      { id: 'search', description: 'Search the fixed retirement closure' },
      { id: 'architecture', description: 'Run the configured architecture gate', command: 'scip-query diff-gate' },
    ],
    slices: [],
  };
}

function recordFor(contract: PlanContractRequest) {
  return createPlanContractRecord({
    collaborationDomainId: DOMAIN,
    request: contract,
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
