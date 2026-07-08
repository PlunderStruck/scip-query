import type { ScipDatabase } from '../storage/db.js';
import { registerCacheClear } from '../storage/cache-registry.js';
import { detectAstLanguage } from '../source/ast/ast-language.js';
import { resolveRustCalleeSymbol } from './rust/callee-symbol-resolution.js';
import { rustImportUsageFactsFromSource } from './rust/import-usage.js';
import { createRustSemanticProvider } from './rust/provider.js';
import type { SemanticProvider, SemanticProviderLanguage } from './types.js';
import { SemanticSessionManager } from './session-manager.js';
import { createTsMorphProvider } from './typescript/ts-morph-provider.js';
import { isTypeScriptLike } from './typescript/source-kinds.js';

const SEMANTIC_SESSIONS = new SemanticSessionManager();

// Opt-in group: provider construction is expensive, so composite analyses
// clear it only when they explicitly request a semantic reset.
registerCacheClear({
  name: 'semantic-provider',
  groups: ['semantic-provider'],
  clearAll: (db) => SEMANTIC_SESSIONS.clear(db),
});

// scip-query: ignore-wrapper — public provider cache boundary exported from
// semantic/index.ts; keeping provider construction behind this function
// prevents query modules from depending on concrete ts-morph providers.
export function getSemanticProvider(db: ScipDatabase, relativePath?: string): SemanticProvider {
  const language = semanticProviderLanguageForPath(relativePath) ?? 'typescript';
  return SEMANTIC_SESSIONS.getOrCreate(db, language, () =>
    language === 'rust'
      ? createRustSemanticProvider(db.config.projectRoot, {
          sourceImportUsageResolver: {
            importUsageFacts: (file) => rustImportUsageFactsFromSource(db, file),
          },
          calleeSymbolResolver: (callee) => resolveRustCalleeSymbol(db, callee),
        })
      : createTsMorphProvider(db, relativePath),
  );
}

// scip-query: ignore-wrapper — this is the semantic provider discriminator shared
// by provider construction and capability reporting; keeping it named prevents
// TypeScript/Rust path policy drift.
export function semanticProviderLanguageForPath(relativePath?: string): SemanticProviderLanguage | null {
  if (!relativePath) return 'typescript';
  if (detectAstLanguage(relativePath) === 'rust') return 'rust';
  if (isTypeScriptLike(relativePath)) return 'typescript';
  return null;
}
