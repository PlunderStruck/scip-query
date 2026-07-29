import type { Command } from 'commander';
import type { CommandDescriptor, CommandResultUnitPolicy } from '../command-kit/command-descriptor-types.js';
import { setCommandAgentContractMap, setCommandEvidenceMap } from '../command-kit/command-execution.js';
import { descriptorEvidenceTier } from '../command-kit/command-docs.js';
import { sanitizeTerminalLine } from '../../platform/terminal-output.js';
import { cliVersion } from '../cli-support.js';
import { runWithCliOutputPagination } from '../output-pagination.js';

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
  setCommandAgentContractMap(
    new Map(
      descriptors.flatMap((descriptor) =>
        descriptor.agent
          ? [
              [
                descriptor.id,
                {
                  ...descriptor.agent,
                  resultUnits: commandResultUnitPolicy(descriptor),
                },
              ] as const,
            ]
          : [],
      ),
    ),
  );
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
        const opts = command.optsWithGlobals() as Record<string, unknown>;
        validateJsonOutputOptions(opts);
        await runWithCliOutputPagination(
          {
            command: descriptor.id,
            producerVersion: cliVersion,
            invocationPrefix: process.argv[1] ? [process.execPath, process.argv[1]] : ['scip-query'],
            argv: process.argv.slice(2),
            cwd: process.cwd(),
            json: opts['json'] === true,
            ...(typeof opts['outputPageSize'] === 'number' ? { pageSize: opts['outputPageSize'] } : {}),
            ...(typeof opts['outputCursor'] === 'string' ? { cursor: opts['outputCursor'] } : {}),
          },
          () => descriptor.handler(...args),
        );
      } catch (err) {
        handleCommandError(err);
      }
    });
    return { descriptor, command };
  });
}

function validateJsonOutputOptions(options: Readonly<Record<string, unknown>>): void {
  if (options['resultOnly'] === true && options['json'] !== true) {
    throw new Error('--result-only requires --json.');
  }
  if (options['compact'] === true && options['json'] !== true) {
    throw new Error('--compact requires --json.');
  }
}

export function commandResultUnitPolicy(descriptor: CommandDescriptor): CommandResultUnitPolicy {
  const explicit = descriptor.agent?.resultUnits;
  if (explicit?.kind === 'field' && explicit.field.trim() === '') {
    throw new Error(`Command ${descriptor.id} declares an empty result-unit field.`);
  }
  if (explicit) return explicit;
  return descriptor.renderShape === 'list' ||
    descriptor.renderShape === 'table' ||
    descriptor.renderShape === 'grouped-by-file'
    ? { kind: 'rows' }
    : { kind: 'report' };
}

function handleCommandError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`error: ${sanitizeTerminalLine(message)}`);
  process.exitCode = 1;
}
