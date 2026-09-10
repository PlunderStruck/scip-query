import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ts } from '@ts-morph/common';
import { Project } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexerHistoryFixture } from '../../properties/indexer-history-fixture.js';
import { getAst } from '../../../src/source/ast/ast-core.js';
import type { SyntaxNode } from '../../../src/source/ast/ast-types.js';
import { evaluateStaticValue } from '../../../src/symbols/graph/static-value-flow.js';
import { collectRuntimeBoundaryGraph } from '../../../src/analysis/runtime-boundaries/graph.js';
import type { BoundaryObservation } from '../../../src/analysis/runtime-boundaries/types.js';
import { callGraph } from '../../../src/queries/navigation/call-graph.js';
import { complexity } from '../../../src/queries/quality/complexity.js';
import { dependenceSlice } from '../../../src/queries/graph/dependence-slice.js';

const escapes = [
  ['factory', 'export function access() { return box; }', 'access()'],
  ['closure', 'export const access = () => box;', 'access()'],
  ['getter', 'export const access = { get current() { return box; } };', 'access.current'],
  ['array', 'export const access = [box];', 'access[0]!'],
  ['object', 'export const access = { current: box };', 'access.current'],
] as const;
const expressions = [
  ['addition', "'/item/' + (1 + 2)", '/item/3'],
  ['multiplication', "'/item/' + (2 * 3)", '/item/6'],
  ['numeric', '1 + 2', 3],
  ['template', '`/item/${1 + 2}`', '/item/3'],
  ['mixed', "1 + 2 + '/item'", '3/item'],
  ['string-control', "'/item/' + '3'", '/item/3'],
  ['literal-control', "'/right'", '/right'],
] as const;
const slices = [
  ['closure', 'function update() { value = input; } update();'],
  ['arrow', '(() => { value = input; })();'],
  ['getter', 'const obj = { get x() { value = input; return 0; } }; void obj.x;'],
  ['setter', 'const obj = { set x(v: number) { value = v; } }; obj.x = input;'],
  ['class', 'class C { x = (value = input); } new C();'],
  ['static', 'class C { static x = (value = input); } void C;'],
  ['block', 'class C { static { value = input; } } void C;'],
  ['eval', 'eval("value = input");'],
  ['tag', 'function tag(_parts: TemplateStringsArray) { value = input; } tag`x`;'],
  ['coercion', 'const obj = { valueOf() { value = input; return 1; } }; void +obj;'],
  ['iterator', 'const obj = { *[Symbol.iterator]() { value = input; yield 0; } }; [...obj];'],
  ['reflect', 'Reflect.apply(() => { value = input; }, null, []);'],
  ['straight-control', 'value = input;'],
  ['branch-control', 'if (input > 3) value = input;'],
] as const;

function nodes(node: SyntaxNode): SyntaxNode[] {
  return [node, ...node.namedChildren.flatMap(nodes)];
}

describe('TypeScript breadth accuracy regressions', () => {
  let fixture: IndexerHistoryFixture;
  let runtime: string;
  let executed: Record<string, { value: unknown; paths: unknown[] }>;
  let observations: BoundaryObservation[];
  beforeAll(async () => {
    fixture = new IndexerHistoryFixture();
    runtime = mkdtempSync(join(tmpdir(), 'scip-breadth-execution-'));
    const configPath = join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.compilerOptions.noLib;
    writeFileSync(configPath, JSON.stringify(config));
    for (const [id, expose, access] of escapes) {
      fixture.write(
        `${id}-owner.ts`,
        `export const box = { path: '/wrong' }; ${expose} export function read() { return box.path; }`,
      );
      fixture.write(
        `${id}-writer.ts`,
        `import { access } from './${id}-owner.js'; export function change() { ${access}.path = '/right'; }`,
      );
      for (const imported of [false, true]) {
        fixture.write(
          `${id}-${imported}.ts`,
          `import { box, read } from './${id}-owner.js'; import { change } from './${id}-writer.js';
export function entry() { change(); const probe = ${imported ? 'box.path' : 'read()'}; fetch(probe); return probe; }`,
        );
      }
    }
    for (const [id, expression] of expressions)
      fixture.write(
        `${id}.ts`,
        `export function entry() { const probe = ${expression}; fetch(String(probe)); return probe; }
export function direct() { fetch(${id === 'numeric' ? 'String(1 + 2)' : expression}); }`,
      );
    for (const [id, body] of slices)
      fixture.write(
        `slice-${id}.ts`,
        `export function entry(input = 2, other = 11) {\nlet value = other; ${body}\nreturn value;\n}`,
      );
    fixture.write(
      'constructor.ts',
      'function replace<T extends new (...args: any[]) => any>(value: T): T { return value; }\n@replace class Store {}\nclass Uncalled {}\nexport function construct() { const unused = Uncalled; return new Store(); }',
    );
    expect(
      new Project({ tsConfigFilePath: configPath }).getPreEmitDiagnostics().map((d) => d.getMessageText()),
    ).toEqual([]);
    for (const [file, source] of fixture.sources)
      writeFileSync(
        join(runtime, file.replace(/\.ts$/, '.js')),
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText,
      );
    const ids = [
      ...escapes.flatMap(([id]) => [`${id}-false`, `${id}-true`]),
      ...expressions.map(([id]) => id),
      ...slices.map(([id]) => `slice-${id}`),
    ];
    executed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          `
      const results = {};
      for (const id of JSON.parse(process.argv[1])) {
        for (const key of Object.keys(require.cache)) delete require.cache[key];
        const paths = []; globalThis.fetch = path => { paths.push(path); return Promise.resolve({}); };
        const f = require(process.argv[2] + '/' + id + '.js').entry;
        results[id] = { value: id.startsWith('slice-') ? [[2,11],[5,11],[2,17]].map(args => f(...args)) : f(), paths };
      }
      process.stdout.write(JSON.stringify(results));
    `,
          JSON.stringify(ids),
          runtime,
        ],
        { encoding: 'utf8' },
      ),
    );
    await fixture.index({ allowExpensiveRebuild: true });
    const db = fixture.open();
    try {
      observations = (await collectRuntimeBoundaryGraph(db)).observations;
    } finally {
      db.close();
    }
  }, 30_000);
  afterAll(async () => {
    await fixture?.dispose();
    if (runtime) rmSync(runtime, { recursive: true, force: true });
  });

  function value(file: string) {
    const db = fixture.open();
    try {
      const root = getAst(db, file)!.rootNode;
      const probe = nodes(root).find(
        (node) => node.type === 'variable_declarator' && node.childForFieldName('name')?.text === 'probe',
      );
      return evaluateStaticValue({ db, file, root }, probe!.childForFieldName('value'));
    } finally {
      db.close();
    }
  }

  it.each(escapes)('qualifies objects escaping through %s', (id) => {
    for (const imported of [false, true]) {
      const name = `${id}-${imported}`;
      expect(executed[name]).toEqual({ value: '/right', paths: ['/right'] });
      expect(value(`${name}.ts`)).not.toMatchObject({ precision: 'literal', value: '/wrong' });
      for (const row of observations.filter((row) => row.owner.file === `${name}.ts`))
        if (row.valuePrecision === 'literal')
          expect(row.keyParts.find((part) => part.name === 'path')?.value).toBe('/right');
    }
  });

  it.each(expressions)('preserves precision through %s and runtime observations', (id, _expression, expected) => {
    expect(executed[id]!.value).toBe(expected);
    const evaluated = value(`${id}.ts`);
    if (id.endsWith('-control')) expect(evaluated).toMatchObject({ precision: 'literal', value: expected });
    if (evaluated?.precision === 'literal') expect(evaluated.value).toBe(expected);
    const direct = observations.filter(
      (row) => row.owner.file === `${id}.ts` && row.owner.name === 'direct' && row.action === 'http.request',
    );
    expect(direct.length).toBeGreaterThan(0);
    for (const row of direct) {
      const path = row.keyParts.find((part) => part.name === 'path');
      if (row.valuePrecision === 'literal') expect(path?.value).toBe(String(expected));
      if (!id.endsWith('-control')) expect(row.valuePrecision).not.toBe('literal');
    }
  });

  it.each(slices)('accounts for independently observed %s effects in a public slice', (id) => {
    const db = fixture.open();
    try {
      const result = dependenceSlice(db, `slice-${id}.ts:3`, { variable: 'value' });
      const output = executed[`slice-${id}`]!.value as number[];
      const influenced = ['input', 'other'].filter((_, index) => output[0] !== output[index + 1]);
      const represented = new Set(
        result.points.filter((point) => point.kind === 'parameter-definition').map((point) => point.name),
      );
      if (id.endsWith('-control')) expect(result.coverage.status).toBe('complete');
      if (result.coverage.status === 'complete')
        expect(influenced.filter((name) => !represented.has(name))).toEqual([]);
      else expect(result.coverage.model.unsupported.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('retains an implicit constructor invocation as a candidate without including an uncalled class', () => {
    const db = fixture.open();
    try {
      const graph = callGraph(db, 'construct')!;
      expect(graph.calleeEvidence).toContainEqual(
        expect.objectContaining({
          shortName: expect.stringContaining('Store'),
          evidenceSource: 'scip-declaration',
          evidenceStrength: 'candidate',
        }),
      );
      expect(graph.calleeEvidence?.some((row) => row.shortName.includes('Uncalled'))).toBe(false);
      expect(complexity(db, 'construct')).toMatchObject({ calleeCount: 0, candidateCalleeCount: 1 });
    } finally {
      db.close();
    }
  });
});
