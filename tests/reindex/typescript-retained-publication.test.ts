import { expect, test } from 'vitest';
import { IndexerHistoryFixture } from '../properties/indexer-history-fixture.js';
import { readRuntimeBoundaryGraph } from '../../src/analysis/runtime-boundaries/index.js';

test('publishes retained documents while advancing source freshness and runtime facts', async () => {
  const fixture = new IndexerHistoryFixture();
  const source = (path: string, amount: number) =>
    `export function value(input: number) { void fetch("${path}"); return input + ${amount}; }\n`;
  const requests = () => {
    const db = fixture.open();
    try {
      return readRuntimeBoundaryGraph(db)
        ?.observations.filter((observation) => observation.action === 'http.request')
        .map((observation) => observation.keyParts.find((part) => part.name === 'path')?.value);
    } finally {
      db.close();
    }
  };
  try {
    fixture.write('owner.ts', source('/one', 1));
    await fixture.index({ skipIfUnchanged: false, allowExpensiveRebuild: true });
    fixture.startService();
    fixture.write('owner.ts', source('/one', 2));
    await fixture.index({ allowExpensiveRebuild: false });
    fixture.assertCurrent();
    const before = fixture.publication();
    fixture.write('owner.ts', source('/two', 2));
    await fixture.index({ allowExpensiveRebuild: false });
    expect(fixture.statuses.join('\n')).toContain('SQLite conversion is unnecessary');
    expect(fixture.statuses.join('\n')).not.toContain('Converting bounded TypeScript');
    expect(fixture.publication()).not.toEqual(before);
    expect(requests()).toEqual(['/two']);
    fixture.assertCurrent();
    const unchanged = await fixture.index({ allowExpensiveRebuild: false });
    expect(unchanged.reused).toBe(true);
    fixture.write('owner.ts', 'export function value(input: number): string { return "changed"; }\n');
    await fixture.index({ allowExpensiveRebuild: false });
    expect(fixture.statuses.join('\n')).toContain('Converting bounded TypeScript');
    expect(requests()).toEqual([]);
    fixture.assertCurrent();
  } finally {
    await fixture.dispose();
  }
}, 60_000);
