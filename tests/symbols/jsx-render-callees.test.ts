import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SymbolInformation_Kind } from '@c4312/scip';
import { ScipDatabase } from '../../src/storage/db.js';
import { buildCalleeMap } from '../../src/symbols/graph/call-graph-evidence.js';
import { crossFileCallerEvidenceMap } from '../../src/symbols/references/caller-evidence.js';
import { findFirstSymbolMatch } from '../../src/symbols/symbol-lookup.js';
import { complexityHotspots } from '../../src/queries/quality/complexity-hotspots.js';
import { callGraph } from '../../src/queries/navigation/call-graph.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('JSX render edges in the call graph', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves rendered child components as execution edges in both directions', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-jsx-render-'));
    tempDirs.push(root);
    writeFixtureFiles(root, {
      'src/Child.tsx': ['export function Child({ total }: { total: number }) {', '  return <span>{total}</span>;', '}'],
      'src/Parent.tsx': [
        "import { Child } from './Child';",
        'export function Parent() {',
        '  return (',
        '    <section>',
        '      <Child total={1} />',
        '      <Local />',
        '    </section>',
        '  );',
        '}',
        'function Local() {',
        '  return <em>local</em>;',
        '}',
      ],
    });
    const dbPath = join(root, 'index.db');
    const sym = (file: string, leaf: string) => `scip-typescript npm test 1.0.0 src/\`${file}\`/${leaf}().`;
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/Child.tsx')
      .document(2, 'typescript', 'src/Parent.tsx')
      .symbol(1, sym('Child.tsx', 'Child'), 'Child', SymbolInformation_Kind.Function)
      .symbol(2, sym('Parent.tsx', 'Parent'), 'Parent', SymbolInformation_Kind.Function)
      .symbol(3, sym('Parent.tsx', 'Local'), 'Local', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 1, 0, 8, 1)
      .definition(3, 2, 3, 9, 0, 11, 1)
      .chunk(1, 1, 0, 3)
      .chunk(2, 2, 0, 12)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(2, 3, 1)
      .mention(2, 1, 0)
      .write();

    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const parent = findFirstSymbolMatch(db, 'Parent');
      const child = findFirstSymbolMatch(db, 'Child');
      expect(parent).not.toBeNull();
      expect(child).not.toBeNull();

      const callees = buildCalleeMap(db, [parent!], { semantic: false }).get(parent!.symbolId) ?? [];
      expect(callees).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            symbol: child!.symbol,
            kind: 'jsx-render',
            source: 'ast-callsite',
            callsiteLine: 4,
          }),
          expect.objectContaining({ symbol: sym('Parent.tsx', 'Local'), kind: 'jsx-render', callsiteLine: 5 }),
        ]),
      );

      const callers = crossFileCallerEvidenceMap(db, [child!], { semantic: false });
      expect([...(callers.get(child!.symbolId) ?? [])]).toEqual(['src/Parent.tsx']);

      const hotspot = complexityHotspots(db, { minLoc: 1, limit: 5, semantic: false }).find((entry) =>
        entry.shortName.includes('Parent'),
      );
      expect(hotspot?.fanOut).toBe(1);
      expect(hotspot?.calleeCount).toBe(2);

      const graph = callGraph(db, 'Parent', { semantic: false });
      expect(graph?.callees.map((row) => row.shortName)).toEqual(
        expect.arrayContaining([expect.stringContaining('Child'), expect.stringContaining('Local')]),
      );
      expect(graph?.calleeEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shortName: expect.stringContaining('Child'),
            relationship: 'resolved-call',
            evidenceStrength: 'exact',
            interaction: 'render',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });
});
