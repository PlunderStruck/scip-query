import type { SourceSearchOptions } from '../queries/navigation/source-search.js';
import type { CodeFileMemberMode } from '../queries/navigation/code.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../domain/source-inspection-limits.js';
import { DEFAULT_OUTPUT_PAGE_SIZE, writeSerializedJson } from '../platform/terminal-output.js';
import { resolveProjectRoot } from './cli-context.js';
import { cliVersion } from './cli-support.js';
import { assertNavigationDetailAllowed } from './navigation-session.js';
import {
  tryCodeWithQueryService,
  tryByKindWithQueryService,
  tryDependenceSliceWithQueryService,
  tryEntryPointsWithQueryService,
  tryFileDependenciesWithQueryService,
  tryFilesWithQueryService,
  tryHierarchyWithQueryService,
  tryImportsWithQueryService,
  tryImportedByWithQueryService,
  tryKindCountsWithQueryService,
  type QueryServiceEntryPointsOptions,
  tryMembersWithQueryService,
  tryMethodsWithQueryService,
  tryRefsWithQueryService,
  tryOutlineWithQueryService,
  trySearchSourceWithQueryService,
  tryStatsWithQueryService,
  trySystemWithQueryService,
  trySurfaceWithQueryService,
  tryTraceWithQueryService,
  tryUnusedImportsWithQueryService,
  tryValueFlowWithQueryService,
  trySemanticNeighborhoodWithQueryService,
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

interface FileDependenciesFastPathInvocation {
  kind: 'file-dependencies';
  direction: 'outgoing' | 'incoming';
  filePattern: string;
}

interface ImportedByFastPathInvocation {
  kind: 'imported-by';
  symbolPattern: string;
}

interface HierarchyFastPathInvocation {
  kind: 'hierarchy';
  symbolPattern: string;
}

interface ByKindFastPathInvocation {
  kind: 'by-kind';
  kindQuery: string;
}

interface KindCountsFastPathInvocation {
  kind: 'kind-counts';
}

interface RefsFastPathInvocation {
  kind: 'refs';
  symbolPattern: string;
}

interface TraceFastPathInvocation {
  kind: 'trace';
  symbolPattern: string;
}

interface ValueFlowFastPathInvocation {
  kind: 'value-flow';
  symbolPattern: string;
}

interface DependenceSliceFastPathInvocation {
  kind: 'dependence-slice';
  criterion: string;
}

type SemanticNeighborhoodFastPathInvocation =
  | { kind: 'call-graph'; symbolPattern: string }
  | { kind: 'reference-neighborhood'; symbolPattern: string }
  | { kind: 'reference-reachability'; symbolPattern: string }
  | { kind: 'slice'; symbolPattern: string }
  | { kind: 'dataflow'; symbolPattern: string };

interface ImportsFastPathInvocation {
  kind: 'imports';
  filePattern: string;
}

interface UnusedImportsFastPathInvocation {
  kind: 'unused-imports';
  filePattern: string;
}

interface SurfaceFastPathInvocation {
  kind: 'surface';
  modulePattern: string;
}

interface SystemFastPathInvocation {
  kind: 'system';
  modulePattern: string;
}

type FastPathInvocation =
  | SourceSearchFastPathInvocation
  | OutlineFastPathInvocation
  | CodeFastPathInvocation
  | EntryPointsFastPathInvocation
  | FilesFastPathInvocation
  | StatsFastPathInvocation
  | MembersFastPathInvocation
  | MethodsFastPathInvocation
  | FileDependenciesFastPathInvocation
  | ImportedByFastPathInvocation
  | HierarchyFastPathInvocation
  | ByKindFastPathInvocation
  | KindCountsFastPathInvocation
  | RefsFastPathInvocation
  | TraceFastPathInvocation
  | ValueFlowFastPathInvocation
  | DependenceSliceFastPathInvocation
  | SemanticNeighborhoodFastPathInvocation
  | ImportsFastPathInvocation
  | UnusedImportsFastPathInvocation
  | SystemFastPathInvocation
  | SurfaceFastPathInvocation;

/**
 * Serve eligible machine-oriented navigation forms before loading the full CLI
 * command registry. Any ambiguity falls through to Commander so errors and
 * uncommon invocations retain the canonical CLI behavior.
 */
export async function tryRunQueryServiceFastPath(argv: readonly string[]): Promise<boolean> {
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
  if (invocation.kind === 'file-dependencies') {
    const response = tryFileDependenciesWithQueryService(projectRoot, invocation.direction, invocation.filePattern, {
      allowDefault: true,
    });
    if (!response) return false;
    const command = invocation.direction === 'outgoing' ? 'deps' : 'rdeps';
    await writeSerializedJsonResult(JSON.stringify(response.result), command, argv);
    return true;
  }
  if (invocation.kind === 'imported-by') {
    const response = tryImportedByWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true });
    if (!response) return false;
    await writeSerializedJsonResult(JSON.stringify(response.result), invocation.kind, argv);
    return true;
  }
  if (invocation.kind === 'hierarchy') {
    const response = tryHierarchyWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true });
    if (!response || !writeUnpagedJsonResult(response.result)) return false;
    return true;
  }
  if (invocation.kind === 'by-kind') {
    const response = tryByKindWithQueryService(projectRoot, invocation.kindQuery, { allowDefault: true });
    if (!response || !writeUnpagedJsonResult(response.result)) return false;
    return true;
  }
  if (invocation.kind === 'kind-counts') {
    const response = tryKindCountsWithQueryService(projectRoot, { allowDefault: true });
    if (!response || !writeUnpagedJsonResult(response.result)) return false;
    return true;
  }
  if (invocation.kind === 'refs') {
    const response = tryRefsWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true });
    if (!response) return false;
    await writeSerializedJsonResult(JSON.stringify(response.result), invocation.kind, argv);
    return true;
  }
  if (invocation.kind === 'trace') {
    const response = tryTraceWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true });
    if (!response) return false;
    await writeSerializedJsonResult(response.result.serializedJson, invocation.kind, argv);
    return true;
  }
  if (invocation.kind === 'value-flow') {
    const response = tryValueFlowWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true });
    if (!response) return false;
    await writeSerializedJsonResult(response.result.serializedJson, invocation.kind, argv);
    return true;
  }
  if (invocation.kind === 'dependence-slice') {
    const response = tryDependenceSliceWithQueryService(projectRoot, invocation.criterion, { allowDefault: true });
    if (!response) return false;
    await writeSerializedJsonResult(response.result.serializedJson, invocation.kind, argv);
    return true;
  }
  if (
    invocation.kind === 'call-graph' ||
    invocation.kind === 'reference-neighborhood' ||
    invocation.kind === 'reference-reachability' ||
    invocation.kind === 'slice' ||
    invocation.kind === 'dataflow'
  ) {
    const response = trySemanticNeighborhoodWithQueryService(projectRoot, invocation.kind, invocation.symbolPattern, {
      allowDefault: true,
    });
    if (!response) return false;
    await writeSerializedJsonResult(response.result.serializedJson, invocation.kind, argv);
    return true;
  }
  if (invocation.kind === 'imports') {
    const response = tryImportsWithQueryService(projectRoot, invocation.filePattern, { allowDefault: true });
    if (!response || !writeUnpagedJsonResult(response.result)) return false;
    return true;
  }
  if (invocation.kind === 'unused-imports') {
    const response = tryUnusedImportsWithQueryService(projectRoot, invocation.filePattern, { allowDefault: true });
    if (!response || !writeUnpagedJsonResult(response.result)) return false;
    return true;
  }
  if (invocation.kind === 'system') {
    const response = trySystemWithQueryService(projectRoot, invocation.modulePattern, { allowDefault: true });
    if (!response) return false;
    await writeSerializedJsonResult(response.result.serializedJson, invocation.kind, argv);
    return true;
  }
  if (invocation.kind === 'surface') {
    const response = trySurfaceWithQueryService(projectRoot, invocation.modulePattern, { allowDefault: true });
    if (!response || !writeUnpagedJsonResult(response.result)) return false;
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
  if (argv[0] === 'stats') return parseNoOperandInvocation(argv, 'stats');
  if (argv[0] === 'kind-counts') return parseNoOperandInvocation(argv, 'kind-counts');
  if (argv[0] === 'members') return parseSymbolQueryInvocation(argv, 'members');
  if (argv[0] === 'methods') return parseSymbolQueryInvocation(argv, 'methods');
  if (argv[0] === 'deps') return parseFileDependenciesInvocation(argv, 'outgoing');
  if (argv[0] === 'rdeps') return parseFileDependenciesInvocation(argv, 'incoming');
  if (argv[0] === 'imported-by') return parseImportedByInvocation(argv);
  if (argv[0] === 'hierarchy') return parseHierarchyInvocation(argv);
  if (argv[0] === 'by-kind') return parseByKindInvocation(argv);
  if (argv[0] === 'refs') return parseRefsInvocation(argv);
  if (argv[0] === 'trace') return parseTraceInvocation(argv);
  if (argv[0] === 'value-flow') return parseValueFlowInvocation(argv);
  if (argv[0] === 'dependence-slice') return parseDependenceSliceInvocation(argv);
  if (
    argv[0] === 'call-graph' ||
    argv[0] === 'reference-neighborhood' ||
    argv[0] === 'reference-reachability' ||
    argv[0] === 'slice' ||
    argv[0] === 'dataflow'
  ) {
    return parseSemanticNeighborhoodInvocation(argv);
  }
  if (argv[0] === 'imports') return parseImportsInvocation(argv);
  if (argv[0] === 'unused-imports') return parseUnusedImportsInvocation(argv);
  if (argv[0] === 'system') return parseSystemInvocation(argv);
  if (argv[0] === 'surface') return parseSurfaceInvocation(argv);
  return null;
}

function parseSymbolQueryInvocation(
  argv: readonly string[],
  kind: 'members' | 'methods',
): MembersFastPathInvocation | MethodsFastPathInvocation | null {
  const query = parseExactCompactOperand(argv);
  if (query === null) return null;
  return kind === 'members' ? { kind, symbolPattern: query } : { kind, className: query };
}

function parseFileDependenciesInvocation(
  argv: readonly string[],
  direction: 'outgoing' | 'incoming',
): FileDependenciesFastPathInvocation | null {
  const filePattern = parseExactCompactOperand(argv);
  return filePattern === null ? null : { kind: 'file-dependencies', direction, filePattern };
}

function parseImportedByInvocation(argv: readonly string[]): ImportedByFastPathInvocation | null {
  const symbolPattern = parseExactCompactOperand(argv);
  return symbolPattern === null ? null : { kind: 'imported-by', symbolPattern };
}

function parseHierarchyInvocation(argv: readonly string[]): HierarchyFastPathInvocation | null {
  const symbolPattern = parseExactCompactOperand(argv);
  return symbolPattern === null ? null : { kind: 'hierarchy', symbolPattern };
}

function parseByKindInvocation(argv: readonly string[]): ByKindFastPathInvocation | null {
  const kindQuery = parseExactCompactOperand(argv);
  return kindQuery === null ? null : { kind: 'by-kind', kindQuery };
}

function parseRefsInvocation(argv: readonly string[]): RefsFastPathInvocation | null {
  const symbolPattern = parseExactCompactOperand(argv);
  return symbolPattern === null ? null : { kind: 'refs', symbolPattern };
}

function parseTraceInvocation(argv: readonly string[]): TraceFastPathInvocation | null {
  const symbolPattern = parseExactCompactOperand(argv);
  return symbolPattern === null ? null : { kind: 'trace', symbolPattern };
}

function parseValueFlowInvocation(argv: readonly string[]): ValueFlowFastPathInvocation | null {
  const symbolPattern = parseExactCompactOperand(argv);
  return symbolPattern === null ? null : { kind: 'value-flow', symbolPattern };
}

function parseDependenceSliceInvocation(argv: readonly string[]): DependenceSliceFastPathInvocation | null {
  const criterion = parseExactCompactOperand(argv);
  return criterion === null ? null : { kind: 'dependence-slice', criterion };
}

function parseSemanticNeighborhoodInvocation(argv: readonly string[]): SemanticNeighborhoodFastPathInvocation | null {
  const kind = argv[0];
  if (
    kind !== 'call-graph' &&
    kind !== 'reference-neighborhood' &&
    kind !== 'reference-reachability' &&
    kind !== 'slice' &&
    kind !== 'dataflow'
  ) {
    return null;
  }
  const symbolPattern = parseExactCompactOperand(argv);
  return symbolPattern === null ? null : { kind, symbolPattern };
}

function parseImportsInvocation(argv: readonly string[]): ImportsFastPathInvocation | null {
  const filePattern = parseExactCompactOperand(argv);
  return filePattern === null ? null : { kind: 'imports', filePattern };
}

function parseUnusedImportsInvocation(argv: readonly string[]): UnusedImportsFastPathInvocation | null {
  const filePattern = parseExactCompactOperand(argv);
  return filePattern === null ? null : { kind: 'unused-imports', filePattern };
}

function parseSystemInvocation(argv: readonly string[]): SystemFastPathInvocation | null {
  const modulePattern = parseExactCompactOperand(argv);
  return modulePattern === null ? null : { kind: 'system', modulePattern };
}

function parseSurfaceInvocation(argv: readonly string[]): SurfaceFastPathInvocation | null {
  const modulePattern = parseExactCompactOperand(argv);
  return modulePattern === null ? null : { kind: 'surface', modulePattern };
}

function parseExactCompactOperand(argv: readonly string[]): string | null {
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
  return query;
}

function writeUnpagedJsonResult(result: unknown): boolean {
  return writeUnpagedSerializedJsonResult(JSON.stringify(result));
}

function writeUnpagedSerializedJsonResult(serialized: string): boolean {
  // The full CLI owns pagination warnings. Fall through when it needs to emit
  // them rather than silently changing stderr on the lightweight path.
  if (serialized.length + 1 > DEFAULT_OUTPUT_PAGE_SIZE) return false;
  writeSerializedJson(serialized);
  return true;
}

async function writeSerializedJsonResult(serialized: string, command: string, argv: readonly string[]): Promise<void> {
  if (serialized.length + 1 <= DEFAULT_OUTPUT_PAGE_SIZE) {
    writeSerializedJson(serialized);
    return;
  }
  const { runWithCliOutputPagination } = await import('./output-pagination.js');
  await runWithCliOutputPagination(
    {
      command,
      producerVersion: cliVersion,
      invocationPrefix: process.argv[1] ? [process.execPath, process.argv[1]] : ['scip-query'],
      argv: [...argv],
      cwd: process.cwd(),
      json: true,
      sourceSession: true,
      reemitSource: false,
    },
    () => writeSerializedJson(serialized),
  );
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

function parseNoOperandInvocation(
  argv: readonly string[],
  kind: 'stats' | 'kind-counts',
): StatsFastPathInvocation | KindCountsFastPathInvocation | null {
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

  return json && resultOnly && compact ? { kind } : null;
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
