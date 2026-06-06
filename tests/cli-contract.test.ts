import { describe, it, expect, vi } from 'vitest';
import { program, renderHeuristicNotice } from '../src/runtime/cli.js';

function command(name: string) {
  const cmd = program.commands.find((entry) => entry.name() === name);
  expect(cmd, `missing command: ${name}`).toBeDefined();
  return cmd!;
}

function optionFlags(name: string): string[] {
  return command(name).options.map((option) => option.flags);
}

describe('CLI contract', () => {
  it('keeps the command names we depend on', () => {
    const names = new Set(program.commands.map((entry) => entry.name()));

    expect(names.has('dead')).toBe(true);
    expect(names.has('health')).toBe(true);
    expect(names.has('redundant-reexports')).toBe(true);
    expect(names.has('diff-impact')).toBe(true);
    expect(names.has('drift')).toBe(true);
    expect(names.has('test-coverage')).toBe(false);
  });

  it('preserves representative command options and descriptions', () => {
    expect(command('dead').description()).toBe('Find dead code and file-internal symbols (no cross-file consumers)');
    expect(optionFlags('dead')).toEqual([
      '--min-loc <n>',
      '--include-tests',
      '--skip-barrels',
      '--include-members',
      '--only-dead',
      '--only-internal',
      '--full',
    ]);

    expect(command('health').description()).toBe('Composite codebase health report with prioritized action list');
    expect(optionFlags('health')).toEqual([
      '-s, --scope <path>',
      '--full',
      '--json',
    ]);

    expect(command('redundant-reexports').description()).toBe('Find barrel re-exports that nobody imports through');
    expect(optionFlags('redundant-reexports')).toEqual([
      '-s, --scope <path>',
      '-n, --limit <n>',
    ]);

    expect(command('diff-impact').description()).toBe('Compute changed symbols and downstream consumers from current git diff');
    expect(optionFlags('diff-impact')).toEqual([
      '--base <ref>',
    ]);
  });

  it('labels heuristic commands as candidates in command descriptions', () => {
    for (const name of [
      'similar',
      'similar-files',
      'similar-chains',
      'extract-candidates',
      'drift',
      'wrapper-candidates',
      'passthrough-candidates',
      'stale-abstractions',
      'complexity-hotspots',
    ]) {
      expect(command(name).description().toLowerCase()).toContain('candidate');
    }
  });

  it('prints an explicit heuristic disclaimer for candidate output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    renderHeuristicNotice('stale abstraction candidates');

    expect(log).toHaveBeenCalledWith(
      'Heuristic stale abstraction candidates: review before acting; these are candidates, not exact compiler facts.\n',
    );
  });
});
