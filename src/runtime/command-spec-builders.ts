import type { CommandDescriptor, CommandOptionParser } from './command-descriptor-types.js';
import { collect } from './cli-context.js';

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

export function withJsonOption(
  options: NonNullable<CommandDescriptor['options']> = [],
): NonNullable<CommandDescriptor['options']> {
  if (options.some((entry) => entry.flags === '--json')) return options;
  return [...options, jsonOption()];
}

export function doc(category: string, examples: readonly string[] = []): NonNullable<CommandDescriptor['docs']> {
  return { category, examples };
}
