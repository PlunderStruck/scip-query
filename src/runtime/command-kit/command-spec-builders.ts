import type {
  CommandAgentContract,
  CommandDescriptor,
  CommandInputSlot,
  CommandOptionParser,
  CommandScope,
  CoveragePolicy,
} from './command-descriptor-types.js';
import { collect } from '../cli-context.js';

export const collectValues = collect as CommandOptionParser;
export const parseInteger = ((value: string) => parseInt(value, 10)) as CommandOptionParser;
export const parsePositiveInteger = ((value: string) => {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}) as CommandOptionParser;
export const parseNumber = parseFloat as CommandOptionParser;
export const parseIntegerLoose = parseInt as CommandOptionParser;

export function option(
  flags: string,
  description: string,
  parser?: CommandOptionParser,
  ...defaultValue: [unknown?]
): NonNullable<CommandDescriptor['options']>[number] {
  return defaultValue.length > 0
    ? { flags, description, parser, defaultValue: defaultValue[0] }
    : { flags, description, parser };
}

export function jsonOption(): NonNullable<CommandDescriptor['options']>[number] {
  return option('--json', 'Output as JSON for programmatic consumption');
}

export function compactOption(): NonNullable<CommandDescriptor['options']>[number] {
  return option('--compact', 'Emit minified one-line JSON (use with --json)');
}

export function withCompactJsonOptions(
  options: NonNullable<CommandDescriptor['options']> = [],
): NonNullable<CommandDescriptor['options']> {
  const withJson = withJsonOption(options);
  return withJson.some((entry) => entry.flags === '--compact') ? withJson : [...withJson, compactOption()];
}

export function withJsonOption(
  options: NonNullable<CommandDescriptor['options']> = [],
): NonNullable<CommandDescriptor['options']> {
  if (options.some((entry) => entry.flags === '--json')) return options;
  return [...options, jsonOption()];
}

export function doc(category: string, examples: readonly string[] = []): NonNullable<CommandDescriptor['docs']> {
  return { category, examples };
}

/** Concise descriptor-local constructor; the declaration remains beside the command it describes. */
export function agentContract(
  answers: string | readonly string[],
  returns: string | readonly string[],
  inputs: readonly CommandInputSlot[],
  coverage: CoveragePolicy,
  scope?: CommandScope,
): CommandAgentContract {
  return {
    answers: typeof answers === 'string' ? [answers] : answers,
    returns: typeof returns === 'string' ? [returns] : returns,
    inputs,
    coverage,
    ...(scope ? { scope } : {}),
  };
}
