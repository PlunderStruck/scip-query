export { getSemanticProvider } from './provider-cache.js';
export { SemanticSessionManager, semanticSessionKey } from './session-manager.js';
export {
  semanticEvidenceProduct,
  semanticCalleeMap,
  semanticCallerMap,
  semanticImportUsage,
  semanticReferences,
  semanticSignature,
} from './shared-primitives.js';
export type {
  SemanticAvailability,
  SemanticCallee,
  SemanticImportUsage,
  SemanticLocation,
  SemanticProvider,
  SemanticProviderLanguage,
  SemanticReference,
} from './types.js';
export type {
  SemanticEvidenceCapability,
  SemanticEvidenceProduct,
  SemanticEvidenceSlot,
  SemanticReferenceMaterializationResult,
} from './shared-primitives.js';
export type { SemanticSession } from './session-manager.js';
