import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import {
  EVIDENCE_DB_FILENAME,
  fileContentHash,
  projectEvidenceFingerprint,
  readCachedSemanticCallees,
  readCachedSemanticReferences,
  readCachedFileEvidence,
  sha256Hex,
  writeCachedSemanticCalleesBatch,
  writeCachedSemanticReferencesBatch,
  writeCachedFileEvidence,
} from '../../src/storage/evidence-cache.js';
import { getSourceFacts } from '../../src/source/source-facts.js';
import { getSourceLines, getSourceText } from '../../src/source/source-text.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

const FILE = 'src/sample.ts';
const SOURCE_LINES = [
  'export function greet(name: string) {',
  '  const message = `hello ${name}`;',
  '  return message.toUpperCase();',
  '}',
];

describe('evidence cache', () => {
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
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-evidence-cache-'));
    projectRoot = join(tempDir, 'project');
    dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, { [FILE]: SOURCE_LINES });
    evidenceFixtureDb(dbPath).document(1, 'typescript', FILE).write();
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves cached source lines from the same source text', () => {
    const db = openDb();
    try {
      const first = getSourceLines(db, FILE);
      const second = getSourceLines(db, FILE);

      expect(first).toBe(second);
      expect(first).toEqual(getSourceText(db, FILE).split('\n'));
      expect(getSourceLines(db, 'src/missing.ts')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('persists source facts and serves them to a fresh connection', () => {
    const db1 = openDb();
    try {
      const facts = getSourceFacts(db1, FILE);
      expect(facts).not.toBeNull();
      expect(facts!.callables.map((callable) => callable.name)).toContain('greet');
      const hash = fileContentHash(db1, FILE, getSourceText(db1, FILE));
      expect(readCachedFileEvidence(db1, 'source-facts', FILE, hash)).not.toBeNull();
    } finally {
      db1.close();
    }

    // A second connection (a "new process") must produce structurally
    // identical facts from the persisted payload.
    const db2 = openDb();
    try {
      const facts = getSourceFacts(db2, FILE);
      expect(facts).not.toBeNull();
      expect(facts!.callables.map((callable) => callable.name)).toContain('greet');
      expect(facts!.fileIdentifiers.has('message')).toBe(true);
      expect(facts!.identifierLineMap.get('message')).toEqual([1, 2]);
      expect(facts!.identifiersByLine[1]?.has('message')).toBe(true);
    } finally {
      db2.close();
    }
  });

  it('reads through the persisted payload instead of re-parsing', () => {
    // Plant a marker payload under the current content hash: if the read
    // path is live, a fresh connection returns the planted facts verbatim.
    const db = openDb();
    const hash = fileContentHash(db, FILE, getSourceText(db, FILE));
    db.close();

    const evidence = new Database(join(tempDir, EVIDENCE_DB_FILENAME));
    const planted = JSON.stringify({
      language: 'typescript',
      callables: [
        {
          name: 'plantedMarker',
          startLine: 0,
          endLine: 3,
          paramCount: 1,
          params: [{ name: 'name', simple: true }],
          paramsEndLine: 0,
          isLiteralPassthrough: false,
        },
      ],
      callSites: [],
      typeContainerMap: [],
      identifierLineMap: [],
      rustAttrReferencedNames: [],
      crossLanguageDispatchNames: [],
    });
    evidence
      .prepare("UPDATE file_evidence SET payload = ? WHERE kind = 'source-facts' AND relative_path = ?")
      .run(planted, FILE);
    evidence.close();

    const db2 = openDb();
    try {
      expect(getSourceFacts(db2, FILE)!.callables[0]!.name).toBe('plantedMarker');
      expect(readCachedFileEvidence(db2, 'source-facts', FILE, hash)).toBe(planted);
    } finally {
      db2.close();
    }
  });

  it('ignores content hash mismatches but reads legacy package-version drift', () => {
    const evidence = new Database(join(tempDir, EVIDENCE_DB_FILENAME));
    evidence
      .prepare("UPDATE file_evidence SET content_hash = ? WHERE kind = 'source-facts' AND relative_path = ?")
      .run(sha256Hex('different content'), FILE);
    evidence.close();

    const db = openDb();
    try {
      // Hash mismatch -> miss -> rebuilt from source (marker gone).
      const facts = getSourceFacts(db, FILE);
      expect(facts!.callables.map((callable) => callable.name)).toContain('greet');
    } finally {
      db.close();
    }

    const reopened = new Database(join(tempDir, EVIDENCE_DB_FILENAME));
    reopened
      .prepare("UPDATE file_evidence SET version = ? WHERE kind = 'source-facts' AND relative_path = ?")
      .run('0.0.0-other', FILE);
    reopened.close();

    const db2 = openDb();
    try {
      const hash = fileContentHash(db2, FILE, getSourceText(db2, FILE));
      expect(readCachedFileEvidence(db2, 'source-facts', FILE, hash)).not.toBeNull();
    } finally {
      db2.close();
    }

    const stableMismatch = new Database(join(tempDir, EVIDENCE_DB_FILENAME));
    stableMismatch
      .prepare("UPDATE file_evidence SET version = ? WHERE kind = 'source-facts' AND relative_path = ?")
      .run('evidence-v0', FILE);
    stableMismatch.close();

    const db3 = openDb();
    try {
      const hash = fileContentHash(db3, FILE, getSourceText(db3, FILE));
      expect(readCachedFileEvidence(db3, 'source-facts', FILE, hash)).toBeNull();
      expect(getSourceFacts(db3, FILE)!.callables.map((callable) => callable.name)).toContain('greet');
    } finally {
      db3.close();
    }
  });

  it('treats corrupt payloads as misses and rebuilds', () => {
    const db = openDb();
    const hash = fileContentHash(db, FILE, getSourceText(db, FILE));
    db.close();

    const evidence = new Database(join(tempDir, EVIDENCE_DB_FILENAME));
    evidence
      .prepare(
        "UPDATE file_evidence SET payload = ?, content_hash = ? WHERE kind = 'source-facts' AND relative_path = ?",
      )
      .run('{not json', hash, FILE);
    evidence.close();

    const db2 = openDb();
    try {
      const facts = getSourceFacts(db2, FILE);
      expect(facts!.callables.map((callable) => callable.name)).toContain('greet');
    } finally {
      db2.close();
    }
  });

  it('round-trips semantic callee rows and invalidates on hash or digest change', () => {
    const db = openDb();
    try {
      const payload = JSON.stringify([{ symbol: 'x', file: 'src/x.ts', line: 3 }]);
      const otherPayload = JSON.stringify([{ symbol: 'y', file: 'src/y.ts', line: 5 }]);
      writeCachedSemanticCalleesBatch(db, [
        { relativePath: FILE, symbol: 'sym#greet', contentHash: 'hash-a', depsDigest: 'digest-a', payload },
        {
          relativePath: FILE,
          symbol: 'sym#other',
          contentHash: 'hash-a',
          depsDigest: 'digest-a',
          payload: otherPayload,
        },
      ]);
      expect(readCachedSemanticCallees(db, FILE, 'sym#greet', 'hash-a', 'digest-a')).toBe(payload);
      expect(readCachedSemanticCallees(db, FILE, 'sym#other', 'hash-a', 'digest-a')).toBe(otherPayload);
      expect(readCachedSemanticCallees(db, FILE, 'sym#greet', 'hash-b', 'digest-a')).toBeNull();
      expect(readCachedSemanticCallees(db, FILE, 'sym#greet', 'hash-a', 'digest-b')).toBeNull();

      // Writing under a new content hash drops the path's stale rows.
      writeCachedSemanticCalleesBatch(db, [
        { relativePath: FILE, symbol: 'sym#other', contentHash: 'hash-b', depsDigest: 'digest-a', payload },
      ]);
      expect(readCachedSemanticCallees(db, FILE, 'sym#greet', 'hash-a', 'digest-a')).toBeNull();
      expect(readCachedSemanticCallees(db, FILE, 'sym#other', 'hash-a', 'digest-a')).toBeNull();
      expect(readCachedSemanticCallees(db, FILE, 'sym#other', 'hash-b', 'digest-a')).toBe(payload);
    } finally {
      db.close();
    }
  });

  it('round-trips semantic reference rows and invalidates on project fingerprint change', () => {
    const dbWithoutMeta = openDb();
    try {
      expect(projectEvidenceFingerprint(dbWithoutMeta)).toBeNull();
    } finally {
      dbWithoutMeta.close();
    }

    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({
        version: 3,
        status: 'complete',
        fingerprint: {
          version: 1,
          languages: ['typescript'],
          pnpmWorkspaces: false,
          files: [{ path: FILE, size: 123, hash: 'source-a' }],
        },
        indexedLanguages: ['typescript'],
      }),
    );

    const db = openDb();
    const projectFingerprint = projectEvidenceFingerprint(db);
    try {
      expect(projectFingerprint).not.toBeNull();
      const payload = JSON.stringify([{ file: 'src/consumer.ts', line: 2, column: 4 }]);
      writeCachedSemanticReferencesBatch(db, [
        { relativePath: FILE, symbol: 'sym#greet', projectFingerprint: projectFingerprint!, payload },
      ]);
      expect(readCachedSemanticReferences(db, FILE, 'sym#greet', projectFingerprint!)).toBe(payload);
      expect(readCachedSemanticReferences(db, FILE, 'sym#greet', 'different-project')).toBeNull();
    } finally {
      db.close();
    }

    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({
        version: 3,
        status: 'complete',
        fingerprint: {
          version: 1,
          languages: ['typescript'],
          pnpmWorkspaces: false,
          files: [{ path: FILE, size: 456, hash: 'source-b' }],
        },
        indexedLanguages: ['typescript'],
      }),
    );

    const dbAfterChange = openDb();
    const nextProjectFingerprint = projectEvidenceFingerprint(dbAfterChange);
    try {
      expect(nextProjectFingerprint).not.toBe(projectFingerprint);
      const nextPayload = JSON.stringify([{ file: 'src/next-consumer.ts', line: 5, column: 1 }]);
      writeCachedSemanticReferencesBatch(dbAfterChange, [
        { relativePath: FILE, symbol: 'sym#greet', projectFingerprint: nextProjectFingerprint!, payload: nextPayload },
      ]);
      expect(readCachedSemanticReferences(dbAfterChange, FILE, 'sym#greet', projectFingerprint!)).toBeNull();
      expect(readCachedSemanticReferences(dbAfterChange, FILE, 'sym#greet', nextProjectFingerprint!)).toBe(nextPayload);
    } finally {
      dbAfterChange.close();
    }
  });

  it('degrades silently when the evidence db cannot be opened', () => {
    const blockedDir = mkdtempSync(join(tmpdir(), 'scip-query-evidence-blocked-'));
    try {
      const blockedRoot = join(blockedDir, 'project');
      const blockedDbPath = join(blockedDir, 'index.db');
      writeFixtureFiles(blockedRoot, { [FILE]: SOURCE_LINES });
      evidenceFixtureDb(blockedDbPath).document(1, 'typescript', FILE).write();
      // Occupy the evidence.db path with a directory so SQLite cannot open it.
      mkdirSync(join(blockedDir, EVIDENCE_DB_FILENAME));

      const db = new ScipDatabase({
        projectRoot: blockedRoot,
        dbPath: blockedDbPath,
        indexPath: join(blockedDir, 'index.scip'),
      });
      try {
        const facts = getSourceFacts(db, FILE);
        expect(facts!.callables.map((callable) => callable.name)).toContain('greet');
        expect(readCachedFileEvidence(db, 'source-facts', FILE, 'any')).toBeNull();
        writeCachedFileEvidence(db, 'source-facts', FILE, 'any', '{}'); // must not throw
      } finally {
        db.close();
      }
    } finally {
      rmSync(blockedDir, { recursive: true, force: true });
    }
  });
});
