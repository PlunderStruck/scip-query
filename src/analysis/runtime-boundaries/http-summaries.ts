import { createHash } from 'node:crypto';
import type { IndexedDefinition } from '../../domain/types.js';
import {
  callableParameterNames,
  smallestCoveringCallable,
  walkNamedSyntax as walk,
} from '../../source/ast/ast-callables.js';
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

export interface HttpSummaryPropagationResult {
  observations: BoundaryObservation[];
  frontiers: BoundaryFrontier[];
  summaries: number;
  filesInspected: number;
  errors: string[];
}

/**
 * Propagate HTTP capability from proved terminal operations through compiler-resolved callers.
 * Argument roles come from data appearing in fetch arguments or URL/init carrier fields, never names or positions.
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
  const rolesForDefinition = (context: BoundaryFileContext, definition: IndexedDefinition): HttpParameterRoles => {
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
    const cached = state.roles.get(definition.symbol);
    if (cached) return cached;
    const roles = deriveParameterRoles(context, definition);
    state.roles.set(definition.symbol, { symbol: definition.symbol, ...roles });
    state.dirty = true;
    return roles;
  };

  recordSpan('runtime-boundaries.http-summary.seed', () => {
    for (const observation of observations) {
      if (observation.action !== 'http.request' || !observation.owner.symbol) continue;
      if (observation.evidence !== 'call-expression' && observation.evidence !== 'client-adapter') continue;
      const definition = definitionsForFile(observation.owner.file).find(
        (candidate) => candidate.symbol === observation.owner.symbol,
      );
      if (!definition) continue;
      const context = contextForFile(definition.relativePath);
      if (!context) continue;
      const roles = rolesForDefinition(context, definition);
      const summary: HttpCallableSummary = {
        definition,
        ...roles,
        constantMethods: observation.keyParts.flatMap((part) =>
          part.name === 'method' && part.evidence !== 'expression' && HTTP_METHODS.has(part.value.toUpperCase())
            ? [part.value.toUpperCase()]
            : [],
        ),
        depth: 0,
        proofObservationIds: [observation.id],
        proofSpans: [observation.source],
      };
      if (mergeSummary(summaries, summary)) queue.push(summaries.get(definition.symbol)!);
    }
  });

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
        for (const summary of batch) {
          if (summary.depth >= MAX_HTTP_SUMMARY_DEPTH) continue;
          try {
            const resolvedCalls = resolvedCallsBySymbol.get(summary.definition.symbolId);
            if (!resolvedCalls) continue;
            frontiers.push(...resolvedCalls.unresolved.map((site) => httpCallResolutionFrontier(summary, site)));
            for (const site of resolvedCalls.sites) {
              const context = contextForFile(site.file);
              if (!context) continue;
              filesInspected.add(site.file);
              const call = site.callNode;
              const instantiated = instantiateSummaryAtCall(summary, call, context);
              if (instantiated) derived.push(instantiated);

              const callerDefinition = site.caller;
              if (!callerDefinition) continue;
              const localRoles = rolesForDefinition(context, callerDefinition);
              const forwardedRoles = forwardedParameterRoles(db, summary, site);
              const callerSummary: HttpCallableSummary = {
                definition: callerDefinition,
                pathParameterIndexes: uniqueSortedNumbers([
                  ...localRoles.pathParameterIndexes,
                  ...forwardedRoles.pathParameterIndexes,
                ]),
                methodParameterIndexes: uniqueSortedNumbers([
                  ...localRoles.methodParameterIndexes,
                  ...forwardedRoles.methodParameterIndexes,
                ]),
                constantMethods: uniqueSortedStrings([...summary.constantMethods, ...localRoles.constantMethods]),
                depth: summary.depth + 1,
                proofObservationIds: uniqueSortedStrings([
                  ...summary.proofObservationIds,
                  ...(instantiated ? [instantiated.id] : []),
                ]),
                proofSpans: [
                  ...summary.proofSpans,
                  { file: site.file, startLine: site.startLine, endLine: site.endLine },
                ],
              };
              if (mergeSummary(summaries, callerSummary)) queue.push(summaries.get(callerDefinition.symbol)!);
            }
          } catch (error) {
            errors.push(
              `builtin.http-summary failed for ${summary.definition.relativePath}:${summary.definition.startLine + 1}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
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
  };
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
  const paths = summary.pathParameterIndexes.flatMap((index) => {
    const value = evaluateBoundaryValue(context, args[index]);
    return value && value.evidence !== 'expression' && addressLike(value.value) ? [{ index, value }] : [];
  });
  const methods = summary.methodParameterIndexes.flatMap((index) => {
    const value = evaluateBoundaryValue(context, args[index]);
    const method = value?.value.toUpperCase();
    return value && method && value.evidence !== 'expression' && HTTP_METHODS.has(method)
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
      derivation: method?.derivation,
    },
    {
      name: 'path',
      value: path.value,
      evidence: 'constant',
      term: path.term,
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

function deriveParameterRoles(context: BoundaryFileContext, definition: IndexedDefinition): HttpParameterRoles {
  const callable = smallestCoveringCallable(context.root, definition.startLine, definition.endLine);
  if (!callable) return { pathParameterIndexes: [], methodParameterIndexes: [], constantMethods: [] };
  const parameters = callableParameterNames(callable);
  const pathNames = new Set<string>();
  const methodNames = new Set<string>();
  const constantMethods = new Set<string>();

  walk(callable, (node) => {
    if (node.type === 'call_expression') {
      const target = node.childForFieldName('function') ?? node.namedChild(0);
      const leaf = target?.text.replace(/\s+/gu, '').split('.').at(-1) ?? '';
      if (leaf === 'fetch') {
        const args = callArguments(node);
        addReferencedParameters(args[0], parameters, pathNames);
        const methodValue = objectFieldValue(args[1], 'method');
        if (methodValue) {
          addReferencedParameters(methodValue, parameters, methodNames);
          const evaluated = evaluateBoundaryValue(context, methodValue);
          const method = evaluated?.value.toUpperCase();
          if (method && evaluated?.evidence !== 'expression' && HTTP_METHODS.has(method)) constantMethods.add(method);
        } else {
          // An opaque RequestInit carrier may contain the method. We retain only data dependencies here;
          // a caller is instantiated only when exactly one dependency evaluates to a real HTTP verb.
          addReferencedParameters(args[1], parameters, methodNames);
        }
      }
    }
    if (node.type !== 'pair') return;
    const key = node.childForFieldName('key') ?? node.namedChild(0);
    const value = node.childForFieldName('value') ?? node.namedChild(1);
    const field = key?.text.replace(/^['"`]|['"`]$/gu, '').toLowerCase();
    if (field === 'url' || field === 'path' || field === 'endpoint') {
      addReferencedParameters(value, parameters, pathNames);
    }
    if (field === 'init' || field === 'requestinit' || field === 'options') {
      addReferencedParameters(value, parameters, methodNames);
    }
  });

  return {
    pathParameterIndexes: parameters.flatMap((name, index) => (name && pathNames.has(name) ? [index] : [])),
    methodParameterIndexes: parameters.flatMap((name, index) => (name && methodNames.has(name) ? [index] : [])),
    constantMethods: [...constantMethods].sort(),
  };
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
  const existing = summaries.get(incoming.definition.symbol);
  if (!existing) {
    summaries.set(incoming.definition.symbol, incoming);
    return true;
  }
  const pathParameterIndexes = uniqueSortedNumbers([
    ...existing.pathParameterIndexes,
    ...incoming.pathParameterIndexes,
  ]);
  const methodParameterIndexes = uniqueSortedNumbers([
    ...existing.methodParameterIndexes,
    ...incoming.methodParameterIndexes,
  ]);
  const constantMethods = uniqueSortedStrings([...existing.constantMethods, ...incoming.constantMethods]);
  const changed =
    pathParameterIndexes.length !== existing.pathParameterIndexes.length ||
    methodParameterIndexes.length !== existing.methodParameterIndexes.length ||
    constantMethods.length !== existing.constantMethods.length ||
    incoming.depth < existing.depth;
  if (!changed) return false;
  summaries.set(incoming.definition.symbol, {
    ...existing,
    pathParameterIndexes,
    methodParameterIndexes,
    constantMethods,
    depth: Math.min(existing.depth, incoming.depth),
    proofObservationIds: uniqueSortedStrings([...existing.proofObservationIds, ...incoming.proofObservationIds]),
    proofSpans: [...existing.proofSpans, ...incoming.proofSpans],
  });
  return true;
}

function objectFieldValue(node: SyntaxNode | null | undefined, field: string): SyntaxNode | null {
  if (!node) return null;
  for (const pair of node.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key') ?? pair.namedChild(0);
    if (key?.text.replace(/^['"`]|['"`]$/gu, '').toLowerCase() !== field) continue;
    return pair.childForFieldName('value') ?? pair.namedChild(1);
  }
  return null;
}

function addReferencedParameters(
  node: SyntaxNode | null | undefined,
  parameters: readonly (string | null)[],
  output: Set<string>,
): void {
  if (!node) return;
  const identifiers = new Set(node.text.match(/[A-Za-z_$][\w$]*/gu) ?? []);
  for (const parameter of parameters) {
    if (parameter && identifiers.has(parameter)) output.add(parameter);
  }
}

function callArguments(node: SyntaxNode): SyntaxNode[] {
  const args = node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'arguments');
  return args?.namedChildren ?? [];
}

function addressLike(value: string): boolean {
  return value.startsWith('/') || /^https?:\/\//iu.test(value);
}

function uniqueSortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
