import type { ScipDatabase } from '../storage/db.js';
import type { AstLanguage } from './ast-language.js';
import { extractCallLeaf } from './source-calls.js';
import { getSourceFacts } from './source-facts.js';

const CALLABLE_FACT_LANGUAGES = new Set<AstLanguage>(['rust', 'typescript', 'tsx', 'javascript', 'python']);

export interface CallSite {
  /** Leaf name of what is being called, for example "foo" for `obj.foo()`. */
  calleeLeaf: string;
  /** True for member/dotted calls like `obj.foo()` where the receiver type is unknown. */
  memberAccess: boolean;
  line: number;
}

// scip-query: ignore-wrapper — public callable-site view kept stable while
// source-facts owns the underlying per-file AST bundle.
export function getCallableSites(
  db: ScipDatabase,
  relativePath: string,
): Array<{ name: string; startLine: number; endLine: number }> | null {
  const facts = getSourceFacts(db, relativePath);
  if (!facts) return null;
  if (!CALLABLE_FACT_LANGUAGES.has(facts.language)) return null;
  return facts.callables.map((callable) => ({
    name: callable.name,
    startLine: callable.startLine,
    endLine: callable.endLine,
  }));
}

export function getCallSites(db: ScipDatabase, relativePath: string): CallSite[] | null {
  const facts = getSourceFacts(db, relativePath);
  if (!facts) return null;
  if (!CALLABLE_FACT_LANGUAGES.has(facts.language)) return null;
  return facts.callSites;
}

export function getTypeContainerMap(
  db: ScipDatabase,
  relativePath: string,
): Map<string, Set<string>> {
  return getSourceFacts(db, relativePath)?.typeContainerMap ?? new Map();
}

export { extractCallLeaf };
