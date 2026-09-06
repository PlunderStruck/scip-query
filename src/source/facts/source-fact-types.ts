import type { AstLanguage } from '../ast/ast-language.js';

/**
 * `call` and `new` are invocations. `jsx-render` is a component element
 * (`<Child />`): the framework invokes `Child` when this component renders,
 * so it is an execution edge for reachability, fan-out, and impact, while
 * consumers that reason about literal call syntax (forwarding shape,
 * similarity fingerprints) can exclude it.
 */
export type CallSiteKind = 'call' | 'new' | 'jsx-render';

/** The nearest syntactic function, including functions without an indexed symbol. */
export interface SourceCallableOwner {
  name: string | null;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SourceFacts {
  language: AstLanguage;
  callables: Array<{
    name: string;
    startLine: number;
    startColumn?: number;
    endLine: number;
    endColumn?: number;
    /** Branch points inside the callable (nested callables count in both); absent when no AST walk produced it. */
    branches?: number;
    paramCount: number;
    params: Array<{ name: string; simple: boolean }>;
    paramsEndLine: number;
    isLiteralPassthrough: boolean;
    clojureKind?: 'function' | 'macro' | 'method';
  }>;
  callSites: Array<{
    /** Invocation shape; absent on older payloads and read as `call`. */
    kind?: CallSiteKind;
    calleeLeaf: string;
    calleeQualifier?: string;
    calleeText?: string;
    memberAccess: boolean;
    line: number;
    targetRange?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
    /** Null is file scope; absent means this provider does not report lexical ownership. */
    owner?: SourceCallableOwner | null;
  }>;
  clojureMembers: Array<{
    ownerName: string;
    ownerKind: 'protocol' | 'record' | 'type' | 'extension';
    memberName: string;
    memberKind: 'protocol-method' | 'record-method' | 'type-method' | 'extension-method';
    startLine: number;
    endLine: number;
  }>;
  typeContainerMap: Map<string, Set<string>>;
  identifierLineMap: Map<string, number[]>;
  identifiersByLine: Array<Set<string>>;
  fileIdentifiers: Set<string>;
  rustAttrReferencedNames: Set<string>;
  crossLanguageDispatchNames: Set<string>;
}
