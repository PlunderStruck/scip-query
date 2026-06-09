import type { ScipDatabase } from '../storage/db.js';
import { registerCacheClear } from '../storage/cache-registry.js';
import type { SemanticProvider } from './types.js';
import { createTsMorphProvider } from './typescript/ts-morph-provider.js';

const PROVIDER_CACHE = new WeakMap<ScipDatabase, Map<string, SemanticProvider>>();

// Opt-in group: provider construction is expensive, so composite analyses
// clear it only when they explicitly request a semantic reset.
registerCacheClear({
  name: 'semantic-provider',
  groups: ['semantic-provider'],
  clearAll: (db) => PROVIDER_CACHE.delete(db),
});

// scip-query: ignore-wrapper — public provider cache boundary exported from
// semantic/index.ts; keeping provider construction behind this function
// prevents query modules from depending on concrete ts-morph providers.
export function getSemanticProvider(db: ScipDatabase, relativePath?: string): SemanticProvider {
  const key = `${db.config.projectRoot}:typescript-workspace`;
  let perDb = PROVIDER_CACHE.get(db);
  if (!perDb) {
    perDb = new Map();
    PROVIDER_CACHE.set(db, perDb);
  }
  const cached = perDb.get(key);
  if (cached) return cached;
  const provider = createTsMorphProvider(db, relativePath);
  perDb.set(key, provider);
  return provider;
}
