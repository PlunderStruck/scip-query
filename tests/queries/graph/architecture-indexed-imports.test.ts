import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { architecture } from '../../../src/queries/graph/architecture.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { buildFileDepGraph } from '../../../src/symbols/graph/file-dep-graph.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

const importCases: Array<{
  syntax: string;
  source: string;
  expected: boolean;
  sourceAvailable?: boolean;
  unresolved?: boolean;
}> = [
  { syntax: 'literal dynamic import', source: "export const load = () => import('@core/value');", expected: true },
  { syntax: 'CommonJS require', source: "export const load = () => require('@core/value');", expected: true },
  { syntax: 'import type expression', source: "export type Value = import('@core/value').Value;", expected: true },
  {
    syntax: 'shadowed require',
    source: "export function load(require: (name: string) => unknown) { return require('@core/value'); }",
    expected: false,
  },
  {
    syntax: 'nonliteral import',
    source: 'export const load = (name: string) => import(name);',
    expected: false,
    unresolved: true,
  },
  {
    syntax: 'unavailable current source',
    source: 'export const value = 1;',
    expected: false,
    sourceAvailable: false,
    unresolved: true,
  },
  { syntax: 'invalid current syntax', source: 'export const broken =', expected: false, unresolved: true },
];

it.each(importCases)(
  'classifies $syntax when the index has no import occurrence',
  ({ source, expected, sourceAvailable = true, unresolved = false }) => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-architecture-imports-'));
    roots.add(root);
    writeFixtureFiles(root, {
      'src/api/load.ts': source,
      'src/core/value.ts': 'export interface Value { value: string }; export const value = 1;',
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@core/*': ['src/core/*'] } } }),
    });
    if (!sourceAvailable) rmSync(join(root, 'src/api/load.ts'));
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/api/load.ts')
      .document(2, 'typescript', 'src/core/value.ts')
      .write();
    const config = {
      boundaries: [
        { name: 'api', paths: ['src/api/**'] },
        { name: 'core', paths: ['src/core/**'] },
      ],
      allowedDependencies: { api: ['core'], core: [] },
      requireMinimalPolicy: true,
    };
    const db = new ScipDatabase({
      projectRoot: root,
      dbPath,
      indexPath: join(root, 'index.scip'),
      architecture: config,
    });
    try {
      const navigationBefore = [...buildFileDepGraph(db, undefined, { scipEdges: 'imports-only' })];
      const report = architecture(db);
      expect(report.edges).toEqual(
        expected ? [expect.objectContaining({ from: 'api', to: 'core', policyStatus: 'allowed' })] : [],
      );
      if (expected || unresolved) expect(report.staleAllowances).toEqual([]);
      if (unresolved)
        expect(report.coverage.limitations).toEqual(expect.arrayContaining([expect.stringContaining('withheld')]));
      if (source.includes('import(name)')) {
        expect(report.staleAllowances).toEqual([]);
        expect(report.coverage.limitations).toEqual(
          expect.arrayContaining([expect.stringContaining('name (dynamic)')]),
        );
      }
      config.allowedDependencies.api = [];
      expect(architecture(db).forbiddenEdges).toEqual(
        expected ? [expect.objectContaining({ from: 'api', to: 'core' })] : [],
      );
      expect([...buildFileDepGraph(db, undefined, { scipEdges: 'imports-only' })]).toEqual(navigationBefore);
    } finally {
      db.close();
    }
  },
);
