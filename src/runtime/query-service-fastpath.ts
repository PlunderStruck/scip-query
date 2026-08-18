import type { SourceSearchOptions } from '../queries/navigation/source-search.js';
import type { CodeFileMemberMode } from '../queries/navigation/code.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../domain/source-inspection-limits.js';
import { DEFAULT_OUTPUT_PAGE_SIZE, writeSerializedJson } from '../platform/terminal-output.js';
import { resolveProjectRoot } from './cli-context.js';
import { assertNavigationDetailAllowed } from './navigation-session.js';
import {
  tryCodeWithQueryService,
  tryEntryPointsWithQueryService,
  tryFilesWithQueryService,
  type QueryServiceEntryPointsOptions,
  tryMembersWithQueryService,
  tryMethodsWithQueryService,
  tryOutlineWithQueryService,
  trySearchSourceWithQueryService,
  tryStatsWithQueryService,
} from './query-service.js';

interface SourceSearchFastPathInvocation {
  kind: 'source-search';
  pattern: string;
  options: SourceSearchOptions;
}

interface OutlineFastPathInvocation {
  kind: 'outline';
  filePattern: string;
}

interface CodeFastPathInvocation {
  kind: 'code';
  selectors: string[];
  options: {
    context: number;
    members: CodeFileMemberMode;
  };
  session: boolean;
}

interface EntryPointsFastPathInvocation {
  kind: 'entrypoints';
  options: QueryServiceEntryPointsOptions;
}

interface FilesFastPathInvocation {
  kind: 'files';
  pattern: string;
}

interface StatsFastPathInvocation {
  kind: 'stats';
}

interface MembersFastPathInvocation {
  kind: 'members';
  symbolPattern: string;
}

interface MethodsFastPathInvocation {
  kind: 'methods';
  className: string;
}

type FastPathInvocation =
  | SourceSearchFastPathInvocation
  | OutlineFastPathInvocation
  | CodeFastPathInvocation
  | EntryPointsFastPathInvocation
  | FilesFastPathInvocation
  | StatsFastPathInvocation
  | MembersFastPathInvocation
  | MethodsFastPathInvocation;

/**
 * Serve eligible machine-oriented navigation forms before loading the full CLI
 * command registry. Any ambiguity falls through to Commander so errors and
 * uncommon invocations retain the canonical CLI behavior.
 */
export function tryRunQueryServiceFastPath(argv: readonly string[]): boolean {
  if (process.env['SCIP_QUERY_PROFILE'] === '1' || process.env['SCIP_QUERY_PROFILE'] === 'true') return false;
  const invocation = parseFastPathInvocation(argv);
  if (!invocation) return false;
  const projectRoot = resolveProjectRoot();
  if (invocation.kind === 'code') {
    try {
      assertNavigationDetailAllowed(projectRoot, 'code', invocation.session);
    } catch {
      return false;
    }
    const response = tryCodeWithQueryService(projectRoot, invocation.selectors, invocation.options, {
      allowDefault: true,
    });
    if (!response) return false;
    writeSerializedJson(response.result.serializedJson);
    return true;
  }
  if (invocation.kind === 'files') {
    const response = tryFilesWithQueryService(projectRoot, invocation.pattern, { allowDefault: true });
    if (!response) return false;
    if (!writeUnpagedJsonResult(response.result)) return false;
    return true;
  }
  if (invocation.kind === 'members') {
    const response = tryMembersWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true });
    if (!response || !writeUnpagedJsonResult(response.result)) return false;
    return true;
  }
  if (invocation.kind === 'methods') {
    const response = tryMethodsWithQueryService(projectRoot, invocation.className, { allowDefault: true });
    if (!response || !writeUnpagedJsonResult(response.result)) return false;
    if (response.result.kind !== 'matched') process.exitCode = 1;
    return true;
  }
  if (invocation.kind === 'stats') {
    const response = tryStatsWithQueryService(projectRoot, { allowDefault: true });
    if (!response) return false;
    writeSerializedJson(JSON.stringify(response.result));
    return true;
  }
  if (invocation.kind === 'entrypoints') {
    const response = tryEntryPointsWithQueryService(projectRoot, invocation.options, { allowDefault: true });
    if (!response) return false;
    writeSerializedJson(JSON.stringify(response.result));
    return true;
  }
  const response =
    invocation.kind === 'source-search'
      ? trySearchSourceWithQueryService(projectRoot, invocation.pattern, invocation.options, { allowDefault: true })
      : tryOutlineWithQueryService(projectRoot, invocation.filePattern, { allowDefault: true });
  if (!response) return false;
  writeSerializedJson(JSON.stringify(response.result));
  return true;
}

export function parseFastPathInvocation(argv: readonly string[]): FastPathInvocation | null {
  if (argv[0] === 'search') return parseSourceSearchInvocation(argv);
  if (argv[0] === 'outline') return parseOutlineInvocation(argv);
  if (argv[0] === 'code') return parseCodeInvocation(argv);
  if (argv[0] === 'entrypoints') return parseEntryPointsInvocation(argv);
  if (argv[0] === 'files') return parseFilesInvocation(argv);
  if (argv[0] === 'stats') return parseStatsInvocation(argv);
  if (argv[0] === 'members') return parseSymbolQueryInvocation(argv, 'members');
  if (argv[0] === 'methods') return parseSymbolQueryInvocation(argv, 'methods');
  return null;
}

function parseSymbolQueryInvocation(
  argv: readonly string[],
  kind: 'members' | 'methods',
): MembersFastPathInvocation | MethodsFastPathInvocation | null {
  let query: string | undefined;
  let json = false;
  let resultOnly = false;
  let compact = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      const remaining = argv.slice(index + 1);
      if (remaining.length !== 1 || query !== undefined) return null;
      query = remaining[0];
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
    if (arg.startsWith('-') || query !== undefined) return null;
    query = arg;
  }

  if (!json || !resultOnly || !compact || query === undefined) return null;
  return kind === 'members' ? { kind, symbolPattern: query } : { kind, className: query };
}

function writeUnpagedJsonResult(result: unknown): boolean {
  const serialized = JSON.stringify(result);
  // The full CLI owns pagination warnings. Fall through when it needs to emit
  // them rather than silently changing stderr on the lightweight path.
  if (serialized.length + 1 > DEFAULT_OUTPUT_PAGE_SIZE) return false;
  writeSerializedJson(serialized);
  return true;
}

function parseFilesInvocation(argv: readonly string[]): FilesFastPathInvocation | null {
  let pattern: string | undefined;
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
    if (arg.startsWith('-') || pattern !== undefined) return null;
    pattern = arg;
  }

  if (!json || !resultOnly || !compact || pattern === undefined) return null;
  return { kind: 'files', pattern };
}

function parseStatsInvocation(argv: readonly string[]): StatsFastPathInvocation | null {
  let json = false;
  let resultOnly = false;
  let compact = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
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
    return null;
  }

  return json && resultOnly && compact ? { kind: 'stats' } : null;
}

function parseEntryPointsInvocation(argv: readonly string[]): EntryPointsFastPathInvocation | null {
  let search: string | undefined;
  let scope: string | undefined;
  let json = false;
  let resultOnly = false;
  let compact = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      const remaining = argv.slice(index + 1);
      if (remaining.length !== 1 || search !== undefined) return null;
      search = remaining[0];
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
    const scopeOption = optionValue(argv, index, arg, '--scope', '-s');
    if (scopeOption) {
      scope = scopeOption.value;
      index = scopeOption.nextIndex;
      continue;
    }
    if (arg.startsWith('-') || search !== undefined) return null;
    search = arg;
  }

  if (!json || !resultOnly || !compact) return null;
  return {
    kind: 'entrypoints',
    options: {
      ...(search === undefined ? {} : { search }),
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

function parseCodeInvocation(argv: readonly string[]): CodeFastPathInvocation | null {
  const selectors: string[] = [];
  let context = 0;
  let members: CodeFileMemberMode = 'exported';
  let session = true;
  let json = false;
  let resultOnly = false;
  let compact = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      selectors.push(...argv.slice(index + 1));
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
    if (arg === '--no-session') {
      session = false;
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
    const membersOption = optionValue(argv, index, arg, '--members');
    if (membersOption) {
      if (membersOption.value !== 'exported' && membersOption.value !== 'all') return null;
      members = membersOption.value;
      index = membersOption.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) return null;
    selectors.push(arg);
  }

  if (
    !json ||
    !resultOnly ||
    !compact ||
    selectors.length < 1 ||
    selectors.length > SOURCE_INSPECTION_MAX_SELECTORS ||
    selectors.some((selector) => selector.length === 0)
  ) {
    return null;
  }
  return { kind: 'code', selectors, options: { context, members }, session };
}

function parseSourceSearchInvocation(argv: readonly string[]): SourceSearchFastPathInvocation | null {
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
    kind: 'source-search',
    pattern,
    options: { scope, context, limit, regexp, ignoreCase, ranking: 'structural' },
  };
}

function parseOutlineInvocation(argv: readonly string[]): OutlineFastPathInvocation | null {
  let filePattern: string | undefined;
  let json = false;
  let resultOnly = false;
  let compact = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      const remaining = argv.slice(index + 1);
      if (remaining.length !== 1 || filePattern !== undefined) return null;
      filePattern = remaining[0];
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
    if (arg === '--signatures') continue;
    if (arg.startsWith('-') || filePattern !== undefined) return null;
    filePattern = arg;
  }

  if (!json || !resultOnly || !compact || filePattern === undefined) return null;
  return { kind: 'outline', filePattern };
}

function optionValue(
  argv: readonly string[],
  index: number,
  arg: string,
  longName: string,
  shortName?: string,
): { value: string; nextIndex: number } | null {
  if (arg.startsWith(`${longName}=`)) return { value: arg.slice(longName.length + 1), nextIndex: index };
  if (arg !== longName && (shortName === undefined || arg !== shortName)) return null;
  const value = argv[index + 1];
  if (value === undefined) return null;
  return { value, nextIndex: index + 1 };
}

function parseInteger(value: string, minimum: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}
