import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindSourceEmissionGeneration,
  finalizeSourceEmission,
  renderSessionEvidence,
  renderSourceEvidence,
  rollbackSourceEmission,
  runWithSourceEmissionInvocation,
  sourceEmissionCheckpoint,
  sourceEmissionSessionSummary,
} from '../../src/runtime/source-emission-session.js';

describe.sequential('source emission sessions', () => {
  let sessionRoot: string;
  let priorSession: string | undefined;
  let priorRoot: string | undefined;

  beforeEach(() => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'scip-query-source-session-test-'));
    priorSession = process.env['SCIP_QUERY_SESSION'];
    priorRoot = process.env['SCIP_QUERY_SESSION_DIR'];
    process.env['SCIP_QUERY_SESSION'] = 'source-emission-test';
    process.env['SCIP_QUERY_SESSION_DIR'] = sessionRoot;
  });

  afterEach(() => {
    restoreEnv('SCIP_QUERY_SESSION', priorSession);
    restoreEnv('SCIP_QUERY_SESSION_DIR', priorRoot);
    rmSync(sessionRoot, { recursive: true, force: true });
  });

  it('cites only wholly covered previews and never fragments exact units', () => {
    const first = invocation('code', () =>
      renderSourceEvidence({ relativePath: 'src/example.ts', startLine: 9, source: 'ten\neleven\ntwelve' }),
    );
    const second = invocation('search', () =>
      renderSourceEvidence({
        relativePath: 'src/example.ts',
        startLine: 10,
        source: 'eleven\ntwelve\nthirteen\nfourteen',
        sessionPolicy: 'preview',
      }),
    );
    const third = invocation('search', () =>
      renderSourceEvidence({
        relativePath: 'src/example.ts',
        startLine: 10,
        source: 'eleven\ntwelve\nthirteen\nfourteen',
        sessionPolicy: 'preview',
      }),
    );
    const fourth = invocation('inspect', () =>
      renderSourceEvidence({
        relativePath: 'src/example.ts',
        startLine: 9,
        source: 'ten\neleven\ntwelve\nthirteen\nfourteen',
        sessionPolicy: 'exact-unit',
      }),
    );

    expect(first).toContain('10  ten');
    expect(first).toContain('12  twelve');
    expect(second).toContain('11  eleven');
    expect(second).toContain('13  thirteen');
    expect(second).toContain('14  fourteen');
    expect(second).not.toContain('previously emitted');
    expect(third).toContain('src/example.ts:11-14  [source previously emitted: session #2 via search; not repeated]');
    expect(third).not.toContain('ten');
    expect(fourth).toContain('10  ten');
    expect(fourth).toContain('14  fourteen');
    expect(fourth).not.toContain('previously emitted');

    const summary = invocation('session', () => sourceEmissionSessionSummary(), false);
    expect(summary).toMatchObject({ enabled: true, uniqueLines: 5, emissions: 3 });
    expect(summary.rows).toEqual([
      '  #1 code: src/example.ts:10-12',
      '  #2 search: src/example.ts:11-14',
      '  #3 inspect: src/example.ts:10-14',
    ]);
  });

  it('replaces the same complete exact unit with a visible receipt', () => {
    const render = () =>
      renderSourceEvidence({
        relativePath: 'src/exact.ts',
        startLine: 4,
        source: 'export function exact() {\n  return true;\n}',
        sessionPolicy: 'exact-unit',
      });
    const first = invocation('code', render);
    const second = invocation('code', render);
    expect(first).toContain('export function exact()');
    expect(second).toContain('src/exact.ts:5-7  [source previously emitted: session #1 via code; not repeated]');
    expect(second).not.toContain('export function exact()');
  });

  it('replaces a byte-identical exact subset of a prior exact source read with a receipt', () => {
    const first = invocation('code', () =>
      renderSourceEvidence({
        relativePath: 'src/exact.ts',
        startLine: 4,
        source: 'four\nfive\nsix\nseven\neight',
        sessionPolicy: 'exact-unit',
        ownerSymbol: 'larger-range',
      }),
    );
    const second = invocation('code', () =>
      renderSourceEvidence({
        relativePath: 'src/exact.ts',
        startLine: 5,
        source: 'five\nsix\nseven',
        sessionPolicy: 'exact-unit',
        ownerSymbol: 'nested-range',
      }),
    );

    expect(first).toContain('5  four');
    expect(second).toContain('src/exact.ts:6-8  [source previously emitted: session #1 via code; not repeated]');
    expect(second).not.toContain('five');
  });

  it('re-emits an exact unit when current bytes change without a generation change', () => {
    invocation('code', () =>
      renderSourceEvidence({
        relativePath: 'src/live.ts',
        startLine: 4,
        source: 'export const state = "before";',
        sessionPolicy: 'exact-unit',
        ownerSymbol: 'state',
      }),
    );
    const changed = invocation('code', () =>
      renderSourceEvidence({
        relativePath: 'src/live.ts',
        startLine: 4,
        source: 'export const state = "after";',
        sessionPolicy: 'exact-unit',
        ownerSymbol: 'state',
      }),
    );
    expect(changed).toContain('state = "after"');
    expect(changed).not.toContain('previously emitted');
  });

  it('cites content-bound graph units and edges but re-emits changed or reversioned evidence', () => {
    const unit = () =>
      renderSessionEvidence({
        kind: 'unit',
        identity: 'symbol:demo',
        label: 'demo()',
        content: '  demo behavior',
        indent: '  ',
      });
    const edge = () =>
      renderSessionEvidence({
        kind: 'edge',
        identity: 'edge:demo-to-store',
        label: 'demo → store call',
        content: '  demo → store — call; compiler/graph-fact',
        indent: '  ',
      });
    const first = invocation('system-map', () => `${unit()}\n${edge()}`);
    const second = invocation('inspect', () => `${unit()}\n${edge()}`);
    const changed = invocation('inspect', () =>
      renderSessionEvidence({
        kind: 'unit',
        identity: 'symbol:demo',
        label: 'demo()',
        content: '  changed demo behavior',
      }),
    );
    const reemitted = invocation('inspect', unit, true, true);
    const nextGeneration = invocation('inspect', unit, true, false, 'generation-b');

    expect(first).toContain('demo behavior');
    expect(first).toContain('demo → store — call');
    expect(second).toMatch(/unit evidence previously emitted: receipt ev-[0-9a-f]{12}/u);
    expect(second).toMatch(/edge evidence previously emitted: receipt ev-[0-9a-f]{12}/u);
    expect(second).toContain('session #1 via system-map');
    expect(second).not.toContain('demo → store — call; compiler');
    expect(changed).toContain('changed demo behavior');
    expect(changed).not.toContain('previously emitted');
    expect(reemitted).toBe('  demo behavior');
    expect(nextGeneration).toBe('  demo behavior');

    const summary = invocation('session', () => sourceEmissionSessionSummary(), false);
    expect(summary).toMatchObject({ enabled: true, evidenceItems: 4, emissions: 3 });
    expect(summary.rows.join('\n')).toMatch(/ev-[0-9a-f]{12} unit demo\(\)/u);
  });

  it('does not remember speculative or incompletely delivered source', () => {
    invocation('code', () => {
      const checkpoint = sourceEmissionCheckpoint();
      renderSourceEvidence({ relativePath: 'src/refused.ts', startLine: 0, source: 'not-delivered' });
      rollbackSourceEmission(checkpoint);
      return undefined;
    });
    invocation(
      'search',
      () => renderSourceEvidence({ relativePath: 'src/paged.ts', startLine: 0, source: 'first-page-only' }),
      false,
    );

    const refusedRetry = invocation('code', () =>
      renderSourceEvidence({ relativePath: 'src/refused.ts', startLine: 0, source: 'not-delivered' }),
    );
    const pagedRetry = invocation('search', () =>
      renderSourceEvidence({ relativePath: 'src/paged.ts', startLine: 0, source: 'first-page-only' }),
    );
    expect(refusedRetry).toContain('not-delivered');
    expect(pagedRetry).toContain('first-page-only');
    expect(refusedRetry).not.toContain('previously emitted');
    expect(pagedRetry).not.toContain('previously emitted');
  });

  it('scopes coverage to the immutable index generation and supports explicit re-emission', () => {
    invocation('code', () =>
      renderSourceEvidence({ relativePath: 'src/versioned.ts', startLine: 0, source: 'original' }),
    );
    const reemitted = invocation(
      'code',
      () => renderSourceEvidence({ relativePath: 'src/versioned.ts', startLine: 0, source: 'original' }),
      true,
      true,
    );
    const nextGeneration = invocation(
      'code',
      () => renderSourceEvidence({ relativePath: 'src/versioned.ts', startLine: 0, source: 'changed' }),
      true,
      false,
      'generation-b',
    );
    expect(reemitted).toContain('original');
    expect(reemitted).not.toContain('previously emitted');
    expect(nextGeneration).toContain('changed');
    expect(nextGeneration).not.toContain('previously emitted');
  });

  it('keeps overlapping previews whole within one command and cites them on a later command', () => {
    const first = invocation('search', () => {
      const initial = renderSourceEvidence({
        relativePath: 'src/thread.ts',
        startLine: 0,
        source: 'one\ntwo',
        sessionPolicy: 'preview',
      });
      const overlap = renderSourceEvidence({
        relativePath: 'src/thread.ts',
        startLine: 1,
        source: 'two\nthree',
        sessionPolicy: 'preview',
      });
      return `${initial}\n${overlap}`;
    });
    const second = invocation('search', () =>
      renderSourceEvidence({
        relativePath: 'src/thread.ts',
        startLine: 0,
        source: 'one\ntwo\nthree',
        sessionPolicy: 'preview',
      }),
    );
    expect(first).not.toContain('previously emitted');
    expect(first.match(/two/gu)).toHaveLength(2);
    expect(second).toContain('src/thread.ts:1-3  [source previously emitted: session #1 via search; not repeated]');
    expect(second).not.toContain('1  one');
  });
});

function invocation<T>(
  command: string,
  run: () => T,
  delivered = true,
  reemit = false,
  generationIdentity = 'generation-a',
): T {
  return runWithSourceEmissionInvocation(
    {
      command,
      cwd: process.cwd(),
      argv: [command],
      json: false,
      reemit,
    },
    () => {
      try {
        bindSourceEmissionGeneration(generationIdentity);
        return run();
      } finally {
        finalizeSourceEmission(delivered);
      }
    },
  );
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
