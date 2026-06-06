import type { ScipDatabase } from '../storage/db.js';
import type { SemanticProvider } from './types.js';
import { createTsMorphProvider } from './typescript/ts-morph-provider.js';

const PROVIDER_CACHE = new WeakMap<ScipDatabase, Map<string, SemanticProvider>>();

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
