import { afterEach, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointTypeScriptSources } from '../../src/reindex/typescript-checkpoint.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('stores only byte-verified source and advances documents even when compiler bytes were retained', () => {
  const root = mkdtempSync(join(tmpdir(), 'scip-source-checkpoint-'));
  roots.push(root);
  const path = join(root, 'index.db');
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE documents(relative_path TEXT PRIMARY KEY, text TEXT)');
    db.prepare('INSERT INTO documents VALUES (?, NULL)').run('a.ts');
    db.prepare('INSERT INTO documents VALUES (?, NULL)').run('missing.ts');
    const source = '\uFEFFexport const value = 1;\n';
    const snapshot = (value: string) => ({
      version: 3,
      languages: ['typescript'],
      pnpmWorkspaces: false,
      typescriptProjectMode: 'single',
      typescriptProjects: [],
      files: [{ path: 'a.ts', hash: createHash('sha256').update(value).digest('hex'), size: Buffer.byteLength(value) }],
    });
    const read = () => db.prepare('SELECT text FROM documents WHERE relative_path = ?').get('a.ts');
    writeFileSync(join(root, 'a.ts'), source);
    expect(checkpointTypeScriptSources({ projectRoot: root, dbPath: path, fingerprint: snapshot(source + 'x') })).toBe(
      0,
    );
    expect(read()).toEqual({ text: null });
    expect(checkpointTypeScriptSources({ projectRoot: root, dbPath: path, fingerprint: snapshot(source) })).toBe(1);
    expect(read()).toEqual({ text: source });
    expect(checkpointTypeScriptSources({ projectRoot: root, dbPath: path, fingerprint: snapshot(source) })).toBe(0);
    const next = source.replace('1', '2');
    writeFileSync(join(root, 'a.ts'), next);
    expect(
      checkpointTypeScriptSources({
        projectRoot: root,
        dbPath: path,
        fingerprint: snapshot(next),
        changedFiles: ['a.ts'],
      }),
    ).toBe(1);
    expect(read()).toEqual({ text: next });
  } finally {
    db.close();
  }
});
