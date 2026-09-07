import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCommandDescriptors } from '../../src/runtime/commands/command-registry.js';
import { stronglyConnectedComponents } from '../../src/analysis/strongly-connected-components.js';

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('JSON validation precedence through registered commands', () => {
  it.each([
    [['--result-only', '--compact', '--raw-json'], '--result-only requires --json.'],
    [['--compact', '--agent-output'], '--compact requires --json.'],
    [['--agent-output', '--json-output', 'unused.json'], '--agent-output requires --json.'],
    [['--json-output', 'unused.json', '--raw-json'], '--json-output requires --json.'],
    [['--raw-json', '--output-page-size', '3'], '--raw-json requires --json.'],
    [
      ['--json', '--agent-output', '--raw-json', '--json-output', 'unused.json'],
      '--agent-output cannot be combined with --raw-json.',
    ],
    [
      ['--json', '--json-output', 'unused.json', '--raw-json', '--output-cursor', 'cursor'],
      '--json-output cannot be combined with --agent-output or --raw-json.',
    ],
    [
      ['--json', '--json-output', 'unused.json', '--output-page-size', '3'],
      '--json-output cannot be combined with output pagination.',
    ],
    [['--json', '--raw-json', '--output-cursor', 'cursor'], '--raw-json cannot be combined with output pagination.'],
  ] as const)('rejects %j before running the handler', async (flags, message) => {
    const program = new Command();
    const handler = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerCommandDescriptors(program, [
      {
        id: 'validation-fixture',
        command: 'validation-fixture',
        description: 'Validate output options',
        renderShape: 'empty',
        handler,
        options: [
          '--json',
          '--result-only',
          '--compact',
          '--agent-output',
          '--json-output <path>',
          '--raw-json',
          '--output-page-size <size>',
          '--output-cursor <cursor>',
        ].map((flags) => ({ flags, description: flags })),
      },
    ]);
    await program.parseAsync(['node', 'fixture', 'validation-fixture', ...flags]);
    expect(errors).toHaveBeenCalledExactlyOnceWith(`error: ${message}`);
    expect(handler).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

it('walks a deep dependency chain without using the JavaScript call stack', () => {
  const graph = new Map<number, ReadonlySet<number>>();
  for (let node = 0; node < 20_000; node += 1) graph.set(node, new Set([node + 1]));
  const result = stronglyConnectedComponents(graph);
  expect(result.components).toHaveLength(20_001);
  expect(result.components[0]).toEqual([20_000]);
  expect(result.components[20_000]).toEqual([0]);
  expect(result.componentOf.size).toBe(20_001);
});
