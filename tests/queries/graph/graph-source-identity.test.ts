import { systemMap } from '../../../src/queries/graph/system-map.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphEvidence, type GraphEvidenceResult } from '../../../src/queries/graph/graph-evidence.js';
import { IndexerHistoryFixture } from '../../properties/indexer-history-fixture.js';

describe('public graph source identity', { timeout: 60_000 }, () => {
  let fixture: IndexerHistoryFixture;
  const symbol = (name: string) => `scip-typescript npm history-fixture 1.0.0 \`identity.ts\`/${name}`;

  function cli(args: string[]) {
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

  function evidence(roots: string[], families: string[], direction = 'outgoing'): GraphEvidenceResult {
    const output = join(fixture.cache, 'identity-evidence.json');
    cli([
      'evidence',
      ...roots.flatMap((root) =>
        root.startsWith('literal:')
          ? ['--search', root.slice(8)]
          : ['--symbol', root.startsWith('scip-') ? root : symbol(root)],
      ),
      ...families.flatMap((family) => ['--edge', family]),
      '--direction',
      direction,
      '--depth',
      '1',
      '--max-edges',
      '200',
      '--full',
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
    fixture.write('base.ts', 'export class ExternalBase { constructor() {} }\n');
    fixture.write('reexport.ts', 'export { ExternalBase as RenamedBase } from "./base.js";\n');
    fixture.write(
      'identity.ts',
      [
        'export function target() { return 7; }',
        'function replaced() { return 1; } function replacement() { return 2; }',
        'export function afterReplacement() { replaced = replacement; return replaced(); }',
        'export function heldTarget() { return 9; }',
        'export function holderLeft() { return 0; } export function holderRight() { return heldTarget; }',
        'export function heldMixed() { return 3; }',
        'export function stored() { return heldMixed; } export function invoked() { return heldMixed(); }',
        'export function referencesOnly() { return stored(); }',

        'export function outer() { function inner() { return target(); } return inner; }',
        'export function first() { return 1; } export function second() { return 2; }',
        'export const unusedArrow = () => 0; export const activeArrow = () => target();',
        'export function closures() { return [() => target(), () => target()]; }',
        'export function left(state: { left: number }) { state.left = 1; } export function right(state: { right: number }) { state.right = 2; }',
        'export class Box { constructor() { target(); } }',
        'export class Child extends Box { constructor() { super(); } }',
        'export function create() { return new Box(); }',
        'export function deferred(state: { hidden: number }) {',
        '  return async () => { state.hidden = 1; await target(); state.hidden = 2; };',
        '}',
        'export function repeatedReturns(flag: boolean) { if (flag) return 1; return 1; }',
        'export function repeatedWrites(state: { value: number }) { state.value = 1; state.value = 1; }',
        'export function equalFirst() { return 1; } export function equalSecond() { return 1; }',
        'export function shadowedState(state: { value: number }) {',
        '  state.value = 1;',
        '  { const state = { value: 0 }; state.value = 2; }',
        '  state.value = 3;',
        '}',
        'export async function returnBeforeWrite(flag: boolean, state: { value: number }) {',
        '  if (flag) { return await target(); }',
        '  state.value = 1;',
        '}',
        'export function dataFirst(alpha: number) { const a = alpha; return a; } export function dataSecond(beta: number) { const b = beta; return b; }',
        'export function receiveA(value: number) { return value; }',
        'export function receiveB(value: number) { return value; }',
        'export function relay(input: number) { receiveA(input); receiveB(input); }',
        'export function shadowedRelay(input: number) { { const input = 3; receiveA(input); } }',
        'export function repeatedRelay(input: number) { receiveA(input); receiveA(input); }',
        'export function noParameters() {}',
        'export function variadic(...values: number[]) { return values; }',
        'export function withDefault(value = 7) { return value; }',
        'export function trickyArguments(input: any) { noParameters(input); variadic(input); withDefault(input); }',
        'export function captureFactory(value: number) {',
        '  return function captured(state: { value: number }, ignored: { value: string }) {',
        '    { const value = 2; state.value = value; }',
        '    state.value = value;',
        '  };',
        '}',
        'import { RenamedBase as ImportedBase } from "./reexport.js";',
        'export class AliasedChild extends ImportedBase { constructor() { super(); } }',
        'export class Middle extends Box {}',
        'export class GrandChild extends Middle { constructor() { super(); } }',
        'export class Empty {}',
        'export class EmptyChild extends Empty { constructor() { super(); } }',
        'declare const chooseBase: boolean;',
        'export class DynamicChild extends (chooseBase ? Box : Empty) { constructor() { super(); } }',
        'export function literalLeft() { return "left-marker"; } export function literalRight() { return "right-marker"; }',
        'export function sharedLeft() { return "shared-marker"; } export function sharedRight() { return "shared-marker"; }',
        'export interface Contract { value: number }',
        'export interface Unrelated { other: string }',
        'export type ContractAlias = Contract;',
        'export type AliasLeft = Contract; export type AliasRight = Unrelated;',
        'export function usesContract(input: ContractAlias): Contract { return input; }',
        '',
      ].join('\n'),
    );
    cli(['reindex', '--allow-expensive-rebuild']);
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
  });

  it.each([
    ['first', 'return 1;'],
    ['second', 'return 2;'],
    ['outer', 'return inner;'],
  ])('reports only the selected %s function return', (name, expected) => {
    const result = evidence([`${name}().`], ['execution']);
    expect(result.edges.filter((edge) => edge.subtype === 'returns').map((edge) => edge.to.label)).toEqual([expected]);
  });

  it('retains nested and arrow source caller identities without inventing outer callers', () => {
    const result = evidence(['target().'], ['execution'], 'incoming');
    const callers = result.edges
      .filter((edge) => edge.subtype === 'call' && edge.to.symbol === symbol('target().'))
      .map((edge) => edge.from);
    expect(callers.map((node) => node.label)).toContain('inner');
    expect(callers.map((node) => node.label)).toContain('activeArrow');
    expect(callers.map((node) => node.label)).not.toContain('outer');
    expect(callers.map((node) => node.label)).not.toContain('unusedArrow');
    const closureLine = readFileSync(join(fixture.root, 'identity.ts'), 'utf8')
      .split('\n')
      .findIndex((line) => line.includes('function closures()'));
    expect(callers.filter((node) => node.location?.line === closureLine)).toHaveLength(2);
    expect(new Set(callers.filter((node) => node.location?.line === closureLine).map((node) => node.id)).size).toBe(2);
  });

  it('does not traverse stored references as incoming executable reachability', () => {
    const db = fixture.open();
    try {
      const result = graphEvidence(
        db,
        { symbols: [symbol('heldMixed().')] },
        {
          families: ['execution'],
          direction: 'incoming',
          maxDepth: 3,
          maxEdges: 200,
        },
      );
      const callers = result.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.from.symbol);
      expect(callers).toContain(symbol('invoked().'));
      expect(callers).not.toContain(symbol('referencesOnly().'));
    } finally {
      db.close();
    }
  });

  it('reports argument mapping gaps from both the caller and callee roots', () => {
    const db = fixture.open();
    try {
      for (const [name, direction] of [
        ['trickyArguments', 'outgoing'],
        ['variadic', 'incoming'],
      ] as const) {
        const result = graphEvidence(
          db,
          { symbols: [symbol(`${name}().`)] },
          {
            families: ['dataflow'],
            direction,
            maxDepth: 1,
            maxEdges: 200,
          },
        );
        expect(result.coverage.unsupportedFrontiers, `${name} ${direction}`).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  it('does not present a reassigned function binding as an exact invocation of its original body', () => {
    const db = fixture.open();
    try {
      const result = graphEvidence(
        db,
        { symbols: [symbol('afterReplacement().')] },
        {
          families: ['execution'],
          direction: 'outgoing',
          maxDepth: 1,
          maxEdges: 200,
        },
      );
      expect(result.targets.every((target) => target.status === 'matched')).toBe(true);
      expect(
        result.edges.filter((edge) => edge.subtype === 'call' && edge.to.symbol?.endsWith('/replaced().')),
      ).toEqual([]);
      expect(result.coverage.unsupportedFrontiers).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('assigns mutations only to the selected sibling function', () => {
    const result = evidence(['right().'], ['state']);
    const writes = result.edges.filter((edge) => edge.subtype === 'writes-resource');
    expect(writes.map((edge) => edge.to.label)).toEqual(['state.right']);
  });

  it('does not attribute a deferred callback mutation or await to its factory', () => {
    const result = evidence(['deferred().'], ['state', 'temporal']);
    expect(result.edges).toEqual([]);
  });

  it('retains distinct same-line return statements with identical text', () => {
    const result = evidence(['repeatedReturns().'], ['execution']);
    const returns = result.edges.filter((edge) => edge.subtype === 'returns');
    expect(returns).toHaveLength(2);
    expect(new Set(returns.map((edge) => edge.to.id)).size).toBe(2);
  });

  it('retains distinct same-line writes with identical text', () => {
    const result = evidence(['repeatedWrites().'], ['state']);
    const writes = result.edges.filter((edge) => edge.subtype === 'writes-resource');
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map((edge) => edge.from.id)).size).toBe(2);
  });

  it('does not merge identical terminals from different function owners', () => {
    const result = evidence(['equalFirst().', 'equalSecond().'], ['execution']);
    const returns = result.edges.filter((edge) => edge.subtype === 'returns');
    expect(returns).toHaveLength(2);
    expect(new Set(returns.map((edge) => edge.to.id)).size).toBe(2);
  });

  it('does not merge state access paths rooted in shadowed bindings', () => {
    const result = evidence(['shadowedState().'], ['state']);
    const writes = result.edges.filter((edge) => edge.subtype === 'writes-resource');
    expect(writes).toHaveLength(3);
    const byLine = writes.sort((a, b) => a.from.location!.line - b.from.location!.line);
    expect(byLine[0]!.to.id).toBe(byLine[2]!.to.id);
    expect(byLine[1]!.to.id).not.toBe(byLine[0]!.to.id);
  });

  it('does not order a returning await before a mutually exclusive later write', () => {
    const result = evidence(['returnBeforeWrite().'], ['temporal']);
    expect(
      result.edges.filter(
        (edge) => edge.subtype === 'await-completion-before' && edge.to.label.includes('state.value'),
      ),
    ).toEqual([]);
  });

  it('does not include an unrelated same-line function in local data flow', () => {
    const result = evidence(['dataFirst().'], ['dataflow']);
    const labels = result.edges.flatMap((edge) => [edge.from.label, edge.to.label]);
    expect(labels).toContain('alpha');
    expect(labels).not.toContain('beta');
    expect(labels).not.toContain('b');
  });

  it('retains argument transfers to two different callees on the same line', () => {
    const result = evidence(['relay().'], ['dataflow']);
    const transfers = result.edges.filter((edge) => edge.subtype === 'argument-to-parameter');
    expect(transfers).toHaveLength(2);
    expect(new Set(transfers.map((edge) => edge.to.id)).size).toBe(2);
  });

  it('does not call a shadowed local a forwarded caller parameter', () => {
    const result = evidence(['shadowedRelay().'], ['dataflow']);
    expect(
      result.edges.filter((edge) => edge.subtype === 'argument-to-parameter' && edge.evidenceStrength === 'exact'),
    ).toEqual([]);
  });

  it('retains both argument transfers for repeated same-line invocations', () => {
    const result = evidence(['repeatedRelay().'], ['dataflow']);
    const transfers = result.edges.filter((edge) => edge.subtype === 'argument-to-parameter');
    expect(transfers).toHaveLength(2);
    expect(new Set(transfers.map((edge) => edge.id)).size).toBe(2);
  });

  it('connects explicit superclass constructor invocation', () => {
    const base = 'Box#`<constructor>`().';
    const child = 'Child#`<constructor>`().';
    const incoming = evidence([base], ['execution'], 'incoming');
    expect(
      incoming.edges
        .filter((edge) => edge.subtype === 'call')
        .map((edge) => edge.from.symbol)
        .sort(),
    ).toEqual([symbol(child), symbol('GrandChild#`<constructor>`().'), symbol('create().')].sort());
    const outgoing = evidence([child], ['execution']);
    expect(outgoing.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.to.symbol)).toEqual([
      symbol(base),
    ]);
  });

  it.each([
    ['AliasedChild', 'scip-typescript npm history-fixture 1.0.0 `base.ts`/ExternalBase#`<constructor>`().'],
    ['GrandChild', symbol('Box#`<constructor>`().')],
    ['EmptyChild', symbol('Empty#')],
  ])('resolves the statically bound superclass of %s', (name, target) => {
    const result = evidence([`${name}#\`<constructor>\`().`], ['execution']);
    expect(result.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.to.symbol)).toEqual([target]);
  });

  it('does not invent one constructor target for a dynamic superclass', () => {
    const result = evidence(['DynamicChild#`<constructor>`().'], ['execution']);
    expect(result.edges.filter((edge) => edge.subtype === 'call')).toEqual([]);
    expect(result.coverage.unsupportedFrontiers).toBeGreaterThan(0);
  });

  it('finds incoming uses of a local contract', () => {
    const result = evidence(['Contract#'], ['contract'], 'incoming');
    expect(
      result.edges.filter((edge) => edge.subtype === 'uses-contract-symbol').map((edge) => edge.from.label),
    ).toContain('identity:usesContract()');
  });

  it('reports referenced contracts without inventing an unrelated contract', () => {
    const result = evidence(['usesContract().'], ['contract']);
    const contracts = result.edges
      .filter((edge) => edge.subtype === 'uses-contract-symbol')
      .map((edge) => edge.to.label);
    expect(contracts).toContain('identity:Contract');
    expect(contracts).toContain('identity:ContractAlias');
    expect(contracts).not.toContain('identity:Unrelated');
  });
  it('locates the actual owner of a literal inside same-line siblings', () => {
    const result = evidence(['literal:right-marker'], ['execution']);
    expect(result.edges.filter((edge) => edge.subtype === 'returns').map((edge) => edge.to.label)).toEqual([
      'return "right-marker";',
    ]);
  });
  it('retains both owners when a literal repeats in different same-line functions', () => {
    const result = evidence(['literal:shared-marker'], ['execution']);
    const edges = result.edges.filter((edge) => edge.subtype === 'returns');
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((edge) => edge.from.id)).size).toBe(2);
  });

  it('does not attribute a neighboring type alias reference to the selected alias', () => {
    const result = evidence(['AliasLeft#'], ['contract']);
    expect(result.edges.filter((edge) => edge.subtype === 'uses-contract-symbol').map((edge) => edge.to.label)).toEqual(
      ['identity:Contract'],
    );
  });
  it('does not invent direct formal-parameter bindings for extra, rest, or defaulted arguments', () => {
    const result = evidence(['trickyArguments().'], ['dataflow']);
    expect(
      result.edges.filter((edge) => edge.evidenceMethods.includes('compiler-callsite-direct-parameter-transfer')),
    ).toEqual([]);
    expect(result.coverage.unsupportedFrontiers).toBeGreaterThan(0);
  });
  it('keeps exact non-call reference owners distinct from same-line calls and siblings', () => {
    const db = fixture.open();
    try {
      const result = systemMap(db, { symbols: [symbol('heldTarget().'), symbol('heldMixed().')], maxDepth: 1 });
      expect(
        result.topology?.edges.map((edge) => ({
          kind: edge.kind,
          fromSymbol: decodeURIComponent(edge.fromNodeId.replace(/^symbol:/u, '')),
          toSymbol: decodeURIComponent(edge.toNodeId.replace(/^symbol:/u, '')),
        })),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'reference',
            fromSymbol: symbol('holderRight().'),
            toSymbol: symbol('heldTarget().'),
          }),
          expect.objectContaining({
            kind: 'reference',
            fromSymbol: symbol('stored().'),
            toSymbol: symbol('heldMixed().'),
          }),
          expect.objectContaining({ kind: 'call', fromSymbol: symbol('invoked().'), toSymbol: symbol('heldMixed().') }),
        ]),
      );
      expect(
        result.topology?.edges.some(
          (edge) =>
            decodeURIComponent(edge.fromNodeId) === `symbol:${symbol('holderLeft().')}` &&
            decodeURIComponent(edge.toNodeId) === `symbol:${symbol('heldTarget().')}`,
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  });
});
