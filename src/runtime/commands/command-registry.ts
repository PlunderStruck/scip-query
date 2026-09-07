import { Option, type Command } from 'commander';
import type { CommandDescriptor, CommandResultUnitPolicy } from '../command-kit/command-descriptor-types.js';
import {
  runWithCommandOperationRole,
  setCommandAgentContractMap,
  setCommandClaimContractMap,
  setCommandEvidenceMap,
} from '../command-kit/command-execution.js';
import { descriptorClaimContract, descriptorEvidenceTier } from '../command-kit/command-docs.js';
import { sanitizeTerminalLine } from '../../platform/terminal-output.js';
import { cliVersion } from '../cli-support.js';
import { CLI_OUTPUT_CONTINUATION_COMMAND, runWithCliOutputPagination } from '../output-pagination.js';
import { resolveCommandOperationRole } from '../command-operation.js';
import { cliInvocationPrefix } from '../cli-invocation.js';

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
  setCommandClaimContractMap(
    new Map(descriptors.map((descriptor) => [descriptor.id, descriptorClaimContract(descriptor)])),
  );
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
    if (descriptor.helpAfter) command.addHelpText('after', `\n${descriptor.helpAfter.trim()}\n`);

    for (const argument of descriptor.arguments ?? []) {
      command.argument(argument.name);
    }

    for (const option of descriptor.options ?? []) {
      registerDescriptorOption(command, option);
    }

    command.action(async (...args: unknown[]) => {
      try {
        const opts = command.optsWithGlobals() as Record<string, unknown>;
        validateJsonOutputOptions(opts);
        const run = () =>
          descriptor.id === CLI_OUTPUT_CONTINUATION_COMMAND
            ? descriptor.handler(...args)
            : runWithCliOutputPagination(
                {
                  command: descriptor.id,
                  producerVersion: cliVersion,
                  invocationPrefix: cliInvocationPrefix(),
                  argv: process.argv.slice(2),
                  cwd: process.cwd(),
                  json: opts['json'] === true,
                  agentOutput: opts['agentOutput'] === true,
                  ...(typeof opts['jsonOutput'] === 'string' ? { jsonOutputPath: opts['jsonOutput'] } : {}),
                  sourceSession: opts['session'] !== false,
                  reemitSource: opts['reemit'] === true,
                  ...(typeof opts['outputPageSize'] === 'number' ? { pageSize: opts['outputPageSize'] } : {}),
                  ...(typeof opts['outputCursor'] === 'string' ? { cursor: opts['outputCursor'] } : {}),
                },
                () => descriptor.handler(...args),
              );
        const operation = descriptor.agent
          ? resolveCommandOperationRole(descriptor.agent.operation, {
              args: args.slice(0, -1),
              options: opts,
            })
          : undefined;
        await (operation ? runWithCommandOperationRole(operation, run) : run());
      } catch (err) {
        handleCommandError(err);
      }
    });
    return { descriptor, command };
  });
}

function validateJsonOutputOptions(options: Readonly<Record<string, unknown>>): void {
  validateJsonRequiredOptions(options);
  if (options['agentOutput'] === true && options['rawJson'] === true) {
    throw new Error('--agent-output cannot be combined with --raw-json.');
  }
  validateJsonFileOutputOptions(options);
  if (
    options['rawJson'] === true &&
    (options['outputPageSize'] !== undefined || options['outputCursor'] !== undefined)
  ) {
    throw new Error('--raw-json cannot be combined with output pagination.');
  }
}

function validateJsonFileOutputOptions(options: Readonly<Record<string, unknown>>): void {
  if (typeof options['jsonOutput'] === 'string') {
    if (options['agentOutput'] === true || options['rawJson'] === true) {
      throw new Error('--json-output cannot be combined with --agent-output or --raw-json.');
    }
    if (options['outputPageSize'] !== undefined || options['outputCursor'] !== undefined) {
      throw new Error('--json-output cannot be combined with output pagination.');
    }
  }
}

function validateJsonRequiredOptions(options: Readonly<Record<string, unknown>>): void {
  const requireJson = (flag: string, enabled: boolean): void => {
    if (enabled && options['json'] !== true) throw new Error(`${flag} requires --json.`);
  };
  requireJson('--result-only', options['resultOnly'] === true);
  requireJson('--compact', options['compact'] === true);
  requireJson('--agent-output', options['agentOutput'] === true);
  requireJson('--json-output', typeof options['jsonOutput'] === 'string');
  requireJson('--raw-json', options['rawJson'] === true);
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

function registerDescriptorOption(command: Command, option: NonNullable<CommandDescriptor['options']>[number]): void {
  if (option.hidden) {
    const compatibilityOption = new Option(option.flags, option.description).hideHelp();
    if (option.parser) compatibilityOption.argParser(option.parser);
    if (Object.hasOwn(option, 'defaultValue')) {
      compatibilityOption.default(option.defaultValue as PlainCommanderDefault);
    }
    command.addOption(compatibilityOption);
  } else if (option.parser && Object.hasOwn(option, 'defaultValue')) {
    command.option(option.flags, option.description, option.parser, option.defaultValue);
  } else if (option.parser) {
    command.option(option.flags, option.description, option.parser);
  } else if (Object.hasOwn(option, 'defaultValue')) {
    command.option(option.flags, option.description, option.defaultValue as PlainCommanderDefault);
  } else {
    command.option(option.flags, option.description);
  }
}
