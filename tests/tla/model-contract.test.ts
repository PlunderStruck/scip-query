import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dedupeTracePaths,
  discoverMapPathByModule,
  loadTlaModelContract,
  readTlaConfigInvariants,
  readTlaModuleFacts,
  resolveContractPath,
} from '../../src/tla/model-contract.js';

describe('TLA model contract', () => {
  it('loads a strict mapping contract and TLA module facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Init == queue = <<>>
Enqueue(job) == queue' = Append(queue, job)
====
`,
    );
    writeFileSync(
      join(root, 'Queue.scip-tla.json'),
      JSON.stringify(
        {
          module: 'Queue.tla',
          variables: {
            queue: { code: ['src/queue.ts/queue'], aliases: ['jobs'] },
          },
          actions: {
            Enqueue: {
              code: ['src/queue.ts/enqueue'],
              reads: ['queue'],
              writes: ['queue'],
              waive: { reads: ['queue'], reason: 'read through queue helper in fixture' },
            },
          },
        },
        null,
        2,
      ),
    );

    const loaded = loadTlaModelContract(root, 'Queue.scip-tla.json');
    const facts = readTlaModuleFacts(root, 'Queue.tla');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.variables.queue?.aliases).toEqual(['queue', 'jobs']);
    expect(loaded.loaded?.contract.actions.Enqueue?.waive).toEqual({
      reads: ['queue'],
      writes: [],
      reason: 'read through queue helper in fixture',
    });
    expect(facts?.modelParse).toBe('regex-fallback');
    expect(facts?.variables).toEqual(['queue']);
    expect(facts?.operators).toEqual(['Enqueue', 'Init']);
  });

  it('parses legacy allowUnknown as per-fact waivers', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Legacy.scip-tla.json'),
      JSON.stringify({
        variables: { queue: { code: ['queue'] } },
        actions: { Enqueue: { code: ['enqueue'], reads: ['queue'], writes: ['queue'], allowUnknown: true } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Legacy.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.actions.Enqueue?.waive).toEqual({
      reads: ['queue'],
      writes: ['queue'],
      reason: 'legacy allowUnknown',
      legacy: true,
    });
  });

  it('rejects variables without concrete code referents', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: { queue: { aliases: ['queue'] } },
        actions: { Enqueue: { code: ['enqueue'], writes: ['queue'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain('variables.queue.code must name at least one TypeScript referent');
  });

  it('parses a resource binding on a variable', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Lock.scip-tla.json'),
      JSON.stringify({
        variables: {
          lockOwner: { code: ['src/lock.ts/pid'], resource: { path: 'lockPath' } },
        },
        actions: { Release: { code: ['src/lock.ts/release'], writes: ['lockOwner'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Lock.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.variables.lockOwner?.resource).toEqual({ path: 'lockPath' });
  });

  it('rejects a resource binding with no path', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: { lockOwner: { code: ['src/lock.ts/pid'], resource: { path: '' } } },
        actions: { Release: { code: ['src/lock.ts/release'], writes: ['lockOwner'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain('variables.lockOwner.resource.path must be a non-empty string');
  });

  it('parses a variable-referent waiver', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Lock.scip-tla.json'),
      JSON.stringify({
        variables: {
          stage: {
            code: ['src/lock.ts/__no_stored_field__'],
            waive: { reason: 'stage has no stored field in code at all' },
          },
        },
        actions: { Release: { code: ['src/lock.ts/release'], writes: ['stage'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Lock.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.variables.stage?.waive).toEqual({
      reason: 'stage has no stored field in code at all',
    });
  });

  it('rejects a variable waiver with no reason', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: { stage: { code: ['src/lock.ts/pid'], waive: {} } },
        actions: { Release: { code: ['src/lock.ts/release'], writes: ['stage'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain('variables.stage.waive.reason must be a non-empty string');
  });

  it('parses selfAlias: false with an explicit alias, excluding the variable name (I3 / followup #25)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Status.scip-tla.json'),
      JSON.stringify({
        variables: {
          status: { code: ['src/status.ts/lifecycleStage'], aliases: ['lifecycleStage'], selfAlias: false },
        },
        actions: { Transition: { code: ['src/status.ts/transition'], writes: ['status'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Status.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.variables.status?.aliases).toEqual(['lifecycleStage']);
    expect(loaded.loaded?.contract.variables.status?.selfAlias).toBe(false);
  });

  it('defaults selfAlias to true, keeping the variable name in aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Status.scip-tla.json'),
      JSON.stringify({
        variables: {
          status: { code: ['src/status.ts/lifecycleStage'], aliases: ['lifecycleStage'] },
        },
        actions: { Transition: { code: ['src/status.ts/transition'], writes: ['status'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Status.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.variables.status?.aliases).toEqual(['status', 'lifecycleStage']);
    expect(loaded.loaded?.contract.variables.status?.selfAlias).toBeUndefined();
  });

  it('rejects selfAlias: false with no other attribution tier (no alias, resource, statements, ormCalls, or waive)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: {
          status: { code: ['src/status.ts/lifecycleStage'], selfAlias: false },
        },
        actions: { Transition: { code: ['src/status.ts/transition'], writes: ['status'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain(
      'variables.status.selfAlias is false but no aliases, resource, statements, ormCalls, or waive are set — status would be unattributable; add an explicit alias, bind resource/statements/ormCalls, or add variables.status.waive with a reason',
    );
  });

  it('accepts selfAlias: false with no alias when a resource binding provides attribution', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Lock.scip-tla.json'),
      JSON.stringify({
        variables: {
          lockOwner: { code: ['src/lock.ts/pid'], selfAlias: false, resource: { path: 'lockPath' } },
        },
        actions: { Release: { code: ['src/lock.ts/release'], writes: ['lockOwner'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Lock.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.variables.lockOwner?.aliases).toEqual([]);
  });

  it('rejects a non-boolean selfAlias', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: {
          status: { code: ['src/status.ts/lifecycleStage'], aliases: ['lifecycleStage'], selfAlias: 'no' },
        },
        actions: { Transition: { code: ['src/status.ts/transition'], writes: ['status'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain('variables.status.selfAlias must be a boolean when present');
  });

  it('rejects two variables sharing an alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: {
          findingsCount: { code: ['src/gate.ts/count'], aliases: ['findings'] },
          findingsList: { code: ['src/gate.ts/list'], aliases: ['findings'] },
        },
        actions: { Run: { code: ['src/gate.ts/run'], writes: ['findingsCount'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain(
      'variables findingsCount, findingsList share alias "findings" — conformance scanning cannot attribute a matching write/read to one variable unambiguously',
    );
  });

  it('rejects two variables sharing a resource path suffix', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: {
          lockOwner: { code: ['src/lock.ts/pid'], resource: { path: 'lockPath' } },
          published: { code: ['src/lock.ts/updatedAt'], resource: { path: 'lockPath' } },
        },
        actions: { Run: { code: ['src/lock.ts/run'], writes: ['lockOwner'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain(
      'variables lockOwner, published share resource path "lockPath" — conformance scanning cannot attribute a matching write/read to one variable unambiguously',
    );
  });

  it('parses a statement binding on a variable', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Ledger.scip-tla.json'),
      JSON.stringify({
        variables: {
          ledger: { code: ['src/db.ts/CONNECTIONS'], statements: [{ pattern: 'finding_outcome_ledger' }] },
        },
        actions: { Write: { code: ['src/db.ts/write'], writes: ['ledger'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Ledger.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.variables.ledger?.statements).toEqual([{ pattern: 'finding_outcome_ledger' }]);
  });

  it('rejects a statement binding with no pattern', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: { ledger: { code: ['src/db.ts/CONNECTIONS'], statements: [{ pattern: '' }] } },
        actions: { Write: { code: ['src/db.ts/write'], writes: ['ledger'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain('variables.ledger.statements[0].pattern must be a non-empty string');
  });

  it('rejects a statement binding with an invalid regular expression pattern', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: { ledger: { code: ['src/db.ts/CONNECTIONS'], statements: [{ pattern: '[unterminated' }] } },
        actions: { Write: { code: ['src/db.ts/write'], writes: ['ledger'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors[0]).toContain('variables.ledger.statements[0].pattern is not a valid regular expression');
  });

  it('rejects two variables sharing a statement pattern', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: {
          ledger: { code: ['src/db.ts/CONNECTIONS'], statements: [{ pattern: 'finding_outcome_ledger' }] },
          other: { code: ['src/db.ts/OTHER'], statements: [{ pattern: 'finding_outcome_ledger' }] },
        },
        actions: { Write: { code: ['src/db.ts/write'], writes: ['ledger'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain(
      'variables ledger, other share statement pattern "finding_outcome_ledger" — conformance scanning cannot attribute a matching write/read to one variable unambiguously',
    );
  });

  it('parses an ORM-call binding on a variable (C1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Billing.scip-tla.json'),
      JSON.stringify({
        variables: {
          subscription: { code: ['src/db.ts/orgSubscriptions'], ormCalls: [{ table: 'orgSubscriptions' }] },
        },
        actions: { Update: { code: ['src/db.ts/update'], writes: ['subscription'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Billing.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.variables.subscription?.ormCalls).toEqual([{ table: 'orgSubscriptions' }]);
  });

  it('rejects an ORM-call binding with no table', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: { subscription: { code: ['src/db.ts/orgSubscriptions'], ormCalls: [{ table: '' }] } },
        actions: { Update: { code: ['src/db.ts/update'], writes: ['subscription'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain('variables.subscription.ormCalls[0].table must be a non-empty string');
  });

  it('rejects an ORM-call binding whose methods override names an unrecognized method', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: {
          subscription: {
            code: ['src/db.ts/orgSubscriptions'],
            ormCalls: [{ table: 'orgSubscriptions', methods: ['upsert'] }],
          },
        },
        actions: { Update: { code: ['src/db.ts/update'], writes: ['subscription'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors[0]).toContain('variables.subscription.ormCalls[0].methods contains unrecognized name(s)');
  });

  it('rejects two variables sharing a table and overlapping method class via ormCalls', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: {
          subscription: { code: ['src/db.ts/orgSubscriptions'], ormCalls: [{ table: 'orgSubscriptions' }] },
          otherSub: { code: ['src/db.ts/OTHER'], ormCalls: [{ table: 'orgSubscriptions' }] },
        },
        actions: { Update: { code: ['src/db.ts/update'], writes: ['subscription'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors.some((error) => error.includes('share ORM table/method'))).toBe(true);
  });

  it('does not collide when two variables bind the same table with disjoint method classes via ormCalls', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Ok.scip-tla.json'),
      JSON.stringify({
        variables: {
          subscriptionWrites: {
            code: ['src/db.ts/orgSubscriptions'],
            ormCalls: [{ table: 'orgSubscriptions', methods: ['update', 'insert', 'delete'] }],
          },
          subscriptionReads: {
            code: ['src/db.ts/orgSubscriptionsView'],
            ormCalls: [{ table: 'orgSubscriptions', methods: ['select'] }],
          },
        },
        actions: { Update: { code: ['src/db.ts/update'], writes: ['subscriptionWrites'] } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Ok.scip-tla.json');

    expect(loaded.errors).toEqual([]);
  });

  it('parses a top-level init mapping', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Pool.scip-tla.json'),
      JSON.stringify({
        variables: { connection: { code: ['src/pool.ts/connectionFor'] } },
        actions: { Query: { code: ['src/pool.ts/query'], reads: ['connection'], writes: [] } },
        init: { codeRefs: ['src/pool.ts/connectionFor'] },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Pool.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.init).toEqual({ codeRefs: ['src/pool.ts/connectionFor'] });
  });

  it('rejects init with no codeRefs', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: { connection: { code: ['src/pool.ts/connectionFor'] } },
        actions: { Query: { code: ['src/pool.ts/query'], reads: ['connection'], writes: [] } },
        init: { codeRefs: [] },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain('init.codeRefs must name at least one TypeScript referent');
  });

  it('rejects an init codeRef that also appears as an action code referent', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: { connection: { code: ['src/pool.ts/connectionFor'] } },
        actions: { Query: { code: ['src/pool.ts/connectionFor'], reads: ['connection'], writes: [] } },
        init: { codeRefs: ['src/pool.ts/connectionFor'] },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain(
      'init.codeRefs overlaps action code referents: src/pool.ts/connectionFor — a referent cannot be both Init and an action',
    );
  });

  it('parses an init waiver', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Pool.scip-tla.json'),
      JSON.stringify({
        variables: { connection: { code: ['src/pool.ts/connectionFor'] } },
        actions: { Query: { code: ['src/pool.ts/query'], reads: ['connection'], writes: [] } },
        init: { codeRefs: ['src/pool.ts/connectionFor'], waive: { reason: 'factory referent kind is approximate' } },
      }),
    );

    const loaded = loadTlaModelContract(root, 'Pool.scip-tla.json');

    expect(loaded.errors).toEqual([]);
    expect(loaded.loaded?.contract.init?.waive).toEqual({ reason: 'factory referent kind is approximate' });
  });

  it('defaults unmappedWriteScope to "scope-files" and accepts an explicit "actions" (P5.7 / followup #19)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Default.scip-tla.json'),
      JSON.stringify({
        variables: { queue: { code: ['src/queue.ts/queue'] } },
        actions: { Enqueue: { code: ['src/queue.ts/enqueue'], writes: ['queue'] } },
      }),
    );
    writeFileSync(
      join(root, 'Actions.scip-tla.json'),
      JSON.stringify({
        variables: { queue: { code: ['src/queue.ts/queue'] } },
        actions: { Enqueue: { code: ['src/queue.ts/enqueue'], writes: ['queue'] } },
        unmappedWriteScope: 'actions',
      }),
    );

    expect(loadTlaModelContract(root, 'Default.scip-tla.json').loaded?.contract.unmappedWriteScope).toBe('scope-files');
    expect(loadTlaModelContract(root, 'Actions.scip-tla.json').loaded?.contract.unmappedWriteScope).toBe('actions');
  });

  it('rejects an invalid unmappedWriteScope value', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(
      join(root, 'Broken.scip-tla.json'),
      JSON.stringify({
        variables: { queue: { code: ['src/queue.ts/queue'] } },
        actions: { Enqueue: { code: ['src/queue.ts/enqueue'], writes: ['queue'] } },
        unmappedWriteScope: 'everything',
      }),
    );

    const loaded = loadTlaModelContract(root, 'Broken.scip-tla.json');

    expect(loaded.loaded).toBeUndefined();
    expect(loaded.errors).toContain('unmappedWriteScope must be "actions" or "scope-files" when present');
  });

  it('dedupes trace paths naming the same file (P5.5 / followup #20)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    writeFileSync(join(root, 'run1.trace.json'), '[]');

    expect(dedupeTracePaths(root, ['run1.trace.json', 'run1.trace.json'])).toEqual(['run1.trace.json']);
    expect(dedupeTracePaths(root, ['run1.trace.json', join(root, 'run1.trace.json')])).toEqual(['run1.trace.json']);
    expect(dedupeTracePaths(root, ['run1.trace.json', 'run2.trace.json'])).toEqual([
      'run1.trace.json',
      'run2.trace.json',
    ]);
  });

  it('resolves contract-adjacent and project-relative config paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-contract-'));
    const specDir = join(root, 'specs');
    mkdirSync(specDir);
    writeFileSync(join(specDir, 'Spec.cfg'), 'SPECIFICATION Spec\n');
    writeFileSync(join(root, 'Root.cfg'), 'SPECIFICATION Spec\n');

    expect(resolveContractPath(root, specDir, 'Spec.cfg')).toBe(join(specDir, 'Spec.cfg'));
    expect(resolveContractPath(root, specDir, 'Root.cfg')).toBe(join(root, 'Root.cfg'));
    expect(resolveContractPath(root, specDir, 'specs/Spec.cfg')).toBe(join(specDir, 'Spec.cfg'));
  });

  it('reads invariants from the single-line INVARIANT form', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-cfg-'));
    const cfg = join(root, 'Spec.cfg');
    writeFileSync(cfg, 'INIT Init\nNEXT Next\nINVARIANT TypeInvariant\nINVARIANT Safety\n');

    expect(readTlaConfigInvariants(cfg)).toEqual(['Safety', 'TypeInvariant']);
  });

  it('reads invariants from the standard TLC INVARIANTS block form', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-cfg-'));
    const cfg = join(root, 'Spec.cfg');
    writeFileSync(
      cfg,
      `SPECIFICATION Spec
CONSTANTS
  MaxTurns = 3
INVARIANTS
  TypeInvariant
  Safety, NoOrphanedRuns
PROPERTY Liveness
`,
    );

    expect(readTlaConfigInvariants(cfg)).toEqual(['NoOrphanedRuns', 'Safety', 'TypeInvariant']);
  });

  it('ignores commented-out invariants and non-invariant sections', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-cfg-'));
    const cfg = join(root, 'Spec.cfg');
    writeFileSync(
      cfg,
      `INIT Init
NEXT Next
INVARIANTS
  TypeInvariant \\* trailing comment DisabledOne
  \\* DisabledTwo
(* block comment
  DisabledThree
*)
  Safety
CONSTRAINT StateBound
`,
    );

    expect(readTlaConfigInvariants(cfg)).toEqual(['Safety', 'TypeInvariant']);
    expect(readTlaConfigInvariants(join(root, 'missing.cfg'))).toEqual([]);
    expect(readTlaConfigInvariants(null)).toEqual([]);
  });

  it('auto-discovers a sibling mapping by bare module name (I5 / auto-discovery)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-discover-'));
    writeFileSync(join(root, 'Foo.tla'), `---- MODULE Foo ----\nVARIABLES x\n====\n`);
    // No Foo.scip-tla.json — only a variant-named mapping exists.
    writeFileSync(
      join(root, 'FooHardened.scip-tla.json'),
      JSON.stringify({ module: 'Foo', variables: {}, actions: {} }),
    );

    const result = discoverMapPathByModule(root, join(root, 'Foo.tla'));

    expect(result).toEqual({ status: 'found', mapPath: join(root, 'FooHardened.scip-tla.json'), moduleName: 'Foo' });
  });

  it('auto-discovers a sibling mapping by project-relative spec path (real Vega/repo convention)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-discover-'));
    const specDir = join(root, 'docs', 'formal');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'Foo.tla'), `---- MODULE Foo ----\nVARIABLES x\n====\n`);
    writeFileSync(
      join(specDir, 'FooHardened.scip-tla.json'),
      JSON.stringify({ module: 'docs/formal/Foo.tla', variables: {}, actions: {} }),
    );

    const result = discoverMapPathByModule(root, join(specDir, 'Foo.tla'));

    expect(result).toEqual({
      status: 'found',
      mapPath: join(specDir, 'FooHardened.scip-tla.json'),
      moduleName: 'Foo',
    });
  });

  it('reports ambiguous when two sibling mappings name the same module', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-discover-'));
    writeFileSync(join(root, 'Foo.tla'), `---- MODULE Foo ----\nVARIABLES x\n====\n`);
    writeFileSync(
      join(root, 'FooHardened.scip-tla.json'),
      JSON.stringify({ module: 'Foo', variables: {}, actions: {} }),
    );
    writeFileSync(join(root, 'FooLegacy.scip-tla.json'), JSON.stringify({ module: 'Foo', variables: {}, actions: {} }));

    const result = discoverMapPathByModule(root, join(root, 'Foo.tla'));

    expect(result).toEqual({
      status: 'ambiguous',
      candidates: [join(root, 'FooHardened.scip-tla.json'), join(root, 'FooLegacy.scip-tla.json')],
      moduleName: 'Foo',
    });
  });

  it('returns none when no sibling mapping declares the module', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-discover-'));
    writeFileSync(join(root, 'Foo.tla'), `---- MODULE Foo ----\nVARIABLES x\n====\n`);
    writeFileSync(join(root, 'Bar.scip-tla.json'), JSON.stringify({ module: 'Bar', variables: {}, actions: {} }));

    const result = discoverMapPathByModule(root, join(root, 'Foo.tla'));

    expect(result).toEqual({ status: 'none' });
  });
});
