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

describe('definition catalog Rust impl range correction', () => {
  it('matches repeated impl method names by owner type instead of fallback chunk start', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-rust-impl-range-'));
    const projectRoot = join(tempDir, 'project');
    const dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/lib.rs': [
        'struct Alpha;',
        'struct Beta;',
        '',
        'impl Default for Alpha {',
        '    fn default() -> Self {',
        '        Alpha',
        '    }',
        '}',
        '',
        'impl Default for Beta {',
        '    fn default() -> Self {',
        '        Beta',
        '    }',
        '}',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'rust', 'src/lib.rs')
      .symbol(1, 'rust-analyzer cargo fixture 0.1.0 lib/impl#[Alpha][Default]default().', 'default', 80)
      .symbol(2, 'rust-analyzer cargo fixture 0.1.0 lib/impl#[Beta][Default]default().', 'default', 80)
      .chunk(1, 1, 0, 13)
      .mention(1, 1, 1)
      .mention(1, 2, 1)
      .write();

    const db = new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    try {
      const definitions = getDefinitionsForFile(db, 'src/lib.rs');
      expect(definitions.find((definition) => definition.symbol.includes('impl#[Alpha]'))).toMatchObject({
        startLine: 4,
        endLine: 6,
      });
      expect(definitions.find((definition) => definition.symbol.includes('impl#[Beta]'))).toMatchObject({
        startLine: 10,
        endLine: 12,
      });
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
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

describe('getDefinitionsForFile includeClassMemberFallbacks (catalog-members K1)', () => {
  // Mixed fixture: a class with a constructor + method (primary rows, so the
  // file has "any primary-indexed definition") plus a written instance field
  // that the indexer only emitted as a mention (fallback row, no
  // defn_enclosing_ranges entry) — the exact shape verified live on Watcher
  // (src/runtime/watch.ts).
  function widgetFixture(): { db: ScipDatabase; tempDir: string } {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-class-member-fallback-'));
    const projectRoot = join(tempDir, 'project');
    const dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/widget.ts': [
        'export class Widget {',
        '  count = 0;',
        '',
        '  constructor() {',
        '    this.count = 0;',
        '  }',
        '',
        '  bump() {',
        '    this.count += 1;',
        '  }',
        '}',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/widget.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#count.', 'count', 7)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#constructor().', 'constructor', 6)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#bump().', 'bump', 6)
      // Primary rows: constructor + method are indexed with real enclosing ranges.
      .definition(1, 1, 2, 3, 2, 5, 3)
      .definition(2, 1, 3, 7, 2, 9, 3)
      // Fallback-only: the field has no defn_enclosing_ranges row, only a
      // definition mention (role=1) whose chunk is scoped to its declaration
      // line (indexers chunk by span, not whole-file, so MIN/MAX(chunk) is
      // the field's own line here).
      .chunk(1, 1, 1, 1)
      .mention(1, 1, 1)
      .write();
    const db = new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    return { db, tempDir };
  }

  it('default call (opt-in absent) returns byte-for-byte the same rows as before the opt-in existed', () => {
    const { db } = widgetFixture();
    try {
      const definitions = getDefinitionsForFile(db, 'src/widget.ts');
      const symbols = definitions.map((d) => d.symbol).sort();
      expect(symbols).toEqual([
        'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#bump().',
        'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#constructor().',
      ]);
      // Snapshot equality: this exact shape is the default-path invariant —
      // no field row, no reordering, no shape drift.
      expect(definitions).toEqual([
        expect.objectContaining({ symbol: 'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#constructor().' }),
        expect.objectContaining({ symbol: 'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#bump().' }),
      ]);
    } finally {
      db.close();
    }
  });

  it('default call with includeClassMemberFallbacks: false matches the opt-in-absent call exactly', () => {
    const { db } = widgetFixture();
    try {
      const absent = getDefinitionsForFile(db, 'src/widget.ts');
      const explicitFalse = getDefinitionsForFile(db, 'src/widget.ts', { includeClassMemberFallbacks: false });
      expect(explicitFalse).toEqual(absent);
    } finally {
      db.close();
    }
  });

  it('opted-in call additionally returns the class-member fallback row with its mention-derived range', () => {
    const { db } = widgetFixture();
    try {
      const definitions = getDefinitionsForFile(db, 'src/widget.ts', { includeClassMemberFallbacks: true });
      const symbols = definitions.map((d) => d.symbol).sort();
      expect(symbols).toEqual([
        'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#bump().',
        'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#constructor().',
        'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#count.',
      ]);
      const count = definitions.find((d) => d.symbol.endsWith('Widget#count.'))!;
      expect(count.parentTypeName).toBe('Widget');
      // Mention-derived range from the chunk/mention rows (line 1, 0-indexed).
      expect(count.startLine).toBe(1);
      expect(count.endLine).toBe(1);
    } finally {
      db.close();
    }
  });
});
