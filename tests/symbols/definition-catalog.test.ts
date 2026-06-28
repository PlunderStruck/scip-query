import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fileContentHash,
  projectEvidenceFingerprint,
  readCachedFileEvidence,
} from '../../src/storage/evidence-cache.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { getSourceText } from '../../src/source/source-text.js';
import { findEnclosingDefinition, getDefinitionsForFile } from '../../src/symbols/definition-catalog.js';
import type { IndexedDefinition } from '../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

function definition(symbol: string, startLine: number, endLine: number, symbolId: number): IndexedDefinition {
  return {
    symbol,
    symbolId,
    documentId: 1,
    startLine,
    endLine,
    relativePath: 'src/example.ts',
    leaf: symbol,
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: 12,
    documentation: null,
    enclosingSymbol: null,
  };
}

describe('definition catalog line ownership', () => {
  it('returns the smallest containing definition while preserving equal-span ties', () => {
    const outer = definition('outer', 0, 10, 1);
    const inner = definition('inner', 3, 5, 2);
    const equalFirst = definition('equalFirst', 7, 8, 3);
    const equalSecond = definition('equalSecond', 7, 8, 4);

    const definitions = [outer, inner, equalFirst, equalSecond];

    expect(findEnclosingDefinition(definitions, 4)).toBe(inner);
    expect(findEnclosingDefinition(definitions, 7)).toBe(equalFirst);
    expect(findEnclosingDefinition(definitions, 1)).toBe(outer);
    expect(findEnclosingDefinition(definitions, 99)).toBeNull();
  });
});

describe('definition catalog evidence cache', () => {
  let tempDir: string;
  let projectRoot: string;
  let dbPath: string;

  function openDb(): ScipDatabase {
    return new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
  }

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-definition-catalog-'));
    projectRoot = join(tempDir, 'project');
    dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/sample.ts': ['export function greet(name: string) {', '  return name.toUpperCase();', '}'],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/sample.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`sample.ts`/greet().', 'greet', 12)
      .definition(1, 1, 1, 0, 0, 0, 1)
      .chunk(1, 1, 0, 2)
      .mention(1, 1, 1)
      .write();
    writeMeta([{ path: 'src/sample.ts', size: 78, hash: 'source-a' }]);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves cached definitions to a fresh connection', () => {
    const db1 = openDb();
    let hash: string;
    let planted: string;
    try {
      const original = getDefinitionsForFile(db1, 'src/sample.ts');
      expect(original).toHaveLength(1);
      hash = fileContentHash(db1, 'src/sample.ts', getSourceText(db1, 'src/sample.ts'));
      expect(readCachedFileEvidence(db1, 'file-definitions', 'src/sample.ts', hash)).not.toBeNull();
      planted = JSON.stringify({
        projectFingerprint: projectEvidenceFingerprint(db1),
        definitions: [
          {
            ...original[0],
            symbolId: 99,
            symbol: 'scip-typescript npm fixture 1.0.0 src/`sample.ts`/planted().',
            leaf: 'planted',
            startLine: 7,
            endLine: 8,
          },
        ],
      });
    } finally {
      db1.close();
    }

    const evidence = new Database(join(tempDir, 'evidence.db'));
    evidence
      .prepare("UPDATE file_evidence SET payload = ? WHERE kind = 'file-definitions' AND relative_path = ?")
      .run(planted, 'src/sample.ts');
    evidence.close();

    const db2 = openDb();
    try {
      expect(readCachedFileEvidence(db2, 'file-definitions', 'src/sample.ts', hash)).toBe(planted);
      expect(getDefinitionsForFile(db2, 'src/sample.ts')).toEqual([
        expect.objectContaining({
          symbolId: 99,
          leaf: 'planted',
          startLine: 7,
          endLine: 8,
        }),
      ]);
    } finally {
      db2.close();
    }
  });

  it('rejects cached definitions from a different project fingerprint', () => {
    const staleEvidence = new Database(join(tempDir, 'evidence.db'));
    staleEvidence
      .prepare("UPDATE file_evidence SET payload = json_set(payload, '$.projectFingerprint', ?) WHERE kind = ?")
      .run('stale-project', 'file-definitions');
    staleEvidence.close();

    const db = openDb();
    try {
      const definitions = getDefinitionsForFile(db, 'src/sample.ts');
      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatchObject({
        symbolId: 1,
        leaf: 'greet',
        startLine: 0,
      });
    } finally {
      db.close();
    }
  });

  function writeMeta(files: Array<{ path: string; size: number; hash: string }>): void {
    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({
        version: 3,
        status: 'complete',
        fingerprint: {
          version: 1,
          languages: ['typescript'],
          pnpmWorkspaces: false,
          files,
        },
        indexedLanguages: ['typescript'],
      }),
    );
  }
});
