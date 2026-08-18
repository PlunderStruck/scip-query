import type { SourceSearchOptions } from '../queries/navigation/source-search.js';
import { writeSerializedJson } from '../platform/terminal-output.js';
import { resolveProjectRoot } from './cli-context.js';
import { trySearchSourceWithQueryService } from './query-service.js';

interface FastPathInvocation {
  pattern: string;
  options: SourceSearchOptions;
}

/**
 * Serve the machine-oriented search form before loading the full CLI command
 * registry. Any ambiguity falls through to Commander so errors and uncommon
 * invocations retain the canonical CLI behavior.
 */
export function tryRunQueryServiceFastPath(argv: readonly string[]): boolean {
  if (process.env['SCIP_QUERY_PROFILE'] === '1' || process.env['SCIP_QUERY_PROFILE'] === 'true') return false;
  const invocation = parseFastPathInvocation(argv);
  if (!invocation) return false;
  const response = trySearchSourceWithQueryService(resolveProjectRoot(), invocation.pattern, invocation.options, {
    allowDefault: true,
  });
  if (!response) return false;
  writeSerializedJson(JSON.stringify(response.result));
  return true;
}

export function parseFastPathInvocation(argv: readonly string[]): FastPathInvocation | null {
  if (argv[0] !== 'search') return null;
  let pattern: string | undefined;
  let scope: string | undefined;
  let context = 2;
  let limit = 6;
  let regexp = false;
  let ignoreCase = false;
  let json = false;
  let resultOnly = false;
  let compact = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      const remaining = argv.slice(index + 1);
      if (remaining.length !== 1 || pattern !== undefined) return null;
      pattern = remaining[0];
      break;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--result-only') {
      resultOnly = true;
      continue;
    }
    if (arg === '--compact') {
      compact = true;
      continue;
    }
    if (arg === '--regexp') {
      regexp = true;
      continue;
    }
    if (arg === '--ignore-case' || arg === '-i') {
      ignoreCase = true;
      continue;
    }
    const scopeOption = optionValue(argv, index, arg, '--scope', '-s');
    if (scopeOption) {
      scope = scopeOption.value;
      index = scopeOption.nextIndex;
      continue;
    }
    const contextOption = optionValue(argv, index, arg, '--context', '-C');
    if (contextOption) {
      const parsed = parseInteger(contextOption.value, 0);
      if (parsed === null) return null;
      context = parsed;
      index = contextOption.nextIndex;
      continue;
    }
    const limitOption = optionValue(argv, index, arg, '--limit', '-n');
    if (limitOption) {
      const parsed = parseInteger(limitOption.value, 1);
      if (parsed === null) return null;
      limit = parsed;
      index = limitOption.nextIndex;
      continue;
    }
    if (arg.startsWith('-') || pattern !== undefined) return null;
    pattern = arg;
  }

  if (!json || !resultOnly || !compact || pattern === undefined) return null;
  return {
    pattern,
    options: { scope, context, limit, regexp, ignoreCase, ranking: 'structural' },
  };
}

function optionValue(
  argv: readonly string[],
  index: number,
  arg: string,
  longName: string,
  shortName: string,
): { value: string; nextIndex: number } | null {
  if (arg.startsWith(`${longName}=`)) return { value: arg.slice(longName.length + 1), nextIndex: index };
  if (arg !== longName && arg !== shortName) return null;
  const value = argv[index + 1];
  if (value === undefined) return null;
  return { value, nextIndex: index + 1 };
}

function parseInteger(value: string, minimum: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}
