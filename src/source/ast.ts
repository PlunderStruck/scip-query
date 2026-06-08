/**
 * Public AST facade.
 *
 * Callers keep importing AST capabilities from this stable module while the
 * parser runtime, language catalog, Vue script extraction, and AST-derived
 * facts live in smaller role-specific modules.
 */
export { detectAstLanguage, isVueSfcPath } from './ast-language.js';
export { callableBodyNodeTypesForLanguage } from './ast-callables.js';
export { clearAstCache, clearAstCacheForFile, getAst } from './ast-core.js';
export {
  extractCallLeaf,
  getCallableSites,
  getCallSites,
  getTypeContainerMap,
  runCachedAstWalk,
} from './ast-facts.js';
export {
  getCallableSignature,
  getCrossLanguageDispatchNames,
  getRustAttrReferencedNames,
  getSourceFacts,
  isLiteralPassthrough,
} from './source-facts.js';
export { compileQuery } from './ast-runtime.js';
export type { AstLanguage } from './ast-language.js';
export type { CallSite, CallableSite } from './ast-facts.js';
export type { CallableSignature, SourceFacts } from './source-facts.js';
export type { QueryInstance, SyntaxNode, Tree } from './ast-types.js';
