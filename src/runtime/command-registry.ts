import type { Command } from 'commander';
import type { CommandDescriptor, RegisteredCommandDescriptor } from './command-descriptor-types.js';

type PlainCommanderDefault = string | boolean | string[] | undefined;

export function registerCommandDescriptors(
  program: Command,
  descriptors: readonly CommandDescriptor[],
): RegisteredCommandDescriptor[] {
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

    command.action((...args: unknown[]) => descriptor.handler(...args));
    return { descriptor, command };
  });
}
