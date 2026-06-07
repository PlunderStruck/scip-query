import type { CommandDescriptor, CommandOptionParser } from './command-descriptor-types.js';
import { collect, parseIntSafe, parsePositiveInt } from './cli-context.js';

export const collectValues = collect as CommandOptionParser;
export const parseInteger = parseIntSafe as CommandOptionParser;
export const parsePositiveInteger = parsePositiveInt as CommandOptionParser;
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

export function doc(category: string, examples: readonly string[] = []): NonNullable<CommandDescriptor['docs']> {
  return { category, examples };
}
