import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { bottlenecks } from '../../../src/queries/graph/bottlenecks.js';
import { coupling, topCoupling } from '../../../src/queries/graph/coupling.js';
import { deepChains } from '../../../src/queries/graph/deep-chains.js';
import { drift } from '../../../src/queries/cleanup/drift.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { createEvidenceSchema, evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

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

function withDriftPolicyFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-drift-policy-'));
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
  it('labels bottlenecks and coupling as contextual graph-risk signals', () => {
    withGraphFixture((db) => {
      const central = bottlenecks(db, { minFanIn: 2, minFanOut: 2, limit: 10, semantic: false }).find(
        (row) => row.shortName === 'src:central:central()',
      );

      expect(central).toMatchObject({
        actionTier: 'signal',
        riskKind: 'coordination-hotspot',
        fanIn: 2,
        fanOut: 2,
        score: 4,
      });
      expect(central?.evidenceReasons).toEqual(
        expect.arrayContaining([
          '2 incoming file(s) reference this symbol',
          '2 distinct cross-file callee symbol(s) are reached from it',
        ]),
      );
      expect(central?.recommendation).toContain('do not refactor solely from graph centrality');

      const pair = coupling(db, 'src/model.ts', 'src/view.ts');
      expect(pair).toMatchObject({
        actionTier: 'signal',
        couplingKind: 'shared-symbol-coupling',
        sharedSymbols: 2,
      });
      expect(pair.recommendation).toContain('intentional boundary');
    });
  });

  it('deduplicates deep-chain suffixes and marks chains as signal risk', () => {
    withGraphFixture((db) => {
      const chains = deepChains(db, { minDepth: 2, limit: 10 });
      const rendered = chains.map((result) => result.chain.join(' > '));

      expect(rendered).toContain('src/a.ts > src/b.ts > src/c.ts > src/d.ts');
      expect(rendered).not.toContain('src/b.ts > src/c.ts > src/d.ts');
      expect(rendered).not.toContain('src/c.ts > src/d.ts');
      expect(chains.find((result) => result.chain[0] === 'src/a.ts')).toMatchObject({
        actionTier: 'signal',
        chainKind: 'transitive-dependency-depth',
      });
    });
  });

  it('splits drift direct cleanup from inferred boundary signals', () => {
    withDriftPolicyFixture((db) => {
      const summary = drift(db, { minDeviation: 5 });
      const explicit = summary.results.find(
        (result) => result.file === 'src/domain/model.ts' && result.kind === 'layer-violation',
      );
      const inferred = summary.results.find(
        (result) => result.file === 'features/orders/a.ts' && result.kind === 'layer-violation',
      );

      expect(explicit).toMatchObject({
        actionTier: 'direct',
        policyBasis: 'explicit',
      });
      expect(explicit?.recommendation).toContain('allowed layer boundary');

      expect(inferred).toMatchObject({
        actionTier: 'signal',
        policyBasis: 'inferred',
      });
      expect(inferred?.recommendation).toContain('intentional exception');
    });
  });

  it('parameterizes quoted top-coupling scopes', () => {
    withGraphFixture((db) => {
      expect(() => topCoupling(db, { scope: "o'brien" })).not.toThrow();
      expect(topCoupling(db, { scope: "o'brien" })).toEqual([]);
    });
  });
});
