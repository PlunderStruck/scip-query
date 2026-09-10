import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setImmediate as yieldToRunner } from 'node:timers/promises';
import { ts } from '@ts-morph/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GraphEvidenceResult } from '../../../src/queries/graph/graph-evidence.js';
import { runtimeCallableDefinition } from '../../../src/analysis/runtime-boundaries/binding-identity.js';
import { getAst } from '../../../src/source/ast/ast-core.js';
import { evaluateStaticValue } from '../../../src/symbols/graph/static-value-flow.js';
import { IndexerHistoryFixture } from '../../properties/indexer-history-fixture.js';

const cases = [
  ['objectReference', 'const box = { value: service }; box.value.run = () => 2;', false, false],
  ['objectShorthand', 'const box = { service }; box.service.run = () => 2;', false, false],
  ['arrayReference', 'const box = [service]; box[0]!.run = () => 2;', false, false],
  ['arrayDestructure', 'const [alias] = [service]; alias!.run = () => 2;', false, false],
  ['objectDestructure', 'const { value: alias } = { value: service }; alias.run = () => 2;', false, false],
  ['objectSlot', 'const box = { value: service }; box.value = other;', false, true],
  ['arraySlot', 'const box = [service]; box[0] = other;', false, true],
  ['objectSibling', 'const box = { value: service }; box.value.count++;', false, true],
  [
    'assignedSlot',
    'const box: { value?: typeof service } = {}; box.value = service; box.value.run = () => 2;',
    false,
    false,
  ],
  ['spreadNested', 'const copy = { ...service }; copy.nested.run = () => 2;', true, false],
  ['spreadSlot', 'const copy = { ...service }; copy.nested = other.nested;', true, true],
  ['spreadSibling', 'const copy = { ...service }; copy.nested.count++;', true, true],
  ['restNested', 'const { ...copy } = service; copy.nested.run = () => 2;', true, false],
  ['restSlot', 'const { ...copy } = service; copy.nested = other.nested;', true, true],
  [
    'methodMetadata',
    'const method = service.run as typeof service.run & { tag?: number }; method.tag = 2;',
    false,
    true,
  ],
  [
    'methodNestedMetadata',
    'const method = service.run as typeof service.run & { cache?: { value: number } }; method.cache = { value: 2 };',
    false,
    true,
  ],
] as const;

const functionSymbol = (name: string, file = 'containers.ts') =>
  `scip-typescript npm history-fixture 1.0.0 \`${file}\`/${name}().`;

describe('TypeScript container and imported callable accuracy', { timeout: 60_000 }, () => {
  let fixture: IndexerHistoryFixture;

  function cli(args: string[]): void {
    const env = { ...process.env };
    delete env['SCIP_QUERY_CACHE_DIR'];
    delete env['SCIP_QUERY_SESSION'];
    execFileSync(process.execPath, [resolve('dist/cli.js'), ...args], {
      cwd: fixture.root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  function evidence(symbol: string, direction = 'outgoing'): GraphEvidenceResult {
    const output = join(fixture.cache, 'container-evidence.json');
    cli([
      'evidence',
      '--symbol',
      symbol,
      '--edge',
      'execution',
      '--direction',
      direction,
      '--depth',
      '1',
      '--max-edges',
      '100',
      '--full',
      '--json',
      '--json-output',
      output,
    ]);
    return JSON.parse(readFileSync(output, 'utf8')).result.graph;
  }

  beforeAll(() => {
    fixture = new IndexerHistoryFixture();
    const configPath = join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.compilerOptions.noLib;
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(
      join(fixture.root, '.scipquery.json'),
      JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }),
    );
    fixture.write(
      'containers.ts',
      cases
        .map(([name, mutation, nested]) =>
          [
            `class Nested_${name} { count = 0; run() { return 1; } }`,
            `class Service_${name} { count = 0; run() { return 1; } nested = new Nested_${name}(); }`,
            `const service_${name} = new Service_${name}(); const other_${name} = new Service_${name}();`,
            `export function ${name}() {`,
            `  const service = service_${name}; const other = other_${name};`,
            `  ${mutation}`,
            `  return service.${nested ? 'nested.' : ''}run();`,
            '}',
          ].join('\n'),
        )
        .join('\n'),
    );
    fixture.write(
      'exports.ts',
      [
        'export function stable() { return 1; }',
        'export function replaced() { return 1; }',
        'replaced = () => 2;',
        'export const object = { run() { return 1; } };',
        'object.run = () => 2;',
        'export function stablePath() { return "/stable"; }',
        'export async function asyncPath() { return "/async"; }',
        'export function* generatorPath() { return "/generator"; }',
        'export function conditionalPath() { if (Date.now()) return "/conditional"; }',
        'export function replacedPath() { return "/obsolete"; }',
        'replacedPath = () => "/replacement";',
        'export const routes = { path: "/stable", count: 0 }; routes.count++;',
        'export const changedRoutes = { path: "/obsolete" }; changedRoutes.path = "/replacement";',
      ].join('\n'),
    );
    fixture.write('barrel.ts', 'export * from "./exports.js";\n');
    fixture.write(
      'imports.ts',
      [
        'import { stable, replaced, object } from "./barrel.js";',
        'import * as namespace from "./barrel.js";',
        'export function stableCall() { return stable(); }',
        'export function replacedCall() { return replaced(); }',
        'export function objectCall() { return object.run(); }',
        'export function namespaceStableCall() { return namespace.stable(); }',
        'export function namespaceReplacedCall() { return namespace.replaced(); }',
        'export function namespaceObjectCall() { return namespace.object.run(); }',
        'export function bracketStableCall() { return namespace["stable"](); }',
        'export function bracketObjectCall() { return namespace["object"]["run"](); }',
        'const alias = object;',
        'export function aliasObjectCall() { return alias.run(); }',
      ].join('\n'),
    );
    fixture.write(
      'values.ts',
      [
        'import { stablePath, replacedPath, routes, changedRoutes, asyncPath, generatorPath, conditionalPath } from "./barrel.js";',
        'import * as namespace from "./barrel.js";',
        'export const stableReturn = stablePath();',
        'export const changedReturn = replacedPath();',
        'export const asyncReturn = asyncPath();',
        'export const generatorReturn = generatorPath();',
        'export const conditionalReturn = conditionalPath();',
        'export const stableBracket = routes["path"];',
        'export const changedBracket = changedRoutes["path"];',
        'export const namespaceBracket = namespace["routes"]["path"];',
        'export const namespaceChangedBracket = namespace["changedRoutes"]["path"];',
      ].join('\n'),
    );
    cli(['reindex', '--allow-expensive-rebuild']);
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
  });
  afterEach(() => yieldToRunner());

  it.each(cases)('%s distinguishes a slot from the referenced object', (name, _mutation, nested, retained) => {
    const graph = evidence(functionSymbol(name));
    const target = `scip-typescript npm history-fixture 1.0.0 \`containers.ts\`/${nested ? 'Nested' : 'Service'}_${name}#run().`;
    const calls = graph.edges.filter((edge) => edge.subtype === 'call');
    expect(calls.map((edge) => edge.to.symbol)).toEqual(retained ? [target] : []);
    if (!retained)
      expect(
        graph.coverage.blindSpots.some((reason) =>
          reason.includes('has no established repository implementation target'),
        ),
      ).toBe(true);
    const incoming = evidence(target, 'incoming');
    expect(incoming.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.from.symbol)).toEqual(
      retained ? [functionSymbol(name)] : [],
    );
  });

  it('keeps incoming imported calls consistent with the outgoing targets', () => {
    const replaced = evidence(functionSymbol('replaced', 'exports.ts'), 'incoming');
    expect(replaced.edges.filter((edge) => edge.subtype === 'call')).toEqual([]);
    const stable = evidence(functionSymbol('stable', 'exports.ts'), 'incoming');
    expect(
      stable.edges
        .filter((edge) => edge.subtype === 'call')
        .map((edge) => edge.from.symbol)
        .sort(),
    ).toEqual(
      ['stableCall', 'namespaceStableCall', 'bracketStableCall']
        .map((name) => functionSymbol(name, 'imports.ts'))
        .sort(),
    );
  });

  it.each([
    ['stableCall', true],
    ['replacedCall', false],
    ['objectCall', false],
    ['namespaceStableCall', true],
    ['namespaceReplacedCall', false],
    ['namespaceObjectCall', false],
    ['bracketStableCall', true],
    ['bracketObjectCall', false],
    ['aliasObjectCall', false],
  ] as const)('%s checks the imported value beyond its re-export', (name, retained) => {
    const graph = evidence(functionSymbol(name, 'imports.ts'));
    expect(graph.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.to.symbol)).toEqual(
      retained ? [functionSymbol('stable', 'exports.ts')] : [],
    );
    if (!retained)
      expect(
        graph.coverage.blindSpots.some((reason) =>
          reason.includes('has no established repository implementation target'),
        ),
      ).toBe(true);
  });

  it.each([
    ['stableCall', true],
    ['replacedCall', false],
  ] as const)('%s applies the same imported-write guard to runtime callbacks', (name, retained) => {
    const db = fixture.open();
    try {
      const root = getAst(db, 'imports.ts')!.rootNode;
      const callable = root.namedChildren
        .flatMap((node) => node.namedChildren)
        .find((node) => node.childForFieldName('name')?.text === name)!;
      const target = callable.childForFieldName('body')!.namedChild(0)!.namedChild(0)!.childForFieldName('function')!;
      const resolved = runtimeCallableDefinition(
        {
          db,
          file: 'imports.ts',
          source: root.text,
          root,
          ownerAt: () => {
            throw new Error('Owner lookup is not needed to identify a callback');
          },
        },
        target,
      );
      expect(resolved?.symbol ?? null).toBe(retained ? functionSymbol('stable', 'exports.ts') : null);
    } finally {
      db.close();
    }
  });

  it.each([
    ['stableReturn', true],
    ['changedReturn', false],
    ['asyncReturn', false],
    ['generatorReturn', false],
    ['conditionalReturn', false],
    ['stableBracket', true],
    ['changedBracket', false],
    ['namespaceBracket', true],
    ['namespaceChangedBracket', false],
  ] as const)('%s evaluates imported values without retaining overwritten values', (name, retained) => {
    const db = fixture.open();
    try {
      const root = getAst(db, 'values.ts')!.rootNode;
      const declaration = root.namedChildren
        .flatMap((node) => node.namedChildren)
        .flatMap((node) => node.namedChildren)
        .find((node) => node.childForFieldName('name')?.text === name)!;
      const value = evaluateStaticValue({ db, file: 'values.ts', root }, declaration.childForFieldName('value'));
      expect(value?.precision, JSON.stringify(value)).toBe(retained ? 'literal' : 'unknown');
      if (retained) expect(value?.value).toBe('/stable');
    } finally {
      db.close();
    }
  });

  it('executes the container cases independently of graph interpretation', () => {
    const output = join(fixture.cache, 'containers.cjs');
    writeFileSync(
      output,
      ts.transpileModule(fixture.sources.get('containers.ts')!, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
    const actual = execFileSync(
      process.execPath,
      [
        '-e',
        'const suite = require(process.argv[1]); process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map(name => suite[name]())));',
        output,
        JSON.stringify(cases.map(([name]) => name)),
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(JSON.parse(actual)).toEqual(cases.map(([, , , retained]) => (retained ? 1 : 2)));
  });

  it('invalidates and restores imported targets equally after incremental edits and full rebuilds', async () => {
    writeFileSync(
      join(fixture.root, '.scipquery.json'),
      JSON.stringify({
        dbPath: '.cache',
        watch: { enabled: true, debounceMs: 600_000, idleTimeoutMs: 0, allowExpensiveRebuild: true },
      }),
    );
    fixture.startService();
    const source = fixture.sources.get('exports.ts')!;
    for (const mutated of [true, false]) {
      fixture.write('exports.ts', source + (mutated ? '\nstable = () => 2;\n' : '\n'));
      await fixture.index({ allowExpensiveRebuild: true });
      expect(
        fixture.statuses.some((status) => status.startsWith('Incremental TypeScript index emitted')),
        fixture.statuses.join('\n'),
      ).toBe(true);
      const incremental = evidence(functionSymbol('stableCall', 'imports.ts'));
      expect(incremental.edges.filter((edge) => edge.subtype === 'call')).toHaveLength(mutated ? 0 : 1);
      await fixture.index({ force: true, allowExpensiveRebuild: true });
      expect(evidence(functionSymbol('stableCall', 'imports.ts'))).toEqual(incremental);
    }
  });
});
