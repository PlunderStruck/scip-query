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

  it('keeps compatibility controls out of ordinary help and exposes them explicitly', () => {
    const program = new Command().name('scip-query').description('Repository exploration surface');
    program.option('--help-all', 'Display every command');

    const ordinary = renderRootCommandHelp(program, commandDescriptors);
    const complete = renderRootCommandHelp(program, commandDescriptors, { includeCompatibility: true });

    expect(ordinary).toContain('Primary exploration:');
    expect(ordinary).toContain('Specialized analysis:');
    expect(ordinary).toContain('Quality and cleanup:');
    expect(ordinary).toContain('Maintenance:');
    expect(ordinary).toContain('Formal modeling:');
    expect(ordinary).not.toContain('Compatibility and deprecated controls:');
    expect(ordinary).not.toContain('anchors <question>');
    expect(complete).toContain('Compatibility and deprecated controls:');
    expect(complete).toContain('anchors <question>');
  });
});
