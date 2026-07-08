import type { ScipDatabase } from '../storage/db.js';
import type { SemanticProvider, SemanticProviderLanguage } from './types.js';

export interface SemanticSession {
  key: string;
  language: SemanticProviderLanguage;
  projectRoot: string;
  provider: SemanticProvider;
  createdAtMs: number;
  lastUsedAtMs: number;
  hits: number;
}

export class SemanticSessionManager {
  private readonly sessions = new WeakMap<ScipDatabase, Map<string, SemanticSession>>();

  getOrCreate(
    db: ScipDatabase,
    language: SemanticProviderLanguage,
    createProvider: () => SemanticProvider,
  ): SemanticProvider {
    const key = semanticSessionKey(db, language);
    let perDb = this.sessions.get(db);
    if (!perDb) {
      perDb = new Map();
      this.sessions.set(db, perDb);
    }
    const existing = perDb.get(key);
    if (existing) {
      existing.hits += 1;
      existing.lastUsedAtMs = Date.now();
      return existing.provider;
    }

    const now = Date.now();
    const provider = createProvider();
    perDb.set(key, {
      key,
      language,
      projectRoot: db.config.projectRoot,
      provider,
      createdAtMs: now,
      lastUsedAtMs: now,
      hits: 1,
    });
    return provider;
  }

  sessionsFor(db: ScipDatabase): SemanticSession[] {
    return [...(this.sessions.get(db)?.values() ?? [])];
  }

  clear(db: ScipDatabase): void {
    const perDb = this.sessions.get(db);
    if (perDb) {
      for (const session of perDb.values()) {
        session.provider.dispose?.();
      }
    }
    this.sessions.delete(db);
  }
}

export function semanticSessionKey(db: ScipDatabase, language: SemanticProviderLanguage): string {
  return `${db.config.projectRoot}:${language}-workspace`;
}
