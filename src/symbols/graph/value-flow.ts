import type { IndexedDefinition } from '../../domain/types.js';
import { getAst } from '../../source/ast/ast-core.js';
import { sourceAnalysisRoot, ANALYSIS_CALLABLE_NODE_TYPES } from '../../source/ast/ast-callables.js';
import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import { sourceCallableForDefinition } from './call-graph-evidence.js';
import { scipOccurrenceTargetsForFile } from './scip-occurrence-call-targets.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import type { ResolvedCallSite } from './resolved-call-sites.js';

export type StaticValueDerivationKind = 'direct' | 'mechanically-derived' | 'heuristic';
export type StaticValuePrecision = 'literal' | 'finite-set' | 'constrained-pattern' | 'symbolic' | 'unknown';
export type StaticValueEvidence = 'literal' | 'constant' | 'identifier' | 'expression';

export type StaticValueTerm =
  | { kind: 'literal'; value: string }
  | { kind: 'finite-set'; values: string[] }
  | { kind: 'parameter'; callable: string; position: number; name: string | null }
  | { kind: 'concat'; parts: StaticValueTerm[] }
  | { kind: 'property'; base: StaticValueTerm; key: string }
  | { kind: 'pattern'; language: string; value: string }
  | { kind: 'symbol'; symbol: string }
  | { kind: 'unknown'; reason: string };

export interface ValueFlowSourceSpan {
  file: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface StaticValueDerivation {
  kind: StaticValueDerivationKind;
  rule: string;
  ruleVersion: string;
  inputFactIds: string[];
  sourceSpans: ValueFlowSourceSpan[];
}

export interface EvaluatedStaticValue {
  value: string;
  evidence: StaticValueEvidence;
  term: StaticValueTerm;
  precision: StaticValuePrecision;
  derivation: StaticValueDerivation;
}

export interface ParameterValueTransfer {
  calleePosition: number;
  callerPosition: number;
  argumentText: string;
  proof: ValueFlowSourceSpan;
}

export type ParameterValueUnknownReason =
  | 'caller-unavailable'
  | 'caller-syntax-unavailable'
  | 'argument-not-direct-parameter'
  | 'callee-parameter-unavailable'
  | 'argument-without-parameter'
  | 'callee-parameter-transform';

export interface UnknownParameterValueTransfer {
  calleePosition: number;
  argumentText: string;
  reason: ParameterValueUnknownReason;
  proof: ValueFlowSourceSpan;
}

export interface CallParameterValueFlow {
  callee: IndexedDefinition;
  caller: IndexedDefinition | null;
  call: ValueFlowSourceSpan;
  transfers: ParameterValueTransfer[];
  unknown: UnknownParameterValueTransfer[];
}

// The database represents one immutable index generation. A call's syntax and
// callable ownership cannot change during that generation, so no clear group
// is necessary.
const CALL_PARAMETER_VALUE_FLOW = createPerDbCache<string, CallParameterValueFlow>('call-parameter-value-flow', {
  clearGroups: [],
});

/**
 * Prove direct argument-to-parameter transfers at one compiler-resolved call.
 * Complex expressions are retained as explicit unknowns; callers must not
 * silently treat them as forwarded parameters.
 */
export function parameterValueFlowAtCall(db: ScipDatabase, site: ResolvedCallSite): CallParameterValueFlow {
  const key = `${site.callee.symbolId}\0${site.file}\0${site.callNode.startIndex}\0${site.callNode.endIndex}`;
  return CALL_PARAMETER_VALUE_FLOW.get(db, key, () =>
    validateCalleeParameterMapping(db, site, buildParameterValueFlow(db, site)),
  );
}

function validateCalleeParameterMapping(
  db: ScipDatabase,
  site: ResolvedCallSite,
  flow: CallParameterValueFlow,
): CallParameterValueFlow {
  const root = getAst(db, site.callee.relativePath)?.rootNode;
  const owner = sourceCallableForDefinition(db, site.callee.relativePath, site.callee);
  const callable =
    root && owner
      ? sourceAnalysisRoot(root, owner.startLine, owner.endLine, ANALYSIS_CALLABLE_NODE_TYPES, owner)
      : null;
  const resolver = root ? sourceBindingResolver(site.callee.relativePath, root) : null;
  // Other language providers retain their explicitly reported invocation conventions.
  if (resolver && !resolver.available) return flow;
  const parameters = callable && resolver ? resolver.callableParameters(callable) : null;
  const restPosition = parameters?.indexOf('rest') ?? -1;
  const reason = (position: number): ParameterValueUnknownReason | null => {
    if (!parameters) return 'callee-parameter-unavailable';
    if (restPosition >= 0 && position >= restPosition) return 'callee-parameter-transform';
    if (position >= parameters.length) return 'argument-without-parameter';
    return parameters[position] === 'direct' ? null : 'callee-parameter-transform';
  };
  const transferred = flow.transfers.filter((transfer) => reason(transfer.calleePosition) === null);
  const rejected = flow.transfers.flatMap((transfer) => {
    const why = reason(transfer.calleePosition);
    return why
      ? [
          {
            calleePosition: transfer.calleePosition,
            argumentText: transfer.argumentText,
            proof: transfer.proof,
            reason: why,
          },
        ]
      : [];
  });
  return {
    ...flow,
    transfers: transferred,
    unknown: [
      ...flow.unknown.map((unknown) => ({ ...unknown, reason: reason(unknown.calleePosition) ?? unknown.reason })),
      ...rejected,
    ],
  };
}

export function forwardedCallerParameterPositions(
  flow: CallParameterValueFlow,
  calleePositions: readonly number[],
): number[] {
  const requested = new Set(calleePositions);
  return [
    ...new Set(
      flow.transfers.flatMap((transfer) => (requested.has(transfer.calleePosition) ? [transfer.callerPosition] : [])),
    ),
  ].sort((left, right) => left - right);
}

function buildParameterValueFlow(db: ScipDatabase, site: ResolvedCallSite): CallParameterValueFlow {
  const call = {
    file: site.file,
    startLine: site.startLine,
    endLine: site.endLine,
    startColumn: site.callNode.startPosition.column,
    endColumn: site.callNode.endPosition.column,
  };
  if (!site.caller) {
    return {
      callee: site.callee,
      caller: null,
      call,
      transfers: [],
      unknown: site.arguments.map((argument, calleePosition) => ({
        calleePosition,
        argumentText: argument.text.trim(),
        reason: 'caller-unavailable',
        proof: call,
      })),
    };
  }

  const root = getAst(db, site.caller.relativePath)?.rootNode;
  const owner = sourceCallableForDefinition(db, site.file, site.caller);
  const callable =
    root && owner
      ? sourceAnalysisRoot(root, owner.startLine, owner.endLine, ANALYSIS_CALLABLE_NODE_TYPES, owner)
      : null;
  if (!callable) {
    return {
      callee: site.callee,
      caller: site.caller,
      call,
      transfers: [],
      unknown: site.arguments.map((argument, calleePosition) => ({
        calleePosition,
        argumentText: argument.text.trim(),
        reason: 'caller-syntax-unavailable',
        proof: call,
      })),
    };
  }

  const bindings = sourceBindingResolver(site.file, root!);
  let spreadSeen = false;
  const transfers: ParameterValueTransfer[] = [];
  const unknown: UnknownParameterValueTransfer[] = [];
  const argumentsToBind = site.arguments.flatMap((argument) => {
    if (argument.type !== 'spread_element') return [argument];
    const value = argument.namedChild(0);
    return (value && bindings.tupleElements(value)) ?? [argument];
  });
  argumentsToBind.forEach((argument, calleePosition) => {
    const argumentText = argument.text.trim();
    spreadSeen ||= ['spread_element', 'list_splat', 'dictionary_splat'].includes(argument.type);
    const callerPosition = spreadSeen
      ? null
      : bindings.available
        ? bindings.directParameterPosition(argument)
        : indexedParameterPosition(db, site.file, callable, argument);
    if (callerPosition !== null) {
      transfers.push({ calleePosition, callerPosition, argumentText, proof: call });
    } else {
      unknown.push({
        calleePosition,
        argumentText,
        reason: 'argument-not-direct-parameter',
        proof: call,
      });
    }
  });
  return { callee: site.callee, caller: site.caller, call, transfers, unknown };
}

/** Other language providers may prove the same declaration using retained local SCIP identities. */
function indexedParameterPosition(
  db: ScipDatabase,
  file: string,
  callable: SyntaxNode,
  argument: SyntaxNode,
): number | null {
  if (argument.type !== 'identifier') return null;
  const locals = scipOccurrenceTargetsForFile(db, file)?.locals ?? [];
  const identity = (node: SyntaxNode) =>
    locals.find(
      (item) =>
        item.line === node.startPosition.row &&
        item.startChar === node.startPosition.column &&
        item.endLine === node.endPosition.row &&
        item.endChar === node.endPosition.column,
    )?.symbol;
  const symbol = identity(argument);
  if (!symbol) return null;
  const parameters =
    callable.childForFieldName('parameters')?.namedChildren.filter((node) => node.type !== 'comment') ?? [];
  const position = parameters.findIndex((parameter) => {
    const name = parameter.childForFieldName('pattern') ?? parameter.childForFieldName('name') ?? parameter;
    return name.type === 'identifier' && identity(name) === symbol;
  });
  return position < 0 ? null : position;
}
