import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTlaModelContract, readTlaModuleFacts, resolveContractPath } from '../../src/tla/model-contract.js';

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
