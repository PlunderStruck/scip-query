import type { IndexedDefinition } from '../../domain/types.js';
import { getAst } from '../../source/ast/ast-core.js';
import {
  callableParameterNames,
  smallestCoveringCallable,
} from '../../source/ast/ast-callables.js';
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
  | 'argument-not-direct-parameter';

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
  return CALL_PARAMETER_VALUE_FLOW.get(db, key, () => buildParameterValueFlow(db, site));
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
  const call = { file: site.file, startLine: site.startLine, endLine: site.endLine };
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
  const callable = root ? smallestCoveringCallable(root, site.caller.startLine, site.caller.endLine) : null;
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

  const callerParameters = callableParameterNames(callable);
  const transfers: ParameterValueTransfer[] = [];
  const unknown: UnknownParameterValueTransfer[] = [];
  site.arguments.forEach((argument, calleePosition) => {
    const argumentText = argument.text.trim();
    const callerPosition = callerParameters.indexOf(argumentText);
    if (callerPosition >= 0) {
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
