import type { ScipDatabase } from '../../storage/db.js';
import type { AstLanguage } from '../ast/ast-language.js';
import type { SyntaxNode } from '../ast/ast-types.js';
import { extractCallLeaf } from './source-calls.js';
import { callableFactForNode, callableFactNodeTypes } from './source-callables.js';
import { getSourceFacts } from './source-facts.js';
import type { CallSiteKind, SourceCallableOwner } from './source-fact-types.js';

const CALLABLE_FACT_LANGUAGES = new Set<AstLanguage>(['rust', 'typescript', 'tsx', 'javascript', 'python', 'clojure']);
const AST_CALLABLE_FACT_LANGUAGES = new Set<AstLanguage>(['rust', 'typescript', 'tsx', 'javascript', 'python']);

export interface CallableSite {
  name: string;
  startLine: number;
  endLine: number;
}

export type { CallSiteKind } from './source-fact-types.js';

export interface CallSite {
  /** Invocation shape; absent on older or non-JS facts and read as `call`. */
  kind?: CallSiteKind;
  /** Leaf name of what is being called, for example "foo" for `obj.foo()`. */
  calleeLeaf: string;
  /** Optional namespace/module qualifier, for example "conn" for `conn/transact!`. */
  calleeQualifier?: string;
  /** Optional original call target text, for example `conn/transact!`. */
  calleeText?: string;
  /** True for member/dotted calls like `obj.foo()` where the receiver type is unknown. */
  memberAccess: boolean;
  line: number;
  targetRange?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  owner?: SourceCallableOwner | null;
}

// scip-query: ignore-wrapper — public callable-site view kept stable while
// source-facts owns the underlying per-file AST bundle.
export function getCallableSites(db: ScipDatabase, relativePath: string): CallableSite[] | null {
  const facts = getSourceFacts(db, relativePath);
  if (!facts) return null;
  if (!CALLABLE_FACT_LANGUAGES.has(facts.language)) return null;
  return facts.callables.map((callable) => ({
    name: callable.name,
    startLine: callable.startLine,
    endLine: callable.endLine,
  }));
}

/**
 * Collect only callable ranges from an already parsed syntax tree. This keeps
 * range-only consumers from building the larger source-facts bundle while
 * preserving the same callable-node policy and source-order traversal.
 */
export function callableSitesFromRoot(root: SyntaxNode, language: AstLanguage): CallableSite[] | null {
  if (!AST_CALLABLE_FACT_LANGUAGES.has(language)) return null;
  const sites: CallableSite[] = [];
  for (const node of root.descendantsOfType([...callableFactNodeTypes(language)])) {
    const callable = callableFactForNode(node, language);
    if (callable) {
      sites.push({
        name: callable.name,
        startLine: callable.startLine,
        endLine: callable.endLine,
      });
    }
  }
  return sites;
}

export function getCallSites(db: ScipDatabase, relativePath: string): CallSite[] | null {
  const facts = getSourceFacts(db, relativePath);
  if (!facts) return null;
  if (!CALLABLE_FACT_LANGUAGES.has(facts.language)) return null;
  return facts.callSites;
}

export function getTypeContainerMap(db: ScipDatabase, relativePath: string): Map<string, Set<string>> {
  return getSourceFacts(db, relativePath)?.typeContainerMap ?? new Map();
}

export { extractCallLeaf };
