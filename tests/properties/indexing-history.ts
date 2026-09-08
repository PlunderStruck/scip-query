import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { it } from 'vitest';
import { compilerFacts, IndexerHistoryFixture, initialSources } from './indexer-history-fixture.js';
import { checkProperty, PROPERTY_TIMEOUT } from './support.js';

const editKinds = [
  'function',
  'constant',
  'delete',
  'restore',
  'rename',
  'rewire',
  'broken',
  'config',
  'noop',
  'revert',
  'restart',
] as const;
type EditKind = (typeof editKinds)[number];

function applyEdit(fixture: IndexerHistoryFixture, kind: Exclude<EditKind, 'restart'>, value: number): void {
  const owner = fixture.sources.has('renamed.ts') ? 'renamed.ts' : 'owner.ts';
  switch (kind) {
    case 'function':
    case 'restore':
      fixture.write(owner, `export function value(input: number) { return input + ${value}; }\n`);
      break;
    case 'constant':
      fixture.write(owner, `export const value = (input: number) => input + ${value};\n`);
      break;
    case 'delete':
      fixture.write(owner, null);
      break;
    case 'rename': {
      const target = owner === 'owner.ts' ? 'renamed.ts' : 'owner.ts';
      fixture.write(target, fixture.sources.get(owner) ?? initialSources['owner.ts']!);
      fixture.write(owner, null);
      fixture.write('bridge.ts', `export { value as shared } from './${target.replace('.ts', '.js')}';\n`);
      break;
    }
    case 'rewire':
      fixture.write(
        'consumer.ts',
        `import { value as shared } from './${owner.replace('.ts', '.js')}';\nexport const result = shared(${value});\n`,
      );
      break;
    case 'broken':
      fixture.write(owner, 'export function value( {\n');
      break;
    case 'config': {
      const path = join(fixture.root, 'tsconfig.json');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.compilerOptions.strict = !config.compilerOptions.strict;
      writeFileSync(path, JSON.stringify(config));
      break;
    }
    case 'noop':
      fixture.write('quiet.ts', fixture.sources.get('quiet.ts')!);
      break;
    case 'revert':
      for (const file of [...fixture.sources.keys()]) if (!(file in initialSources)) fixture.write(file, null);
      for (const [file, source] of Object.entries(initialSources)) fixture.write(file, source);
      break;
  }
}

async function checkpoint(fixture: IndexerHistoryFixture, kind: EditKind, value: number): Promise<void> {
  const previous = fixture.open();
  const accepted = compilerFacts(previous);
  try {
    if (kind === 'restart') await fixture.restartService();
    else applyEdit(fixture, kind, value);
    await fixture.index();
    assert.deepEqual(compilerFacts(previous), accepted, 'An open reader must retain its original compiler snapshot');
    try {
      fixture.assertCurrent();
    } catch (error) {
      throw new Error(
        `Checkpoint ${kind}(${value}); publication=${JSON.stringify(fixture.publication()?.publication)}\n${fixture.statuses.join('\n')}`,
        { cause: error },
      );
    }
  } finally {
    previous.close();
  }
}

async function withIndexedFixture(run: (fixture: IndexerHistoryFixture) => Promise<void>): Promise<void> {
  const fixture = new IndexerHistoryFixture();
  try {
    await fixture.index();
    fixture.assertCurrent();
    fixture.startService();
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

it(
  'indexing: generated histories traverse the real planner, daemon, publication and retained readers',
  async () => {
    await checkProperty(
      'indexing',
      'running-indexer-histories',
      fc.asyncProperty(
        fc.array(fc.record({ kind: fc.constantFrom(...editKinds), value: fc.integer({ min: -100, max: 100 }) }), {
          minLength: 3,
          maxLength: 12,
        }),
        async (history) =>
          withIndexedFixture(async (fixture) => {
            // Required dependency-identity change: this must use the actual affected
            // planner and daemon, and must not silently pass via a whole rebuild.
            applyEdit(fixture, 'constant', 1);
            await fixture.index({ allowExpensiveRebuild: false });
            assert.equal(fixture.publication()?.publication?.mode, 'incremental', fixture.statuses.join('\n'));
            fixture.assertCurrent();
            for (const edit of history) await checkpoint(fixture, edit.kind, edit.value);
          }),
      ),
      'system',
    );
  },
  PROPERTY_TIMEOUT,
);

it(
  'indexing: all named edit kinds have an exercised checkpoint including syntax repair and service restart',
  async () => {
    await withIndexedFixture(async (fixture) => {
      for (const kind of editKinds) await checkpoint(fixture, kind, 7);
      await checkpoint(fixture, 'restore', 9);
    });
  },
  PROPERTY_TIMEOUT,
);

it(
  'indexing: exhaustively enumerates short histories over function, constant and absent owners',
  async () => {
    const depth = process.env['SCIP_PROPERTY_PROFILE'] === 'thorough' ? 3 : 2;
    const alphabet = ['function', 'constant', 'delete'] as const;
    const histories: EditKind[][] = [];
    let level: EditKind[][] = [[]];
    for (let length = 1; length <= depth; length++) {
      level = level.flatMap((prefix) => alphabet.map((kind) => [...prefix, kind]));
      histories.push(...level);
    }
    let checkpoints = 0;
    for (const history of histories) {
      await withIndexedFixture(async (fixture) => {
        for (const kind of history) {
          await checkpoint(fixture, kind, 3);
          checkpoints++;
        }
      });
    }
    assert.equal(histories.length, depth === 3 ? 39 : 12);
    assert.equal(checkpoints, depth === 3 ? 102 : 21);
    console.log(
      `Indexer enumeration: ${histories.length} histories, ${checkpoints} edit checkpoints, alphabet=3, maximum length=${depth}`,
    );
  },
  PROPERTY_TIMEOUT,
);
