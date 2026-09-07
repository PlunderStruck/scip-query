import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { nextRouteIdentity } from '../../src/analysis/frontend-route-conventions.js';

function declarations(path: string, names: string[], globals: Record<string, unknown> = {}) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(selected).toHaveLength(names.length);
  const context = createContext(globals);
  // Declarations only; benchmark startup, installations and external commands never execute.
  runInContext(ts.transpile(selected.map((node) => node.getText(source)).join('\n')), context);
  return context;
}

describe('continuation worker3 contracts', () => {
  it('continues processing route segments after an interception and preserves marker precedence', () => {
    expect(nextRouteIdentity('src/app/(group)/a/b/@modal/(..)(..)target/child/page.tsx')).toEqual({
      route: ['target', 'child'],
      entry: 'page',
      intercepting: true,
    });
    expect(nextRouteIdentity('app/a/(...)root/(group)/child/page.tsx')).toEqual({
      route: ['root', 'child'],
      entry: 'page',
      intercepting: true,
    });
  });

  it('keeps evidence argument zero budgets and exact value consumption', () => {
    const context = declarations('scripts/evidence-product-contract.mjs', [
      'parseArgs',
      'positiveInteger',
      'splitCommand',
      'requireEvidenceArgumentValue',
    ]);
    const parse = context.parseArgs as (args: string[]) => unknown;
    expect(parse(['--cold-iterations', '0', '--command', '--no-clear'])).toMatchObject({
      coldIterations: 0,
      commands: [['--no-clear']],
      noClear: false,
    });
    expect(() => parse(['--out', '', '--unknown'])).toThrow('--out requires a value');
    expect(() => parse(['--constructor'])).toThrow('unknown option: --constructor');
  });

  it('retains detector callback receivers, insertion order, and metadata override precedence', () => {
    const context = declarations('scripts/accuracy-calibration.mjs', ['collectRepositoryDetectorRows'], {
      Date: { now: () => 100 },
    });
    const collect = context.collectRepositoryDetectorRows as (...args: unknown[]) => {
      candidateCounts: Record<string, number>;
      detectorMetadata: Record<string, unknown>;
    };
    const rows: unknown[] = [];
    const calls: string[] = [];
    const config = {
      collectCandidates(this: unknown, _db: unknown, detector: string) {
        expect(this).toBe(config);
        calls.push(detector);
        return { total: 7, rows: [detector], metadata: { durationMs: 9 } };
      },
    };
    const result = collect(
      {},
      { detectors: ['b', 'a'], sampleSize: 2, seed: 'seed' },
      config,
      { root: '/root', commit: 'commit' },
      'repo',
      null,
      rows,
    );
    expect(calls).toEqual(['b', 'a']);
    expect(rows).toEqual(['b', 'a']);
    expect(Object.keys(result.candidateCounts)).toEqual(['b', 'a']);
    expect(result.detectorMetadata).toEqual({ b: { durationMs: 9 }, a: { durationMs: 9 } });
  });

  it('counts refresh transitions without counting repeated indexing observations', async () => {
    let now = 100;
    const states = [
      { watcher: { state: 'idle' } },
      { watcher: { state: 'indexing' } },
      { watcher: { state: 'indexing' } },
      { watcher: { state: 'idle' } },
      { watcher: { state: 'indexing' }, lastRefresh: { completedAt: 'new', durationMs: 42 } },
    ];
    const context = declarations(
      'scripts/incremental-freshness-contract.mjs',
      ['waitForRefresh', 'refreshTimingResult'],
      {
        args: { timeout: 500 },
        Date: { now: () => now },
        readJson: () => states.shift(),
        sleep: async (ms: number) => {
          now += ms;
        },
      },
    );
    const wait = context.waitForRefresh as (...args: unknown[]) => Promise<unknown>;
    expect(await wait('/fixture/state', 'old', 100)).toEqual({
      completedAt: 'new',
      durationMs: 42,
      eventToObservedMs: 25,
      eventToIndexingMs: 25,
      eventToFreshMs: 100,
      indexingTransitions: 2,
    });
  });

  it('closes failed lock candidates before cleanup and retains the first publication error', () => {
    const calls: string[] = [];
    const first = new Error('write failed');
    const context = declarations('src/platform/process-file-lock.ts', ['writeProcessLockCandidate'], {
      Buffer,
      writeFileCompletely: () => {
        calls.push('write');
        throw first;
      },
      removeCandidateFile: () => {
        calls.push('remove');
      },
    });
    const runtime = {
      openFile() {
        expect(this).toBe(runtime);
        calls.push('open');
        return 5;
      },
      syncFile() {
        calls.push('sync');
      },
      closeFile() {
        expect(this).toBe(runtime);
        calls.push('close');
        throw new Error('close failed');
      },
    };
    const write = context.writeProcessLockCandidate as (...args: unknown[]) => void;
    expect(() => write('/fixture/candidate', {}, runtime)).toThrow(first);
    expect(calls).toEqual(['open', 'write', 'close', 'remove']);
  });

  it('keeps command stdout access inside its parser fallback', () => {
    const context = declarations('scripts/semantic-command-calibration.mjs', ['parseCalibrationCommandOutput']);
    const parse = context.parseCalibrationCommandOutput as (child: unknown) => {
      parsed: unknown;
      parseError: string | null;
    };
    expect(parse({ stdout: '   ' })).toEqual({ parsed: null, parseError: null });
    const failed = parse({
      get stdout() {
        throw new Error('unreadable stdout');
      },
    });
    expect(failed.parsed).toBeNull();
    expect(failed.parseError).toContain('unreadable stdout');
  });
});
