import type { IndexedDefinition } from '../../domain/types.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { getSourceFiles } from '../../source/primitives/source-fileset.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { referenceEvidenceForSymbol } from '../../symbols/references/reference-sites.js';
import { leafName } from '../../symbols/symbol-parser.js';
import { boundaryFileContext, createBoundaryObservation, type BoundaryFileContext } from './extractors.js';
import { resolveCallableExpression, resolveObjectBinding } from './object-members.js';
import type { BoundaryKeyPart, BoundaryObservation, BoundarySourceLocation } from './types.js';
import { evaluateBoundaryValue } from './value-evaluator.js';

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
  errors: string[];
}

/**
 * Bind scalar request-body discriminators to variable-key registries through a proved HTTP carrier.
 * The analysis derives body roles from serialization, follows compiler-resolved calls, and emits
 * only concrete discriminator values; unresolved or ambiguous flows remain absent.
 */
export function deriveCarrierDiscriminators(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
): CarrierDiscriminatorResult {
  const errors: string[] = [];
  const bodySummaries = collectBodySummaries(db, errors);
  const producer = deriveProducerDiscriminators(db, observations, bodySummaries, errors);
  const consumers = deriveConsumerDiscriminators(db, observations, errors);
  return {
    observations: deduplicateObservations([...producer.observations, ...consumers]),
    bodySummaries: bodySummaries.size,
    discriminatorSummaries: producer.summaries,
    errors,
  };
}

export function collectBodySummaries(db: ScipDatabase, errors: string[] = []): Map<string, BodyCallableSummary> {
  const summaries = new Map<string, BodyCallableSummary>();
  const queue: BodyCallableSummary[] = [];
  for (const file of getSourceFiles(db)) {
    const context = boundaryFileContext(db, file);
    if (!context || !/\bJSON\.stringify\s*\(|\bbody\s*:/u.test(context.source)) continue;
    for (const definition of getDefinitionsForFile(db, file)) {
      const parameterIndexes = serializedBodyParameterIndexes(context, definition);
      if (parameterIndexes.length === 0) continue;
      const summary: BodyCallableSummary = {
        definition,
        parameterIndexes,
        depth: 0,
        proofSpans: [{ file, startLine: definition.startLine, endLine: definition.endLine }],
      };
      summaries.set(definition.symbol, summary);
      queue.push(summary);
    }
  }

  while (queue.length > 0) {
    const summary = queue.shift()!;
    if (summary.depth >= MAX_BODY_SUMMARY_DEPTH) continue;
    try {
      for (const site of referenceEvidenceForSymbol(db, summary.definition, { semantic: false })) {
        const context = boundaryFileContext(db, site.file);
        if (!context) continue;
        const calls = matchingCallsAtLine(context.root, site.line, leafName(summary.definition.symbol));
        if (calls.length !== 1) continue;
        const call = calls[0]!;
        const caller = enclosingDefinition(db, site.file, call.startPosition.row);
        if (!caller) continue;
        const callerParameters = callableParameterNames(context, caller);
        const args = callArguments(call);
        const forwarded = summary.parameterIndexes.flatMap((index) => {
          const argument = args[index]?.text.trim();
          const callerIndex = argument ? callerParameters.indexOf(argument) : -1;
          return callerIndex >= 0 ? [callerIndex] : [];
        });
        if (forwarded.length === 0) continue;
        const incoming: BodyCallableSummary = {
          definition: caller,
          parameterIndexes: uniqueSortedNumbers(forwarded),
          depth: summary.depth + 1,
          proofSpans: [...summary.proofSpans, { file: site.file, startLine: site.line, endLine: site.line }],
        };
        if (mergeBodySummary(summaries, incoming)) queue.push(summaries.get(caller.symbol)!);
      }
    } catch (error) {
      errors.push(`builtin.carrier body summary failed for ${summary.definition.relativePath}: ${errorMessage(error)}`);
    }
  }
  return summaries;
}

function deriveProducerDiscriminators(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
  bodySummaries: ReadonlyMap<string, BodyCallableSummary>,
  errors: string[],
): { observations: BoundaryObservation[]; summaries: number } {
  const summaries = new Map<string, DiscriminatorCallableSummary>();
  const queue: DiscriminatorCallableSummary[] = [];
  const produced: BoundaryObservation[] = [];

  for (const boundary of observations) {
    if (
      boundary.action !== 'http.request' ||
      boundary.strength === 'candidate' ||
      boundary.sourceScope !== 'production'
    )
      continue;
    const carrier = httpCarrier(boundary);
    if (!carrier) continue;
    const context = boundaryFileContext(db, boundary.source.file);
    if (!context) continue;
    const calls = callsCoveringLine(context.root, boundary.source.startLine);
    const boundaryCall = calls.find((call) => call.startPosition.row === boundary.source.startLine) ?? calls[0];
    if (!boundaryCall) continue;
    const target = callTargetNode(boundaryCall);
    if (!target) continue;
    const callees = resolveCallableExpression(db, boundary.source.file, target.text);
    if (callees.length !== 1) continue;
    const bodySummary = bodySummaries.get(callees[0]!.symbol);
    if (!bodySummary) continue;
    const owner = boundary.owner.symbol
      ? getDefinitionsForFile(db, boundary.owner.file).find((definition) => definition.symbol === boundary.owner.symbol)
      : null;
    if (!owner) continue;
    const ownerParameters = callableParameterNames(context, owner);
    const args = callArguments(boundaryCall);
    for (const bodyIndex of bodySummary.parameterIndexes) {
      const body = resolveLocalInitializer(context, args[bodyIndex]);
      if (!body) continue;
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
          const key = discriminatorSummaryKey(summary);
          if (!summaries.has(key)) {
            summaries.set(key, summary);
            queue.push(summary);
          }
          continue;
        }
        const value = evaluateBoundaryValue(context, valueNode);
        if (!value || value.evidence === 'expression') continue;
        produced.push(
          createCarrierObservation(context, pair, 'carrier.publish', carrier, field, value.value, [boundary.id]),
        );
      }
    }
  }

  while (queue.length > 0) {
    const summary = queue.shift()!;
    if (summary.depth >= MAX_DISCRIMINATOR_SUMMARY_DEPTH) continue;
    try {
      for (const site of referenceEvidenceForSymbol(db, summary.definition, { semantic: false })) {
        const context = boundaryFileContext(db, site.file);
        if (!context) continue;
        const calls = matchingCallsAtLine(context.root, site.line, leafName(summary.definition.symbol));
        if (calls.length !== 1) continue;
        const call = calls[0]!;
        const argument = callArguments(call)[summary.parameterIndex];
        if (!argument) continue;
        const value = evaluateBoundaryValue(context, argument);
        if (value && value.evidence !== 'expression') {
          produced.push(
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
        const caller = enclosingDefinition(db, site.file, call.startPosition.row);
        if (!caller) continue;
        const callerParameters = callableParameterNames(context, caller);
        const callerIndex = callerParameters.indexOf(argument.text.trim());
        if (callerIndex < 0) continue;
        const incoming: DiscriminatorCallableSummary = {
          ...summary,
          definition: caller,
          parameterIndex: callerIndex,
          depth: summary.depth + 1,
          proofSpans: [...summary.proofSpans, { file: site.file, startLine: site.line, endLine: site.line }],
        };
        const key = discriminatorSummaryKey(incoming);
        if (!summaries.has(key)) {
          summaries.set(key, incoming);
          queue.push(incoming);
        }
      }
    } catch (error) {
      errors.push(
        `builtin.carrier discriminator summary failed for ${summary.definition.relativePath}: ${errorMessage(error)}`,
      );
    }
  }

  return { observations: produced, summaries: summaries.size };
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
        try {
          const handlerContext = boundaryFileContext(db, handler.relativePath);
          if (!handlerContext) continue;
          const callable = smallestCoveringCallable(handlerContext.root, handler.startLine, handler.endLine);
          if (!callable) continue;
          walk(callable, (node) => {
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
              const container = registryHandler.keyParts.find((part) => part.name === 'registry')?.value;
              const value = registryHandler.keyParts.find((part) => part.name === 'key')?.value;
              if (!container || !value) continue;
              if (
                !families.some((family) => family.file === registryHandler.source.file && family.binding === container)
              )
                continue;
              const consumerContext = boundaryFileContext(db, registryHandler.source.file);
              const consumerNode = consumerContext
                ? smallestNodeCoveringLine(consumerContext.root, registryHandler.source.startLine)
                : null;
              if (!consumerContext || !consumerNode) continue;
              consumers.push(
                createCarrierObservation(consumerContext, consumerNode, 'carrier.consume', carrier, field, value, [
                  boundary.id,
                  registryHandler.id,
                ]),
              );
            }
          });
        } catch (error) {
          errors.push(`builtin.carrier consumer analysis failed for ${handler.relativePath}: ${errorMessage(error)}`);
        }
      }
    }
  }
  return consumers;
}

function serializedBodyParameterIndexes(context: BoundaryFileContext, definition: IndexedDefinition): number[] {
  const callable = smallestCoveringCallable(context.root, definition.startLine, definition.endLine);
  if (!callable) return [];
  const parameters = callableParameterNamesFromNode(callable);
  const names = new Set<string>();
  walk(callable, (node) => {
    if (node.type !== 'pair' || pairName(node)?.toLowerCase() !== 'body') return;
    const value = pairValue(node);
    if (!value || !/\bJSON\.stringify\s*\(/u.test(value.text)) return;
    addReferencedParameters(value, parameters, names);
  });
  return parameters.flatMap((name, index) => (name && names.has(name) ? [index] : []));
}

export function bodyFieldForLocal(
  db: ScipDatabase,
  context: BoundaryFileContext,
  definition: IndexedDefinition,
  local: string,
): string | null {
  const callable = smallestCoveringCallable(context.root, definition.startLine, definition.endLine);
  if (!callable) return null;
  const direct = new RegExp(`\\.body\\??\\.${escapeRegExp(local)}\\b`, 'u');
  if (direct.test(callable.text)) return local;
  let helperExpression: string | null = null;
  walk(callable, (node) => {
    if (helperExpression || node.type !== 'variable_declarator') return;
    const name = node.childForFieldName('name') ?? node.namedChild(0);
    const value = node.childForFieldName('value') ?? node.namedChild(1);
    if (!name || !value || !new RegExp(`(?:^|[,{}])\\s*${escapeRegExp(local)}\\s*(?:[,}]|$)`, 'u').test(name.text))
      return;
    if (value.type !== 'call_expression') return;
    helperExpression = callTargetNode(value)?.text ?? null;
  });
  if (!helperExpression) return null;
  const helpers = resolveCallableExpression(db, definition.relativePath, helperExpression);
  if (helpers.length !== 1) return null;
  const helperContext = boundaryFileContext(db, helpers[0]!.relativePath);
  const helperCallable = helperContext
    ? smallestCoveringCallable(helperContext.root, helpers[0]!.startLine, helpers[0]!.endLine)
    : null;
  return helperCallable &&
    direct.test(helperCallable.text) &&
    new RegExp(`\\b${escapeRegExp(local)}\\s*[,}]`, 'u').test(helperCallable.text)
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
    'derived',
    'http-body-registry-discriminator',
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
  const callable = smallestCoveringCallable(context.root, definition.startLine, definition.endLine);
  return callable ? callableParameterNamesFromNode(callable) : [];
}

function callableParameterNamesFromNode(callable: SyntaxNode): Array<string | null> {
  const parameters =
    callable.childForFieldName('parameters') ?? callable.namedChildren.find((child) => /parameters/u.test(child.type));
  return parameters?.namedChildren.map(parameterName) ?? [];
}

function parameterName(node: SyntaxNode): string | null {
  if (node.type === 'identifier') return node.text;
  const named = node.childForFieldName('name') ?? node.childForFieldName('pattern');
  if (named) return parameterName(named);
  return node.namedChildren.find((child) => child.type === 'identifier')?.text ?? null;
}

function enclosingDefinition(db: ScipDatabase, file: string, line: number): IndexedDefinition | null {
  return (
    getDefinitionsForFile(db, file)
      .filter((definition) => definition.startLine <= line && definition.endLine >= line)
      .sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine))[0] ?? null
  );
}

function smallestCoveringCallable(root: SyntaxNode, startLine: number, endLine: number): SyntaxNode | null {
  let match: SyntaxNode | null = null;
  walk(root, (node) => {
    if (!/(?:function|method|lambda)/u.test(node.type) && node.type !== 'arrow_function') return;
    if (node.startPosition.row > startLine || node.endPosition.row < endLine) return;
    if (!match || node.endIndex - node.startIndex < match.endIndex - match.startIndex) match = node;
  });
  return match;
}

function smallestNodeCoveringLine(root: SyntaxNode, line: number): SyntaxNode | null {
  let match: SyntaxNode | null = null;
  walk(root, (node) => {
    if (node.startPosition.row > line || node.endPosition.row < line) return;
    if (!match || node.endIndex - node.startIndex < match.endIndex - match.startIndex) match = node;
  });
  return match;
}

function callsCoveringLine(root: SyntaxNode, line: number): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  walk(root, (node) => {
    if (node.type !== 'call_expression') return;
    if (node.startPosition.row <= line && node.endPosition.row >= line) calls.push(node);
  });
  return calls.sort((left, right) => left.endIndex - left.startIndex - (right.endIndex - right.startIndex));
}

function matchingCallsAtLine(root: SyntaxNode, line: number, expectedLeaf: string): SyntaxNode[] {
  return callsCoveringLine(root, line).filter((call) => {
    const target = callTargetNode(call);
    const leaf = target?.text.replace(/\s+/gu, '').split('.').at(-1)?.replace(/<.*>$/u, '') ?? '';
    return leaf === expectedLeaf;
  });
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

function unwrapExpression(input: SyntaxNode): SyntaxNode {
  let node = input;
  while (
    ['as_expression', 'satisfies_expression', 'type_assertion', 'parenthesized_expression'].includes(node.type) &&
    node.namedChildren.length > 0
  ) {
    node = node.namedChildren[0]!;
  }
  return node;
}

function addReferencedParameters(node: SyntaxNode, parameters: readonly (string | null)[], output: Set<string>): void {
  const identifiers = new Set(node.text.match(/[A-Za-z_$][\w$]*/gu) ?? []);
  for (const parameter of parameters) if (parameter && identifiers.has(parameter)) output.add(parameter);
}

function uniqueSortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function deduplicateObservations(values: readonly BoundaryObservation[]): BoundaryObservation[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}
