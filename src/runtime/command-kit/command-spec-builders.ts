import type {
  CommandAgentContract,
  CommandAnalysisSemanticContract,
  CommandDescriptor,
  CommandGraphProjectionSemanticContract,
  CommandInputSlot,
  CommandLocatorSemanticContract,
  CommandMaintenanceSemanticContract,
  CommandOptionParser,
  CommandSemanticOperationalContract,
  CommandScope,
  CommandSourceReadSemanticContract,
  CoveragePolicy,
} from './command-descriptor-types.js';
import type { ClaimFamilyContract, ClaimOrigin, CommandClaimContract } from '../claim-qualification.js';
import { REPOSITORY_OBSERVATION_OPERATION, type CommandOperationSelector } from '../command-operation.js';
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

/**
 * Declare a mixed producer without granting it validation, state authority,
 * or action permission. Result-family bindings retain the actual origins that
 * the old aggregate `mixed` label erased.
 */
export function mixedClaimContract(
  observedSources: CommandClaimContract['observedSources'],
  families: readonly ClaimFamilyContract[],
): CommandClaimContract {
  return {
    origin: 'mixed',
    observedSources,
    producerValidation: { status: 'not-evaluated' },
    families,
  };
}

export function fixedClaimContract(
  origin: Exclude<ClaimOrigin, 'mixed'>,
  observedSources: CommandClaimContract['observedSources'],
): CommandClaimContract {
  return {
    origin,
    observedSources,
    producerValidation: { status: 'not-evaluated' },
  };
}

export function fixedClaimFamily(id: string, selector: string, origin: Exclude<ClaimOrigin, 'mixed'>) {
  return { id, selector, origin: { kind: 'fixed' as const, origin } };
}

export function fieldClaimFamily(
  id: string,
  selector: string,
  field: string,
  values: Readonly<Record<string, Exclude<ClaimOrigin, 'mixed'>>>,
) {
  return { id, selector, origin: { kind: 'result-field' as const, field, values } };
}

/** Concise descriptor-local constructor; the declaration remains beside the command it describes. */
export function agentContract(
  answers: string | readonly string[],
  returns: string | readonly string[],
  inputs: readonly CommandInputSlot[],
  coverage: CoveragePolicy,
  scope: CommandScope | undefined,
  operation: CommandOperationSelector,
  semantic: CommandAgentContract['semantic'],
): CommandAgentContract {
  return {
    answers: typeof answers === 'string' ? [answers] : answers,
    returns: typeof returns === 'string' ? [returns] : returns,
    inputs,
    coverage,
    operation,
    semantic,
    ...(scope ? { scope } : {}),
  };
}

/**
 * Declare an ordinary repository analysis explicitly. The descriptor's own
 * question and result-unit prose remain the command-specific meaning; this
 * helper supplies only the shared conservative limits of that semantic class.
 */
export function analysisAgentContract(
  answers: string | readonly string[],
  returns: string | readonly string[],
  inputs: readonly CommandInputSlot[],
  coverage: CoveragePolicy,
  scope?: CommandScope,
  operation: CommandOperationSelector = REPOSITORY_OBSERVATION_OPERATION,
): CommandAgentContract {
  const normalizedAnswers = typeof answers === 'string' ? [answers] : answers;
  const normalizedReturns = typeof returns === 'string' ? [returns] : returns;
  return agentContract(
    normalizedAnswers,
    normalizedReturns,
    inputs,
    coverage,
    scope,
    operation,
    analysisSemanticContract(
      normalizedAnswers.join(' '),
      normalizedReturns.join('; '),
      ['This command establishes only its declared result units and evidence contract.'],
      undefined,
      { outputCost: coverage === 'complete' ? 'bounded' : 'variable' },
    ),
  );
}

/** Declare an operational or repository-mutating control explicitly. */
export function maintenanceAgentContract(
  answers: string | readonly string[],
  returns: string | readonly string[],
  inputs: readonly CommandInputSlot[],
  coverage: CoveragePolicy,
  scope?: CommandScope,
  operation: CommandOperationSelector = REPOSITORY_OBSERVATION_OPERATION,
): CommandAgentContract {
  const normalizedAnswers = typeof answers === 'string' ? [answers] : answers;
  const normalizedReturns = typeof returns === 'string' ? [returns] : returns;
  return agentContract(
    normalizedAnswers,
    normalizedReturns,
    inputs,
    coverage,
    scope,
    operation,
    maintenanceSemanticContract(normalizedReturns.join('; '), [
      'This command does not establish repository graph relationships unless its result says so explicitly.',
    ]),
  );
}

export function locatorSemanticContract(
  locates: CommandLocatorSemanticContract['locates'],
  nonClaims: readonly string[],
  options: Pick<CommandLocatorSemanticContract, 'ranking' | 'compatibility'> &
    Partial<CommandSemanticOperationalContract> = { ranking: 'identity-only' },
): CommandLocatorSemanticContract {
  return {
    kind: 'locator',
    locates,
    nonClaims,
    outputCost: 'small',
    frontierClosure: ['evidence', 'inspect', 'code'],
    ...options,
  };
}

export function graphProjectionSemanticContract(
  contract: Omit<CommandGraphProjectionSemanticContract, 'kind' | keyof CommandSemanticOperationalContract> &
    Partial<CommandSemanticOperationalContract>,
): CommandGraphProjectionSemanticContract {
  return {
    kind: 'graph-projection',
    outputCost: 'bounded',
    frontierClosure: ['inspect', 'code'],
    ...contract,
  };
}

export function sourceReadSemanticContract(
  reads: CommandSourceReadSemanticContract['reads'],
  nonClaims: readonly string[],
  compatibility?: CommandSourceReadSemanticContract['compatibility'],
  operational: Partial<CommandSemanticOperationalContract> = {},
): CommandSourceReadSemanticContract {
  return {
    kind: 'source-read',
    reads,
    nonClaims,
    outputCost: 'potentially-large',
    frontierClosure: [],
    ...(compatibility ? { compatibility } : {}),
    ...operational,
  };
}

export function analysisSemanticContract(
  analysis: string,
  resultMeaning: string,
  nonClaims: readonly string[],
  compatibility?: CommandAnalysisSemanticContract['compatibility'],
  operational: Partial<CommandSemanticOperationalContract> = {},
): CommandAnalysisSemanticContract {
  return {
    kind: 'analysis',
    analysis,
    resultMeaning,
    nonClaims,
    outputCost: 'bounded',
    frontierClosure: ['inspect', 'code'],
    ...(compatibility ? { compatibility } : {}),
    ...operational,
  };
}

export function maintenanceSemanticContract(
  effect: string,
  nonClaims: readonly string[],
  compatibility?: CommandMaintenanceSemanticContract['compatibility'],
  operational: Partial<CommandSemanticOperationalContract> = {},
): CommandMaintenanceSemanticContract {
  return {
    kind: 'maintenance',
    effect,
    nonClaims,
    outputCost: 'variable',
    frontierClosure: [],
    ...(compatibility ? { compatibility } : {}),
    ...operational,
  };
}
