import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphEvidence, type GraphEvidenceOptions } from '../../../src/queries/graph/graph-evidence.js';
import { IndexerHistoryFixture } from '../../properties/indexer-history-fixture.js';

describe('real compiler dependency and projection accuracy', { timeout: 60_000 }, () => {
  let fixture: IndexerHistoryFixture;
  const fn = (name: string) => `scip-typescript npm history-fixture 1.0.0 \`chain.ts\`/${name}().`;
  beforeAll(async () => {
    fixture = new IndexerHistoryFixture();
    fixture.write('value.ts', 'export function shared() { return 1; }');
    fixture.write('barrel.ts', 'export { shared as renamed } from "./value.js";');
    fixture.write('types.ts', 'export interface Shape { value: number }');
    fixture.write('side.ts', 'export const side = 1;');
    fixture.write(
      'use.ts',
      [
        'import { renamed as local } from "./barrel.js";',
        'import type { Shape } from "./types.js";',
        'import "./side.js";',
        'import { join } from "node:path";',
        'export const result: Shape = { value: local() };',
        'export const path = join("a", "b");',
      ].join('\n'),
    );
    fixture.write('missing.ts', 'import "./absent.js"; declare const name: string; import(name);');
    fixture.write(
      'chain.ts',
      [
        'export function leaf() { return 1; }',
        'export function middle() { return leaf(); }',
        'export function root() { return middle(); }',
        'export function sibling() { return leaf(); }',
        'export function withGap(callback: () => void) { callback(); return 2; }',
      ].join('\n'),
    );
    await fixture.index();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  function project(roots: string[], options: GraphEvidenceOptions = {}) {
    const db = fixture.open();
    try {
      return graphEvidence(
        db,
        { symbols: roots },
        { families: ['execution'], direction: 'outgoing', maxDepth: 3, maxEdges: 1_000, ...options },
      );
    } finally {
      db.close();
    }
  }

  it('retains named aliases, type-only imports, side effects, and external imports together', () => {
    const result = project(['use.ts'], { families: ['dependencies'], maxDepth: 1 });
    const local = result.edges.filter((edge) => edge.subtype === 'imports' && edge.from.location?.file === 'use.ts');
    expect([...new Set(local.map((edge) => edge.to.location?.file))].sort()).toEqual([
      'barrel.ts',
      'side.ts',
      'types.ts',
    ]);
    expect(
      result.edges.some((edge) => edge.subtype === 'imports-external' && edge.to.label.includes('node:path')),
    ).toBe(true);
  });

  it('retains a re-export dependency in both directions', () => {
    const outgoing = project(['barrel.ts'], { families: ['dependencies'], maxDepth: 1 });
    const incoming = project(['value.ts'], { families: ['dependencies'], direction: 'incoming', maxDepth: 1 });
    const match = (result: ReturnType<typeof project>) =>
      result.edges.filter(
        (edge) =>
          edge.subtype === 'imports' &&
          edge.from.location?.file === 'barrel.ts' &&
          edge.to.location?.file === 'value.ts',
      );
    expect(match(outgoing)).not.toHaveLength(0);
    expect(match(incoming).map((edge) => edge.id)).toEqual(match(outgoing).map((edge) => edge.id));
  });

  it('makes root ordering and repeated roots immaterial to selected relationships', () => {
    const first = project([fn('root'), fn('sibling')]);
    const reversed = project([fn('sibling'), fn('root'), fn('root')]);
    expect(reversed.edges.map((edge) => edge.id).sort()).toEqual(first.edges.map((edge) => edge.id).sort());
  });

  it('recovers precisely the same edge set from every printed fold', () => {
    const complete = project([fn('root')]);
    const bounded = project([fn('root')], { maxEdges: 1 });
    const recovered = new Set(bounded.edges.map((edge) => edge.id));
    for (const fold of bounded.folds) {
      const expanded = project([fn('root')], { maxEdges: 1, foldIds: [fold.id] });
      for (const edge of expanded.edges) recovered.add(edge.id);
    }
    expect([...recovered].sort()).toEqual(complete.edges.map((edge) => edge.id).sort());
  });

  it('limits calls by depth without inventing the missing caller direction', () => {
    const outgoing = project([fn('root')], { maxDepth: 1 });
    const calls = outgoing.edges.filter((edge) => edge.subtype === 'call');
    expect(calls.map((edge) => [edge.from.symbol, edge.to.symbol])).toEqual([[fn('root'), fn('middle')]]);
    const incoming = project([fn('middle')], { direction: 'incoming', maxDepth: 1 });
    expect(incoming.edges.filter((edge) => edge.subtype === 'call').map((edge) => edge.id)).toEqual(
      calls.map((edge) => edge.id),
    );
  });

  it('does not let an unresolved invocation claim incomplete dependency analysis', () => {
    const result = project([fn('withGap')], { families: ['dependencies'], maxDepth: 1 });
    expect(result.coverage.unsupportedFrontiers).toBe(0);
  });
  it('connects roots in runtime direction regardless of lexical symbol ordering', () => {
    const result = project([fn('root'), fn('leaf')], { connecting: true });
    expect(
      result.edges
        .filter((edge) => edge.subtype === 'call')
        .map((edge) => [edge.from.symbol, edge.to.symbol])
        .sort(),
    ).toEqual(
      [
        [fn('root'), fn('middle')],
        [fn('middle'), fn('leaf')],
      ].sort(),
    );
  });

  it('discloses missing relative modules and dynamic imports without calling them external packages', () => {
    const result = project(['missing.ts'], { families: ['dependencies'], maxDepth: 1 });
    expect(result.coverage.unsupportedFrontiers).toBeGreaterThanOrEqual(2);
    expect(
      result.edges.filter((edge) => edge.subtype === 'imports-external' || edge.to.location?.file === 'absent.js'),
    ).toEqual([]);
    expect(result.coverage.blindSpots.join(' ')).toContain('absent.js');
  });
});
