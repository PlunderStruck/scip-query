import { describe, expect, it } from 'vitest';
import type { ScipDatabase } from '../../src/storage/db.js';
import type { SemanticProvider } from '../../src/semantic/types.js';
import { SemanticSessionManager, semanticSessionKey } from '../../src/semantic/session-manager.js';

describe('SemanticSessionManager', () => {
  it('reuses one provider per database and language until cleared', () => {
    const db = fakeDb('/workspace/project');
    const manager = new SemanticSessionManager();
    let created = 0;
    const disposed: string[] = [];

    const first = manager.getOrCreate(db, 'typescript', () => fakeProvider('typescript', ++created, disposed));
    const second = manager.getOrCreate(db, 'typescript', () => fakeProvider('typescript', ++created, disposed));
    const rust = manager.getOrCreate(db, 'rust', () => fakeProvider('rust', ++created, disposed));

    expect(second).toBe(first);
    expect(rust).not.toBe(first);
    expect(created).toBe(2);
    expect(manager.sessionsFor(db)).toHaveLength(2);
    expect(manager.sessionsFor(db)[0]).toMatchObject({
      key: semanticSessionKey(db, 'typescript'),
      language: 'typescript',
      projectRoot: '/workspace/project',
      hits: 2,
    });

    manager.clear(db);
    expect(disposed).toEqual(['typescript:1', 'rust:2']);
    const afterClear = manager.getOrCreate(db, 'typescript', () => fakeProvider('typescript', ++created, disposed));

    expect(afterClear).not.toBe(first);
    expect(created).toBe(3);
  });
});

function fakeDb(projectRoot: string): ScipDatabase {
  return { config: { projectRoot } } as ScipDatabase;
}

function fakeProvider(language: 'typescript' | 'rust', id: number, disposed: string[]): SemanticProvider {
  return {
    language,
    availability: () => ({ available: true, reason: String(id) }),
    dispose: () => disposed.push(`${language}:${id}`),
    importUsage: () => [],
    referencesFor: () => [],
    calleesFor: () => [],
    signatureFor: () => null,
  };
}
