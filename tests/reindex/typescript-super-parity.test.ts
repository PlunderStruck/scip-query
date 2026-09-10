import { expect, it } from 'vitest';
import { IndexerHistoryFixture } from '../properties/indexer-history-fixture.js';
import { scipOccurrenceCallTargetsForRange } from '../../src/symbols/graph/scip-occurrence-call-targets.js';

it('preserves compiler super targets through incremental edits and a clean rebuild', async () => {
  const fixture = new IndexerHistoryFixture();
  const targets = () => {
    const db = fixture.open();
    try {
      return scipOccurrenceCallTargetsForRange(db, 'child.ts', 0, 100).targets.map((target) => ({
        symbol: target.definition.symbol,
        range: target.sourceRange,
      }));
    } finally {
      db.close();
    }
  };
  try {
    fixture.write('base.ts', 'export class Base { constructor(value: number) {} }\n');
    fixture.write(
      'child.ts',
      'import { Base } from "./base.js";\nexport class Child extends Base { constructor() { super(1); } }\n',
    );
    await fixture.index({ skipIfUnchanged: false, allowExpensiveRebuild: true });
    fixture.startService();
    expect(targets().some((target) => target.symbol.includes('Base#') && target.symbol.includes('constructor'))).toBe(
      true,
    );
    for (const source of [
      'import { Base } from "./base.js"; const Alias = Base;\nexport class Child extends Alias { constructor() { super(4); } }\n',
      'import { Base as Renamed } from "./base.js";\nexport class Child extends Renamed { constructor() { super(2); } }\n',
      'import { Base } from "./base.js";\nclass Middle extends Base {}\nexport class Child extends Middle { constructor() { super(3); } }\n',
    ]) {
      fixture.write('child.ts', source);
      await fixture.index({ allowExpensiveRebuild: true });
      expect(
        fixture.statuses.some((status) => status.startsWith('Incremental TypeScript index emitted')),
        fixture.statuses.join('\n'),
      ).toBe(true);
      const incremental = targets();
      expect(
        incremental.some((target) => target.symbol.includes('Base#') && target.symbol.includes('constructor')),
      ).toBe(true);
      await fixture.index({ skipIfUnchanged: false, allowExpensiveRebuild: true });
      expect(targets()).toEqual(incremental);
    }
  } finally {
    await fixture.dispose();
  }
}, 60_000);
