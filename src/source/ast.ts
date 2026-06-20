/**
 * Public AST facade.
 *
 * Callers keep importing AST capabilities from this stable module while the
 * parser runtime, language catalog, Vue script extraction, and AST-derived
 * facts live in smaller role-specific modules.
 */
export { detectAstLanguage, isVueSfcPath } from './ast-language.js';
export { callableBodyNodeTypesForLanguage } from './ast-callables.js';
export { getAst } from './ast-core.js';
export {
  extractCallLeaf,
  getCallableSites,
  getCallSites,
  getTypeContainerMap,
} from './ast-facts.js';
export {
  getCrossLanguageDispatchNames,
  getRustAttrReferencedNames,
  getSourceFacts,
  isLiteralPassthrough,
} from './source-facts.js';
export { extractVueTemplateBlock, getVueTemplateFacts } from './vue-template.js';
export { getVueSfcUnit } from './vue-sfc.js';
export { buildVueComponentBehaviorProfile, buildVueComponentBehaviorProfiles } from './vue-profile.js';
export { buildReactComponentBehaviorProfiles, buildReactComponentBehaviorProfilesForFile } from './react-profile.js';
export { frameworkSourceReferences } from './source-references.js';
export { compileQuery } from './ast-runtime.js';
export type { AstLanguage } from './ast-language.js';
export type { CallSite } from './ast-facts.js';
export type { FrameworkSourceReference, FrameworkSourceReferenceKind } from './source-references.js';
export type { SourceFacts } from './source-facts.js';
export type {
  VueTemplateBindingFact,
  VueTemplateBlock,
  VueTemplateFacts,
  VueTemplateIdentifierFact,
  VueTemplateTagFact,
} from './vue-template.js';
export type {
  VueSfcBlockKind,
  VueSfcResolvedBlock,
  VueSfcScriptBlock,
  VueSfcUnit,
} from './vue-sfc.js';
export type { VueComponentBehaviorProfile } from './vue-profile.js';
export type { ReactComponentBehaviorProfile } from './react-profile.js';
export type {
  VueScriptCallFact,
  VueScriptFacts,
  VueScriptFunctionFact,
  VueScriptImportFact,
} from './vue-script-facts.js';
export type { QueryInstance, SyntaxNode, Tree } from './ast-types.js';
