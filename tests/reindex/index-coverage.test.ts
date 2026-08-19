import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectIndexDocumentCoverage } from '../../src/reindex/index-coverage.js';
import type { ProjectInputSnapshot } from '../../src/domain/project-input.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('index document coverage', () => {
  it('reports fingerprinted source files missing from the graph-bearing document table', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-index-coverage-'));
    tempDirs.push(root);
    const dbPath = join(root, 'index.db');
    mkdirSync(root, { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE documents (id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE);
      INSERT INTO documents (id, relative_path) VALUES (1, 'src/present.ts');
    `);
    db.close();

    const snapshot: ProjectInputSnapshot = {
      version: 1,
      languages: ['typescript'],
      pnpmWorkspaces: false,
      typescriptProjectMode: 'single',
      typescriptProjects: [],
      files: [
        { path: 'package.json', size: 2, hash: 'config' },
        { path: 'src/present.ts', size: 1, hash: 'present' },
        { path: 'src/missing.ts', size: 1, hash: 'missing' },
      ],
    };

    expect(inspectIndexDocumentCoverage(dbPath, snapshot, ['typescript'])).toEqual({
      state: 'incomplete',
      expectedDocumentCount: 2,
      actualDocumentCount: 1,
      missingDocumentCount: 1,
      missingPaths: ['src/missing.ts'],
      affectedLanguages: ['typescript'],
    });
  });

  it('does not require compiler-target-excluded files from providers without an exhaustive document contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-index-coverage-provider-'));
    tempDirs.push(root);
    const dbPath = join(root, 'index.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE documents (id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE);
      INSERT INTO documents (id, relative_path) VALUES
        (1, 'src/present.ts'),
        (2, 'src/main.rs');
    `);
    db.close();

    const snapshot: ProjectInputSnapshot = {
      version: 1,
      languages: ['typescript', 'rust'],
      pnpmWorkspaces: false,
      typescriptProjectMode: 'single',
      typescriptProjects: [],
      files: [
        { path: 'src/present.ts', size: 1, hash: 'present' },
        { path: 'src/missing.ts', size: 1, hash: 'missing' },
        { path: 'src/main.rs', size: 1, hash: 'main' },
        { path: 'src/browser_audio.rs', size: 1, hash: 'cfg-disabled' },
      ],
    };

    expect(inspectIndexDocumentCoverage(dbPath, snapshot, ['typescript', 'rust'])).toEqual({
      state: 'incomplete',
      expectedDocumentCount: 2,
      actualDocumentCount: 2,
      missingDocumentCount: 1,
      missingPaths: ['src/missing.ts'],
      affectedLanguages: ['typescript'],
    });
  });
});
