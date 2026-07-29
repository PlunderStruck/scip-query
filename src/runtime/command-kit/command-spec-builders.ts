import type {
  CommandAgentContract,
  CommandDescriptor,
  CommandInputSlot,
  CommandOptionParser,
  CommandScope,
  CoveragePolicy,
} from './command-descriptor-types.js';
import { InvalidArgumentError } from 'commander';
import { collect } from '../cli-context.js';

export const collectValues = collect as CommandOptionParser;
const INTEGER_VALUE = /^[+-]?\d+$/u;
const NUMBER_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

export const parseInteger = ((value: string) => parseExactInteger(value, 'an integer')) as CommandOptionParser;
export const parseNonNegativeInteger = ((value: string) => {
  const parsed = parseExactInteger(value, 'a non-negative integer');
  if (parsed < 0) throw new InvalidArgumentError(`Expected a non-negative integer, got "${value}".`);
  return parsed;
}) as CommandOptionParser;
export const parsePositiveInteger = ((value: string) => {
  const parsed = parseExactInteger(value, 'a positive integer');
  if (parsed < 1) throw new InvalidArgumentError(`Expected a positive integer, got "${value}".`);
  return parsed;
}) as CommandOptionParser;
export const parseNumber = ((value: string) => {
  if (!NUMBER_VALUE.test(value)) throw new InvalidArgumentError(`Expected a number, got "${value}".`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new InvalidArgumentError(`Expected a finite number, got "${value}".`);
  return parsed;
}) as CommandOptionParser;
/** @deprecated Kept as an import-compatible alias; parsing is now exact. */
export const parseIntegerLoose = parseInteger;

function parseExactInteger(value: string, expected: string): number {
  if (!INTEGER_VALUE.test(value)) throw new InvalidArgumentError(`Expected ${expected}, got "${value}".`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError(`Expected ${expected}, got "${value}".`);
  return parsed;
}

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

export function resultOnlyOption(): NonNullable<CommandDescriptor['options']>[number] {
  return option('--result-only', 'Emit only the command-owned result (use with --json)');
}

export function withCompactJsonOptions(
  options: NonNullable<CommandDescriptor['options']> = [],
): NonNullable<CommandDescriptor['options']> {
  return withJsonOption(options);
}

export function withJsonOption(
  options: NonNullable<CommandDescriptor['options']> = [],
): NonNullable<CommandDescriptor['options']> {
  const commonOptions = [jsonOption(), resultOnlyOption(), compactOption()];
  const commonFlags = new Set(commonOptions.map((entry) => entry.flags));
  return [...options.filter((entry) => !commonFlags.has(entry.flags)), ...commonOptions];
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
