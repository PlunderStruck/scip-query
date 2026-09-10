import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { ts } from '@ts-morph/common';
import { IndexerHistoryFixture } from '../../properties/indexer-history-fixture.js';
import { getAst } from '../../../src/source/ast/ast-core.js';
import type { SyntaxNode } from '../../../src/source/ast/ast-types.js';
import { evaluateStaticValue } from '../../../src/symbols/graph/static-value-flow.js';
import { collectRuntimeBoundaryGraph } from '../../../src/analysis/runtime-boundaries/graph.js';

const cases = [
  ['helper', 'function change(value: typeof paths) { value.path = "/right"; } change(paths);', 'paths.path', '/right'],
  ['assign', 'Object.assign(paths, { path: "/right" });', 'paths.path', '/right'],
  ['reflect', 'Reflect.set(paths, "path", "/right");', 'paths.path', '/right'],
  ['unchanged', '', 'paths.path', '/wrong'],
  ['sibling', 'Object.assign(paths, { count: 2 });', 'paths.path', '/wrong'],
  [
    'argumentThrows',
    'function fail(): never { throw new Error("expected"); } function path(value: never) { return "/wrong"; }',
    'path(fail())',
    'throws',
  ],
  [
    'initializerThrows',
    'function fail(): never { throw new Error("expected"); } function path() { const ignored = fail(); return "/wrong"; }',
    'path()',
    'throws',
  ],
] as const;

function nodes(node: SyntaxNode): SyntaxNode[] {
  return [node, ...node.namedChildren.flatMap(nodes)];
}

describe('TypeScript value effects through HTTP evidence', () => {
  let fixture: IndexerHistoryFixture;
  beforeAll(async () => {
    fixture = new IndexerHistoryFixture();
    const configPath = join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.compilerOptions.noLib;
    writeFileSync(configPath, JSON.stringify(config));
    for (const [id, setup, expression] of cases)
      fixture.write(
        `${id}.ts`,
        `const paths = { path: "/wrong", count: 0 };\n${setup}\nexport function entry() { return fetch(${expression}); }\n`,
      );
    expect(new Project({ tsConfigFilePath: configPath }).getPreEmitDiagnostics()).toEqual([]);
    await fixture.index({ allowExpensiveRebuild: true });
  });
  afterAll(async () => {
    await fixture.dispose();
  });

  it.each(cases)(
    '%s preserves execution and qualifies the extracted value',
    async (id, _setup, _expression, expected) => {
      const source = fixture.sources.get(`${id}.ts`)!;
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
      const executed = execFileSync(
        process.execPath,
        [
          '-e',
          `globalThis.fetch = async path => path;\n${compiled}\nPromise.resolve().then(() => exports.entry()).then(value => console.log(JSON.stringify(value)), () => console.log(JSON.stringify('throws')));`,
        ],
        { encoding: 'utf8' },
      );
      expect(JSON.parse(executed)).toBe(expected);
      const db = fixture.open();
      try {
        const root = getAst(db, `${id}.ts`)!.rootNode;
        const call = nodes(root).find(
          (node) => node.type === 'call_expression' && node.childForFieldName('function')?.text === 'fetch',
        )!;
        const value = evaluateStaticValue(
          { db, file: `${id}.ts`, root },
          call.childForFieldName('arguments')!.namedChild(0),
        );
        const runtime = await collectRuntimeBoundaryGraph(db);
        const paths = runtime.observations
          .filter((observation) => observation.source.file === `${id}.ts` && observation.action === 'http.request')
          .flatMap((observation) => observation.keyParts.filter((part) => part.name === 'path'));
        if (expected === '/wrong') {
          expect(value).toMatchObject({ value: '/wrong', precision: 'literal' });
          expect(paths).toContainEqual(expect.objectContaining({ value: '/wrong', evidence: 'constant' }));
        } else {
          expect(value?.precision).not.toBe('literal');
          expect(paths).not.toContainEqual(expect.objectContaining({ value: '/wrong', evidence: 'constant' }));
        }
      } finally {
        db.close();
      }
    },
  );
});
