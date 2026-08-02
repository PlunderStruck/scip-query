import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PlanContractRecordV1 } from '../../../src/change-control/plan-contract.js';
import { planReuseAuthority, type PlanReuseRuntime } from '../../../src/queries/impact/plan-reuse-authority.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('plan reuse authority', () => {
  it('establishes one owner only when every named consumer has a direct compiler path', () => {
    const result = planReuseAuthority(
      {} as ScipDatabase,
      [plan()],
      runtime({ relay: ['applyOutcome'], sweeper: ['applyOutcome'] }),
    );

    expect(result.coverage.state).toBe('complete');
    expect(result.evaluations).toMatchObject([{ disposition: 'established', missingConsumers: [] }]);
    expect(result.evaluations[0]?.consumers.map((consumer) => consumer.observedPath[0]?.kind)).toEqual([
      'call',
      'call',
    ]);
  });

  it('accepts a bounded transitive compiler path and records every edge', () => {
    const result = planReuseAuthority(
      {} as ScipDatabase,
      [plan()],
      runtime({ relay: ['relayBridge'], relayBridge: ['applyOutcome'], sweeper: ['applyOutcome'] }),
    );

    expect(result.evaluations[0]?.disposition).toBe('established');
    expect(result.evaluations[0]?.consumers[0]?.observedPath.map((edge) => edge.to.symbol)).toEqual([
      'relayBridge',
      'applyOutcome',
    ]);
  });

  it('reports each consumer whose complete graph has no path to the owner', () => {
    const result = planReuseAuthority(
      {} as ScipDatabase,
      [plan()],
      runtime({ relay: ['applyOutcome'], sweeper: ['somethingElse'], somethingElse: [] }),
    );

    expect(result.coverage.state).toBe('complete');
    expect(result.evaluations).toMatchObject([
      {
        disposition: 'contradiction',
        missingConsumers: [
          {
            seedId: 'sweeper',
            referent: 'sweeper',
            disposition: 'contradiction',
            truncated: false,
            frontier: [{ symbol: 'somethingElse', reason: 'graph-end' }],
          },
        ],
      },
    ]);
  });

  it('accepts a compiler-resolved callable argument without pretending it is a direct call', () => {
    const resolver = runtime({ relay: ['createRelay'], sweeper: ['applyOutcome'], createRelay: [] });
    resolver.callableArgument = (_db, consumer, authority) =>
      consumer.symbol === 'relay' && authority.symbol === 'applyOutcome'
        ? { state: 'found', file: 'src/relay.ts', line: 8 }
        : { state: 'not-found' };

    const result = planReuseAuthority({} as ScipDatabase, [plan()], resolver);

    expect(result.evaluations[0]?.disposition).toBe('established');
    expect(result.evaluations[0]?.consumers[0]?.observedPath).toMatchObject([
      { from: { symbol: 'relay' }, to: { symbol: 'applyOutcome' }, kind: 'callable-argument', line: 8 },
    ]);
  });

  it('finds a callable argument from a real index without benchmark-specific names', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-plan-reuse-callback-'));
    const projectRoot = join(tempDir, 'project');
    const dbPath = join(tempDir, 'index.db');
    const owner = fixtureSymbol('core.ts', 'applyPolicy');
    const factory = fixtureSymbol('factory.ts', 'makeRunner');
    const consumer = fixtureSymbol('runner.ts', 'executeBatch');
    writeFixtureFiles(projectRoot, {
      'src/core.ts': ['export function applyPolicy(input: string) {', '  return input.trim();', '}'],
      'src/factory.ts': [
        'export function makeRunner(run: (input: string) => string) {',
        '  return (input: string) => run(input);',
        '}',
      ],
      'src/runner.ts': [
        "import { applyPolicy } from './core.js';",
        "import { makeRunner } from './factory.js';",
        'export const executeBatch = makeRunner(applyPolicy);',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/core.ts')
      .document(2, 'typescript', 'src/factory.ts')
      .document(3, 'typescript', 'src/runner.ts')
      .symbol(1, owner, 'applyPolicy', 12)
      .symbol(2, factory, 'makeRunner', 12)
      .symbol(3, consumer, 'executeBatch', 13)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .definition(3, 3, 3, 2, 0, 2, 52)
      .chunk(1, 1, 0, 2)
      .chunk(2, 2, 0, 2)
      .chunk(3, 3, 0, 2)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(3, 3, 1)
      .mention(3, 1, 0)
      .mention(3, 2, 0)
      .write();

    const db = new ScipDatabase({ dbPath, projectRoot });
    try {
      const result = planReuseAuthority(db, [singleConsumerPlan(owner, consumer)]);

      expect(result.coverage.state).toBe('complete');
      expect(result.evaluations[0]?.disposition).toBe('established');
      expect(result.evaluations[0]?.consumers[0]?.observedPath).toMatchObject([
        { from: { symbol: consumer }, to: { symbol: owner }, kind: 'callable-argument', file: 'src/runner.ts' },
      ]);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('treats an exceeded depth bound as insufficient evidence rather than a contradiction', () => {
    const result = planReuseAuthority(
      {} as ScipDatabase,
      [plan()],
      runtime({ relay: ['layerOne'], layerOne: ['layerTwo'], layerTwo: ['applyOutcome'], sweeper: ['applyOutcome'] }),
      { maxDepth: 1 },
    );

    expect(result.coverage.state).toBe('partial');
    expect(result.evaluations[0]).toMatchObject({
      disposition: 'insufficient-evidence',
      missingConsumers: [],
      consumers: [
        {
          seedId: 'relay',
          disposition: 'insufficient-evidence',
          truncated: true,
          frontier: [{ symbol: 'layerTwo', depth: 2, reason: 'depth-limit' }],
        },
        { seedId: 'sweeper', disposition: 'established' },
      ],
    });
  });

  it('terminates cycles and reports a complete missing path', () => {
    const result = planReuseAuthority(
      {} as ScipDatabase,
      [plan()],
      runtime({ relay: ['loop'], loop: ['relay'], sweeper: ['applyOutcome'] }),
    );

    expect(result.coverage.state).toBe('complete');
    expect(result.evaluations[0]?.missingConsumers[0]).toMatchObject({
      seedId: 'relay',
      disposition: 'contradiction',
      truncated: false,
      frontier: [{ symbol: 'loop', reason: 'cycle-closed' }],
    });
  });

  it('fails coverage closed when a referent is ambiguous', () => {
    const resolver = runtime({ relay: ['applyOutcome'], sweeper: ['applyOutcome'] });
    resolver.resolve = (_db, referent) =>
      referent === 'applyOutcome'
        ? { state: 'unknown', reason: 'applyOutcome resolves to 2 symbols; use a qualified referent' }
        : resolved(referent);

    const result = planReuseAuthority({} as ScipDatabase, [plan()], resolver);

    expect(result.coverage.state).toBe('partial');
    expect(result.evaluations).toMatchObject([{ disposition: 'insufficient-evidence' }]);
  });
});

function runtime(graph: Record<string, readonly string[]>): PlanReuseRuntime {
  return {
    resolve: (_db, referent) => resolved(referent),
    callees: (_db, referent) => ({
      state: 'complete',
      values: (graph[referent.symbol] ?? []).map((callee) => resolvedValue(callee)),
    }),
  };
}

function resolved(referent: string): ReturnType<PlanReuseRuntime['resolve']> {
  return { state: 'resolved', value: resolvedValue(referent) };
}

function resolvedValue(referent: string) {
  return {
    symbol: referent,
    file: referent === 'applyOutcome' ? 'src/core.ts' : `src/${referent}.ts`,
  };
}

function plan(): PlanContractRecordV1 {
  return {
    planId: `SQP-${'A'.repeat(32)}`,
    affectedSeeds: [
      { id: 'relay', kind: 'symbol', referent: 'relay', role: 'relay outcome consumer' },
      { id: 'sweeper', kind: 'symbol', referent: 'sweeper', role: 'sweeper outcome consumer' },
    ],
    reuseAuthorities: [
      {
        id: 'outcome-owner',
        referent: 'applyOutcome',
        responsibility: 'delivery outcome effects',
        consumerSeedIds: ['relay', 'sweeper'],
        condition: 'Both consumers delegate outcome effects to applyOutcome',
        evidenceIds: ['graph'],
      },
    ],
  } as PlanContractRecordV1;
}

function singleConsumerPlan(owner: string, consumer: string): PlanContractRecordV1 {
  return {
    planId: `SQP-${'B'.repeat(32)}`,
    affectedSeeds: [{ id: 'worker', kind: 'symbol', referent: consumer, role: 'policy consumer' }],
    reuseAuthorities: [
      {
        id: 'policy-owner',
        referent: owner,
        responsibility: 'policy application',
        consumerSeedIds: ['worker'],
        condition: 'The affected worker delegates policy application to the existing owner',
        evidenceIds: ['compiler-graph'],
      },
    ],
  } as PlanContractRecordV1;
}

function fixtureSymbol(file: string, name: string): string {
  return `scip-typescript npm neutral 1.0.0 src/\`${file}\`/${name}().`;
}
