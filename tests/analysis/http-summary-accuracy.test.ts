import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexerHistoryFixture } from '../properties/indexer-history-fixture.js';
import { collectRuntimeBoundaryGraph } from '../../src/analysis/runtime-boundaries/graph.js';
import type { BoundaryObservation } from '../../src/analysis/runtime-boundaries/types.js';

describe('compiler-resolved HTTP summary accuracy', () => {
  let fixture: IndexerHistoryFixture;
  let observations: BoundaryObservation[];
  beforeAll(async () => {
    fixture = new IndexerHistoryFixture();
    fixture.write(
      'requests.ts',
      [
        'export function direct(path: string) { return fetch(path, { method: "POST" }); }',
        'export function conditionalPath(flag: boolean) { if (flag) return "/conditional"; }',
        'export function callConditional() { return fetch(conditionalPath(false)); }',
        'export function shadowedCallee(conditionalPath: Function) { return fetch(conditionalPath()); }',
        'export async function asyncPath() { return "/promise"; }',
        'export function callAsync() { return fetch(asyncPath()); }',

        'export function transformed(path: string) { return fetch("/prefix" + path, { method: "POST" }); }',
        'export function shadowed(path: string) { { const path = "/fixed"; return fetch(path, { method: "POST" }); } }',
        'export function separate(path: string) { fetch("/fixed", { method: "POST" }); return fetch(path); }',
        'export function overwritten(path: string, method: string) { return fetch(path, { method, method: "GET" }); }',
        'export function varied(path: string, method: string) { return fetch(path, { method }); }',
        'export function forward(path: string) { return varied(path, "PATCH"); }',
        'export function reassigned(path: string) { path = "/fixed"; return fetch(path, { method: "POST" }); }',
        'export function invokeReassigned() { return reassigned("/unused-reassigned"); }',
        'export function invokeDirect() { return direct("/direct"); }',
        'export function invokeTransformed() { return transformed("/suffix"); }',
        'export function invokeShadowed() { return shadowed("/unused"); }',
        'export function invokeSeparate() { return separate("/get-only"); }',
        'export function invokeOverwritten() { return overwritten("/overwritten", "POST"); }',
        'export function invokeForward() { return forward("/forwarded"); }',
        'export function two(path: string) { fetch(path, { method: "POST" }); fetch(path, { method: "GET" }); }',
        'export function invokeTwo() { return two("/two"); }',
        '',
      ].join('\n'),
    );
    await fixture.index({ force: true, allowExpensiveRebuild: true });
    const db = fixture.open();
    try {
      observations = (await collectRuntimeBoundaryGraph(db)).observations;
    } finally {
      db.close();
    }
  }, 60_000);
  afterAll(async () => {
    await fixture?.dispose();
  });

  function requests(owner: string) {
    return observations
      .filter((item) => item.extractor === 'builtin.http-summary' && item.owner.name === owner)
      .map((item) => ({
        path: item.keyParts.find((part) => part.name === 'path')?.value,
        method: item.keyParts.find((part) => part.name === 'method')?.value,
      }));
  }
  it('preserves direct parameter forwarding', () =>
    expect(requests('invokeDirect')).toContainEqual({ path: '/direct', method: 'POST' }));
  it('does not equate a transformed path with its input', () =>
    expect(requests('invokeTransformed')).not.toContainEqual({ path: '/suffix', method: 'POST' }));
  it('does not propagate a shadowed parameter', () => expect(requests('invokeShadowed')).toEqual([]));
  it('does not combine a constant method from an unrelated request with a parameter path', () => {
    expect(requests('invokeSeparate')).toEqual([{ path: '/get-only', method: 'GET' }]);
  });
  it('honors the last method property', () =>
    expect(requests('invokeOverwritten')).toEqual([{ path: '/overwritten', method: 'GET' }]));
  it('propagates a resolved method argument through a wrapper', () =>
    expect(requests('invokeForward')).toContainEqual({ path: '/forwarded', method: 'PATCH' }));
  it('preserves two distinct operations of the same wrapper', () =>
    expect(requests('invokeTwo')).toEqual(
      expect.arrayContaining([
        { path: '/two', method: 'POST' },
        { path: '/two', method: 'GET' },
      ]),
    ));
  it('does not propagate an input after its parameter binding is overwritten', () =>
    expect(requests('invokeReassigned')).toEqual([]));
  it.each(['callConditional', 'shadowedCallee', 'callAsync'])(
    'does not invent a literal URL from the %s call result',
    (owner) => {
      const requests = observations.filter((item) => item.owner.name === owner && item.action === 'http.request');
      expect(requests).not.toHaveLength(0);
      expect(requests.every((item) => item.strength === 'candidate')).toBe(true);
    },
  );
});
