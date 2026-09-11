import type { ScipDatabase } from '../../storage/db.js';
import { detectAstLanguage, type AstLanguage } from '../ast/ast-language.js';
import { getAst } from '../ast/ast-core.js';
import { nodesOfTypes } from '../ast/ast-node-index.js';
import type { SyntaxNode } from '../ast/ast-types.js';
import { callSiteForNode, extractCallLeaf } from './source-calls.js';
import { callableFactForNode, callableFactNodeTypes } from './source-callables.js';
import { getSourceFacts } from './source-facts.js';
import type { CallSiteKind, SourceCallableOwner, SourceFacts } from './source-fact-types.js';

const CALLABLE_FACT_LANGUAGES = new Set<AstLanguage>(['rust', 'typescript', 'tsx', 'javascript', 'python', 'clojure']);
const AST_CALLABLE_FACT_LANGUAGES = new Set<AstLanguage>(['rust', 'typescript', 'tsx', 'javascript', 'python']);
const JAVASCRIPT_FACT_LANGUAGES = new Set<AstLanguage>(['typescript', 'tsx', 'javascript']);
const CALLABLE_IDENTITIES = new WeakMap<SyntaxNode, Map<AstLanguage, SourceFacts['callables']>>();
const CALL_SITES = new WeakMap<SyntaxNode, SourceFacts['callSites']>();

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
  return (
    callableFactsFromRoot(root, language)?.map(({ name, startLine, endLine }) => ({ name, startLine, endLine })) ?? null
  );
}

/** Callable identity, including columns and parameters, without computing branches, calls or identifiers. */
export function callableFactsFromRoot(root: SyntaxNode, language: AstLanguage): SourceFacts['callables'] | null {
  if (!AST_CALLABLE_FACT_LANGUAGES.has(language)) return null;
  const cached = CALLABLE_IDENTITIES.get(root)?.get(language);
  if (cached) return cached;
  const sites: SourceFacts['callables'] = [];
  for (const node of nodesOfTypes(root, [...callableFactNodeTypes(language)])) {
    const callable = callableFactForNode(node, language);
    if (callable) {
      sites.push({ ...callable, branches: undefined });
    }
  }
  const byLanguage = CALLABLE_IDENTITIES.get(root) ?? new Map();
  byLanguage.set(language, sites);
  CALLABLE_IDENTITIES.set(root, byLanguage);
  return sites;
}

/** Source ownership needs callable identity, not the full quality/identifier report. */
export function getCallableIdentityFacts(db: ScipDatabase, relativePath: string): SourceFacts['callables'] | null {
  const language = detectAstLanguage(relativePath);
  if (!language || !JAVASCRIPT_FACT_LANGUAGES.has(language)) {
    return getSourceFacts(db, relativePath)?.callables ?? null;
  }
  const root = getAst(db, relativePath)?.rootNode;
  return root ? callableFactsFromRoot(root, language) : null;
}

export function getCallSites(db: ScipDatabase, relativePath: string): CallSite[] | null {
  const language = detectAstLanguage(relativePath);
  if (language && JAVASCRIPT_FACT_LANGUAGES.has(language)) {
    const root = getAst(db, relativePath)?.rootNode;
    if (!root) return null;
    const cached = CALL_SITES.get(root);
    if (cached) return cached;
    const sites = nodesOfTypes(root, [
      'call_expression',
      'new_expression',
      'jsx_opening_element',
      'jsx_self_closing_element',
    ]).flatMap((node) => {
      const site = callSiteForNode(node, language);
      return site ? [site] : [];
    });
    CALL_SITES.set(root, sites);
    return sites;
  }
  const facts = getSourceFacts(db, relativePath);
  if (!facts) return null;
  if (!CALLABLE_FACT_LANGUAGES.has(facts.language)) return null;
  return facts.callSites;
}

export function getTypeContainerMap(db: ScipDatabase, relativePath: string): Map<string, Set<string>> {
  return getSourceFacts(db, relativePath)?.typeContainerMap ?? new Map();
}

export { extractCallLeaf };
