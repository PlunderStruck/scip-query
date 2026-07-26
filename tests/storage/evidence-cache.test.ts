import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import {
  applyFindingOutcomeLedgerTransition,
  EVIDENCE_DB_FILENAME,
  fileContentHash,
  projectEvidenceFingerprint,
  readCachedProjectEvidence,
  readCachedSemanticCallees,
  readCachedSemanticCalleesForFile,
  readCachedSemanticReferences,
  readCachedSemanticReferencesForFile,
  readCachedFileEvidence,
  readFindingOutcomeLedger,
  sha256Hex,
  writeCachedProjectEvidence,
  writeCachedSemanticCalleesBatch,
  writeCachedSemanticReferencesBatch,
  writeCachedFileEvidence,
  FINDING_OUTCOME_LEDGER_CAP_PER_CHECK,
  SHARED_FILE_EVIDENCE_KINDS,
  maintainSharedEvidenceCache,
} from '../../src/storage/evidence-cache.js';
import { SOURCE_FACTS_PAYLOAD_VERSION, getSourceFacts } from '../../src/source/facts/source-facts.js';
import { getSourceLines, getSourceText } from '../../src/source/primitives/source-text.js';
import { getReExports } from '../../src/language-parsers/index.js';
import {
  createFileEvidenceProduct,
  createProjectEvidenceProduct,
  evidenceProductInvalidation,
} from '../../src/storage/evidence-products.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

const FILE = 'src/sample.ts';
const REEXPORT_FILE = 'src/barrel.ts';
const REEXPORT_TARGET_FILE = 'src/target.ts';
const SOURCE_LINES = [
  'export function greet(name: string) {',
  '  const message = `hello ${name}`;',
  '  return message.toUpperCase();',
  '}',
];
const PROFILE_ENV_KEYS = [
  'SCIP_QUERY_PROFILE',
  'SCIP_QUERY_PROFILE_OUT',
  'SCIP_QUERY_PROFILE_COMMAND',
  'SCIP_QUERY_PROFILE_RUN_ID',
  'SCIP_QUERY_PROFILE_WORKLOAD_IDENTITY',
  'SCIP_QUERY_PROFILE_WORKLOAD_IDENTITY_KIND',
] as const;
const PRODUCT_TEST = createFileEvidenceProduct<{ marker: string }>({
  kind: 'doc-path-tokens',
  invalidation: evidenceProductInvalidation('doc-path-tokens'),
  serialize: (value) => JSON.stringify(value),
  deserialize: (payload) => {
    const raw = JSON.parse(payload) as unknown;
    if (!raw || typeof raw !== 'object' || typeof (raw as { marker?: unknown }).marker !== 'string') return null;
    return { marker: (raw as { marker: string }).marker };
  },
});
const PROJECT_PRODUCT_TEST = createProjectEvidenceProduct<{ marker: string }>({
  kind: 'file-dependency-graph',
  invalidation: evidenceProductInvalidation('file-dependency-graph'),
  serialize: (value) => JSON.stringify(value),
  deserialize: (payload) => {
    const raw = JSON.parse(payload) as unknown;
    if (!raw || typeof raw !== 'object' || typeof (raw as { marker?: unknown }).marker !== 'string') return null;
    return { marker: (raw as { marker: string }).marker };
  },
});

function restoreProfileEnv(snapshot: Record<(typeof PROFILE_ENV_KEYS)[number], string | undefined>): void {
  for (const key of PROFILE_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

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
    writeFixtureFiles(projectRoot, {
      [FILE]: SOURCE_LINES,
      [REEXPORT_FILE]: ["export { targetValue } from './target.js';"],
      [REEXPORT_TARGET_FILE]: ['export const targetValue = 1;'],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', FILE)
      .document(2, 'typescript', REEXPORT_FILE)
      .document(3, 'typescript', REEXPORT_TARGET_FILE)
      .write();
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

  it('round-trips typed file evidence products', () => {
    const db = openDb();
    try {
      PRODUCT_TEST.write(db, 'docs/product.md', 'hash-a', { marker: 'cached' });

      expect(PRODUCT_TEST.read(db, 'docs/product.md', 'hash-a')).toEqual({ marker: 'cached' });
      expect(PRODUCT_TEST.read(db, 'docs/product.md', 'hash-b')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('reads proven content-addressed products across worktrees while keeping other evidence local', () => {
    const sharedEvidenceDbPath = join(tempDir, 'repository-cache', 'evidence.db');
    const firstDir = join(tempDir, 'worktree-cache-1');
    const secondDir = join(tempDir, 'worktree-cache-2');
    const thirdDir = join(tempDir, 'worktree-cache-3');
    for (const directory of [firstDir, secondDir, thirdDir]) {
      mkdirSync(directory, { recursive: true });
      copyFileSync(dbPath, join(directory, 'index.db'));
    }
    const openWorktreeDb = (directory: string): ScipDatabase =>
      new ScipDatabase({
        projectRoot,
        dbPath: join(directory, 'index.db'),
        indexPath: join(directory, 'index.scip'),
        sharedEvidenceDbPath,
      });

    const first = openWorktreeDb(firstDir);
    try {
      writeCachedFileEvidence(first, 'doc-path-tokens', 'docs/shared.md', 'hash-a', 'shared-a');
      writeCachedFileEvidence(first, 'file-definitions', 'src/private.ts', 'hash-private', 'private');
    } finally {
      first.close();
    }
    const second = openWorktreeDb(secondDir);
    try {
      writeCachedFileEvidence(second, 'doc-path-tokens', 'docs/shared.md', 'hash-b', 'shared-b');
      expect(readCachedFileEvidence(second, 'doc-path-tokens', 'docs/shared.md', 'hash-a')).toBe('shared-a');
      expect(readCachedFileEvidence(second, 'file-definitions', 'src/private.ts', 'hash-private')).toBeNull();
    } finally {
      second.close();
    }
    const third = openWorktreeDb(thirdDir);
    try {
      expect(readCachedFileEvidence(third, 'doc-path-tokens', 'docs/shared.md', 'hash-a')).toBe('shared-a');
      expect(readCachedFileEvidence(third, 'doc-path-tokens', 'docs/shared.md', 'hash-b')).toBe('shared-b');
    } finally {
      third.close();
    }
  });

  it('keeps the shared evidence allowlist limited to content and tool-version dependencies', () => {
    for (const kind of SHARED_FILE_EVIDENCE_KINDS) {
      expect(evidenceProductInvalidation(kind).dependsOn).toEqual(
        expect.arrayContaining(['content-hash', 'tool-version']),
      );
      expect(evidenceProductInvalidation(kind).dependsOn).toHaveLength(2);
    }
  });

  it('evicts the oldest shared evidence rows above the maintenance bound', () => {
    const path = join(tempDir, 'maintenance', 'evidence.db');
    mkdirSync(join(tempDir, 'maintenance'), { recursive: true });
    const evidence = new Database(path);
    evidence.exec(`
      CREATE TABLE file_evidence (
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        version TEXT NOT NULL,
        payload TEXT NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        PRIMARY KEY (kind, relative_path, content_hash, version)
      )
    `);
    const insert = evidence.prepare('INSERT INTO file_evidence VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('doc-path-tokens', 'old', 'a', 'evidence-v1', 'old', 1);
    insert.run('doc-path-tokens', 'middle', 'b', 'evidence-v1', 'middle', 2);
    insert.run('doc-path-tokens', 'new', 'c', 'evidence-v1', 'new', 3);
    evidence.close();

    expect(maintainSharedEvidenceCache(path, { maxRows: 2, budgetBytes: Number.MAX_SAFE_INTEGER })).toEqual({
      deletedRows: 1,
      remainingRows: 2,
    });
    const verified = new Database(path, { readonly: true });
    try {
      expect(verified.prepare('SELECT relative_path FROM file_evidence ORDER BY last_accessed_at').all()).toEqual([
        { relative_path: 'middle' },
        { relative_path: 'new' },
      ]);
    } finally {
      verified.close();
    }

    expect(maintainSharedEvidenceCache(path, { maxRows: 10, budgetBytes: 1 })).toEqual({
      deletedRows: 2,
      remainingRows: 0,
    });
    expect(maintainSharedEvidenceCache(path, { maxRows: 10, budgetBytes: 1 })).toEqual({
      deletedRows: 0,
      remainingRows: 0,
    });
  });

  it('treats invalid file evidence product payloads as misses', () => {
    const db = openDb();
    try {
      writeCachedFileEvidence(db, 'doc-path-tokens', 'docs/product.md', 'hash-corrupt', '{not json');

      expect(PRODUCT_TEST.read(db, 'docs/product.md', 'hash-corrupt')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('profiles typed file evidence product hits and corrupt misses', () => {
    const envSnapshot = Object.fromEntries(PROFILE_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
      (typeof PROFILE_ENV_KEYS)[number],
      string | undefined
    >;
    const profilePath = join(tempDir, 'product-profile.jsonl');
    process.env.SCIP_QUERY_PROFILE = '1';
    process.env.SCIP_QUERY_PROFILE_OUT = profilePath;
    process.env.SCIP_QUERY_PROFILE_COMMAND = 'scip-query test';
    const metaPath = join(tempDir, 'meta.json');
    writeFileSync(metaPath, JSON.stringify({ version: 3, status: 'complete', fingerprint: { fixture: 'profile' } }));

    const db = openDb();
    try {
      PRODUCT_TEST.write(db, 'docs/profiled.md', 'hash-hit', { marker: 'cached' });
      expect(PRODUCT_TEST.read(db, 'docs/profiled.md', 'hash-hit')).toEqual({ marker: 'cached' });
      expect(PRODUCT_TEST.read(db, 'docs/profiled.md', 'hash-hit')).toEqual({ marker: 'cached' });

      writeCachedFileEvidence(db, 'doc-path-tokens', 'docs/profiled.md', 'hash-corrupt', '{not json');
      expect(PRODUCT_TEST.read(db, 'docs/profiled.md', 'hash-corrupt')).toBeNull();

      PROJECT_PRODUCT_TEST.write(db, 'scope:profiled', 'project-profiled', { marker: 'cached' });
      expect(PROJECT_PRODUCT_TEST.read(db, 'scope:profiled', 'project-profiled')).toEqual({ marker: 'cached' });
      expect(PROJECT_PRODUCT_TEST.read(db, 'scope:profiled', 'project-profiled')).toEqual({ marker: 'cached' });
    } finally {
      db.close();
      rmSync(metaPath, { force: true });
      restoreProfileEnv(envSnapshot);
    }

    const events = readFileSync(profilePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'span',
        name: 'evidence-product.file.read',
        kind: 'doc-path-tokens',
        available: true,
        hit: true,
        workOutcome: 'computed',
      }),
      expect.objectContaining({
        type: 'span',
        name: 'evidence-product.file.read',
        kind: 'doc-path-tokens',
        available: true,
        hit: true,
        workOutcome: 'computed',
      }),
      expect.objectContaining({
        type: 'span',
        name: 'evidence-product.file.read',
        kind: 'doc-path-tokens',
        available: true,
        hit: false,
        workOutcome: 'computed',
      }),
      expect.objectContaining({
        type: 'span',
        name: 'evidence-product.project.read',
        kind: 'file-dependency-graph',
        available: true,
        hit: true,
        workOutcome: 'computed',
      }),
      expect.objectContaining({
        type: 'span',
        name: 'evidence-product.project.read',
        kind: 'file-dependency-graph',
        available: true,
        hit: true,
        workOutcome: 'computed',
      }),
    ]);
    expect(events[0]?.workIdentity).toBe(events[1]?.workIdentity);
    expect(events[1]?.workIdentity).not.toBe(events[2]?.workIdentity);
    expect(events[3]?.workIdentity).toBe(events[4]?.workIdentity);
  });

  it('round-trips typed project evidence products', () => {
    const db = openDb();
    try {
      PROJECT_PRODUCT_TEST.write(db, 'scope:all', 'project-a', { marker: 'cached' });

      expect(PROJECT_PRODUCT_TEST.read(db, 'scope:all', 'project-a')).toEqual({ marker: 'cached' });
      expect(readCachedProjectEvidence(db, 'file-dependency-graph', 'scope:all', 'project-a')).not.toBeNull();
      expect(PROJECT_PRODUCT_TEST.read(db, 'scope:all', 'project-b')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('treats invalid project evidence product payloads as misses', () => {
    const db = openDb();
    try {
      writeCachedProjectEvidence(db, 'file-dependency-graph', 'scope:corrupt', 'project-a', '{not json');

      expect(PROJECT_PRODUCT_TEST.read(db, 'scope:corrupt', 'project-a')).toBeNull();
    } finally {
      db.close();
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
      version: SOURCE_FACTS_PAYLOAD_VERSION,
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

  it('rebuilds source facts when the persisted payload version is old', () => {
    const db = openDb();
    const hash = fileContentHash(db, FILE, getSourceText(db, FILE));
    db.close();

    const evidence = new Database(join(tempDir, EVIDENCE_DB_FILENAME));
    const oldPayload = JSON.stringify({
      language: 'typescript',
      callables: [
        {
          name: 'oldMarker',
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
      .run(oldPayload, FILE);
    evidence.close();

    const db2 = openDb();
    try {
      const facts = getSourceFacts(db2, FILE);
      expect(facts!.callables.map((callable) => callable.name)).toContain('greet');
      expect(facts!.callables.map((callable) => callable.name)).not.toContain('oldMarker');
      expect(readCachedFileEvidence(db2, 'source-facts', FILE, hash)).not.toBe(oldPayload);
    } finally {
      db2.close();
    }
  });

  it('persists re-exports and serves them to a fresh connection', () => {
    const db1 = openDb();
    let originalPayload: string | null;
    try {
      expect(getReExports(db1, REEXPORT_FILE)).toEqual([
        expect.objectContaining({
          kind: 'named',
          sourcePath: REEXPORT_TARGET_FILE,
          names: ['targetValue'],
          startLine: 0,
          endLine: 0,
        }),
      ]);
      const hash = fileContentHash(db1, REEXPORT_FILE, getSourceText(db1, REEXPORT_FILE));
      originalPayload = readCachedFileEvidence(db1, 'source-reexports', REEXPORT_FILE, hash);
      expect(originalPayload).not.toBeNull();
    } finally {
      db1.close();
    }

    const planted = JSON.stringify({
      ...JSON.parse(originalPayload!),
      reExports: [{ kind: 'star', sourcePath: 'src/planted.ts', names: [], startLine: 7, endLine: 8 }],
    });
    const evidence = new Database(join(tempDir, EVIDENCE_DB_FILENAME));
    evidence
      .prepare("UPDATE file_evidence SET payload = ? WHERE kind = 'source-reexports' AND relative_path = ?")
      .run(planted, REEXPORT_FILE);
    evidence.close();

    const db2 = openDb();
    try {
      expect(getReExports(db2, REEXPORT_FILE)).toEqual([
        { kind: 'star', sourcePath: 'src/planted.ts', names: [], startLine: 7, endLine: 8 },
      ]);
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
      expect(readCachedSemanticCalleesForFile(db, FILE, 'hash-a', 'digest-a')).toEqual(
        new Map([
          ['sym#greet', payload],
          ['sym#other', otherPayload],
        ]),
      );
      expect(readCachedSemanticCalleesForFile(db, FILE, 'hash-b', 'digest-a')).toEqual(new Map());
      expect(readCachedSemanticCalleesForFile(db, FILE, 'hash-a', 'digest-b')).toEqual(new Map());
      expect(readCachedSemanticCallees(db, FILE, 'sym#greet', 'hash-b', 'digest-a')).toBeNull();
      expect(readCachedSemanticCallees(db, FILE, 'sym#greet', 'hash-a', 'digest-b')).toBeNull();

      // Writing under a new content hash drops the path's stale rows.
      writeCachedSemanticCalleesBatch(db, [
        { relativePath: FILE, symbol: 'sym#other', contentHash: 'hash-b', depsDigest: 'digest-a', payload },
      ]);
      expect(readCachedSemanticCallees(db, FILE, 'sym#greet', 'hash-a', 'digest-a')).toBeNull();
      expect(readCachedSemanticCallees(db, FILE, 'sym#other', 'hash-a', 'digest-a')).toBeNull();
      expect(readCachedSemanticCallees(db, FILE, 'sym#other', 'hash-b', 'digest-a')).toBe(payload);
      expect(readCachedSemanticCalleesForFile(db, FILE, 'hash-a', 'digest-a')).toEqual(new Map());
      expect(readCachedSemanticCalleesForFile(db, FILE, 'hash-b', 'digest-a')).toEqual(
        new Map([['sym#other', payload]]),
      );
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
      expect(readCachedSemanticReferencesForFile(db, FILE, projectFingerprint!)).toEqual(
        new Map([['sym#greet', payload]]),
      );
      expect(readCachedSemanticReferences(db, FILE, 'sym#greet', 'different-project')).toBeNull();
      expect(readCachedSemanticReferencesForFile(db, FILE, 'different-project')).toEqual(new Map());
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
      expect(readCachedSemanticReferencesForFile(dbAfterChange, FILE, projectFingerprint!)).toEqual(new Map());
      expect(readCachedSemanticReferencesForFile(dbAfterChange, FILE, nextProjectFingerprint!)).toEqual(
        new Map([['sym#greet', nextPayload]]),
      );
    } finally {
      dbAfterChange.close();
    }
  });

  it('allows intentional partial-index project fingerprints without sharing complete-index cache keys', () => {
    const partialDir = mkdtempSync(join(tmpdir(), 'scip-query-partial-project-fingerprint-'));
    const partialRoot = join(partialDir, 'project');
    const partialDbPath = join(partialDir, 'index.db');
    writeFixtureFiles(partialRoot, { [FILE]: SOURCE_LINES });
    evidenceFixtureDb(partialDbPath).document(1, 'typescript', FILE).write();

    const fingerprint = {
      version: 1,
      languages: ['typescript', 'rust'],
      files: [{ path: FILE, size: 123, hash: 'source-a' }],
    };
    writeFileSync(
      join(partialDir, 'meta.json'),
      JSON.stringify({
        version: 3,
        status: 'partial',
        fingerprint,
        indexedLanguages: ['rust'],
        skipped: [{ language: 'c', reason: 'fixture skipped language' }],
      }),
    );

    try {
      const partialDb = new ScipDatabase({
        projectRoot: partialRoot,
        dbPath: partialDbPath,
        indexPath: join(partialDir, 'index.scip'),
      });
      const partialFingerprint = projectEvidenceFingerprint(partialDb);
      partialDb.close();
      expect(partialFingerprint).not.toBeNull();

      writeFileSync(
        join(partialDir, 'meta.json'),
        JSON.stringify({
          version: 3,
          status: 'complete',
          fingerprint,
          indexedLanguages: ['rust'],
          skipped: [],
        }),
      );
      const completeDb = new ScipDatabase({
        projectRoot: partialRoot,
        dbPath: partialDbPath,
        indexPath: join(partialDir, 'index.scip'),
      });
      try {
        expect(projectEvidenceFingerprint(completeDb)).not.toBe(partialFingerprint);
      } finally {
        completeDb.close();
      }
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  });

  it('keeps semantic reference rows for other cache namespaces when writing a new namespace', () => {
    const db = openDb();
    try {
      const typeScriptPayload = JSON.stringify([{ file: 'src/consumer.ts', line: 2, column: 4 }]);
      const rustPayload = JSON.stringify([{ file: 'src/consumer.rs', line: 8, column: 2 }]);

      writeCachedSemanticReferencesBatch(db, [
        {
          relativePath: FILE,
          symbol: 'sym#greet',
          projectFingerprint: 'typescript-cache-fingerprint',
          payload: typeScriptPayload,
        },
      ]);
      writeCachedSemanticReferencesBatch(db, [
        {
          relativePath: 'src/lib.rs',
          symbol: 'rust#run',
          projectFingerprint: 'rust-cache-fingerprint',
          payload: rustPayload,
        },
      ]);

      expect(readCachedSemanticReferences(db, FILE, 'sym#greet', 'typescript-cache-fingerprint')).toBe(
        typeScriptPayload,
      );
      expect(readCachedSemanticReferences(db, 'src/lib.rs', 'rust#run', 'rust-cache-fingerprint')).toBe(rustPayload);
    } finally {
      db.close();
    }
  });

  it('round-trips the finding-outcome ledger and caps rows per check by recency', () => {
    const db = openDb();
    try {
      expect(readFindingOutcomeLedger(db)).toEqual([]);

      expect(
        applyFindingOutcomeLedgerTransition(
          db,
          { observationId: 'round-trip-1', fingerprint: 'fingerprint-1', observedAt: 2 },
          () => [
            { check: 'echo', findingId: 'A', firstSeen: 1, lastSeen: 1, timesShown: 1, outcome: 'still-open' },
            { check: 'echo', findingId: 'B', firstSeen: 2, lastSeen: 2, timesShown: 1, outcome: 'resolved' },
          ],
        ).status,
      ).toBe('applied');
      const rows = readFindingOutcomeLedger(db).sort((left, right) => left.findingId.localeCompare(right.findingId));
      expect(rows).toEqual([
        { check: 'echo', findingId: 'A', firstSeen: 1, lastSeen: 1, timesShown: 1, outcome: 'still-open' },
        { check: 'echo', findingId: 'B', firstSeen: 2, lastSeen: 2, timesShown: 1, outcome: 'resolved' },
      ]);

      applyFindingOutcomeLedgerTransition(
        db,
        { observationId: 'round-trip-2', fingerprint: 'fingerprint-2', observedAt: 3 },
        (previous) =>
          previous.map((row) =>
            row.findingId === 'A'
              ? { ...row, lastSeen: 3, timesShown: row.timesShown + 1, outcome: 'suppressed' }
              : row,
          ),
      );
      expect(readFindingOutcomeLedger(db).find((row) => row.findingId === 'A')).toMatchObject({
        lastSeen: 3,
        timesShown: 2,
        outcome: 'suppressed',
      });

      // Recency cap: only the most-recently-seen N rows survive per check.
      const overflow = Array.from({ length: FINDING_OUTCOME_LEDGER_CAP_PER_CHECK + 10 }, (_, index) => ({
        check: 'doc-reference',
        findingId: `SQ${index}`,
        firstSeen: index,
        lastSeen: index,
        timesShown: 1,
        outcome: 'still-open',
      }));
      applyFindingOutcomeLedgerTransition(
        db,
        { observationId: 'round-trip-overflow', fingerprint: 'fingerprint-overflow', observedAt: 10_000 },
        (previous) => [...previous, ...overflow],
      );
      const capped = readFindingOutcomeLedger(db).filter((row) => row.check === 'doc-reference');
      expect(capped).toHaveLength(FINDING_OUTCOME_LEDGER_CAP_PER_CHECK);
      expect(capped.map((row) => row.findingId)).not.toContain('SQ0'); // oldest evicted
      expect(capped.map((row) => row.findingId)).toContain(`SQ${FINDING_OUTCOME_LEDGER_CAP_PER_CHECK + 9}`);
    } finally {
      db.close();
    }
  });

  it('does not consume an observation id when the immediate transaction times out on a writer lock', () => {
    const db = openDb();
    const blocker = new Database(join(tempDir, EVIDENCE_DB_FILENAME));
    try {
      readFindingOutcomeLedger(db); // Open this ScipDatabase's independent evidence connection first.
      blocker.pragma('journal_mode = WAL');
      blocker.exec('BEGIN IMMEDIATE');

      const blocked = applyFindingOutcomeLedgerTransition(
        db,
        { observationId: 'busy-retry', fingerprint: 'busy-fingerprint', observedAt: 11_000 },
        (previous) => [
          ...previous,
          {
            check: 'busy-check',
            findingId: 'A',
            firstSeen: 11_000,
            lastSeen: 11_000,
            timesShown: 1,
            outcome: 'still-open',
          },
        ],
        { busyTimeoutMs: 5 },
      );
      expect(blocked.status).toBe('busy');
      expect(blocked.current.some((row) => row.check === 'busy-check')).toBe(false);

      blocker.exec('ROLLBACK');
      const retried = applyFindingOutcomeLedgerTransition(
        db,
        { observationId: 'busy-retry', fingerprint: 'busy-fingerprint', observedAt: 11_000 },
        (previous) => [
          ...previous,
          {
            check: 'busy-check',
            findingId: 'A',
            firstSeen: 11_000,
            lastSeen: 11_000,
            timesShown: 1,
            outcome: 'still-open',
          },
        ],
      );
      expect(retried.status).toBe('applied');
    } finally {
      if (blocker.inTransaction) blocker.exec('ROLLBACK');
      blocker.close();
      db.close();
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
