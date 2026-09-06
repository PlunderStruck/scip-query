import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { commandPanels, renderRootCommandHelp } from '../../src/runtime/commands/command-panels.js';
import { PRIMARY_EXPLORATION_COMMAND_IDS } from '../../src/runtime/command-kit/exploration-manual.js';
import { commandDescriptors } from '../../src/runtime/commands/command-descriptors.js';

describe('command cockpit panels', () => {
  it('places every descriptor in exactly one semantic panel', () => {
    const panels = commandPanels(commandDescriptors, { includeCompatibility: true });
    const ids = panels.flatMap((panel) => panel.commands.map((descriptor) => descriptor.id));

    expect(ids).toHaveLength(commandDescriptors.length);
    expect(new Set(ids).size).toBe(commandDescriptors.length);
    expect(panels.find((panel) => panel.id === 'primary-exploration')?.commands.map((command) => command.id)).toEqual(
      PRIMARY_EXPLORATION_COMMAND_IDS,
    );
  });

  it('keeps advanced and compatibility controls out of ordinary help and exposes them explicitly', () => {
    const program = new Command().name('scip-query').description('Repository exploration surface');
    program.option('--help-all', 'Display every command');

    const ordinary = renderRootCommandHelp(program, commandDescriptors);
    const complete = renderRootCommandHelp(program, commandDescriptors, { includeCompatibility: true });

    expect(ordinary).toContain('Primary exploration:');
    expect(ordinary).toContain('Maintenance:');
    for (const name of ['health', 'review', 'context']) expect(ordinary).toMatch(new RegExp(`^  ${name} `, 'm'));
    expect(ordinary).not.toContain('Specialized analysis:');
    expect(ordinary).not.toContain('Quality and cleanup:');
    expect(ordinary).not.toContain('Formal modeling:');
    expect(ordinary).not.toContain('Compatibility and deprecated controls:');
    expect(ordinary).not.toContain('anchors <question>');
    expect(complete).toContain('Specialized analysis:');
    expect(complete).toContain('Quality and cleanup:');
    expect(complete).not.toContain('Formal modeling:');
    expect(complete).toContain('Compatibility and deprecated controls:');
    expect(complete).not.toContain('anchors <question>');
  });
});
