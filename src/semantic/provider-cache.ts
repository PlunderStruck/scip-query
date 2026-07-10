import type { ScipDatabase } from '../storage/db.js';
import { registerCacheClear } from '../storage/cache-registry.js';
import { detectAstLanguage } from '../source/ast/ast-language.js';
import { getSourceFacts } from '../source/source-facts.js';
import { createRustCalleeSymbolResolver } from './rust/callee-symbol-resolution.js';
import { rustImportUsageFactsFromSource } from './rust/import-usage.js';
import { createRustSemanticProvider } from './rust/provider.js';
import { rustScipOccurrenceCalleeMap } from './rust/scip-occurrence-callees.js';
import type { IndexedDefinition } from '../domain/types.js';
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
          calleeSymbolResolver: createRustCalleeSymbolResolver(db),
          sourceZeroCalleeOracle: (definition) => rustSourceProvesZeroCallees(db, definition),
          scipOccurrenceCalleeOracle: (definitions) => rustScipOccurrenceCalleeMap(db, definitions),
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

function rustSourceProvesZeroCallees(db: ScipDatabase, definition: IndexedDefinition): boolean {
  const facts = getSourceFacts(db, definition.relativePath);
  if (!facts || facts.language !== 'rust') return false;
  const callable =
    facts.callables.find(
      (candidate) =>
        candidate.startLine === definition.startLine &&
        candidate.endLine === definition.endLine &&
        candidate.name === definition.leaf,
    ) ??
    facts.callables.find(
      (candidate) => candidate.startLine === definition.startLine && candidate.endLine === definition.endLine,
    );
  if (!callable) return false;
  return !facts.callSites.some((site) => site.line >= callable.startLine && site.line <= callable.endLine);
}
