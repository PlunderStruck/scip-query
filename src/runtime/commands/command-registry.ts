import type { Command } from 'commander';
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
import { runWithCliOutputPagination } from '../output-pagination.js';
import { resolveCommandOperationRole } from '../command-operation.js';
import { findGitRoot } from '../../platform/git-worktree.js';
import { resolveIndexStoragePaths } from '../../platform/cache-layout.js';
import { loadProjectConfig } from '../config.js';
import { currentCliObservationReceipt } from '../observation-receipt.js';
import { decodeObservationReceipt, type ObservationReceiptV2 } from '../../domain/observation-receipt.js';
import {
  beginAutomaticOperationCapture,
  completeAutomaticOperationCapture,
  type AutomaticOperationCapture,
} from '../autonomous-operation-journal.js';

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
        const run = () =>
          runWithCliOutputPagination(
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
        const operation = descriptor.agent
          ? resolveCommandOperationRole(descriptor.agent.operation, {
              args: args.slice(0, -1),
              options: opts,
            })
          : undefined;
        const capture = operation ? beginCliOperationCapture(descriptor.id, operation) : undefined;
        try {
          await (operation ? runWithCommandOperationRole(operation, run) : run());
          completeCliOperationCapture(capture, typeof process.exitCode === 'number' ? process.exitCode : 0);
        } catch (error) {
          completeCliOperationCapture(capture, 1, error);
          throw error;
        }
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

function beginCliOperationCapture(
  command: string,
  operationRole: Parameters<typeof beginAutomaticOperationCapture>[0]['operationRole'],
): AutomaticOperationCapture | undefined {
  try {
    const projectRoot = findGitRoot(process.cwd());
    if (!projectRoot) return undefined;
    const config = loadProjectConfig(projectRoot);
    return beginAutomaticOperationCapture({
      projectRoot,
      cacheDir: resolveIndexStoragePaths(projectRoot, config).cacheDir,
      command,
      operationRole,
      argv: process.argv.slice(2),
      preReceipt: supportedCurrentReceipt(),
    });
  } catch (error) {
    if (process.env['SCIP_QUERY_DEBUG']) {
      console.error(`automatic-workflow: could not start operation capture: ${String(error)}`);
    }
    return undefined;
  }
}

function completeCliOperationCapture(
  capture: AutomaticOperationCapture | undefined,
  exitCode: number,
  error?: unknown,
): void {
  if (!capture) return;
  try {
    completeAutomaticOperationCapture({
      capture,
      exitCode,
      postReceipt: supportedCurrentReceipt(),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    });
  } catch (captureError) {
    if (process.env['SCIP_QUERY_DEBUG']) {
      console.error(`automatic-workflow: could not finish operation capture: ${String(captureError)}`);
    }
  }
}

function supportedCurrentReceipt(): ObservationReceiptV2 | undefined {
  try {
    const decoded = decodeObservationReceipt(currentCliObservationReceipt());
    return decoded.kind === 'supported' ? decoded.receipt : undefined;
  } catch {
    return undefined;
  }
}
