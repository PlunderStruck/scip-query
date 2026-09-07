import type { SourceSearchOptions } from '../queries/navigation/source-search.js';
import type { CodeFileMemberMode } from '../queries/navigation/code.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../domain/source-inspection-limits.js';
import { cliVersion } from '../platform/cli-version.js';
import { CLIENT_SAFE_OUTPUT_BYTES, writeSerializedJson } from '../platform/terminal-output.js';
import { resolveProjectRoot } from './cli-context.js';
import { cliInvocationPrefix } from './cli-invocation.js';
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
  tryUnusedImportsWithQueryService,
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

interface DependenceSliceFastPathInvocation {
  kind: 'dependence-slice';
  criterion: string;
}

type SemanticNeighborhoodFastPathInvocation = { kind: 'call-graph'; symbolPattern: string };

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
  // These two commands have resolution-dependent exit status, in addition to output transport.
  if (invocation.kind === 'methods') return runMethodsFastPath(projectRoot, invocation);
  if (invocation.kind === 'dependence-slice') return runDependenceSliceFastPath(projectRoot, invocation, argv);
  const output = queryNavigationFastPath(projectRoot, invocation);
  if (!output) return false;
  if (output.mode === 'bounded') return writeUnpagedSerializedJsonResult(output.serialized);
  if (output.mode === 'paged') {
    await writeSerializedJsonResult(output.serialized, output.command ?? invocation.kind, argv);
  } else {
    writeSerializedJson(output.serialized);
  }
  return true;
}

interface FastPathOutput {
  serialized: string;
  mode: 'direct' | 'bounded' | 'paged';
  command?: string;
}

function jsonFastPathOutput(
  response: { result: unknown } | null,
  mode: FastPathOutput['mode'],
  command?: string,
): FastPathOutput | null {
  return response ? { serialized: JSON.stringify(response.result), mode, command } : null;
}

function serializedFastPathOutput(
  response: { result: { serializedJson: string } } | null,
  mode: FastPathOutput['mode'],
): FastPathOutput | null {
  return response ? { serialized: response.result.serializedJson, mode } : null;
}

function runMethodsFastPath(projectRoot: string, invocation: MethodsFastPathInvocation): boolean {
  const response = tryMethodsWithQueryService(projectRoot, invocation.className, { allowDefault: true });
  if (!response || !writeUnpagedJsonResult(response.result)) return false;
  if (response.result.kind !== 'matched') process.exitCode = 1;
  return true;
}

async function runDependenceSliceFastPath(
  projectRoot: string,
  invocation: DependenceSliceFastPathInvocation,
  argv: readonly string[],
): Promise<boolean> {
  const response = tryDependenceSliceWithQueryService(projectRoot, invocation.criterion, { allowDefault: true });
  if (!response) return false;
  const result = JSON.parse(response.result.serializedJson) as { resolution: string };
  if (result.resolution !== 'matched') process.exitCode = 1;
  await writeSerializedJsonResult(response.result.serializedJson, invocation.kind, argv);
  return true;
}

type NavigationFastPathInvocation = Exclude<
  FastPathInvocation,
  MethodsFastPathInvocation | DependenceSliceFastPathInvocation
>;

function navigationKindIn<Kind extends NavigationFastPathInvocation['kind']>(
  invocation: NavigationFastPathInvocation,
  kinds: readonly Kind[],
): invocation is Extract<NavigationFastPathInvocation, { kind: Kind }> {
  return kinds.includes(invocation.kind as Kind);
}

function queryNavigationFastPath(projectRoot: string, invocation: NavigationFastPathInvocation): FastPathOutput | null {
  if (navigationKindIn(invocation, ['code', 'call-graph', 'system']))
    return querySerializedNavigation(projectRoot, invocation);
  if (navigationKindIn(invocation, ['files', 'members', 'file-dependencies', 'imported-by', 'refs', 'surface']))
    return queryPagedNavigation(projectRoot, invocation);
  if (navigationKindIn(invocation, ['hierarchy', 'by-kind', 'kind-counts', 'imports', 'unused-imports']))
    return queryBoundedNavigation(projectRoot, invocation);
  return queryDirectNavigation(projectRoot, invocation);
}

function querySerializedNavigation(
  projectRoot: string,
  invocation: Extract<NavigationFastPathInvocation, { kind: 'code' | 'call-graph' | 'system' }>,
): FastPathOutput | null {
  switch (invocation.kind) {
    case 'code':
      return serializedFastPathOutput(
        tryCodeWithQueryService(projectRoot, invocation.selectors, invocation.options, { allowDefault: true }),
        'direct',
      );
    case 'call-graph':
      return serializedFastPathOutput(
        trySemanticNeighborhoodWithQueryService(projectRoot, invocation.kind, invocation.symbolPattern, {
          allowDefault: true,
        }),
        'paged',
      );
    case 'system':
      return serializedFastPathOutput(
        trySystemWithQueryService(projectRoot, invocation.modulePattern, { allowDefault: true }),
        'paged',
      );
  }
}

function queryPagedNavigation(
  projectRoot: string,
  invocation: Extract<
    NavigationFastPathInvocation,
    { kind: 'files' | 'members' | 'file-dependencies' | 'imported-by' | 'refs' | 'surface' }
  >,
): FastPathOutput | null {
  switch (invocation.kind) {
    case 'files':
      return jsonFastPathOutput(
        tryFilesWithQueryService(projectRoot, invocation.pattern, { allowDefault: true }),
        'paged',
      );
    case 'members':
      return jsonFastPathOutput(
        tryMembersWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true }),
        'paged',
      );
    case 'file-dependencies':
      return jsonFastPathOutput(
        tryFileDependenciesWithQueryService(projectRoot, invocation.direction, invocation.filePattern, {
          allowDefault: true,
        }),
        'paged',
        invocation.direction === 'outgoing' ? 'deps' : 'rdeps',
      );
    case 'imported-by':
      return jsonFastPathOutput(
        tryImportedByWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true }),
        'paged',
      );
    case 'refs':
      return jsonFastPathOutput(
        tryRefsWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true }),
        'paged',
      );
    case 'surface':
      return jsonFastPathOutput(
        trySurfaceWithQueryService(projectRoot, invocation.modulePattern, { allowDefault: true }),
        'paged',
      );
  }
}

function queryBoundedNavigation(
  projectRoot: string,
  invocation: Extract<
    NavigationFastPathInvocation,
    { kind: 'hierarchy' | 'by-kind' | 'kind-counts' | 'imports' | 'unused-imports' }
  >,
): FastPathOutput | null {
  switch (invocation.kind) {
    case 'hierarchy':
      return jsonFastPathOutput(
        tryHierarchyWithQueryService(projectRoot, invocation.symbolPattern, { allowDefault: true }),
        'bounded',
      );
    case 'by-kind':
      return jsonFastPathOutput(
        tryByKindWithQueryService(projectRoot, invocation.kindQuery, { allowDefault: true }),
        'bounded',
      );
    case 'kind-counts':
      return jsonFastPathOutput(tryKindCountsWithQueryService(projectRoot, { allowDefault: true }), 'bounded');
    case 'imports':
      return jsonFastPathOutput(
        tryImportsWithQueryService(projectRoot, invocation.filePattern, { allowDefault: true }),
        'bounded',
      );
    case 'unused-imports':
      return jsonFastPathOutput(
        tryUnusedImportsWithQueryService(projectRoot, invocation.filePattern, { allowDefault: true }),
        'bounded',
      );
  }
}

function queryDirectNavigation(
  projectRoot: string,
  invocation: Extract<NavigationFastPathInvocation, { kind: 'stats' | 'entrypoints' | 'source-search' | 'outline' }>,
): FastPathOutput | null {
  switch (invocation.kind) {
    case 'stats':
      return jsonFastPathOutput(tryStatsWithQueryService(projectRoot, { allowDefault: true }), 'direct');
    case 'entrypoints':
      return jsonFastPathOutput(
        tryEntryPointsWithQueryService(projectRoot, invocation.options, { allowDefault: true }),
        'direct',
      );
    case 'source-search':
      return jsonFastPathOutput(
        trySearchSourceWithQueryService(projectRoot, invocation.pattern, invocation.options, { allowDefault: true }),
        'direct',
      );
    case 'outline':
      return jsonFastPathOutput(
        tryOutlineWithQueryService(projectRoot, invocation.filePattern, { allowDefault: true }),
        'direct',
      );
  }
}

const FAST_PATH_PARSERS = new Map<string, (argv: readonly string[]) => FastPathInvocation | null>([
  ['search', parseSourceSearchInvocation],
  ['outline', parseOutlineInvocation],
  ['code', parseCodeInvocation],
  ['entrypoints', parseEntryPointsInvocation],
  ['files', parseFilesInvocation],
  ['stats', (argv) => parseNoOperandInvocation(argv, 'stats')],
  ['kind-counts', (argv) => parseNoOperandInvocation(argv, 'kind-counts')],
  ['members', (argv) => parseSymbolQueryInvocation(argv, 'members')],
  ['methods', (argv) => parseSymbolQueryInvocation(argv, 'methods')],
  ['deps', (argv) => parseFileDependenciesInvocation(argv, 'outgoing')],
  ['rdeps', (argv) => parseFileDependenciesInvocation(argv, 'incoming')],
  ['imported-by', parseImportedByInvocation],
  ['hierarchy', parseHierarchyInvocation],
  ['by-kind', parseByKindInvocation],
  ['refs', parseRefsInvocation],
  ['dependence-slice', parseDependenceSliceInvocation],
  ['call-graph', parseSemanticNeighborhoodInvocation],
  ['imports', parseImportsInvocation],
  ['unused-imports', parseUnusedImportsInvocation],
  ['system', parseSystemInvocation],
  ['surface', parseSurfaceInvocation],
]);

export function parseFastPathInvocation(argv: readonly string[]): FastPathInvocation | null {
  return FAST_PATH_PARSERS.get(argv[0])?.(argv) ?? null;
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

function parseDependenceSliceInvocation(argv: readonly string[]): DependenceSliceFastPathInvocation | null {
  const criterion = parseExactCompactOperand(argv);
  return criterion === null ? null : { kind: 'dependence-slice', criterion };
}

function parseSemanticNeighborhoodInvocation(argv: readonly string[]): SemanticNeighborhoodFastPathInvocation | null {
  const kind = argv[0];
  if (kind !== 'call-graph') {
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
  if (!serializedJsonFitsClientBudget(serialized)) return false;
  writeSerializedJson(serialized);
  return true;
}

async function writeSerializedJsonResult(serialized: string, command: string, argv: readonly string[]): Promise<void> {
  if (serializedJsonFitsClientBudget(serialized)) {
    writeSerializedJson(serialized);
    return;
  }
  const { runWithCliOutputPagination } = await import('./output-pagination.js');
  await runWithCliOutputPagination(
    {
      command,
      producerVersion: cliVersion,
      invocationPrefix: cliInvocationPrefix(),
      argv: [...argv],
      cwd: process.cwd(),
      json: true,
      sourceSession: true,
      reemitSource: false,
    },
    () => writeSerializedJson(serialized),
  );
}

export function serializedJsonFitsClientBudget(serialized: string): boolean {
  return Buffer.byteLength(serialized) + 1 <= CLIENT_SAFE_OUTPUT_BYTES;
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
  const state: EntryPointsInvocationState = { json: false, resultOnly: false, compact: false };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      const remaining = argv.slice(index + 1);
      if (remaining.length !== 1 || state.search !== undefined) return null;
      state.search = remaining[0];
      break;
    }
    if (applyEntryPointsFlag(state, arg)) continue;
    const scopeOption = optionValue(argv, index, arg, '--scope', '-s');
    if (scopeOption) {
      state.scope = scopeOption.value;
      index = scopeOption.nextIndex;
      continue;
    }
    if (arg.startsWith('-') || state.search !== undefined) return null;
    state.search = arg;
  }

  return entryPointsInvocationResult(state);
}

interface EntryPointsInvocationState {
  search?: string;
  scope?: string;
  json: boolean;
  resultOnly: boolean;
  compact: boolean;
}

function applyEntryPointsFlag(state: EntryPointsInvocationState, arg: string): boolean {
  switch (arg) {
    case '--json':
      state.json = true;
      return true;
    case '--result-only':
      state.resultOnly = true;
      return true;
    case '--compact':
      state.compact = true;
      return true;
    default:
      return false;
  }
}

function entryPointsInvocationResult(state: EntryPointsInvocationState): EntryPointsFastPathInvocation | null {
  const { search, scope, json, resultOnly, compact } = state;
  if (!json || !resultOnly || !compact) return null;
  return {
    kind: 'entrypoints',
    options: {
      ...(search === undefined ? {} : { search }),
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

interface CodeInvocationState {
  selectors: string[];
  context: number;
  members: CodeFileMemberMode;
  session: boolean;
  json: boolean;
  resultOnly: boolean;
  compact: boolean;
}

function applyCodeInvocationFlag(state: CodeInvocationState, arg: string): boolean {
  switch (arg) {
    case '--json':
      state.json = true;
      return true;
    case '--result-only':
      state.resultOnly = true;
      return true;
    case '--compact':
      state.compact = true;
      return true;
    case '--no-session':
      state.session = false;
      return true;
    default:
      return false;
  }
}

function applyCodeInvocationOption(state: CodeInvocationState, argv: readonly string[], index: number): number | null {
  const arg = argv[index];
  const contextOption = optionValue(argv, index, arg, '--context', '-C');
  if (contextOption) {
    const parsed = parseInteger(contextOption.value, 0);
    if (parsed === null) return null;
    state.context = parsed;
    return contextOption.nextIndex;
  }
  const membersOption = optionValue(argv, index, arg, '--members');
  if (membersOption) {
    if (membersOption.value !== 'exported' && membersOption.value !== 'all') return null;
    state.members = membersOption.value;
    return membersOption.nextIndex;
  }
  if (arg.startsWith('-')) return null;
  state.selectors.push(arg);
  return index;
}

function validCodeInvocationState(state: CodeInvocationState): boolean {
  return (
    state.json &&
    state.resultOnly &&
    state.compact &&
    state.selectors.length >= 1 &&
    state.selectors.length <= SOURCE_INSPECTION_MAX_SELECTORS &&
    !state.selectors.some((selector) => selector.length === 0)
  );
}

function parseCodeInvocation(argv: readonly string[]): CodeFastPathInvocation | null {
  const state: CodeInvocationState = {
    selectors: [],
    context: 0,
    members: 'exported',
    session: true,
    json: false,
    resultOnly: false,
    compact: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      state.selectors.push(...argv.slice(index + 1));
      break;
    }
    if (applyCodeInvocationFlag(state, arg)) continue;
    const nextIndex = applyCodeInvocationOption(state, argv, index);
    if (nextIndex === null) return null;
    index = nextIndex;
  }

  const { selectors, context, members, session } = state;
  if (!validCodeInvocationState(state)) return null;
  return { kind: 'code', selectors, options: { context, members }, session };
}

interface SourceSearchInvocationState {
  pattern?: string;
  scope?: string;
  context: number;
  limit: number;
  regexp: boolean;
  ignoreCase: boolean;
  json: boolean;
  resultOnly: boolean;
  compact: boolean;
}

function parseSourceSearchInvocation(argv: readonly string[]): SourceSearchFastPathInvocation | null {
  const state: SourceSearchInvocationState = {
    context: 2,
    limit: 6,
    regexp: false,
    ignoreCase: false,
    json: false,
    resultOnly: false,
    compact: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      const remaining = argv.slice(index + 1);
      if (remaining.length !== 1 || state.pattern !== undefined) return null;
      state.pattern = remaining[0];
      break;
    }
    if (applySourceSearchFlag(state, arg)) continue;
    const nextIndex = applySourceSearchOption(state, argv, index);
    if (nextIndex === null) return null;
    index = nextIndex;
  }
  return sourceSearchInvocationResult(state);
}

function sourceSearchInvocationResult(state: SourceSearchInvocationState): SourceSearchFastPathInvocation | null {
  if (!state.json || !state.resultOnly || !state.compact || state.pattern === undefined) return null;
  const { pattern, scope, context, limit, regexp, ignoreCase } = state;
  return {
    kind: 'source-search',
    pattern,
    options: { scope, context, limit, regexp, ignoreCase, ranking: 'structural' },
  };
}

function applySourceSearchFlag(state: SourceSearchInvocationState, arg: string): boolean {
  switch (arg) {
    case '--json':
      state.json = true;
      return true;
    case '--result-only':
      state.resultOnly = true;
      return true;
    case '--compact':
      state.compact = true;
      return true;
    case '--regexp':
      state.regexp = true;
      return true;
    case '--ignore-case':
    case '-i':
      state.ignoreCase = true;
      return true;
    default:
      return false;
  }
}

function applySourceSearchOption(
  state: SourceSearchInvocationState,
  argv: readonly string[],
  index: number,
): number | null {
  const arg = argv[index];
  const scopeOption = optionValue(argv, index, arg, '--scope', '-s');
  if (scopeOption) {
    state.scope = scopeOption.value;
    return scopeOption.nextIndex;
  }
  const contextOption = optionValue(argv, index, arg, '--context', '-C');
  if (contextOption) return applySourceSearchInteger(state, 'context', contextOption, 0);
  const limitOption = optionValue(argv, index, arg, '--limit', '-n');
  if (limitOption) return applySourceSearchInteger(state, 'limit', limitOption, 1);
  if (arg.startsWith('-') || state.pattern !== undefined) return null;
  state.pattern = arg;
  return index;
}

function applySourceSearchInteger(
  state: SourceSearchInvocationState,
  key: 'context' | 'limit',
  option: { value: string; nextIndex: number },
  minimum: number,
): number | null {
  const parsed = parseInteger(option.value, minimum);
  if (parsed === null) return null;
  state[key] = parsed;
  return option.nextIndex;
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
