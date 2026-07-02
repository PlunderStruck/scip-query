import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dedupeTracePaths,
  loadTlaModelContract,
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
});
