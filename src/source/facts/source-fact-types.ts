import type { AstLanguage } from '../ast/ast-language.js';

export interface SourceFacts {
  language: AstLanguage;
  callables: Array<{
    name: string;
    startLine: number;
    endLine: number;
    /** Branch points inside the callable (nested callables count in both); absent when no AST walk produced it. */
    branches?: number;
    paramCount: number;
    params: Array<{ name: string; simple: boolean }>;
    paramsEndLine: number;
    isLiteralPassthrough: boolean;
    clojureKind?: 'function' | 'macro' | 'method';
  }>;
  callSites: Array<{
    calleeLeaf: string;
    calleeQualifier?: string;
    calleeText?: string;
    memberAccess: boolean;
    line: number;
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
