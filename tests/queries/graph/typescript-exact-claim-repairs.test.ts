import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ts } from '@ts-morph/common';
import { Project } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexerHistoryFixture } from '../../properties/indexer-history-fixture.js';
import { getAst } from '../../../src/source/ast/ast-core.js';
import type { SyntaxNode } from '../../../src/source/ast/ast-types.js';
import { evaluateStaticValue } from '../../../src/symbols/graph/static-value-flow.js';
import { scipOccurrenceCallTargetsForRange } from '../../../src/symbols/graph/scip-occurrence-call-targets.js';
import { graphEvidence } from '../../../src/queries/graph/graph-evidence.js';
import { collectRuntimeBoundaryGraph } from '../../../src/analysis/runtime-boundaries/graph.js';
import { readRuntimeBoundaryGraph } from '../../../src/analysis/runtime-boundaries/storage.js';

const values: Array<[string, string, string, unknown]> = [
  ['literal-control', '', '"/right"', '/right'],
  ['direct-control', 'function read(_arg: unknown) { return "/right"; }', 'read("input")', '/right'],
  [
    'parameter-object',
    'const input = { get x(): string { throw new Error("getter"); } }; function read({ x }: { x: string }) { return "/wrong"; }',
    'read(input)',
    { throws: 'getter' },
  ],
  [
    'parameter-iterator',
    'const input = { *[Symbol.iterator]() { throw new Error("iterator"); } }; function read([x]: Iterable<string>) { return "/wrong"; }',
    'read(input)',
    { throws: 'iterator' },
  ],
  [
    'argument-coercion',
    'const input = { valueOf() { throw new Error("coercion"); } }; function read(_arg: unknown) { return "/wrong"; }',
    'read(+input)',
    { throws: 'coercion' },
  ],
  [
    'template-coercion',
    'const input = { toString() { throw new Error("coercion"); } }; function read(_arg: unknown) { return "/wrong"; }',
    'read(`${input}`)',
    { throws: 'coercion' },
  ],
  [
    'initializer-spread',
    'const input = { *[Symbol.iterator]() { throw new Error("iterator"); } }; function read() { const array = [...input]; return "/wrong"; }',
    'read()',
    { throws: 'iterator' },
  ],
  ['reflect-receiver', 'const box = { path: "/wrong" }; Reflect.set({}, "path", "/right", box);', 'box.path', '/right'],
  [
    'reflect-sibling',
    'const box = { path: "/right", other: "before" }; Reflect.set({}, "other", "after", box);',
    'box.path',
    '/right',
  ],
  ['eval-value', 'const box = { path: "/wrong" }; eval("box.path = \'/right\'");', 'box.path', '/right'],
  [
    'reflect-setter-receiver',
    'const box = { path: "/wrong" }; const target = { set redirect(value: string) { (this as unknown as { path: string }).path = value; } }; Reflect.set(target, "redirect", "/right", box);',
    'box.path',
    '/right',
  ],
  [
    'reflect-default-receiver',
    'const box = { path: "/wrong" }; Reflect.set(box, "path", "/right");',
    'box.path',
    '/right',
  ],
  [
    'reflect-target-control',
    'const box = { path: "/right" }; const receiver = {}; Reflect.set(box, "path", "/wrong", receiver);',
    'box.path',
    '/right',
  ],
  ['indirect-eval-control', 'const box = { path: "/right" }; (0, eval)("1 + 1");', 'box.path', '/right'],
  ['parameter-default-control', 'function read(_value = "input") { return "/right"; }', 'read()', '/right'],
  ['parameter-rest-control', 'function read(..._values: string[]) { return "/right"; }', 'read("input")', '/right'],
  [
    'lazy-initializer-control',
    'function read() { const later = () => { throw new Error("unused"); }; return "/right"; }',
    'read()',
    '/right',
  ],
  [
    'reflect-installed-setter',
    'const box = { path: "/wrong" }; const target = { redirect: "before" }; Object.defineProperty(target, "redirect", { set(value: string) { (this as unknown as { path: string }).path = value; } }); Reflect.set(target, "redirect", "/right", box);',
    'box.path',
    '/right',
  ],
  [
    'reflect-installed-own-setter',
    'const box = { path: "/wrong", redirect: "before" }; Object.defineProperty(box, "redirect", { set(value: string) { this.path = value; } }); Reflect.set(box, "redirect", "/right");',
    'box.path',
    '/right',
  ],
  [
    'reflect-installed-descriptors',
    'const box = { path: "/wrong", redirect: "before" }; Object.defineProperties(box, { redirect: { set(value: string) { this.path = value; } } }); Reflect.set(box, "redirect", "/right");',
    'box.path',
    '/right',
  ],
];

const calls: Array<[string, string, unknown, boolean]> = [
  [
    'constructor',
    'class Base { value = 1; }\nexport function entry() {\n/* probe */ return new Base().value;\n}',
    1,
    true,
  ],
  [
    'constructor-same-line',
    'function replace(_value: any, _context: any) { return class Other { value = 2; }; }\n@replace class Decorated { value = 1; } class Base { value = 3; }\nexport function entry() {\n/* probe */ return new Base().value;\n}',
    3,
    true,
  ],
  [
    'direct',
    'function original() { return 1; }\nexport function entry() {\n/* probe */ return original();\n}',
    1,
    true,
  ],
  [
    'eval-function',
    'function original() { return 1; }\nfunction replacement() { return 2; }\nexport function entry() { eval("original = replacement");\n/* probe */ return original();\n}',
    2,
    false,
  ],
  [
    'decorated',
    'function replace(_value: any, _context: any) { return class Other { value = 2; }; }\n@replace\nclass Base { value = 1; }\nexport function entry() {\n/* probe */ return new Base().value;\n}',
    2,
    false,
  ],
  [
    'alias-same',
    'const replacement = () => 2; const alias = replacement;\nexport function entry() {\n/* probe */ return alias();\n}',
    2,
    false,
  ],
  [
    'alias-split',
    'const replacement = () => 2;\nconst alias = replacement;\nexport function entry() {\n/* probe */ return alias();\n}',
    2,
    false,
  ],
];

function allNodes(node: SyntaxNode): SyntaxNode[] {
  return [node, ...node.namedChildren.flatMap(allNodes)];
}

describe('TypeScript exact-claim regressions', () => {
  let fixture: IndexerHistoryFixture;
  let executed: Record<string, { value?: unknown; throws?: string }>;
  beforeAll(async () => {
    fixture = new IndexerHistoryFixture();
    const configPath = join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.compilerOptions.noLib;
    writeFileSync(configPath, JSON.stringify(config));
    for (const [id, setup, expression] of values)
      fixture.write(`${id}.ts`, `export function entry() {\n${setup}\nconst probe = ${expression};\nreturn probe;\n}`);
    for (const [id, source] of calls) fixture.write(`call-${id}.ts`, source);
    fixture.write(
      'owner.ts',
      'export const box = { path: "/wrong", stable: "/right" }; export const path = "/right"; export default box;',
    );
    fixture.write('writer.ts', 'import { box } from "./owner.js"; export function change() { box.path = "/right"; }');
    fixture.write('shared-http.ts', 'import { box } from "./owner.js"; export function send() { fetch(box.stable); }');
    fixture.write('barrel.ts', 'export { box, path } from "./owner.js";');
    fixture.write('bridge.ts', 'export function shared(_input: number) { return 1; }');
    for (const [id, imports, expression] of [
      ['named', 'import { box } from "./owner.js";', 'box.path'],
      ['renamed', 'import { box as renamed } from "./owner.js";', 'renamed.path'],
      ['namespace', 'import * as owner from "./owner.js";', 'owner.box.path'],
      ['default', 'import box from "./owner.js";', 'box.path'],
      ['barrel', 'import { box } from "./barrel.js";', 'box.path'],
      ['unchanged-property', 'import { box } from "./owner.js";', 'box.stable'],
      ['primitive', 'import { path } from "./owner.js";', 'path'],
    ])
      fixture.write(
        `shared-${id}.ts`,
        `${imports}\nimport { change } from "./writer.js";\nexport async function entry() { await Promise.resolve().then(change); const probe = ${expression}; return probe; }`,
      );
    expect(
      new Project({ tsConfigFilePath: configPath })
        .getPreEmitDiagnostics()
        .map((diagnostic) => diagnostic.getMessageText()),
    ).toEqual([]);
    const runtime = join(fixture.root, '.runtime');
    mkdirSync(runtime);
    for (const [file, source] of fixture.sources)
      writeFileSync(
        join(runtime, file.replace(/\.ts$/, '.js')),
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText,
      );
    const ids = [
      ...values.map(([id]) => id),
      ...calls.map(([id]) => `call-${id}`),
      ...['named', 'renamed', 'namespace', 'default', 'barrel', 'unchanged-property', 'primitive'].map(
        (id) => `shared-${id}`,
      ),
    ];
    executed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          `(async () => { const results = {}; for (const id of JSON.parse(process.argv[1])) { try { results[id] = { value: await require(process.argv[2] + '/' + id + '.js').entry() }; } catch (error) { results[id] = { throws: error.message }; } } process.stdout.write(JSON.stringify(results)); })();`,
          JSON.stringify(ids),
          runtime,
        ],
        { encoding: 'utf8' },
      ),
    );
    await fixture.index({ allowExpensiveRebuild: true });
  });
  afterAll(async () => {
    await fixture.dispose();
  });

  function evaluated(file: string) {
    const db = fixture.open();
    try {
      const root = getAst(db, file)!.rootNode;
      const probe = allNodes(root).find(
        (node) => node.type === 'variable_declarator' && node.childForFieldName('name')?.text === 'probe',
      );
      return evaluateStaticValue({ db, file, root }, probe?.childForFieldName('value'));
    } finally {
      db.close();
    }
  }

  it.each(values)(
    '%s agrees with independent evaluation or reports uncertainty',
    (id, _setup, _expression, expected) => {
      expect(executed[id]).toEqual(typeof expected === 'object' ? expected : { value: expected });
      const value = evaluated(`${id}.ts`);
      if (id.endsWith('-control') || id === 'reflect-sibling')
        expect(value).toMatchObject({ precision: 'literal', value: expected });
      else if (value?.precision === 'literal') expect({ value: value.value }).toEqual(executed[id]);
    },
  );
  it.each(['named', 'renamed', 'namespace', 'default', 'barrel'])('qualifies cross-file %s writes', (id) => {
    expect(executed[`shared-${id}`]).toEqual({ value: '/right' });
    expect(evaluated(`shared-${id}.ts`)).not.toMatchObject({ precision: 'literal', value: '/wrong' });
  });
  it.each(['unchanged-property', 'primitive'])('preserves %s constants', (id) => {
    expect(evaluated(`shared-${id}.ts`)).toMatchObject({ precision: 'literal', value: '/right' });
  });
  it.each(calls)('qualifies %s implementation identity', (id, source, expected, established) => {
    expect(executed[`call-${id}`]).toEqual({ value: expected });
    const db = fixture.open();
    try {
      const file = `call-${id}.ts`;
      const line = source.split('\n').findIndex((text) => text.includes('/* probe */'));
      const result = scipOccurrenceCallTargetsForRange(db, file, line, line);
      expect(result.targets.some((target) => target.implementationStatus === 'established')).toBe(established);
      const graph = graphEvidence(
        db,
        { locations: [`${file}:${line + 1}`] },
        { families: ['execution'], direction: 'outgoing', maxDepth: 1, maxEdges: 100 },
      );
      expect(graph.edges.some((edge) => edge.subtype === 'call' && edge.evidenceStrength === 'exact')).toBe(
        established,
      );
    } finally {
      db.close();
    }
  });
  it('invalidates an unchanged HTTP consumer when a new module starts writing its shared property', async () => {
    async function path(stored = false) {
      const db = fixture.open();
      try {
        const graph = stored ? readRuntimeBoundaryGraph(db)! : await collectRuntimeBoundaryGraph(db);
        return graph.observations
          .find((row) => row.owner.file === 'shared-http.ts' && row.action === 'http.request')
          ?.keyParts.find((part) => part.name === 'path');
      } finally {
        db.close();
      }
    }
    expect(await path()).toMatchObject({ value: '/right', term: { kind: 'literal' } });
    expect(await path(true)).toMatchObject({ value: '/right', term: { kind: 'literal' } });
    for (const access of ['owner["box"]', 'owner["b\\u006fx"]']) {
      fixture.write('new-writer.ts', `import * as owner from "./owner.js"; ${access}.stable = "/changed";`);
      await fixture.index({ allowExpensiveRebuild: true });
      expect(evaluated('shared-unchanged-property.ts'), access).not.toMatchObject({
        value: '/right',
        precision: 'literal',
      });
      expect(await path(), access).not.toMatchObject({ value: '/right', term: { kind: 'literal' } });
      expect(await path(true), access).not.toMatchObject({ value: '/right', term: { kind: 'literal' } });
      fixture.write('new-writer.ts', 'export const quiet = 1;');
      await fixture.index({ allowExpensiveRebuild: true });
      expect(await path()).toMatchObject({ value: '/right', term: { kind: 'literal' } });
    }
    fixture.write('new-writer.ts', 'import { box } from "./owner.js"; box.stable = "/changed";');
    await fixture.index({ allowExpensiveRebuild: true });
    expect(await path()).not.toMatchObject({ value: '/right', term: { kind: 'literal' } });
    expect(await path(true)).not.toMatchObject({ value: '/right', term: { kind: 'literal' } });
    fixture.write('new-writer.ts', 'export const quiet = 1;');
    await fixture.index({ allowExpensiveRebuild: true });
    expect(await path()).toMatchObject({ value: '/right', term: { kind: 'literal' } });
    expect(await path(true)).toMatchObject({ value: '/right', term: { kind: 'literal' } });
  }, 30_000);
});
