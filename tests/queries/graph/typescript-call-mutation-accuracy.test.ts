import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setImmediate as yieldToRunner } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ts } from '@ts-morph/common';
import type { GraphEvidenceResult } from '../../../src/queries/graph/graph-evidence.js';
import { IndexerHistoryFixture } from '../../properties/indexer-history-fixture.js';
import { collectRuntimeBoundaryGraph } from '../../../src/analysis/runtime-boundaries/graph.js';
import { scipOccurrenceCallTargetsForRange } from '../../../src/symbols/graph/scip-occurrence-call-targets.js';

const cases = [
  ['unchanged', '', 'service.run()', true],
  ['siblingWrite', 'service.count++;', 'service.run()', true],
  ['nestedSiblingWrite', 'service.nested.count++;', 'service.nested.run()', true],
  ['aliasSiblingWrite', 'const alias = service; alias.count++;', 'service.run()', true],
  ['methodWrite', 'service.run = () => 2;', 'service.run()', false],
  ['aliasMethodWrite', 'const alias = service; alias.run = () => 2;', 'service.run()', false],
  ['parenthesizedWrite', '(service).run = () => 2;', 'service.run()', false],
  ['assertedWrite', '(service as typeof service).run = () => 2;', 'service.run()', false],
  ['satisfiesWrite', '(service satisfies typeof service).run = () => 2;', 'service.run()', false],
  ['parenthesizedCall', 'service.run = () => 2;', '(service).run()', false],
  ['assertedCall', 'service.run = () => 2;', '(service as typeof service).run()', false],
  ['wrappedAliasWrite', 'const alias = (service); alias.run = () => 2;', 'service.run()', false],
  ['assertedAliasWrite', 'const alias = service as typeof service; alias.run = () => 2;', 'service.run()', false],
  ['nestedParentWrite', 'service.nested = { count: 0, run() { return 2; } };', 'service.nested.run()', false],
  ['computedSiblingWrite', 'service["count"]++;', 'service["run"]()', true],
  ['computedMethodWrite', 'service["run"] = () => 2;', 'service.run()', false],
  ['destructuredSiblingWrite', '({ count: service.count } = { count: 1 });', 'service.run()', true],
  ['destructuredMethodWrite', '({ run: service.run } = { run: () => 2 });', 'service.run()', false],
  ['memberAliasSiblingWrite', 'const alias = service.nested; alias.count++;', 'service.nested.run()', true],
  ['memberAliasMethodWrite', 'const alias = service.nested; alias.run = () => 2;', 'service.nested.run()', false],
  ['unrelatedNestedWrite', 'service.nested.count++;', 'service.run()', true],
  ['nonNullWrite', 'service!.run = () => 2;', 'service.run()', false],
  ['typeAssertionWrite', '(<typeof service>service).run = () => 2;', 'service.run()', false],
  ['letAliasWrite', 'let alias = service; alias.run = () => 2;', 'service.run()', false],
  ['varAliasWrite', 'var alias = service; alias.run = () => 2;', 'service.run()', false],
  ['letAliasSiblingWrite', 'let alias = service; alias.count++;', 'service.run()', true],
  ['assignedAliasWrite', 'let alias; alias = service; alias.run = () => 2;', 'service.run()', false],
  [
    'reassignedAliasWrite',
    'let alias = { run() { return 0; } }; alias = service; alias.run = () => 2;',
    'service.run()',
    false,
  ],
  [
    'reassignedAwayAfterWrite',
    'let alias: { run(): number } = service; alias.run = () => 2; alias = { run() { return 0; } };',
    'service.run()',
    false,
  ],
  ['destructuredMemberWrite', 'const { nested: alias } = service; alias.run = () => 2;', 'service.nested.run()', false],
  ['destructuredAliasSiblingWrite', 'const { nested: alias } = service; alias.count++;', 'service.nested.run()', true],
  [
    'destructuredNestedWrite',
    'const { nested: { run: original } } = service; service.nested.run = () => 2;',
    'service.nested.run()',
    false,
  ],
] as const;

const caller = (name: string, file = 'mutations.ts') =>
  `scip-typescript npm history-fixture 1.0.0 \`${file}\`/${name}().`;

describe('TypeScript call accuracy after member writes', { timeout: 60_000 }, () => {
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

  function evidence(
    name: string,
    file = 'mutations.ts',
    direction = 'outgoing',
    symbol = caller(name, file),
  ): GraphEvidenceResult {
    const output = join(fixture.cache, `${name}.json`);
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
    // The history fixture omits standard libraries for small indexer state tests.
    // These public accuracy checks also require real external compiler references.
    const tsconfigPath = join(fixture.root, 'tsconfig.json');
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    delete tsconfig.compilerOptions.noLib;
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
    writeFileSync(
      join(fixture.root, '.scipquery.json'),
      JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }),
    );
    fixture.write(
      'mutations.ts',
      cases
        .map(([name, mutation, call]) =>
          [
            `class Nested_${name} { count = 0; run() { return 1; } }`,
            `class Service_${name} { count = 0; run() { return 1; } other() { return 2; } nested = new Nested_${name}(); }`,
            `const service_${name} = new Service_${name}();`,
            `export function ${name}() {`,
            `  const service = service_${name};`,
            `  ${mutation}`,
            `  return ${call};`,
            '}',
          ].join('\n'),
        )
        .join('\n'),
    );
    fixture.write(
      'objects.ts',
      [
        'export const left = { run() { return 1; }, nested: { run() { return 3; } } };',
        'const right = { run() { return 2; } };',
        'export function leftCall() { return left.run(); }',
        'export function rightCall() { return right.run(); }',
        'export function nestedCall() { return left.nested.run(); }',
        'export function localCall() { const local = { run() { return 4; } }; return local.run(); }',
        'export function computedTarget(key: "run" | "nested" = "run") { const object = { run() { return 1; }, nested() { return 2; } }; return object[key](); }',
      ].join('\n'),
    );
    fixture.write(
      'object-consumer.ts',
      'import { left } from "./objects.js";\nexport function importedCall() { return left.run(); }\n',
    );
    fixture.write(
      'route-constants.ts',
      [
        'export const route = { path: "/imported", count: 0 }; route.count++;',
        'export const replaced = { path: "/obsolete" }; (replaced as typeof replaced).path = "/replacement";',
        'export const mutableReplaced = { path: "/obsolete-alias" }; let alias; alias = mutableReplaced; alias.path = "/replacement";',
        'export const mutableSibling = { path: "/kept-alias", count: 0 }; let sibling = mutableSibling; sibling.count++;',
      ].join('\n'),
    );
    fixture.write(
      'route-consumer.ts',
      [
        'import { route, replaced, mutableReplaced, mutableSibling } from "./route-constants.js";',
        'import * as routes from "./route-constants.js";',
        'export function directRoute() { fetch(route.path); }',
        'export function namespaceRoute() { fetch(routes.route.path); }',
        'export function replacedRoute() { fetch(replaced.path); }',
        'export function mutableReplacedRoute() { fetch(mutableReplaced.path); }',
        'export function mutableSiblingRoute() { fetch(mutableSibling.path); }',
      ].join('\n'),
    );
    fixture.write(
      'handlers.ts',
      [
        'import { HttpApiBuilder } from "effect/unstable/httpapi";',
        'declare const Api: unknown;',
        'function unchangedHandler() { return 1; }',
        'function replacedHandler() { return 1; }',
        'replacedHandler = () => 2;',
        'let variableHandler = () => 1;',
        'variableHandler = () => 2;',
        'export const registrations = HttpApiBuilder.group(Api, "session", (handlers: any) =>',
        '  handlers.handle("unchanged", unchangedHandler).handle("replaced", replacedHandler).handle("variable", variableHandler)',
        ');',
      ].join('\n'),
    );
    fixture.write(
      'receivers.ts',
      [
        'export class Unchanged { run() { return 1; } execute() { return this.run(); } }',
        'export class Replaced { run() { return 1; } execute() { this.run = () => 2; return this.run(); } }',
        'export class Sibling { count = 0; run() { return 1; } execute() { this.count++; return this.run(); } }',
        'export class Aliased { run() { return 1; } execute() { const receiver = this; receiver.run = () => 2; return this.run(); } }',
        'export class Arrow { run() { return 1; } execute() { const replace = () => { this.run = () => 2; }; replace(); return this.run(); } }',
        'export class Separate { run() { return 1; } execute() { function separate(this: Separate) { this.run = () => 2; } return this.run(); } }',
      ].join('\n'),
    );
    fixture.write(
      'callables.ts',
      [
        'export function original() { return 1; }',
        'export function other() { return 2; }',
        'export function factory() { return original; }',
        'export function retain(callback: () => number) { return callback; }',
        'export function invokeReturned() { return factory()(); }',
        'export function invokeParameter(callback: () => number) { return callback(); }',
        'export function passArgument() { return retain(original); }',
        'export function invokeConditional(flag: boolean) { return (flag ? original : other)(); }',
        'export function invokeIife() { return (() => 3)(); }',
        'export function invokeAsserted() { return (<typeof original>original)(); }',
        'export function invokeAliasParameter(callback: () => number) { const alias = callback; return alias(); }',
        'export function invokeDestructuredParameter({ callback }: { callback(): number }) { return callback(); }',
        'export function invokeExternal() { return Math.max(1, 2); }',
      ].join('\n'),
    );
    cli(['reindex', '--allow-expensive-rebuild']);
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
  });

  // Synchronous CLI calls must yield between cases so the runner can flush worker updates.
  afterEach(() => yieldToRunner());

  it.each(cases)(
    '%s preserves unchanged declaration leads and withholds replaced method targets',
    (name, _mutation, _call, established) => {
      const graph = evidence(name);
      const className = _call.includes('nested') ? 'Nested' : 'Service';
      const target = `scip-typescript npm history-fixture 1.0.0 \`mutations.ts\`/${className}_${name}#run().`;
      const calls = graph.edges.filter((edge) => edge.subtype === 'call' && edge.from.symbol === caller(name));
      expect(
        calls,
        `${name}: expected ${established ? 'one original method call' : 'no call to the replaced method'}`,
      ).toHaveLength(established ? 1 : 0);
      if (established) {
        expect(calls[0]?.to.symbol).toBe(target);
        expect(calls[0]?.evidenceStrength).toBe('candidate');
        expect(graph.coverage.blindSpots).toContainEqual(
          expect.stringContaining('Runtime implementation remains unresolved'),
        );
      } else {
        expect(
          graph.coverage.blindSpots.some((reason) =>
            reason.includes('has no established repository implementation target'),
          ),
        ).toBe(true);
      }
      const incoming = evidence(name, 'mutations.ts', 'incoming', target);
      expect(incoming.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.from.symbol)).toEqual(
        established ? [caller(name)] : [],
      );
    },
  );

  it.each(['leftCall', 'rightCall', 'nestedCall', 'localCall'])(
    'resolves the object-literal method called by %s',
    (name) => {
      const graph = evidence(name, 'objects.ts');
      const calls = graph.edges.filter(
        (edge) => edge.subtype === 'call' && edge.from.symbol === caller(name, 'objects.ts'),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.to.label).toContain('run');
      expect(calls[0]?.evidenceStrength).toBe('candidate');
      expect(graph.coverage.blindSpots).toContainEqual(
        expect.stringContaining('Runtime implementation remains unresolved'),
      );
      const incoming = evidence(name, 'objects.ts', 'incoming', calls[0]!.to.symbol!);
      const expected = [caller(name, 'objects.ts')];
      if (name === 'leftCall') expected.push(caller('importedCall', 'object-consumer.ts'));
      expect(
        incoming.edges
          .filter((edge) => edge.subtype === 'call')
          .map((edge) => edge.from.symbol)
          .sort(),
      ).toEqual(expected.sort());
    },
  );

  it('discloses a computed member invocation without treating its index variable as the called function', () => {
    const graph = evidence('computedTarget', 'objects.ts');
    expect(graph.edges.filter((edge) => edge.subtype === 'call')).toHaveLength(0);
    expect(graph.coverage.blindSpots.some((reason) => reason.includes('Invocation object[key]'))).toBe(true);
  });

  it('executes the mutation fixtures and observes the original or replacement result independently of the graph', () => {
    const runtime = join(fixture.cache, 'mutations.cjs');
    writeFileSync(
      runtime,
      ts.transpileModule(fixture.sources.get('mutations.ts')!, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
    const results = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          'const suite = require(process.argv[1]); const names = JSON.parse(process.argv[2]); process.stdout.write(JSON.stringify(names.map(name => suite[name]())));',
          runtime,
          JSON.stringify(cases.map(([name]) => name)),
        ],
        { encoding: 'utf8', timeout: 10_000 },
      ),
    );
    expect(results).toEqual(cases.map(([, , , established]) => (established ? 1 : 2)));
  });

  it('retains unchanged imported member values and rejects replaced values for runtime consumers', async () => {
    const db = fixture.open();
    try {
      const graph = await collectRuntimeBoundaryGraph(db);
      const pathFor = (name: string) =>
        graph.observations
          .find((item) => item.action === 'http.request' && item.owner.name === name)
          ?.keyParts.find((part) => part.name === 'path')?.value;
      expect(pathFor('directRoute')).toBe('/imported');
      expect(pathFor('namespaceRoute')).toBe('/imported');
      expect(pathFor('replacedRoute')).toBeDefined();
      expect(pathFor('replacedRoute')).not.toBe('/obsolete');
      expect(pathFor('mutableReplacedRoute')).toBeDefined();
      expect(pathFor('mutableReplacedRoute')).not.toBe('/obsolete-alias');
      expect(pathFor('mutableSiblingRoute')).toBe('/kept-alias');
    } finally {
      db.close();
    }
  });

  it('does not register a replaced callback implementation as an exact runtime handler', async () => {
    const db = fixture.open();
    try {
      const graph = await collectRuntimeBoundaryGraph(db);
      const handler = (operation: string) =>
        graph.observations.find(
          (item) =>
            item.action === 'framework.handle' &&
            item.keyParts.some((part) => part.name === 'operation' && part.value === operation),
        );
      expect(handler('unchanged')?.owner.symbol).toBe(caller('unchangedHandler', 'handlers.ts'));
      expect(handler('unchanged')?.strength).toBe('exact');
      expect(handler('replaced')?.strength).toBe('candidate');
      expect(handler('replaced')?.owner.symbol).not.toBe(caller('replacedHandler', 'handlers.ts'));
      expect(handler('variable')?.strength).toBe('candidate');
    } finally {
      db.close();
    }
  });

  it.each([
    ['Unchanged', true],
    ['Replaced', false],
    ['Sibling', true],
    ['Aliased', false],
    ['Arrow', false],
    ['Separate', true],
  ] as const)('tracks the receiver of %s without merging separate function receivers', (name, established) => {
    const prefix = `scip-typescript npm history-fixture 1.0.0 \`receivers.ts\`/${name}#`;
    const graph = evidence(name, 'receivers.ts', 'outgoing', `${prefix}execute().`);
    const calls = graph.edges.filter((edge) => edge.subtype === 'call' && edge.to.symbol === `${prefix}run().`);
    expect(calls).toHaveLength(established ? 1 : 0);
    if (!established)
      expect(graph.coverage.blindSpots.some((reason) => reason.includes('Invocation this.run'))).toBe(true);
    const incoming = evidence(name, 'receivers.ts', 'incoming', `${prefix}run().`);
    expect(incoming.edges.filter((edge) => edge.subtype === 'call')).toHaveLength(established ? 1 : 0);
  });

  it.each([
    ['invokeReturned', 'factory()', ['factory']],
    ['invokeParameter', 'callback', []],
    ['invokeAliasParameter', 'alias', []],
    ['invokeDestructuredParameter', 'callback', []],
    ['invokeConditional', 'flag ? original : other', []],
    ['invokeIife', '() => 3', []],
  ] as const)('discloses the unresolved invocation in %s', (name, invocation, expected) => {
    const graph = evidence(name, 'callables.ts');
    expect(graph.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.to.symbol)).toEqual(
      expected.map((target) => caller(target, 'callables.ts')),
    );
    expect(
      graph.coverage.blindSpots.some((reason) => reason.includes(`Invocation ${invocation}`)),
      graph.coverage.blindSpots.join('\n'),
    ).toBe(true);
  });

  it('does not turn a passed callable value into an invocation', () => {
    const graph = evidence('passArgument', 'callables.ts');
    expect(graph.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.to.symbol)).toEqual([
      caller('retain', 'callables.ts'),
    ]);
  });

  it('preserves the distinction between a local callback and an external library implementation', () => {
    const graph = evidence('invokeExternal', 'callables.ts');
    expect(graph.coverage.blindSpots.some((reason) => reason.includes('Compiler reference for Math.max'))).toBe(true);
  });

  it('keeps a callback parameter unresolved instead of counting its declaration as an implementation', () => {
    const db = fixture.open();
    try {
      const targets = scipOccurrenceCallTargetsForRange(db, 'callables.ts', 5, 5);
      expect(
        targets.targets.map((target) => ({
          symbol: target.definition.symbol,
          callable: target.definition.isFunctionLike,
        })),
      ).toEqual([]);
      expect(targets.unresolvedCallsites).toBe(1);
    } finally {
      db.close();
    }
  });

  it('retains direct calls through angle-bracket type assertions', () => {
    const graph = evidence('invokeAsserted', 'callables.ts');
    expect(graph.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.to.symbol)).toEqual([
      caller('original', 'callables.ts'),
    ]);
  });

  it('executes the receiver and callable fixtures independently of the index', () => {
    for (const [file, expression, expected] of [
      [
        'receivers',
        '["Unchanged", "Replaced", "Sibling", "Aliased", "Arrow", "Separate"].map(name => new suite[name]().execute())',
        [1, 2, 1, 2, 2, 1],
      ],
      [
        'callables',
        '[suite.invokeReturned(), suite.invokeParameter(() => 5), suite.invokeConditional(true), suite.invokeConditional(false), suite.invokeIife(), suite.invokeAsserted(), suite.passArgument()()]',
        [1, 5, 1, 2, 3, 1, 1],
      ],
    ] as const) {
      const runtime = join(fixture.cache, `${file}.cjs`);
      writeFileSync(
        runtime,
        ts.transpileModule(fixture.sources.get(`${file}.ts`)!, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      );
      const actual = execFileSync(
        process.execPath,
        ['-e', `const suite = require(process.argv[1]); process.stdout.write(JSON.stringify(${expression}));`, runtime],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(JSON.parse(actual)).toEqual(expected);
    }
  });

  it('keeps imported object method targets equal after incremental edits and a clean rebuild', async () => {
    writeFileSync(
      join(fixture.root, '.scipquery.json'),
      JSON.stringify({
        dbPath: '.cache',
        watch: { enabled: true, debounceMs: 600_000, idleTimeoutMs: 0, allowExpensiveRebuild: true },
      }),
    );
    fixture.startService();
    const source = fixture.sources.get('objects.ts')!;
    fixture.write('objects.ts', source.replace('return 1;', 'return 10;'));
    await fixture.index({ allowExpensiveRebuild: true });
    expect(
      fixture.statuses.some((status) => status.startsWith('Incremental TypeScript index emitted')),
      fixture.statuses.join('\n'),
    ).toBe(true);
    const incremental = evidence('importedCall', 'object-consumer.ts');
    expect(incremental.edges.filter((edge) => edge.subtype === 'call')).toHaveLength(1);
    await fixture.index({ force: true, allowExpensiveRebuild: true });
    expect(evidence('importedCall', 'object-consumer.ts')).toEqual(incremental);
  });
});
