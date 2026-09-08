import assert from 'node:assert/strict';
import { it } from 'vitest';
import { compilerFacts, IndexerHistoryFixture } from './indexer-history-fixture.js';

it('indexing: anonymous property identities survive a cold/warm export round trip', async () => {
  const fixture = new IndexerHistoryFixture();
  const notes = [
    'type Note = { summary: string; details?: string };',
    'export const notes: { [key: string]: Note } = {',
    "  first: { summary: 'first', details: 'detail' },",
    "  second: { summary: 'second' },",
    '};',
    '',
  ].join('\n');
  fixture.write('z-notes.ts', notes);
  fixture.write(
    'a-consumer.ts',
    [
      "import { notes } from './z-notes.js';",
      "const defaults = { summary: 'none', details: 'none' };",
      'export function readNote(key: string) {',
      '  const note = notes[key] ?? defaults;',
      '  return { summary: note.summary, details: note.details };',
      '}',
      '',
    ].join('\n'),
  );
  try {
    await fixture.index();
    fixture.assertCurrent();
    const before = fixture.open();
    const baseline = compilerFacts(before);
    const symbolCatalog = before.db
      .prepare(
        'SELECT symbol, display_name, kind, documentation, signature, enclosing_symbol, relationships FROM global_symbols ORDER BY symbol',
      )
      .all();
    before.close();
    fixture.startService();
    fixture.write('z-notes.ts', notes + 'export const probe = 713219;\n');
    await fixture.index({ allowExpensiveRebuild: false });
    assert.equal(fixture.publication()?.publication?.mode, 'incremental', fixture.statuses.join('\n'));
    fixture.assertCurrent();
    fixture.write('z-notes.ts', '// Move declarations: 🐈\n' + notes);
    await fixture.index({ allowExpensiveRebuild: false });
    assert.equal(fixture.publication()?.publication?.mode, 'incremental');
    fixture.assertCurrent();
    fixture.write('z-notes.ts', notes);
    await fixture.index({ allowExpensiveRebuild: false });
    fixture.assertCurrent();
    const after = fixture.open();
    try {
      assert.deepEqual(compilerFacts(after), baseline, 'Restored source must preserve the original compiler facts');
      assert.deepEqual(
        after.db
          .prepare(
            'SELECT symbol, display_name, kind, documentation, signature, enclosing_symbol, relationships FROM global_symbols ORDER BY symbol',
          )
          .all(),
        symbolCatalog,
        'Restored source must not accumulate symbol records or change metadata',
      );
    } finally {
      after.close();
    }
  } finally {
    await fixture.dispose();
  }
}, 120_000);
