import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function calibrationParser() {
  const path = 'scripts/semantic-command-calibration.mjs';
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['parseArgs', 'applyCalibrationValueOption', 'validateCalibrationLimits', 'mustValue'];
  const declarations = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(declarations).toHaveLength(names.length);
  const effects: string[] = [];
  const exit = new Error('fixture exit');
  const context = createContext({
    Error,
    REPOS: { first: {}, second: {} },
    DEFAULT_RUN_HISTORY: '/fixture/history.jsonl',
    join,
    resolve,
    tmpdir: () => '/fixture/tmp',
    Date: { now: () => 123 },
    printMatrix: () => effects.push('matrix'),
    printHelp: () => effects.push('help'),
    process: {
      exit: (code: number) => {
        effects.push(`exit:${code}`);
        throw exit;
      },
    },
  });
  // Load only these declarations; the script's benchmark entrypoint never runs.
  runInContext(declarations.map((node) => node.getText(source)).join('\n'), context);
  return { parse: context['parseArgs'] as (argv: string[]) => Record<string, unknown>, effects, exit };
}

describe('calibration argument compatibility', () => {
  it('preserves defaults and makes fresh repository lists', () => {
    const { parse } = calibrationParser();
    const first = parse([]);
    expect(first).toEqual({
      repos: ['first', 'second'],
      commandIds: null,
      iterations: 2,
      timeoutMs: 180000,
      out: '/fixture/history.jsonl',
      profileDir: '/fixture/tmp/scip-semantic-command-calibration-123',
      append: false,
    });
    (first['repos'] as string[]).push('changed');
    expect(parse([])['repos']).toEqual(['first', 'second']);
  });

  it('consumes each value once, retains last options, and preserves accepted numeric bounds', () => {
    const { parse } = calibrationParser();
    expect(
      parse([
        '--repo',
        'one,two',
        '--command',
        'a,b',
        '--iterations',
        '3',
        '--iterations',
        '1.5',
        '--timeout-ms',
        '1000',
        '--out',
        'report.jsonl',
        '--profile-dir',
        'profiles',
        '--append',
      ]),
    ).toEqual({
      repos: ['one', 'two'],
      commandIds: ['a', 'b'],
      iterations: 1.5,
      timeoutMs: 1000,
      out: resolve('report.jsonl'),
      profileDir: resolve('profiles'),
      append: true,
    });
    expect(parse(['--repo', '--append'])['repos']).toEqual(['--append']);
  });

  it('preserves missing-value and unknown-argument error precedence', () => {
    const { parse } = calibrationParser();
    expect(() => parse(['--repo'])).toThrow('--repo requires a value');
    expect(() => parse(['--out', ''])).toThrow('--out requires a value');
    expect(() => parse(['--iterations', '0', '--unknown'])).toThrow('Unknown argument: --unknown');
    expect(() => parse(['--iterations', '0', '--timeout-ms', '0'])).toThrow('--iterations must be >= 1');
    expect(() => parse(['--timeout-ms', '999'])).toThrow('--timeout-ms must be >= 1000');
    expect(() => parse(['--iterations', 'Infinity'])).toThrow('--iterations must be >= 1');
  });

  it.each([
    ['--list', 'matrix'],
    ['--help', 'help'],
    ['-h', 'help'],
  ])('handles %s before numeric validation or later arguments', (flag, output) => {
    const { parse, effects, exit } = calibrationParser();
    expect(() => parse(['--iterations', '0', flag, '--unknown'])).toThrow(exit);
    expect(effects).toEqual([output, 'exit:0']);
  });
});
