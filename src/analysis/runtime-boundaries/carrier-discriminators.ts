import { sourceCallableForDefinition } from '../../symbols/graph/callable-owner-identity.js';
import type { IndexedDefinition } from '../../domain/types.js';
import {
  addReferencedParameters,
  callableParameterNames as callableParameterNamesFromNode,
  sourceAnalysisRoot,
  ANALYSIS_CALLABLE_NODE_TYPES,
  unwrapExpression,
  walkNamedSyntax as walk,
} from '../../source/ast/ast-callables.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { escapeRegex } from '../../source/primitives/regex-utils.js';
import type { ScipDatabase } from '../../storage/db.js';
import { findEnclosingDefinition, getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { resolvedCallSitesForDefinition } from '../../symbols/graph/resolved-call-sites.js';
import { evaluateStaticValue as evaluateBoundaryValue } from '../../symbols/graph/static-value-flow.js';
import { forwardedCallerParameterPositions, parameterValueFlowAtCall } from '../../symbols/graph/value-flow.js';
import { boundaryFileContext, createBoundaryObservation, type BoundaryFileContext } from './extractors.js';
import { resolveCallableExpression, resolveObjectBinding } from './object-members.js';
import type {
  BoundaryKeyPart,
  BoundaryObservation,
  BoundarySourceLocation,
  RuntimeBoundaryBodySummary,
} from './types.js';

const MAX_BODY_SUMMARY_DEPTH = 8;
const MAX_DISCRIMINATOR_SUMMARY_DEPTH = 8;

export interface BodyCallableSummary {
  definition: IndexedDefinition;
  parameterIndexes: number[];
  depth: number;
  proofSpans: BoundarySourceLocation[];
}

interface DiscriminatorCallableSummary {
  definition: IndexedDefinition;
  carrier: string;
  field: string;
  parameterIndex: number;
  depth: number;
  proofObservationIds: string[];
  proofSpans: BoundarySourceLocation[];
}

export interface CarrierDiscriminatorResult {
  observations: BoundaryObservation[];
  bodySummaries: number;
  discriminatorSummaries: number;
  filesInspected: number;
  errors: string[];
}

interface BodySummaryCollectionResult {
  summaries: Map<string, BodyCallableSummary>;
  filesInspected: number;
}

/**
 * Bind scalar request-body discriminators to variable-key registries through a proved HTTP carrier.
 * The analysis derives body roles from serialization, follows compiler-resolved calls, and emits
 * possible discriminator values. Body transformations, handler binding and deployment
 * identity require confirmation; these observations never establish executable handoffs.
 */
export function deriveCarrierDiscriminators(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
  bodySummarySeeds: readonly RuntimeBoundaryBodySummary[] = [],
): CarrierDiscriminatorResult {
  const errors: string[] = [];
  const bodySummaryCollection = collectBodySummaryResult(db, bodySummarySeeds, errors);
  const bodySummaries = bodySummaryCollection.summaries;
  const producer = deriveProducerDiscriminators(db, observations, bodySummaries, errors);
  const consumers = deriveConsumerDiscriminators(db, observations, errors);
  return {
    observations: deduplicateObservations([...producer.observations, ...consumers]),
    bodySummaries: bodySummaries.size,
    discriminatorSummaries: producer.summaries,
    filesInspected: bodySummaryCollection.filesInspected,
    errors,
  };
}

function propagateBodySummary(
  db: ScipDatabase,
  summary: BodyCallableSummary,
  contextForFile: (file: string) => BoundaryFileContext | null,
  summaries: Map<string, BodyCallableSummary>,
  queue: BodyCallableSummary[],
): void {
  for (const site of resolvedCallSitesForDefinition(db, summary.definition).sites) {
    const context = contextForFile(site.file);
    if (!context) continue;
    const caller = site.caller;
    if (!caller) continue;
    const forwarded = forwardedCallerParameterPositions(parameterValueFlowAtCall(db, site), summary.parameterIndexes);
    if (forwarded.length === 0) continue;
    const incoming: BodyCallableSummary = {
      definition: caller,
      parameterIndexes: uniqueSortedNumbers(forwarded),
      depth: summary.depth + 1,
      proofSpans: [...summary.proofSpans, { file: site.file, startLine: site.startLine, endLine: site.endLine }],
    };
    if (mergeBodySummary(summaries, incoming)) queue.push(summaries.get(caller.symbol)!);
  }
}

function collectBodySummaryResult(
  db: ScipDatabase,
  seeds: readonly RuntimeBoundaryBodySummary[],
  errors: string[],
): BodySummaryCollectionResult {
  const summaries = new Map<string, BodyCallableSummary>();
  const queue: BodyCallableSummary[] = [];
  const contexts = new Map<string, BoundaryFileContext | null>();
  const contextForFile = (file: string): BoundaryFileContext | null => {
    if (contexts.has(file)) return contexts.get(file) ?? null;
    const context = boundaryFileContext(db, file);
    contexts.set(file, context);
    return context;
  };
  for (const seed of seeds) {
    const summary: BodyCallableSummary = {
      ...seed,
      depth: 0,
      proofSpans: [
        {
          file: seed.definition.relativePath,
          startLine: seed.definition.startLine,
          endLine: seed.definition.endLine,
        },
      ],
    };
    summaries.set(seed.definition.symbol, summary);
    queue.push(summary);
  }

  while (queue.length > 0) {
    const summary = queue.shift()!;
    if (summary.depth >= MAX_BODY_SUMMARY_DEPTH) continue;
    try {
      propagateBodySummary(db, summary, contextForFile, summaries, queue);
    } catch (error) {
      errors.push(`builtin.carrier body summary failed for ${summary.definition.relativePath}: ${errorMessage(error)}`);
    }
  }
  return { summaries, filesInspected: new Set(seeds.map((seed) => seed.definition.relativePath)).size };
}

interface ProducerDiscriminatorState {
  summaries: Map<string, DiscriminatorCallableSummary>;
  queue: DiscriminatorCallableSummary[];
  produced: BoundaryObservation[];
}

interface ProducerDiscriminatorSeed {
  carrier: string;
  context: BoundaryFileContext;
  owner: IndexedDefinition;
  ownerParameters: ReturnType<typeof callableParameterNames>;
  args: SyntaxNode[];
  bodySummary: BodyCallableSummary;
}

function deriveProducerDiscriminators(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
  bodySummaries: ReadonlyMap<string, BodyCallableSummary>,
  errors: string[],
): { observations: BoundaryObservation[]; summaries: number } {
  const state: ProducerDiscriminatorState = { summaries: new Map(), queue: [], produced: [] };
  for (const boundary of observations) {
    const seed = resolveProducerDiscriminatorSeed(db, boundary, bodySummaries);
    if (seed) collectProducerDiscriminatorFields(boundary, seed, state);
  }
  while (state.queue.length > 0) {
    const summary = state.queue.shift()!;
    if (summary.depth >= MAX_DISCRIMINATOR_SUMMARY_DEPTH) continue;
    try {
      propagateProducerDiscriminator(db, summary, state);
    } catch (error) {
      errors.push(
        `builtin.carrier discriminator summary failed for ${summary.definition.relativePath}: ${errorMessage(error)}`,
      );
    }
  }
  return { observations: state.produced, summaries: state.summaries.size };
}

function enqueueDiscriminatorSummary(state: ProducerDiscriminatorState, summary: DiscriminatorCallableSummary): void {
  const key = discriminatorSummaryKey(summary);
  if (state.summaries.has(key)) return;
  state.summaries.set(key, summary);
  state.queue.push(summary);
}

function producerBoundaryBodySummary(
  db: ScipDatabase,
  boundary: BoundaryObservation,
  context: BoundaryFileContext,
  bodySummaries: ReadonlyMap<string, BodyCallableSummary>,
) {
  const calls = callsCoveringLine(context.root, boundary.source.startLine);
  const boundaryCall = calls.find((call) => call.startPosition.row === boundary.source.startLine) ?? calls[0];
  if (!boundaryCall) return null;
  const target = callTargetNode(boundaryCall);
  if (!target) return null;
  const callees = resolveCallableExpression(db, boundary.source.file, target.text);
  if (callees.length !== 1) return null;
  const bodySummary = bodySummaries.get(callees[0]!.symbol);
  if (!bodySummary) return null;
  return { boundaryCall, bodySummary };
}

function resolveProducerDiscriminatorSeed(
  db: ScipDatabase,
  boundary: BoundaryObservation,
  bodySummaries: ReadonlyMap<string, BodyCallableSummary>,
): ProducerDiscriminatorSeed | null {
  if (boundary.action !== 'http.request' || boundary.strength === 'candidate' || boundary.sourceScope !== 'production')
    return null;
  const carrier = httpCarrier(boundary);
  if (!carrier) return null;
  const context = boundaryFileContext(db, boundary.source.file);
  if (!context) return null;
  const resolvedBody = producerBoundaryBodySummary(db, boundary, context, bodySummaries);
  if (!resolvedBody) return null;
  const { boundaryCall, bodySummary } = resolvedBody;
  const owner = boundary.owner.symbol
    ? getDefinitionsForFile(db, boundary.owner.file).find((definition) => definition.symbol === boundary.owner.symbol)
    : null;
  if (!owner) return null;
  const ownerParameters = callableParameterNames(context, owner);
  const args = callArguments(boundaryCall);
  return { carrier, context, owner, ownerParameters, args, bodySummary };
}

function collectProducerBodyFields(
  boundary: BoundaryObservation,
  seed: ProducerDiscriminatorSeed,
  state: ProducerDiscriminatorState,
  body: SyntaxNode,
): void {
  const { carrier, context, owner, ownerParameters } = seed;
  for (const pair of objectPairs(body)) {
    const field = pairName(pair);
    const valueNode = pairValue(pair);
    if (!field || !valueNode) continue;
    const parameterIndex = ownerParameters.indexOf(valueNode.text.trim());
    if (parameterIndex >= 0) {
      const summary: DiscriminatorCallableSummary = {
        definition: owner,
        carrier,
        field,
        parameterIndex,
        depth: 0,
        proofObservationIds: [boundary.id],
        proofSpans: [
          boundary.source,
          {
            file: boundary.source.file,
            startLine: pair.startPosition.row,
            endLine: pair.endPosition.row,
          },
        ],
      };
      enqueueDiscriminatorSummary(state, summary);
      continue;
    }
    const value = evaluateBoundaryValue(context, valueNode);
    if (!value || value.precision !== 'literal' || value.evidence === 'expression') continue;
    state.produced.push(
      createCarrierObservation(context, pair, 'carrier.publish', carrier, field, value.value, [boundary.id]),
    );
  }
}

function collectProducerDiscriminatorFields(
  boundary: BoundaryObservation,
  seed: ProducerDiscriminatorSeed,
  state: ProducerDiscriminatorState,
): void {
  const { context, args, bodySummary } = seed;
  for (const bodyIndex of bodySummary.parameterIndexes) {
    const body = resolveLocalInitializer(context, args[bodyIndex]);
    if (!body) continue;
    collectProducerBodyFields(boundary, seed, state, body);
  }
}

function propagateProducerDiscriminator(
  db: ScipDatabase,
  summary: DiscriminatorCallableSummary,
  state: ProducerDiscriminatorState,
): void {
  for (const site of resolvedCallSitesForDefinition(db, summary.definition).sites) {
    const context = boundaryFileContext(db, site.file);
    if (!context) continue;
    const call = site.callNode;
    const argument = callArguments(call)[summary.parameterIndex];
    if (!argument) continue;
    const value = evaluateBoundaryValue(context, argument);
    if (value && value.precision === 'literal' && value.evidence !== 'expression') {
      state.produced.push(
        createCarrierObservation(
          context,
          call,
          'carrier.publish',
          summary.carrier,
          summary.field,
          value.value,
          summary.proofObservationIds,
        ),
      );
    }
    const caller = site.caller;
    if (!caller) continue;
    const callerIndex = parameterValueFlowAtCall(db, site).transfers.find(
      (transfer) => transfer.calleePosition === summary.parameterIndex,
    )?.callerPosition;
    if (callerIndex === undefined) continue;
    const incoming: DiscriminatorCallableSummary = {
      ...summary,
      definition: caller,
      parameterIndex: callerIndex,
      depth: summary.depth + 1,
      proofSpans: [...summary.proofSpans, { file: site.file, startLine: site.startLine, endLine: site.endLine }],
    };
    enqueueDiscriminatorSummary(state, incoming);
  }
}

export function deriveConsumerDiscriminators(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
  errors: string[],
): BoundaryObservation[] {
  const consumers: BoundaryObservation[] = [];
  const registryHandlers = observations.filter(
    (observation) =>
      observation.action === 'registry.handle' &&
      observation.strength !== 'candidate' &&
      observation.sourceScope === 'production',
  );

  for (const boundary of observations) {
    if (boundary.action !== 'http.handle' || boundary.strength === 'candidate' || boundary.sourceScope !== 'production')
      continue;
    const carrier = httpCarrier(boundary);
    if (!carrier) continue;
    const context = boundaryFileContext(db, boundary.source.file);
    if (!context) continue;
    const routeCall = callsCoveringLine(context.root, boundary.source.startLine)[0];
    if (!routeCall) continue;
    for (const handlerExpression of callArguments(routeCall).slice(1)) {
      const handlers = resolveCallableExpression(db, boundary.source.file, handlerExpression.text);
      for (const handler of handlers) {
        deriveHandlerConsumers(db, boundary, carrier, handler, registryHandlers, consumers, errors);
      }
    }
  }
  return consumers;
}

function deriveHandlerConsumers(
  db: ScipDatabase,
  boundary: BoundaryObservation,
  carrier: string,
  handler: IndexedDefinition,
  registryHandlers: readonly BoundaryObservation[],
  consumers: BoundaryObservation[],
  errors: string[],
): void {
  try {
    const handlerContext = boundaryFileContext(db, handler.relativePath);
    if (!handlerContext) return;
    const callable = callableNodeForDefinition(handlerContext, handler);
    if (!callable) return;
    walk(callable, (node) =>
      deriveRegistryCallConsumers(db, boundary, carrier, handler, handlerContext, node, registryHandlers, consumers),
    );
  } catch (error) {
    errors.push(`builtin.carrier consumer analysis failed for ${handler.relativePath}: ${errorMessage(error)}`);
  }
}

function deriveRegistryCallConsumers(
  db: ScipDatabase,
  boundary: BoundaryObservation,
  carrier: string,
  handler: IndexedDefinition,
  handlerContext: BoundaryFileContext,
  node: SyntaxNode,
  registryHandlers: readonly BoundaryObservation[],
  consumers: BoundaryObservation[],
): void {
  if (node.type !== 'call_expression') return;
  const target = callTargetNode(node);
  if (!target) return;
  const indexed = /^([A-Za-z_$][\w$]*)\s*\[\s*([A-Za-z_$][\w$]*)\s*\]$/u.exec(target.text.trim());
  if (!indexed) return;
  const registry = indexed[1]!;
  const local = indexed[2]!;
  const field = bodyFieldForLocal(db, handlerContext, handler, local);
  if (!field) return;
  const families = registryFamilyBindings(db, handler.relativePath, registry);
  for (const registryHandler of registryHandlers) {
    appendRegistryConsumer(db, boundary, carrier, field, families, registryHandler, consumers);
  }
}

function appendRegistryConsumer(
  db: ScipDatabase,
  boundary: BoundaryObservation,
  carrier: string,
  field: string,
  families: ReturnType<typeof registryFamilyBindings>,
  registryHandler: BoundaryObservation,
  consumers: BoundaryObservation[],
): void {
  const container = registryHandler.keyParts.find((part) => part.name === 'registry')?.value;
  const value = registryHandler.keyParts.find((part) => part.name === 'key')?.value;
  if (!container || !value) return;
  if (!families.some((family) => family.file === registryHandler.source.file && family.binding === container)) return;
  const consumerContext = boundaryFileContext(db, registryHandler.source.file);
  const consumerNode = consumerContext
    ? sourceAnalysisRoot(
        consumerContext.root,
        registryHandler.source.startLine,
        registryHandler.source.endLine,
        ANALYSIS_CALLABLE_NODE_TYPES,
        registryHandler.source,
      )
    : null;
  if (!consumerContext || !consumerNode) return;
  consumers.push(
    createCarrierObservation(consumerContext, consumerNode, 'carrier.consume', carrier, field, value, [
      boundary.id,
      registryHandler.id,
    ]),
  );
}

export function serializedBodySummariesForFile(context: BoundaryFileContext): RuntimeBoundaryBodySummary[] {
  const definitions = getDefinitionsForFile(context.db, context.file);
  const parameterIndexesBySymbol = new Map<string, Set<number>>();
  walk(context.root, (node) => {
    if (node.type !== 'pair' || pairName(node)?.toLowerCase() !== 'body') return;
    const value = pairValue(node);
    if (!value || !/\bJSON\.stringify\s*\(/u.test(value.text)) return;
    const definition = findEnclosingDefinition(definitions, node.startPosition.row);
    const callable = enclosingCallable(node);
    if (!definition || !callable) return;
    const parameters = callableParameterNamesFromNode(callable);
    const names = new Set<string>();
    addReferencedParameters(value, parameters, names);
    const indexes = parameterIndexesBySymbol.get(definition.symbol) ?? new Set<number>();
    parameters.forEach((name, index) => {
      if (name && names.has(name)) indexes.add(index);
    });
    if (indexes.size > 0) parameterIndexesBySymbol.set(definition.symbol, indexes);
  });
  return definitions.flatMap((definition): RuntimeBoundaryBodySummary[] => {
    const indexes = parameterIndexesBySymbol.get(definition.symbol);
    return indexes ? [{ definition, parameterIndexes: [...indexes].sort((left, right) => left - right) }] : [];
  });
}

function enclosingCallable(node: SyntaxNode): SyntaxNode | null {
  let candidate: SyntaxNode | null = node.parent;
  while (candidate) {
    if (/(?:function|method|lambda)/u.test(candidate.type) || candidate.type === 'arrow_function') return candidate;
    candidate = candidate.parent;
  }
  return null;
}

export function bodyFieldForLocal(
  db: ScipDatabase,
  context: BoundaryFileContext,
  definition: IndexedDefinition,
  local: string,
): string | null {
  const callable = callableNodeForDefinition(context, definition);
  if (!callable) return null;
  const direct = new RegExp(`\\.body\\??\\.${escapeRegex(local)}\\b`, 'u');
  if (direct.test(callable.text)) return local;
  let helperExpression: string | null = null;
  walk(callable, (node) => {
    if (helperExpression || node.type !== 'variable_declarator') return;
    const name = node.childForFieldName('name') ?? node.namedChild(0);
    const value = node.childForFieldName('value') ?? node.namedChild(1);
    if (!name || !value || !new RegExp(`(?:^|[,{}])\\s*${escapeRegex(local)}\\s*(?:[,}]|$)`, 'u').test(name.text))
      return;
    if (value.type !== 'call_expression') return;
    helperExpression = callTargetNode(value)?.text ?? null;
  });
  if (!helperExpression) return null;
  const helpers = resolveCallableExpression(db, definition.relativePath, helperExpression);
  if (helpers.length !== 1) return null;
  const helperContext = boundaryFileContext(db, helpers[0]!.relativePath);
  const helperCallable = helperContext ? callableNodeForDefinition(helperContext, helpers[0]!) : null;
  return helperCallable &&
    direct.test(helperCallable.text) &&
    new RegExp(`\\b${escapeRegex(local)}\\s*[,}]`, 'u').test(helperCallable.text)
    ? local
    : null;
}

export function registryFamilyBindings(
  db: ScipDatabase,
  sourceFile: string,
  registry: string,
): Array<{ file: string; binding: string }> {
  const results: Array<{ file: string; binding: string }> = [];
  for (const object of resolveObjectBinding(db, sourceFile, registry)) {
    const initializer = unwrapExpression(object.initializer);
    if (initializer.type !== 'call_expression') continue;
    for (const argument of callArguments(initializer)) {
      const binding = argument.text.trim();
      if (!/^[A-Za-z_$][\w$]*$/u.test(binding)) continue;
      for (const family of resolveObjectBinding(db, object.definition.relativePath, binding)) {
        results.push({ file: family.definition.relativePath, binding: family.definition.leaf });
      }
    }
  }
  return [...new Map(results.map((value) => [`${value.file}\0${value.binding}`, value])).values()];
}

function createCarrierObservation(
  context: BoundaryFileContext,
  node: SyntaxNode,
  action: 'carrier.publish' | 'carrier.consume',
  carrier: string,
  field: string,
  value: string,
  proofObservationIds: readonly string[],
): BoundaryObservation {
  const keyParts: BoundaryKeyPart[] = [
    { name: 'carrier', value: carrier, evidence: 'constant', term: { kind: 'literal', value: carrier } },
    { name: 'field', value: field, evidence: 'literal', term: { kind: 'literal', value: field } },
    { name: 'value', value, evidence: 'constant', term: { kind: 'literal', value } },
  ];
  const observation = createBoundaryObservation(
    context,
    node,
    'builtin.carrier',
    action,
    keyParts,
    'candidate',
    'http-body-registry-discriminator-unverified-flow',
  );
  observation.derivation = {
    kind: 'mechanically-derived',
    rule: 'http-body-registry-discriminator',
    ruleVersion: '1',
    inputFactIds: [...proofObservationIds],
    sourceSpans: [observation.source],
  };
  return observation;
}

function httpCarrier(observation: BoundaryObservation): string | null {
  const method = observation.keyParts.find((part) => part.name === 'method' && part.evidence !== 'expression')?.value;
  const path = observation.keyParts.find((part) => part.name === 'path' && part.evidence !== 'expression')?.value;
  return method && path ? `${method.toUpperCase()} ${path}` : null;
}

function mergeBodySummary(summaries: Map<string, BodyCallableSummary>, incoming: BodyCallableSummary): boolean {
  const existing = summaries.get(incoming.definition.symbol);
  if (!existing) {
    summaries.set(incoming.definition.symbol, incoming);
    return true;
  }
  const parameterIndexes = uniqueSortedNumbers([...existing.parameterIndexes, ...incoming.parameterIndexes]);
  if (parameterIndexes.length === existing.parameterIndexes.length && incoming.depth >= existing.depth) return false;
  summaries.set(incoming.definition.symbol, {
    ...existing,
    parameterIndexes,
    depth: Math.min(existing.depth, incoming.depth),
    proofSpans: [...existing.proofSpans, ...incoming.proofSpans],
  });
  return true;
}

function discriminatorSummaryKey(summary: DiscriminatorCallableSummary): string {
  return `${summary.definition.symbol}\0${summary.carrier}\0${summary.field}\0${summary.parameterIndex}`;
}

function callableParameterNames(context: BoundaryFileContext, definition: IndexedDefinition): Array<string | null> {
  const callable = callableNodeForDefinition(context, definition);
  return callable ? callableParameterNamesFromNode(callable) : [];
}

function callsCoveringLine(root: SyntaxNode, line: number): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  walk(root, (node) => {
    if (node.type !== 'call_expression') return;
    if (node.startPosition.row <= line && node.endPosition.row >= line) calls.push(node);
  });
  return calls.sort((left, right) => left.endIndex - left.startIndex - (right.endIndex - right.startIndex));
}

function callTargetNode(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('function') ?? node.namedChild(0);
}

function callArguments(node: SyntaxNode): SyntaxNode[] {
  const args = node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'arguments');
  return args?.namedChildren ?? [];
}

function resolveLocalInitializer(context: BoundaryFileContext, node: SyntaxNode | null | undefined): SyntaxNode | null {
  if (!node) return null;
  const text = node.text.trim();
  if (!/^[A-Za-z_$][\w$]*$/u.test(text)) return unwrapExpression(node);
  let initializer: SyntaxNode | null = null;
  walk(context.root, (candidate) => {
    if (initializer || candidate.type !== 'variable_declarator') return;
    const name = candidate.childForFieldName('name') ?? candidate.namedChild(0);
    if (name?.text.trim() !== text) return;
    initializer = candidate.childForFieldName('value') ?? candidate.namedChild(1);
  });
  return initializer ? unwrapExpression(initializer) : unwrapExpression(node);
}

function objectPairs(node: SyntaxNode): SyntaxNode[] {
  const object = unwrapExpression(node);
  return object.type === 'object'
    ? object.namedChildren.filter((child) => child.type === 'pair' || child.type === 'shorthand_property_identifier')
    : [];
}

function pairName(pair: SyntaxNode): string | null {
  if (pair.type === 'shorthand_property_identifier') return pair.text;
  const key = pair.childForFieldName('key') ?? pair.namedChild(0);
  return key?.text.replace(/^['"`]|['"`]$/gu, '') ?? null;
}

function pairValue(pair: SyntaxNode): SyntaxNode | null {
  if (pair.type === 'shorthand_property_identifier') return pair;
  return pair.childForFieldName('value') ?? pair.namedChild(1);
}

function uniqueSortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function deduplicateObservations(values: readonly BoundaryObservation[]): BoundaryObservation[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function callableNodeForDefinition(context: BoundaryFileContext, definition: IndexedDefinition): SyntaxNode | null {
  const callable = sourceCallableForDefinition(context.db, context.file, definition);
  if (definition.symbol.startsWith('source-callable:'))
    return sourceAnalysisRoot(context.root, definition.startLine, definition.endLine, ANALYSIS_CALLABLE_NODE_TYPES, {
      startColumn: definition.startChar,
      endColumn: definition.endChar,
    });
  return callable
    ? sourceAnalysisRoot(context.root, callable.startLine, callable.endLine, ANALYSIS_CALLABLE_NODE_TYPES, callable)
    : null;
}
