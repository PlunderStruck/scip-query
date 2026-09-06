import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SymbolInformation_Kind as Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { byKind, kindCounts } from '../../../src/queries/navigation/by-kind.js';
import { fanIn, topFanIn, externalSymbolFanOut, topFanOut } from '../../../src/queries/graph/fan.js';
import { coupling, topCoupling } from '../../../src/queries/graph/coupling.js';
import { hotspots } from '../../../src/queries/graph/hotspots.js';
import { deps, rdeps } from '../../../src/queries/navigation/deps.js';
import { stats } from '../../../src/queries/navigation/stats.js';
import { system } from '../../../src/queries/navigation/system.js';
import { consumerSurface } from '../../../src/queries/navigation/surface.js';
import { complexity } from '../../../src/queries/quality/complexity.js';
import { changeSurface } from '../../../src/queries/impact/change-surface.js';

const symbol = (file: string, name: string) => `scip-typescript npm fixture 1.0.0 src/\`${file}\`/${name}().`;
function fixture(run: (db: ScipDatabase) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'scip-metric-contract-'));
  try {
    writeFixtureFiles(root, {
      'src/a.ts': 'export function first() {}\nexport function second() {}\n',
      'src/b.ts': 'export function use() { first(); first(); second(); }\n',
      'src/c.ts': 'export function use() { first(); }\n',
      'src/zero.ts': 'export function zero() {}\n',
    });
    const builder = evidenceFixtureDb(join(root, 'index.db'));
    for (const [id, file] of [
      [1, 'a.ts'],
      [2, 'b.ts'],
      [3, 'c.ts'],
      [4, 'zero.ts'],
    ] as const)
      builder.document(id, 'typescript', `src/${file}`).chunk(id, id, 0, id === 1 ? 1 : 0);
    for (const [id, doc, file, name, line] of [
      [1, 1, 'a.ts', 'first', 0],
      [2, 1, 'a.ts', 'second', 1],
      [3, 2, 'b.ts', 'use', 0],
      [4, 3, 'c.ts', 'use', 0],
      [5, 4, 'zero.ts', 'zero', 0],
    ] as const) {
      builder.symbol(id, symbol(file, name), name, Kind.Function).mention(doc, id, 1);
      // An indexer may emit only a definition mention, with no enclosing range.
      if (id !== 5) builder.definition(id, doc, id, line, 0, line, 50);
    }
    builder
      .mention(2, 1, 0)
      .mention(2, 2, 0)
      .mention(3, 1, 0)
      .occurrence(2, symbol('a.ts', 'first'), 0, 0, 24, 29)
      .occurrence(2, symbol('a.ts', 'first'), 0, 0, 33, 38)
      .occurrence(2, symbol('a.ts', 'second'), 0, 0, 42, 48)
      .occurrence(3, symbol('a.ts', 'first'), 0, 0, 24, 29)
      .write();
    const db = new ScipDatabase({
      projectRoot: root,
      dbPath: join(root, 'index.db'),
      indexPath: join(root, 'index.scip'),
    });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('command metric contracts', () => {
  it('counts reference files and externally defined symbols, not invocation frequency', () =>
    fixture((db) => {
      expect(fanIn(db, symbol('a.ts', 'first'))[0]?.count).toBe(2);
      expect(fanIn(db, symbol('a.ts', 'second'))[0]?.count).toBe(1);
      expect(fanIn(db, symbol('zero.ts', 'zero'))[0]?.count).toBe(0);
      expect(topFanIn(db).find((row) => row.symbol === symbol('a.ts', 'second'))?.count).toBe(1);
      expect(externalSymbolFanOut(db, 'src/b.ts')[0]?.count).toBe(2);
      expect(externalSymbolFanOut(db, 'src/c.ts')[0]?.count).toBe(1);
      expect(topFanOut(db).find((row) => row.name === 'src/b.ts')?.count).toBe(2);
      expect(fanIn(db, 'never_exists')).toEqual([]);
      expect(externalSymbolFanOut(db, 'src/missing.ts')).toEqual([]);
    }));
  it('rejects an ambiguous fan-in root instead of silently selecting a same-name symbol', () =>
    fixture((db) => {
      expect(() => fanIn(db, 'use')).toThrow(/ambiguous/i);
    }));
  it('counts the union of shared symbols symmetrically and refuses unresolved pairs', () =>
    fixture((db) => {
      expect(coupling(db, 'src/a.ts', 'src/b.ts').sharedSymbols).toBe(2);
      expect(coupling(db, 'src/b.ts', 'src/a.ts').sharedSymbols).toBe(2);
      expect(coupling(db, 'src/a.ts', 'src/c.ts').sharedSymbols).toBe(1);
      expect(coupling(db, 'src/b.ts', 'src/c.ts').sharedSymbols).toBe(0);
      expect(topCoupling(db).find((row) => row.file1 === 'src/a.ts' && row.file2 === 'src/b.ts')?.sharedSymbols).toBe(
        2,
      );
      expect(() => coupling(db, 'src/a.ts', 'src/missing.ts')).toThrow(/resolve|indexed/i);
      expect(() => coupling(db, 'src/a.ts', 'src/a.ts')).toThrow(/different|distinct/i);
    }));
  it('reports the stored chunk counting unit rather than claiming raw occurrences', () =>
    fixture((db) => {
      const first = hotspots(db).find((row) => row.symbol === symbol('a.ts', 'first'));
      expect(first).toMatchObject({ refCount: 2, fileCount: 2, countUnit: 'referencing-chunks' });
      expect(hotspots(db).find((row) => row.symbol === symbol('a.ts', 'second'))).toMatchObject({
        refCount: 1,
        fileCount: 1,
      });
      expect(hotspots(db)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ symbol: symbol('zero.ts', 'zero') })]),
      );
    }));
  it('uses the same definition set for enumeration and counts, and rejects malformed kinds', () =>
    fixture((db) => {
      expect(byKind(db, 'function')).toHaveLength(5);
      expect(kindCounts(db)).toEqual([{ kind: Kind.Function, kindName: 'Function', count: 5 }]);
      expect(byKind(db, 'function', { scope: 'src/a.ts' })).toHaveLength(2);
      expect(kindCounts(db, { scope: 'src/a.ts' })[0]?.count).toBe(2);
      expect(() => byKind(db, `${Kind.Function}garbage`)).toThrow(/kind/i);
      expect(() => byKind(db, '')).toThrow(/kind/i);
      expect(byKind(db, 'class')).toEqual([]);
    }));
  it('reports direct file relationships in each direction and stored index row totals', () =>
    fixture((db) => {
      expect(deps(db, 'src/b.ts').map((row) => row.relativePath)).toEqual(['src/a.ts']);
      expect(
        rdeps(db, 'src/a.ts')
          .map((row) => row.relativePath)
          .sort(),
      ).toEqual(['src/b.ts', 'src/c.ts']);
      expect(deps(db, 'src/a.ts')).toEqual([]);
      expect(rdeps(db, 'src/zero.ts')).toEqual([]);
      expect(deps(db, 'src/missing.ts')).toEqual([]);
      expect(stats(db)).toMatchObject({ documents: 4, symbols: 5, definitions: 5, references: 3 });
    }));
});

describe('module and complexity command contracts', () => {
  it('keeps each symbol owner file and reports observed external references', () =>
    fixture((db) => {
      const result = system(db, 'src');
      expect(result.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/zero.ts']);
      expect(result.symbols.find((row) => row.symbol === symbol('b.ts', 'use'))?.relativePath).toBe('src/b.ts');
      expect(consumerSurface(db, 'src/a.ts').map((row) => [row.consumer, row.shortName.split(':').at(-1)])).toEqual([
        ['src/b.ts', 'first()'],
        ['src/b.ts', 'second()'],
        ['src/c.ts', 'first()'],
      ]);
      expect(consumerSurface(db, 'src/zero.ts')).toEqual([]);
      expect(system(db, 'missing')).toEqual({ files: [], symbols: [], dependsOn: [], dependedOnBy: [] });
    }));
  it('rejects ambiguous complexity roots and unavailable source instead of returning a low score', () =>
    fixture((db) => {
      expect(() => complexity(db, 'use')).toThrow(/ambiguous/i);
      rmSync(join(db.config.projectRoot, 'src/zero.ts'));
      expect(() => complexity(db, symbol('zero.ts', 'zero'))).toThrow(/source|file|exist/i);
    }));
});

it('counts a consumer file once across multiple changed-file symbols', () =>
  fixture((db) => {
    const result = changeSurface(db, 'src/a.ts', { semantic: false });
    expect(result?.symbols.map((row) => row.externalConsumers)).toEqual([2, 1]);
    expect(result?.totalExternalConsumers).toBe(2);
  }));
