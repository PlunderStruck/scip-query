import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { commandDescriptors } from '../../src/runtime/commands/command-descriptors.js';
import { registerCommandDescriptors } from '../../src/runtime/commands/command-registry.js';
import { parseFastPathInvocation } from '../../src/runtime/query-service-fastpath.js';

const output = ['--json', '--result-only', '--compact'];

function canonical(argv: string[]): { args: unknown[]; options: Record<string, unknown> } {
  const descriptor = commandDescriptors.find((entry) => entry.id === argv[0]);
  if (!descriptor) throw new Error(`Missing canonical command ${argv[0]}`);
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .option('--no-session');
  const [{ command }] = registerCommandDescriptors(program, [descriptor]);
  // Exercise real descriptor registration and Commander parsing, without
  // executing a repository query or its output transport.
  command.action(() => {});
  program.parse(argv, { from: 'user' });
  return { args: command.processedArgs, options: command.optsWithGlobals() };
}

describe('fast invocations match canonical command parsing', () => {
  it.each([
    ['files', 'pattern'],
    ['members', 'symbolPattern'],
    ['methods', 'className'],
    ['deps', 'filePattern'],
    ['rdeps', 'filePattern'],
    ['imported-by', 'symbolPattern'],
    ['hierarchy', 'symbolPattern'],
    ['by-kind', 'kindQuery'],
    ['refs', 'symbolPattern'],
    ['dependence-slice', 'criterion'],
    ['call-graph', 'symbolPattern'],
    ['imports', 'filePattern'],
    ['unused-imports', 'filePattern'],
    ['system', 'modulePattern'],
    ['surface', 'modulePattern'],
    ['outline', 'filePattern'],
  ])('%s preserves exact operands, flag ordering, and option terminators', (command, field) => {
    for (const operand of ['src/module.ts', 'SomeType.member', '--literal', '']) {
      const argv = [command, ...output, '--', operand];
      const normal = canonical(argv);
      const fast = parseFastPathInvocation(argv);
      expect(fast).not.toBeNull();
      expect(fast).toHaveProperty(field, normal.args[0]);
    }
    const argv = [command, '--compact', 'src/module.ts', '--json', '--result-only', '--json'];
    expect(parseFastPathInvocation(argv)).toHaveProperty(field, canonical(argv).args[0]);
  });

  it.each(['stats', 'kind-counts'])('%s preserves no-operand forms', (command) => {
    const argv = [command, ...output];
    expect(canonical(argv).args).toEqual([]);
    expect(parseFastPathInvocation(argv)).toEqual({ kind: command });
  });

  it.each(
    [
      [],
      ['-C', '0', '-n', '1'],
      ['--context=+2', '--limit=12'],
      ['--scope', 'src', '--regexp', '-i'],
      ['--context', '-0', '--limit', '+7'],
    ].map((options) => ({ options })),
  )('search uses canonical options for $options', ({ options }) => {
    const argv = ['search', ...output, ...options, '--', '--needle'];
    const normal = canonical(argv);
    expect(parseFastPathInvocation(argv)).toEqual({
      kind: 'source-search',
      pattern: normal.args[0],
      options: {
        scope: normal.options.scope,
        context: normal.options.context,
        limit: normal.options.limit,
        regexp: normal.options.regexp === true,
        ignoreCase: normal.options.ignoreCase === true,
        ranking: 'structural',
      },
    });
  });

  it.each([[], ['-C', '3', '--members', 'all'], ['--no-session']].map((options) => ({ options })))(
    'code uses canonical options for $options',
    ({ options }) => {
      const argv = ['code', ...output, ...options, '--', 'firstSymbol', 'src/file.ts'];
      const normal = canonical(argv);
      expect(parseFastPathInvocation(argv)).toEqual({
        kind: 'code',
        selectors: normal.args[0],
        options: { context: normal.options.context, members: normal.options.members },
        session: normal.options.session !== false,
      });
    },
  );

  it.each([[], ['--scope', 'src'], ['--scope=src', '--', '--root']].map((options) => ({ options })))(
    'entrypoints preserves optional selectors for $options',
    ({ options }) => {
      const argv = ['entrypoints', ...output, ...options];
      const normal = canonical(argv);
      expect(parseFastPathInvocation(argv)).toEqual({
        kind: 'entrypoints',
        options: {
          ...(normal.args[0] === undefined ? {} : { search: normal.args[0] }),
          ...(normal.options.scope === undefined ? {} : { scope: normal.options.scope }),
        },
      });
    },
  );

  it.each(['1tail', '1.5', '2e3', '-1', '9007199254740992'])(
    'leaves invalid integer %s to canonical error handling',
    (value) => {
      const argv = ['search', ...output, '--context', value, 'needle'];
      expect(parseFastPathInvocation(argv)).toBeNull();
      expect(() => canonical(argv)).toThrow();
    },
  );

  it('leaves unsupported and retired forms to the canonical route', () => {
    for (const argv of [
      ['trace', ...output, 'root'],
      ['value-flow', ...output, 'root'],
      ['search', ...output, '--full', 'needle'],
      ['search', ...output, '--limit', '0', 'needle'],
      ['code', ...output, '--local-calls', 'root'],
      ['search', '--json', 'needle'],
    ])
      expect(parseFastPathInvocation(argv)).toBeNull();
  });
});
