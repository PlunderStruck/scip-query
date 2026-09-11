import type { HttpSummaryPropagationResult } from './types.js';
export type { HttpSummaryPropagationResult } from './types.js';
import { createHash } from 'node:crypto';
import type { IndexedDefinition } from '../../domain/types.js';
import { sourceAnalysisRoot, ANALYSIS_CALLABLE_NODE_TYPES } from '../../source/ast/ast-callables.js';
import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import { effectiveObjectField, isPlatformFetch, fetchRequestMethod } from './http-call-semantics.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { fileContentHash } from '../../storage/evidence-cache.js';
import { createFileEvidenceProduct, evidenceProductInvalidation } from '../../storage/evidence-products.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import {
  resolvedCallSitesForDefinitions,
  type ResolvedCallSite,
  type UnresolvedCallSite,
} from '../../symbols/graph/resolved-call-sites.js';
import { forwardedCallerParameterPositions, parameterValueFlowAtCall } from '../../symbols/graph/value-flow.js';
import {
  boundaryFileContext,
  createBoundaryObservation,
  type BoundaryFileContext,
  type RuntimeBoundaryProfileSpan,
} from './extractors.js';
import { evaluateStaticValue as evaluateBoundaryValue } from '../../symbols/graph/static-value-flow.js';
import { deduplicateFrontiers } from './frontiers.js';
import { runtimeBoundarySourceScope } from './source-scope.js';
import type { BoundaryFrontier, BoundaryKeyPart, BoundaryObservation, BoundarySourceLocation } from './types.js';

const HTTP_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const MAX_HTTP_SUMMARY_DEPTH = 8;

/** The complete observation subset consumed by HTTP summary seeding. */
export function httpSummarySeeds(observations: readonly BoundaryObservation[]): BoundaryObservation[] {
  return observations.filter(
    (observation) =>
      observation.action === 'http.request' &&
      !!observation.owner.symbol &&
      (observation.evidence === 'call-expression' || observation.evidence === 'client-adapter'),
  );
}

interface HttpCallableSummary {
  definition: IndexedDefinition;
  pathParameterIndexes: number[];
  methodParameterIndexes: number[];
  constantMethods: string[];
  depth: number;
  proofObservationIds: string[];
  proofSpans: BoundarySourceLocation[];
}

interface HttpParameterRoles {
  pathParameterIndexes: number[];
  methodParameterIndexes: number[];
  constantMethods: string[];
}

interface CachedHttpParameterRoles extends HttpParameterRoles {
  symbol: string;
}

interface HttpRoleFileState {
  contentHash: string;
  roles: Map<string, CachedHttpParameterRoles>;
  dirty: boolean;
}

const HTTP_PARAMETER_ROLES_PRODUCT = createFileEvidenceProduct<CachedHttpParameterRoles[]>({
  kind: 'runtime-boundary-http-roles',
  invalidation: evidenceProductInvalidation('runtime-boundary-http-roles'),
  serialize: serializeHttpParameterRoles,
  deserialize: deserializeHttpParameterRoles,
});

/**
 * Propagate HTTP capability from proved terminal operations through compiler-resolved callers.
 * Argument roles require direct compiler parameter bindings at each request; transformed values and opaque option carriers remain unresolved.
 */
export function propagateCompilerResolvedHttpSummaries(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
  profileSpan?: RuntimeBoundaryProfileSpan,
): HttpSummaryPropagationResult {
  const recordSpan: RuntimeBoundaryProfileSpan = profileSpan ?? ((_name, run) => run());
  const summaries = new Map<string, HttpCallableSummary>();
  const queue: HttpCallableSummary[] = [];
  const derived: BoundaryObservation[] = [];
  const filesInspected = new Set<string>();
  const errors: string[] = [];
  const frontiers: BoundaryFrontier[] = [];
  const contexts = new Map<string, BoundaryFileContext | null>();
  const definitions = new Map<string, readonly IndexedDefinition[]>();
  const roleFiles = new Map<string, HttpRoleFileState>();
  const contextForFile = (file: string): BoundaryFileContext | null => {
    if (contexts.has(file)) return contexts.get(file) ?? null;
    const context = boundaryFileContext(db, file);
    contexts.set(file, context);
    return context;
  };
  const definitionsForFile = (file: string): readonly IndexedDefinition[] => {
    const existing = definitions.get(file);
    if (existing) return existing;
    const fileDefinitions = getDefinitionsForFile(db, file);
    definitions.set(file, fileDefinitions);
    return fileDefinitions;
  };
  const rolesForDefinition = (
    context: BoundaryFileContext,
    definition: IndexedDefinition,
    source: BoundarySourceLocation,
  ): HttpParameterRoles => {
    let state = roleFiles.get(context.file);
    if (!state) {
      const contentHash = fileContentHash(db, context.file, context.source);
      const cached = HTTP_PARAMETER_ROLES_PRODUCT.read(db, context.file, contentHash) ?? [];
      state = {
        contentHash,
        roles: new Map(cached.map((roles) => [roles.symbol, roles])),
        dirty: false,
      };
      roleFiles.set(context.file, state);
    }
    const roleKey = `v2:${definition.symbol}:${source.startLine}:${source.startColumn}:${source.endLine}:${source.endColumn}`;
    const cached = state.roles.get(roleKey);
    if (cached) return cached;
    const roles = deriveParameterRoles(context, source);
    state.roles.set(roleKey, { symbol: roleKey, ...roles });
    state.dirty = true;
    return roles;
  };

  recordSpan('runtime-boundaries.http-summary.seed', () => {
    for (const observation of httpSummarySeeds(observations)) {
      const definition = definitionsForFile(observation.owner.file).find(
        (candidate) => candidate.symbol === observation.owner.symbol,
      );
      if (!definition) continue;
      const context = contextForFile(definition.relativePath);
      if (!context) continue;
      const roles = rolesForDefinition(context, definition, observation.source);
      const summary: HttpCallableSummary = {
        definition,
        ...roles,
        depth: 0,
        proofObservationIds: [observation.id],
        proofSpans: [observation.source],
      };
      if (mergeSummary(summaries, summary)) queue.push(summary);
    }
  });

  const propagation: HttpPropagationState = {
    db,
    summaries,
    queue,
    derived,
    filesInspected,
    errors,
    frontiers,
    contextForFile,
  };

  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length);
    const resolvedCallsBySymbol = recordSpan(
      'runtime-boundaries.http-summary.resolve-call-sites',
      () =>
        resolvedCallSitesForDefinitions(
          db,
          batch.map((summary) => summary.definition),
        ),
      { batchSize: batch.length },
    );
    recordSpan(
      'runtime-boundaries.http-summary.process-call-sites',
      () => {
        for (const summary of batch) processHttpSummary(summary, resolvedCallsBySymbol, propagation);
      },
      { batchSize: batch.length },
    );
  }

  HTTP_PARAMETER_ROLES_PRODUCT.writeBatch(
    db,
    [...roleFiles.entries()].flatMap(([relativePath, state]) =>
      state.dirty
        ? [
            {
              relativePath,
              contentHash: state.contentHash,
              value: [...state.roles.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)),
            },
          ]
        : [],
    ),
  );

  return {
    observations: derived,
    frontiers: deduplicateFrontiers(frontiers),
    summaries: summaries.size,
    filesInspected: filesInspected.size,
    errors,
    summarySymbols: uniqueSortedStrings([...summaries.values()].map((summary) => summary.definition.symbol)),
    inspectedFiles: [...filesInspected].sort(),
  };
}

interface HttpPropagationState {
  db: ScipDatabase;
  summaries: Map<string, HttpCallableSummary>;
  queue: HttpCallableSummary[];
  derived: BoundaryObservation[];
  filesInspected: Set<string>;
  errors: string[];
  frontiers: BoundaryFrontier[];
  contextForFile: (file: string) => BoundaryFileContext | null;
}

function processHttpSummary(
  summary: HttpCallableSummary,
  resolvedCallsBySymbol: ReturnType<typeof resolvedCallSitesForDefinitions>,
  state: HttpPropagationState,
): void {
  const { errors, frontiers } = state;
  if (summary.depth >= MAX_HTTP_SUMMARY_DEPTH) return;
  try {
    const resolvedCalls = resolvedCallsBySymbol.get(summary.definition.symbolId);
    if (!resolvedCalls) return;
    frontiers.push(...resolvedCalls.unresolved.map((site) => httpCallResolutionFrontier(summary, site)));
    for (const site of resolvedCalls.sites) processHttpSummarySite(summary, site, state);
  } catch (error) {
    errors.push(
      `builtin.http-summary failed for ${summary.definition.relativePath}:${summary.definition.startLine + 1}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function processHttpSummarySite(
  summary: HttpCallableSummary,
  site: ResolvedCallSite,
  state: HttpPropagationState,
): void {
  const { db, summaries, queue, derived, filesInspected, contextForFile } = state;
  const context = contextForFile(site.file);
  if (!context) return;
  filesInspected.add(site.file);
  const call = site.callNode;
  const instantiated = instantiateSummaryAtCall(summary, call, context);
  if (instantiated) derived.push(instantiated);

  const callerDefinition = site.caller;
  if (!callerDefinition) return;
  const forwardedRoles = forwardedParameterRoles(db, summary, site);
  const callerSummary: HttpCallableSummary = {
    definition: callerDefinition,
    ...forwardedRoles,
    constantMethods: uniqueSortedStrings([
      ...summary.constantMethods,
      ...resolvedMethodArguments(summary, call, context),
    ]),
    depth: summary.depth + 1,
    proofObservationIds: uniqueSortedStrings([
      ...summary.proofObservationIds,
      ...(instantiated ? [instantiated.id] : []),
    ]),
    proofSpans: [...summary.proofSpans, { file: site.file, startLine: site.startLine, endLine: site.endLine }],
  };
  if (mergeSummary(summaries, callerSummary)) queue.push(callerSummary);
}

function httpCallResolutionFrontier(summary: HttpCallableSummary, site: UnresolvedCallSite): BoundaryFrontier {
  const missingKeyParts = uniqueSortedStrings([
    ...(summary.pathParameterIndexes.length > 0 ? ['path'] : []),
    ...(summary.methodParameterIndexes.length > 0 && summary.constantMethods.length !== 1 ? ['method'] : []),
  ]);
  const method = summary.constantMethods.length === 1 ? summary.constantMethods[0] : '?';
  const identity = `${summary.definition.symbol}\0${site.file}\0${site.line}\0${site.reason}`;
  return {
    observationId: `frontier:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
    kind: 'call-resolution',
    action: 'http.request',
    strength: 'candidate',
    source: { file: site.file, startLine: site.line, endLine: site.line },
    ownerShortName: null,
    address: `method=${method ?? '?'} path=?`,
    reason:
      `Compiler identity found a reference to ${summary.definition.leaf}, but exact call recovery stopped ` +
      `with ${site.reason} (${site.candidates} syntax candidate(s)); HTTP value propagation did not cross this site.`,
    missingKeyParts: missingKeyParts.length > 0 ? missingKeyParts : ['call'],
    sourceScope: runtimeBoundarySourceScope(site.file),
  };
}

function instantiateSummaryAtCall(
  summary: HttpCallableSummary,
  call: SyntaxNode,
  context: BoundaryFileContext,
): BoundaryObservation | null {
  const args = callArguments(call);
  if (args.some((argument) => argument.type === 'spread_element')) return null;
  const paths = summary.pathParameterIndexes.flatMap((index) => {
    const value = evaluateBoundaryValue(context, args[index]);
    return value && value.evidence !== 'expression' && addressLike(value.value) ? [{ index, value }] : [];
  });
  const methods = summary.methodParameterIndexes.flatMap((index) => {
    const value = evaluateBoundaryValue(context, args[index]);
    const method = value?.value.toUpperCase();
    return value &&
      method &&
      value.precision === 'literal' &&
      value.evidence !== 'expression' &&
      HTTP_METHODS.has(method)
      ? [{ index, value: { ...value, value: method } }]
      : [];
  });
  const resolvedMethods = uniqueSortedStrings([...summary.constantMethods, ...methods.map((item) => item.value.value)]);
  if (paths.length !== 1 || resolvedMethods.length !== 1) return null;
  const path = paths[0]!.value;
  const method = methods.find((item) => item.value.value === resolvedMethods[0])?.value;
  const keyParts: BoundaryKeyPart[] = [
    {
      name: 'method',
      value: resolvedMethods[0]!,
      evidence: method ? 'constant' : 'literal',
      term: method?.term ?? { kind: 'literal', value: resolvedMethods[0]! },
      precision: 'literal',
      derivation: method?.derivation,
    },
    {
      name: 'path',
      value: path.value,
      evidence: 'constant',
      term: path.term,
      precision: path.precision,
      derivation: path.derivation,
    },
  ];
  const observation = createBoundaryObservation(
    context,
    call,
    'builtin.http-summary',
    'http.request',
    keyParts,
    'derived',
    'compiler-resolved-http-summary',
  );
  observation.derivation = {
    kind: 'mechanically-derived',
    rule: 'compiler-resolved-http-summary',
    ruleVersion: '1',
    inputFactIds: summary.proofObservationIds,
    sourceSpans: [...summary.proofSpans, observation.source],
  };
  return observation;
}

function deriveParameterRoles(context: BoundaryFileContext, source: BoundarySourceLocation): HttpParameterRoles {
  const empty: HttpParameterRoles = { pathParameterIndexes: [], methodParameterIndexes: [], constantMethods: [] };
  if (source.startColumn === undefined || source.endColumn === undefined) return empty;
  const call = sourceAnalysisRoot(context.root, source.startLine, source.endLine, ANALYSIS_CALLABLE_NODE_TYPES, source);
  if (call?.type !== 'call_expression') return empty;
  const bindings = sourceBindingResolver(context.file, context.root);
  const target = call.childForFieldName('function');
  const imported = target && bindings.importedValue(target);
  const fetch = isPlatformFetch(context, call);
  const axiosMethod = imported?.module === 'axios' && imported.member ? imported.member.toUpperCase() : null;
  if (!fetch && (!axiosMethod || !HTTP_METHODS.has(axiosMethod))) return empty;
  const args = callArguments(call);
  if (args.some((argument) => argument.type === 'spread_element')) return empty;
  const pathPosition = args[0] ? bindings.directParameterPosition(args[0]) : null;
  const method = fetch ? effectiveObjectField(context, args[1], 'method') : null;
  const methodPosition = method?.kind === 'value' ? bindings.directParameterPosition(method.node) : null;
  const constantMethod = fetch ? fetchRequestMethod(args[1], context) : axiosMethod;
  return {
    pathParameterIndexes: pathPosition === null ? [] : [pathPosition],
    methodParameterIndexes: methodPosition === null ? [] : [methodPosition],
    constantMethods: constantMethod && HTTP_METHODS.has(constantMethod) ? [constantMethod] : [],
  };
}

function resolvedMethodArguments(
  summary: HttpCallableSummary,
  call: SyntaxNode,
  context: BoundaryFileContext,
): string[] {
  const args = callArguments(call);
  if (args.some((argument) => argument.type === 'spread_element')) return [];
  return summary.methodParameterIndexes.flatMap((index) => {
    const value = evaluateBoundaryValue(context, args[index]);
    return value &&
      value.precision === 'literal' &&
      ['constant', 'literal'].includes(value.evidence) &&
      HTTP_METHODS.has(value.value.toUpperCase())
      ? [value.value.toUpperCase()]
      : [];
  });
}

function serializeHttpParameterRoles(roles: readonly CachedHttpParameterRoles[]): string {
  return roles
    .map((role) =>
      [
        encodeURIComponent(role.symbol),
        role.pathParameterIndexes.join(','),
        role.methodParameterIndexes.join(','),
        role.constantMethods.join(','),
      ].join('\t'),
    )
    .join('\n');
}

function deserializeHttpParameterRoles(payload: string): CachedHttpParameterRoles[] | null {
  if (!payload) return [];
  const roles: CachedHttpParameterRoles[] = [];
  for (const line of payload.split('\n')) {
    const fields = line.split('\t');
    if (fields.length !== 4) return null;
    const pathParameterIndexes = parseNumberList(fields[1]!);
    const methodParameterIndexes = parseNumberList(fields[2]!);
    const constantMethods = fields[3] ? fields[3].split(',') : [];
    if (
      pathParameterIndexes === null ||
      methodParameterIndexes === null ||
      constantMethods.some((method) => !HTTP_METHODS.has(method))
    ) {
      return null;
    }
    roles.push({
      symbol: decodeURIComponent(fields[0]!),
      pathParameterIndexes,
      methodParameterIndexes,
      constantMethods,
    });
  }
  return roles;
}

function parseNumberList(value: string): number[] | null {
  if (!value) return [];
  const numbers = value.split(',').map(Number);
  return numbers.every((number) => Number.isSafeInteger(number) && number >= 0) ? numbers : null;
}

function forwardedParameterRoles(
  db: ScipDatabase,
  callee: HttpCallableSummary,
  site: ResolvedCallSite,
): Pick<HttpCallableSummary, 'pathParameterIndexes' | 'methodParameterIndexes'> {
  const flow = parameterValueFlowAtCall(db, site);
  return {
    pathParameterIndexes: forwardedCallerParameterPositions(flow, callee.pathParameterIndexes),
    methodParameterIndexes: forwardedCallerParameterPositions(flow, callee.methodParameterIndexes),
  };
}

function mergeSummary(summaries: Map<string, HttpCallableSummary>, incoming: HttpCallableSummary): boolean {
  if (incoming.pathParameterIndexes.length === 0) return false;
  // Keep each terminal's correlated argument roles and method together. Combining
  // two operations can manufacture a path/method pair that neither operation uses.
  const key = JSON.stringify([
    incoming.definition.symbol,
    incoming.pathParameterIndexes,
    incoming.methodParameterIndexes,
    incoming.constantMethods,
  ]);
  const existing = summaries.get(key);
  if (existing && existing.depth <= incoming.depth) return false;
  summaries.set(key, incoming);
  return true;
}

function callArguments(node: SyntaxNode): SyntaxNode[] {
  const args = node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'arguments');
  return args?.namedChildren ?? [];
}

function addressLike(value: string): boolean {
  return value.startsWith('/') || /^https?:\/\//iu.test(value);
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
