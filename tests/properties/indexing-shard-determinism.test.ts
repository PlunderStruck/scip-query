import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it, vi } from 'vitest';
import { compilerFacts, IndexerHistoryFixture } from './indexer-history-fixture.js';

it('indexing: emission shards retain the complete compiler project and its ambient declarations', async () => {
  vi.stubEnv('SCIP_QUERY_TS_COMPILER_SHARD_FILES', '2');
  const fixture = new IndexerHistoryFixture();
  fixture.write('a-globals.d.ts', 'interface SharedGlobal { value: number }\ndeclare const shared: SharedGlobal;\n');
  fixture.write('z-reader.ts', 'export const globalResult = shared.value;\n');
  try {
    await fixture.index();
    assert.match(fixture.statuses.join('\n'), /compiler shard/);
    fixture.assertCurrent();
  } finally {
    await fixture.dispose();
    vi.unstubAllEnvs();
  }
}, 120_000);

it('indexing: timing history, shard boundaries, and concurrency cannot change compiler facts', async () => {
  vi.stubEnv('SCIP_QUERY_TS_COMPILER_SHARD_FILES', '2');
  const fixture = new IndexerHistoryFixture();
  for (const path of [...fixture.sources.keys()]) {
    if (path !== 'quiet.ts') fixture.write(path, null);
  }
  for (const [owner, consumer] of [
    ['a', 'b'],
    ['c', 'd'],
    ['e', 'f'],
  ]) {
    const declaration = 'type Note = { summary: string }; export const note: Note = { summary: "one" };';
    const use = `import { note } from './${owner}-owner.js'; export function warm(input: number) { const local = input + 1; return local; } export const selected = note.summary;`;
    fixture.write(`${owner}-owner.ts`, declaration.padEnd(999) + '\n');
    fixture.write(`${consumer}-consumer.ts`, use.padEnd(999) + '\n');
  }
  try {
    await fixture.index();
    assert.match(fixture.statuses.join('\n'), /compiler shard/);
    fixture.assertCurrent();
    const before = fixture.open();
    const baseline = compilerFacts(before);
    before.close();
    writeFileSync(
      join(fixture.cache, 'typescript-shard-costs.json'),
      JSON.stringify({
        version: 1,
        samples: [
          { firstPath: 'a-owner.ts', lastPath: 'a-owner.ts', totalBytes: 1000, durationMs: 4000 },
          { firstPath: 'b-consumer.ts', lastPath: 'f-consumer.ts', totalBytes: 5000, durationMs: 5000 },
        ],
      }),
    );
    for (const [files, concurrency] of [
      ['2', '1'],
      ['1', '2'],
    ]) {
      vi.stubEnv('SCIP_QUERY_TS_COMPILER_SHARD_FILES', files);
      vi.stubEnv('SCIP_QUERY_TS_COMPILER_SHARD_CONCURRENCY', concurrency);
      await fixture.index({ skipIfUnchanged: false });
      assert.match(fixture.statuses.join('\n'), /compiler shard/);
      fixture.assertCurrent();
      const after = fixture.open();
      try {
        assert.deepEqual(compilerFacts(after), baseline, 'Emission scheduling must not change compiler facts');
      } finally {
        after.close();
      }
    }
  } finally {
    await fixture.dispose();
    vi.unstubAllEnvs();
  }
}, 120_000);
