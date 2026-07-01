import type { Command } from 'commander';
import type { CommandDescriptor } from './command-descriptor-types.js';
import type { CommandEvidenceTier } from './command-descriptor-types.js';
import { setCommandEvidenceMap } from './command-execution.js';

type PlainCommanderDefault = string | boolean | string[] | undefined;

interface RegisteredCommandDescriptor {
  descriptor: CommandDescriptor;
  command: Command;
}

export function registerCommandDescriptors(
  program: Command,
  descriptors: readonly CommandDescriptor[],
): RegisteredCommandDescriptor[] {
  setCommandEvidenceMap(new Map(descriptors.map((descriptor) => [descriptor.id, descriptorEvidenceTier(descriptor)])));
  return descriptors.map((descriptor) => {
    const command = descriptor.hidden
      ? program.command(descriptor.command, { hidden: true })
      : program.command(descriptor.command);
    command.description(descriptor.description);

    for (const argument of descriptor.arguments ?? []) {
      command.argument(argument.name);
    }

    for (const option of descriptor.options ?? []) {
      if (option.parser && Object.hasOwn(option, 'defaultValue')) {
        command.option(option.flags, option.description, option.parser, option.defaultValue);
      } else if (option.parser) {
        command.option(option.flags, option.description, option.parser);
      } else if (Object.hasOwn(option, 'defaultValue')) {
        command.option(option.flags, option.description, option.defaultValue as PlainCommanderDefault);
      } else {
        command.option(option.flags, option.description);
      }
    }

    command.action(async (...args: unknown[]) => {
      try {
        await descriptor.handler(...args);
      } catch (err) {
        handleCommandError(err);
      }
    });
    return { descriptor, command };
  });
}

function descriptorEvidenceTier(descriptor: CommandDescriptor): CommandEvidenceTier {
  if (descriptor.evidence) return descriptor.evidence;
  if (MIXED_EVIDENCE_COMMANDS.has(descriptor.id)) return 'mixed';
  return descriptor.heuristic ? 'heuristic' : 'graph-fact';
}

const MIXED_EVIDENCE_COMMANDS = new Set(['diff-gate', 'health', 'plan-context', 'co-change']);

function handleCommandError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
