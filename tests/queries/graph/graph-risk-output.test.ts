import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { bottlenecks } from '../../../src/queries/graph/bottlenecks.js';
import { coupling, topCoupling } from '../../../src/queries/graph/coupling.js';
import { dependencyDepth } from '../../../src/queries/graph/deep-chains.js';
import { TARGET_COUPLING_SQL } from '../../../src/queries/internal/target-coupling.js';
import { externalSymbolFanOut, fileDependencyOutDegree, topFanIn, topFanOut } from '../../../src/queries/graph/fan.js';
import { hotspots } from '../../../src/queries/graph/hotspots.js';
import { drift } from '../../../src/queries/cleanup/drift.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { createEvidenceSchema, evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { findFirstSymbolMatch } from '../../../src/symbols/symbol-lookup.js';
import {
  getResolvedReferenceSites,
  getResolvedReferenceSitesMap,
} from '../../../src/symbols/references/reference-sites.js';

const sym = (path: string, name: string) => `scip-typescript npm fixture 1.0.0 src/\`${path}\`/${name}().`;

function withGraphFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-graph-risk-'));
  const dbPath = join(tempDir, 'index.db');
  try {
    writeFixtureFiles(tempDir, {
      'src/a.ts': 'export function a(): void { b(); }',
      'src/b.ts': 'export function b(): void { c(); }',
      'src/c.ts': 'export function c(): void { d(); }',
      'src/d.ts': 'export function d(): void {}',
      'src/central.ts': 'export function central(): void { depOne(); depTwo(); }',
      'src/dep-one.ts': 'export function depOne(): void {}',
      'src/dep-two.ts': 'export function depTwo(): void {}',
      'src/caller-one.ts': 'export function callerOne(): void { central(); }',
      'src/caller-two.ts': 'export function callerTwo(): void { central(); }',
      'src/model.ts': 'export function sharedOne(): void {} export function sharedTwo(): void {}',
      'src/view.ts': 'export function render(): void { sharedOne(); sharedTwo(); }',
    });

    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .document(2, 'typescript', 'src/b.ts')
      .document(3, 'typescript', 'src/c.ts')
      .document(4, 'typescript', 'src/d.ts')
      .document(5, 'typescript', 'src/central.ts')
      .document(6, 'typescript', 'src/dep-one.ts')
      .document(7, 'typescript', 'src/dep-two.ts')
      .document(8, 'typescript', 'src/caller-one.ts')
      .document(9, 'typescript', 'src/caller-two.ts')
      .document(10, 'typescript', 'src/model.ts')
      .document(11, 'typescript', 'src/view.ts')
      .symbol(1, sym('a.ts', 'a'), 'a', 6)
      .symbol(2, sym('b.ts', 'b'), 'b', 6)
      .symbol(3, sym('c.ts', 'c'), 'c', 6)
      .symbol(4, sym('d.ts', 'd'), 'd', 6)
      .symbol(5, sym('central.ts', 'central'), 'central', 6)
      .symbol(6, sym('dep-one.ts', 'depOne'), 'depOne', 6)
      .symbol(7, sym('dep-two.ts', 'depTwo'), 'depTwo', 6)
      .symbol(8, sym('caller-one.ts', 'callerOne'), 'callerOne', 6)
      .symbol(9, sym('caller-two.ts', 'callerTwo'), 'callerTwo', 6)
      .symbol(10, sym('model.ts', 'sharedOne'), 'sharedOne', 6)
      .symbol(11, sym('model.ts', 'sharedTwo'), 'sharedTwo', 6)
      .symbol(12, sym('view.ts', 'render'), 'render', 6)
      .definition(1, 1, 1, 0, 0, 0, 40)
      .definition(2, 2, 2, 0, 0, 0, 40)
      .definition(3, 3, 3, 0, 0, 0, 40)
      .definition(4, 4, 4, 0, 0, 0, 30)
      .definition(5, 5, 5, 0, 0, 0, 60)
      .definition(6, 6, 6, 0, 0, 0, 40)
      .definition(7, 7, 7, 0, 0, 0, 40)
      .definition(8, 8, 8, 0, 0, 0, 50)
      .definition(9, 9, 9, 0, 0, 0, 50)
      .definition(10, 10, 10, 0, 0, 0, 40)
      .definition(11, 10, 11, 0, 41, 0, 90)
      .definition(12, 11, 12, 0, 0, 0, 60)
      .chunk(1, 1, 0, 0)
      .chunk(2, 2, 0, 0)
      .chunk(3, 3, 0, 0)
      .chunk(4, 4, 0, 0)
      .chunk(5, 5, 0, 0)
      .chunk(6, 6, 0, 0)
      .chunk(7, 7, 0, 0)
      .chunk(8, 8, 0, 0)
      .chunk(9, 9, 0, 0)
      .chunk(10, 10, 0, 0)
      .chunk(11, 11, 0, 0)
      .mention(1, 1, 1)
      .mention(1, 2, 0)
      .mention(2, 2, 1)
      .mention(2, 3, 0)
      .mention(3, 3, 1)
      .mention(3, 4, 0)
      .mention(4, 4, 1)
      .mention(5, 5, 1)
      .mention(5, 6, 0)
      .mention(5, 7, 0)
      .mention(6, 6, 1)
      .mention(7, 7, 1)
      .mention(8, 8, 1)
      .mention(8, 5, 0)
      .mention(9, 9, 1)
      .mention(9, 5, 0)
      .mention(10, 10, 1)
      .mention(10, 11, 1)
      .mention(11, 12, 1)
      .mention(11, 10, 0)
      .mention(11, 11, 0)
      .write();

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    const db = new ScipDatabase(config);
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function withCycleChainFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-deep-chain-cycle-'));
  const dbPath = join(tempDir, 'index.db');
  try {
    writeFixtureFiles(tempDir, {
      'src/cycle-a.ts': 'export function cycleA(): void { cycleB(); }',
      'src/cycle-b.ts': 'export function cycleB(): void { cycleA(); tail(); }',
      'src/tail.ts': 'export function tail(): void {}',
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/cycle-a.ts')
      .document(2, 'typescript', 'src/cycle-b.ts')
      .document(3, 'typescript', 'src/tail.ts')
      .symbol(1, sym('cycle-a.ts', 'cycleA'), 'cycleA', 6)
      .symbol(2, sym('cycle-b.ts', 'cycleB'), 'cycleB', 6)
      .symbol(3, sym('tail.ts', 'tail'), 'tail', 6)
      .definition(1, 1, 1, 0, 0, 0, 40)
      .definition(2, 2, 2, 0, 0, 0, 50)
      .definition(3, 3, 3, 0, 0, 0, 30)
      .chunk(1, 1, 0, 0)
      .chunk(2, 2, 0, 0)
      .chunk(3, 3, 0, 0)
      .mention(1, 1, 1)
      .mention(1, 2, 0)
      .mention(2, 2, 1)
      .mention(2, 1, 0)
      .mention(2, 3, 0)
      .mention(3, 3, 1)
      .write();

    const db = new ScipDatabase({
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function withArchitecturePolicyFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-architecture-policy-'));
  const dbPath = join(tempDir, 'index.db');
  try {
    writeFixtureFiles(tempDir, {
      'src/domain/model.ts': "import { startRuntime } from '../runtime/api';\nexport const value = startRuntime();\n",
      'src/runtime/api.ts': "export function startRuntime(): string { return 'ok'; }\n",
      'features/orders/a.ts': "import { log } from '../../infra/logger';\nexport const a = log();\n",
      'features/orders/b.ts': 'export const b = 1;\n',
      'features/orders/c.ts': 'export const c = 1;\n',
      'features/orders/d.ts': 'export const d = 1;\n',
      'features/orders/e.ts': 'export const e = 1;\n',
      'infra/logger.ts': "export function log(): string { return 'logged'; }\n",
    });

    const sqliteDb = new Database(dbPath);
    try {
      createEvidenceSchema(sqliteDb);
      sqliteDb.exec(`
        INSERT INTO documents (id, language, relative_path) VALUES
          (1, 'typescript', 'src/domain/model.ts'),
          (2, 'typescript', 'src/runtime/api.ts'),
          (3, 'typescript', 'features/orders/a.ts'),
          (4, 'typescript', 'features/orders/b.ts'),
          (5, 'typescript', 'features/orders/c.ts'),
          (6, 'typescript', 'features/orders/d.ts'),
          (7, 'typescript', 'features/orders/e.ts'),
          (8, 'typescript', 'infra/logger.ts');
      `);
    } finally {
      sqliteDb.close();
    }

    const db = new ScipDatabase({
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
      architecture: {
        boundaries: [
          { name: 'domain', paths: ['src/domain/**'] },
          { name: 'runtime', paths: ['src/runtime/**'] },
          { name: 'feature', paths: ['features/**'] },
          { name: 'infra', paths: ['infra/**'] },
        ],
        allowedDependencies: {
          domain: [],
        },
      },
    });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('graph-risk output classification', () => {
  it('batches resolved reference chunks without changing per-symbol sites', () => {
    withGraphFixture((db) => {
      const central = findFirstSymbolMatch(db, 'central');
      const depOne = findFirstSymbolMatch(db, 'depOne');
      expect(central).not.toBeNull();
      expect(depOne).not.toBeNull();
      if (!central || !depOne) return;

      const expected = new Map([
        [central.symbolId, getResolvedReferenceSites(db, central)],
        [depOne.symbolId, getResolvedReferenceSites(db, depOne)],
      ]);
      const all = vi.spyOn(db, 'all');
      const actual = getResolvedReferenceSitesMap(db, [central, depOne]);

      expect(actual).toEqual(expected);
      expect(all.mock.calls.filter(([sql]) => String(sql).includes('SELECT m.symbol_id'))).toHaveLength(1);
    });
  });

  it('labels bottlenecks and coupling as contextual graph-risk signals', () => {
    withGraphFixture((db) => {
      const get = vi.spyOn(db, 'get');
      const central = bottlenecks(db, { minFanIn: 2, minFanOut: 2, limit: 10, semantic: false }).find(
        (row) => row.shortName === 'src:central:central()',
      );

      expect(central).toMatchObject({
        actionTier: 'signal',
        riskKind: 'coordination-hotspot',
        fanIn: 2,
        fanOut: 2,
        score: 4,
        callerFiles: ['src/caller-one.ts', 'src/caller-two.ts'],
        candidateCallerFiles: ['src/caller-one.ts', 'src/caller-two.ts'],
        candidateExternalCallees: [sym('dep-one.ts', 'depOne'), sym('dep-two.ts', 'depTwo')],
        inputBasis: 'mixed-static-call-or-reference-evidence',
        externalCallees: [
          {
            symbol: sym('dep-one.ts', 'depOne'),
            shortName: 'src:dep-one:depOne()',
            file: 'src/dep-one.ts',
          },
          {
            symbol: sym('dep-two.ts', 'depTwo'),
            shortName: 'src:dep-two:depTwo()',
            file: 'src/dep-two.ts',
          },
        ],
      });
      expect(central?.evidenceReasons).toEqual(
        expect.arrayContaining([
          '2 incoming file(s) reference this symbol',
          '2 distinct cross-file callee target(s) are observed; candidate targets do not establish reachability',
        ]),
      );
      expect(central?.recommendation).toContain('do not refactor solely from graph centrality');
      expect(
        get.mock.calls.filter(([sql]) => String(sql).includes('SELECT COUNT(*) AS count FROM global_symbols')),
      ).toHaveLength(1);

      expect(topFanIn(db, { limit: 20 }).find((row) => row.name === 'src:central:central()')).toMatchObject({
        count: 2,
        symbol: sym('central.ts', 'central'),
        definedIn: 'src/central.ts',
      });
      expect(topFanOut(db, { limit: 20 }).find((row) => row.name === 'src/central.ts')).toEqual({
        name: 'src/central.ts',
        count: 2,
      });
      expect(externalSymbolFanOut(db, 'src/view.ts')).toEqual([
        {
          name: 'src/view.ts',
          file: 'src/view.ts',
          count: 2,
          basis: 'external-symbol-references',
        },
      ]);
      expect(fileDependencyOutDegree(db, 'src/view.ts')).toEqual([
        {
          name: 'src/view.ts',
          file: 'src/view.ts',
          count: 1,
          basis: 'file-dependency-edges',
        },
      ]);
      expect(hotspots(db, { limit: 20 }).find((row) => row.shortName === 'src:central:central()')).toMatchObject({
        refCount: 2,
        fileCount: 2,
        definedIn: 'src/central.ts',
        basis: 'scip-cross-file-mentions',
        countUnit: 'referencing-chunks',
      });

      const pair = coupling(db, 'src/model.ts', 'src/view.ts');
      expect(pair).toMatchObject({
        actionTier: 'signal',
        couplingKind: 'shared-symbol-coupling',
        sharedSymbols: 2,
      });
      expect(pair.recommendation).toContain('intentional boundary');

      const rankedPairs = topCoupling(db, { limit: 100 });
      expect(new Set(rankedPairs.map((row) => `${row.file1}\0${row.file2}`)).size).toBe(rankedPairs.length);
      expect(rankedPairs.every((row) => row.file1 < row.file2)).toBe(true);
      for (const ranked of rankedPairs) {
        expect(ranked.sharedSymbols).toBe(coupling(db, ranked.file1, ranked.file2).sharedSymbols);
      }

      const plan = db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${TARGET_COUPLING_SQL}`,
        'src/model.ts',
        'src/view.ts',
        'src/view.ts',
        'src/model.ts',
      );
      expect(plan.some((row) => row.detail.includes('sqlite_autoindex_documents_1'))).toBe(true);
      expect(plan.some((row) => /SCAN (?:gs|global_symbols)/u.test(row.detail))).toBe(false);
    });
  });

  it('deduplicates deep-chain suffixes and marks chains as signal risk', () => {
    withGraphFixture((db) => {
      const chains = dependencyDepth(db, { minDepth: 2, limit: 10 });
      const rendered = chains.map((result) => result.chain.join(' > '));

      expect(rendered).toContain('src/a.ts > src/b.ts > src/c.ts > src/d.ts');
      expect(rendered).not.toContain('src/b.ts > src/c.ts > src/d.ts');
      expect(rendered).not.toContain('src/c.ts > src/d.ts');
      expect(chains.find((result) => result.chain[0] === 'src/a.ts')).toMatchObject({
        actionTier: 'signal',
        chainKind: 'transitive-dependency-depth',
        edgeBasis: 'symbol-references',
      });
    });
  });

  it('counts a dependency cycle as one condensed depth component', () => {
    withCycleChainFixture((db) => {
      const [chain] = dependencyDepth(db, { minDepth: 2, limit: 10 });

      expect(chain).toMatchObject({
        chain: ['src/cycle-a.ts', 'src/tail.ts'],
        components: [['src/cycle-a.ts', 'src/cycle-b.ts'], ['src/tail.ts']],
        depth: 2,
        fileCount: 3,
      });
      expect(chain?.evidenceReasons).toContain(
        'cycles count once toward depth and retain their full membership separately',
      );
    });
  });

  it('reports declared boundary violations without inventing undeclared ones', () => {
    withArchitecturePolicyFixture((db) => {
      const summary = drift(db, { minDeviation: 5 });
      const explicit = summary.results.find(
        (result) => result.file === 'src/domain/model.ts' && result.kind === 'architecture-violation',
      );
      const undeclared = summary.results.find(
        (result) => result.file === 'features/orders/a.ts' && result.kind === 'architecture-violation',
      );

      expect(explicit).toMatchObject({
        actionTier: 'direct',
        policyBasis: 'explicit',
      });
      expect(explicit?.recommendation).toContain('allowed boundary');
      expect(undeclared).toBeUndefined();
    });
  });

  it('parameterizes quoted top-coupling scopes', () => {
    withGraphFixture((db) => {
      expect(() => topCoupling(db, { scope: "o'brien" })).not.toThrow();
      expect(topCoupling(db, { scope: "o'brien" })).toEqual([]);
    });
  });
});
