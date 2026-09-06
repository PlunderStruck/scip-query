import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { complexity, branchEstimatesForDefinitions } from '../../../src/queries/quality/complexity.js';
import { getDefinitionsForFile } from '../../../src/symbols/definition-catalog.js';
import { buildAstCalleeMap } from '../../../src/symbols/graph/call-graph-evidence.js';
import { createTsMorphProvider } from '../../../src/semantic/typescript/ts-morph-provider.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('function complexity evidence contract', () => {
  it.each([
    'function nested() { return helper(); } return nested;',
    'const nested = () => helper(); return nested;',
    'return [1].map(() => helper());',
    'return () => helper();',
    'function outer() { return helper(); } return outer;',
  ])('does not attribute an unindexed nested invocation to its outer callable: %s', (body) => {
    const root = mkdtempSync(join(tmpdir(), 'scip-call-owner-'));
    const file = 'src/functions.ts';
    const symbol = (name: string) => `scip-typescript npm fixture 1.0.0 src/\`functions.ts\`/${name}().`;
    const source = [
      `export function outer() { ${body} }`,
      'export function helper() { return 1; }',
      'export const direct = () => helper();',
    ];
    writeFixtureFiles(root, {
      [file]: source,
      'tsconfig.json': ['{"compilerOptions":{"target":"ES2022"},"include":["src/**/*.ts"]}'],
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', file)
      .symbol(1, symbol('outer'), 'outer', 17)
      .definition(1, 1, 1, 0, 0, 0, source[0]!.length)
      .symbol(2, symbol('helper'), 'helper', 17)
      .definition(2, 1, 2, 1, 0, 1, source[1]!.length)
      .symbol(3, symbol('direct'), 'direct', 17)
      .definition(3, 1, 3, 2, 0, 2, source[2]!.length)
      .chunk(1, 1, 0, source.length - 1)
      .occurrence(1, symbol('helper'), 0, 0, source[0]!.indexOf('helper'), source[0]!.indexOf('helper') + 6)
      .occurrence(1, symbol('helper'), 2, 0, source[2]!.indexOf('helper'), source[2]!.indexOf('helper') + 6)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const definitions = getDefinitionsForFile(db, file);
      for (const selected of [definitions, definitions.filter((definition) => definition.symbolId === 1)]) {
        expect(buildAstCalleeMap(db, selected).get(1)).toEqual([]);
      }
      expect(complexity(db, symbol('outer'))).toMatchObject({ calleeCount: 0 });
      expect(buildAstCalleeMap(db, definitions).get(3)).toEqual([
        expect.objectContaining({ symbol: symbol('helper'), source: 'scip-occurrence' }),
      ]);
      const provider = createTsMorphProvider(db);
      try {
        const outer = definitions.find((definition) => definition.symbolId === 1)!;
        const direct = definitions.find((definition) => definition.symbolId === 3)!;
        expect(provider.calleesForDefinitions!([outer]).get(outer.symbolId)).toEqual([]);
        expect(provider.calleeCoverageForDefinitions!([outer]).get(outer.symbolId)).toMatchObject({
          resolvedInRepository: 0,
        });
        expect(provider.calleesForDefinitions!([direct]).get(direct.symbolId)).toEqual([
          expect.objectContaining({ symbol: symbol('helper') }),
        ]);
      } finally {
        provider.dispose?.();
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shares function-local metrics and keeps chunk neighbors out of resolved call counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-complexity-contract-'));
    const file = 'src/functions.ts';
    const symbol = (name: string) => `scip-typescript npm fixture 1.0.0 src/\`functions.ts\`/${name}().`;
    const source = [
      'export function outer(x: number) {',
      '  function inner() { if (x) return 1; return 0; }',
      '  return inner;',
      '}',
      'export function fallback(x?: number) { return x ?? 0; }',
      'export function run() { return fallback(1); }',
    ];
    writeFixtureFiles(root, { [file]: source });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', file)
      .symbol(1, symbol('outer'), 'outer', 17)
      .definition(1, 1, 1, 0, 0, 3, 1)
      .symbol(2, symbol('fallback'), 'fallback', 17)
      .definition(2, 1, 2, 4, 0, 4, source[4]!.length)
      .symbol(3, symbol('run'), 'run', 17)
      .definition(3, 1, 3, 5, 0, 5, source[5]!.length)
      .chunk(1, 1, 0, 5)
      .mention(1, 1, 1)
      .mention(1, 2, 1)
      .mention(1, 3, 1)
      .mention(1, 2, 0)
      .occurrence(1, symbol('fallback'), 5, 0, source[5]!.indexOf('fallback'), source[5]!.indexOf('fallback') + 8)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      expect(complexity(db, symbol('outer'))).toMatchObject({
        cyclomaticEstimate: 1,
        metricRules: 'typescript-function-local-v1',
        calleeCount: 0,
      });
      expect(complexity(db, symbol('fallback'))).toMatchObject({
        cyclomaticEstimate: 2,
        metricRules: 'typescript-function-local-v1',
        calleeCount: 0,
      });
      expect(complexity(db, symbol('run'))).toMatchObject({ calleeCount: 1 });
      const batch = branchEstimatesForDefinitions(db, getDefinitionsForFile(db, file));
      expect(batch.get(1)).toMatchObject({ branches: 0, metricRules: 'typescript-function-local-v1' });
      expect(batch.get(2)).toMatchObject({ branches: 1, metricRules: 'typescript-function-local-v1' });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
