import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphEvidenceResult } from '../../../src/queries/graph/graph-evidence.js';
import { IndexerHistoryFixture } from '../../properties/indexer-history-fixture.js';

const target = 'scip-typescript npm history-fixture 1.0.0 `target.ts`/target().';
const symbol = (name: string) => `scip-typescript npm history-fixture 1.0.0 \`calls.ts\`/${name}().`;
const directCallers = [
  'direct',
  'throughBarrel',
  'throughNamespace',
  'throughDefault',
  'throughStar',
  'multiline',
  'optionalCall',
].map(symbol);
const expectedCallers = [...directCallers, 'scip-typescript npm history-fixture 1.0.0 `target.ts`/sameFile().'].sort();

describe('incoming calls through the real compiler and public CLI', { timeout: 60_000 }, () => {
  let fixture: IndexerHistoryFixture;

  function cli(args: string[]): string {
    const env = { ...process.env };
    delete env['SCIP_QUERY_CACHE_DIR'];
    delete env['SCIP_QUERY_SESSION'];
    return execFileSync(process.execPath, [resolve('dist/cli.js'), ...args], {
      cwd: fixture.root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  function evidence(roots: string[], direction = 'incoming', extra: string[] = []): GraphEvidenceResult {
    const output = join(fixture.cache, 'call-evidence.json');
    cli([
      'evidence',
      ...roots.flatMap((root) => ['--symbol', root]),
      '--edge',
      'execution',
      '--subtype',
      'call',
      '--direction',
      direction,
      '--depth',
      '1',
      '--max-edges',
      '100',
      ...extra,
      '--json',
      '--json-output',
      output,
    ]);
    return JSON.parse(readFileSync(output, 'utf8')).result.graph;
  }

  beforeAll(() => {
    fixture = new IndexerHistoryFixture();
    writeFileSync(
      join(fixture.root, '.scipquery.json'),
      JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }),
    );
    fixture.write(
      'target.ts',
      'export function target<T = unknown>() { return 7; }\nexport function sameFile() { return target(); }\n',
    );
    fixture.write('barrel.ts', "export { target as renamed } from './target.js';\n");
    fixture.write('default-barrel.ts', "export { target as default } from './target.js';\n");
    fixture.write('star-barrel.ts', "export * from './barrel.js';\n");
    fixture.write(
      'calls.ts',
      [
        "import { target as alias } from './target.js';",
        "import { renamed } from './barrel.js';",
        "import * as owner from './target.js';",
        "import defaultTarget from './default-barrel.js';",
        "import { renamed as chained } from './star-barrel.js';",
        'export function direct() { return alias(); }',
        'export function throughBarrel() { return renamed(); }',
        'export function throughNamespace() { return owner.target(); }',
        'export function throughDefault() { return defaultTarget(); }',
        'export function throughStar() { return chained(); }',
        'export function multiline() {',
        '  return renamed<number>(',
        '  );',
        '}',
        'export function optionalCall() { return alias?.(); }',
        'export function shadowed(alias: () => number) { return alias(); }',
        'export function localShadow() { const alias = () => 99; return alias(); }',
        'export function memberDecoy() { const object = { target() { return 99; } }; return object.target(); }',
        'function unrelated() { return 99; }',
        'function retain(value: unknown, result: number) { return result; }',
        'export function referenceBesideCall() { return retain(alias, unrelated()); }',
        'export function callbackValue() { return alias; }',
        '',
      ].join('\n'),
    );
    fixture.write(
      'members.ts',
      [
        'export class A {',
        '  run() { return 1; }',
        '}',
        'export class B {',
        '  run() { return 2; }',
        '}',
        'export function both(a: A, b: B) { const marker = "😀"; a.run(); return b.run(); }',
        'export function valueOnly(run: (value: unknown) => void, a: A) { run(a.run); }',
        'export function recursive(n: number): number { return n > 0 ? recursive(n - 1) : 0; }',
        'export function unused() { return 0; } export function neighbor(a: A) { return a.run(); }',
        '',
      ].join('\n'),
    );
    cli(['reindex', '--allow-expensive-rebuild']);
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
  });

  it.each([1, 3])('preserves every independently expected direct caller at depth %i', (depth) => {
    const result = evidence([target], 'incoming', ['--depth', String(depth), '--full']);
    const calls = result.edges.filter((edge) => edge.to.symbol === target);
    expect(calls.map((edge) => edge.from.symbol).sort()).toEqual(expectedCallers);
    expect(calls.every((edge) => edge.evidenceStrength === 'exact')).toBe(true);
    expect(calls.every((edge) => edge.evidenceMethods?.includes('scip-occurrence-callsite'))).toBe(true);
    expect(result.coverage.omittedEdges).toBe(0);
  });

  it('agrees with outgoing resolution without using that direction as the expected-answer oracle', () => {
    const result = evidence(directCallers, 'outgoing');
    expect(
      result.edges
        .filter((edge) => edge.to.symbol === target)
        .map((edge) => edge.from.symbol)
        .sort(),
    ).toEqual([...directCallers].sort());
  });

  it('does not turn shadowed names, a member with the same name, or passed values into incoming calls', () => {
    const result = evidence([target]);
    const forbidden = ['shadowed', 'localShadow', 'memberDecoy', 'referenceBesideCall', 'callbackValue'].map(symbol);
    expect(result.edges.filter((edge) => forbidden.includes(edge.from.symbol ?? ''))).toEqual([]);
  });

  it('does not reintroduce name-only imported targets through the outgoing fallback', () => {
    const roots = ['shadowed', 'localShadow', 'memberDecoy', 'referenceBesideCall', 'callbackValue'].map(symbol);
    const result = evidence(roots, 'outgoing', ['--depth', '2']);
    expect(result.edges.filter((edge) => edge.to.symbol === target)).toEqual([]);
  });

  it.each(['A', 'B'])('keeps same-line member invocation bindings distinct for %s', (owner) => {
    const member = `scip-typescript npm history-fixture 1.0.0 \`members.ts\`/${owner}#run().`;
    const result = evidence([member]);
    expect(result.edges.filter((edge) => edge.to.symbol === member).map((edge) => edge.from.symbol)).toEqual([
      'scip-typescript npm history-fixture 1.0.0 `members.ts`/both().',
      ...(owner === 'A' ? ['scip-typescript npm history-fixture 1.0.0 `members.ts`/neighbor().'] : []),
    ]);
  });

  it('retains a recursive invocation within the target definition', () => {
    const recursive = 'scip-typescript npm history-fixture 1.0.0 `members.ts`/recursive().';
    const result = evidence([recursive]);
    expect(result.edges.map((edge) => [edge.from.symbol, edge.to.symbol])).toEqual([[recursive, recursive]]);
  });

  it('does not attribute a neighboring same-line function call to an unused function', () => {
    const unused = 'scip-typescript npm history-fixture 1.0.0 `members.ts`/unused().';
    const neighbor = 'scip-typescript npm history-fixture 1.0.0 `members.ts`/neighbor().';
    const member = 'scip-typescript npm history-fixture 1.0.0 `members.ts`/A#run().';
    const alone = evidence([unused], 'outgoing');
    expect(alone.edges).toEqual([]);
    const together = evidence([unused, neighbor], 'outgoing');
    expect(together.edges.map((edge) => [edge.from.symbol, edge.to.symbol])).toEqual([[neighbor, member]]);
  });

  it('preserves the complete caller set in recoverable folds when the output budget is small', () => {
    const bounded = evidence([target], 'incoming', ['--max-edges', '1']);
    expect(bounded.coverage).toMatchObject({
      status: 'bounded',
      matchedEdges: expectedCallers.length,
      returnedEdges: 1,
    });
    const callers = bounded.edges.map((edge) => edge.from.symbol);
    for (const fold of bounded.folds ?? []) {
      const expanded = evidence([target], 'incoming', ['--max-edges', '1', '--fold', fold.id]);
      callers.push(...expanded.edges.map((edge) => edge.from.symbol));
    }
    expect(callers.sort()).toEqual(expectedCallers);
  });
});
