/**
 * Persistent evidence cache — file-content-addressed analysis results that
 * survive both process exit and reindex.
 *
 * index.db is opened readonly and replaced wholesale on reindex, so derived
 * evidence that is expensive to recompute (tree-sitter source facts, ts-morph
 * callee resolution) lives in a sibling `evidence.db`, keyed by sha256 of the
 * producing file's content (plus a direct-deps digest for cross-file-sensitive
 * evidence) and a stable payload version. A key only matches while the bytes
 * that produced the value are unchanged, so stale reads are structurally
 * impossible at the single-file level.
 *
 * The cache must never fail a query: a structural SQLite error (read-only
 * filesystem, corruption, incompatible schema) disables it for the rest of
 * the process and every operation degrades to a miss/no-op. A transient
 * writer-lock timeout skips only the affected best-effort metric update.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { decodeReindexMetadata } from '../domain/reindex-metadata.js';
import type { ScipDatabase } from './db.js';
import { createPerDbCache } from './per-db-cache.js';

export const EVIDENCE_DB_FILENAME = 'evidence.db';

/** Per-file payload kinds keyed by content hash; payloads may add stricter guards. */
// scip-query: ignore-stale - cache kind names are the storage contract shared by evidence products.
export const FILE_EVIDENCE_KINDS = [
  'source-facts',
  'file-definitions',
  'definition-exclusions',
  'doc-path-tokens',
  'doc-path-evidence',
  'source-imports',
  'source-reexports',
  'source-fingerprints',
  'consumer-file-usage',
  'react-component-behavior-profiles',
  'git-file-adds',
  'typescript-reference-fragments',
  'typescript-import-usage',
  'typescript-signatures',
  'runtime-boundary-http-roles',
  'runtime-boundary-source-hashes',
  'runtime-boundary-direct-extraction',
] as const;

export type FileEvidenceKind = (typeof FILE_EVIDENCE_KINDS)[number];

export const PROJECT_EVIDENCE_KINDS = [
  'file-dependency-graph',
  'semantic-import-usage',
  'semantic-signatures',
  'health-semantic-prewarm',
] as const;

export type ProjectEvidenceKind = (typeof PROJECT_EVIDENCE_KINDS)[number];

interface EvidenceConnection {
  evidence: Database.Database;
  shared: SharedEvidenceConnection | null;
  readFileEvidence: Database.Statement;
  readLegacyFileEvidence: Database.Statement;
  existsFileEvidence: Database.Statement;
  existsLegacyFileEvidence: Database.Statement;
  writeFileEvidence: Database.Statement;
  rekeyFileEvidence: Database.Statement;
  readProjectEvidence: Database.Statement;
  readLegacyProjectEvidence: Database.Statement;
  writeProjectEvidence: Database.Statement;
  rekeyProjectEvidenceKind: Database.Statement;
  readCallees: Database.Statement;
  readLegacyCallees: Database.Statement;
  readCalleesForFile: Database.Statement;
  readLegacyCalleesForFile: Database.Statement;
  writeCallees: Database.Statement;
  dropStaleCallees: Database.Statement;
  readReferences: Database.Statement;
  readLegacyReferences: Database.Statement;
  readReferencesForFile: Database.Statement;
  readLegacyReferencesForFile: Database.Statement;
  writeReferences: Database.Statement;
  dropStaleReferences: Database.Statement;
}

interface SharedEvidenceConnection {
  evidence: Database.Database;
  readFileEvidence: Database.Statement;
  existsFileEvidence: Database.Statement;
  writeFileEvidence: Database.Statement;
  touchFileEvidence: Database.Statement;
}

export const SHARED_FILE_EVIDENCE_KINDS = [
  'source-facts',
  'definition-exclusions',
  'doc-path-tokens',
  'react-component-behavior-profiles',
] as const satisfies readonly FileEvidenceKind[];

const SHARED_FILE_EVIDENCE_KIND_SET = new Set<FileEvidenceKind>(SHARED_FILE_EVIDENCE_KINDS);
export const DEFAULT_SHARED_EVIDENCE_MAX_ROWS = 250_000;
export const DEFAULT_SHARED_EVIDENCE_BUDGET_BYTES = 512 * 1024 * 1024;
export const SHARED_EVIDENCE_ACCESS_TOUCH_INTERVAL_MS = 60_000;

// scip-query: ignore-stale — reviewed S1 owned contract; this is the persisted semantic-callee cache row.
export interface SemanticCalleeCacheEntry {
  relativePath: string;
  symbol: string;
  contentHash: string;
  depsDigest: string;
  payload: string;
}

// scip-query: ignore-stale - semantic reference batches need a named cache row shape across storage and semantic code.
export interface SemanticReferenceCacheEntry {
  relativePath: string;
  symbol: string;
  projectFingerprint: string;
  payload: string;
}

export interface FileEvidenceCacheEntry {
  kind: FileEvidenceKind;
  relativePath: string;
  contentHash: string;
  payload: string;
}

export interface FileEvidenceCacheRekeyEntry {
  kind: FileEvidenceKind;
  relativePath: string;
  previousContentHash: string;
  nextContentHash: string;
}

// Connection handle, not evidence: lives for the ScipDatabase's lifetime and
// holds no per-file state, so it registers with no cache-clear groups.
// `null` = permanently disabled for this process.
const CONNECTIONS = new WeakMap<ScipDatabase, EvidenceConnection | null>();

const CONTENT_HASH_CACHE = createPerDbCache<string, string>('evidence-content-hash', {
  clearGroups: ['whole-project', 'source-file'],
});

const PROJECT_FINGERPRINT_CACHE = createPerDbCache<string, string | null>('evidence-project-fingerprint', {
  clearGroups: ['whole-project'],
});

const VERSION = 'evidence-v1';
const LEGACY_VERSION_PREDICATE = "version NOT LIKE 'evidence-%'";

// scip-query: ignore-wrapper — canonical hash helper; the cache key contract
// (one algorithm, hex form) lives here instead of being repeated per caller.
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Per-file content hash, memoized per (db, path) like the source-text cache. */
export function fileContentHash(db: ScipDatabase, relativePath: string, content: string): string {
  return CONTENT_HASH_CACHE.get(db, relativePath, () => sha256Hex(content));
}

export function projectEvidenceFingerprint(db: ScipDatabase): string | null {
  return PROJECT_FINGERPRINT_CACHE.get(db, 'current', () => {
    try {
      if (!db.generation.metadataRaw) return null;
      const decoded = decodeReindexMetadata(db.generation.metadataRaw);
      if ((decoded.kind !== 'legacy' && decoded.kind !== 'supported') || !decoded.capabilities.usableForEvidenceCache) {
        return null;
      }
      const metadata = decoded.metadata;
      const indexedLanguages = [...(metadata.indexedLanguages ?? [])].sort();
      return sha256Hex(
        JSON.stringify({
          fingerprint: metadata.fingerprint,
          indexedLanguages,
          status: metadata.status,
        }),
      );
    } catch (error) {
      debugLog('project fingerprint unavailable', error);
      return null;
    }
  });
}

function debugLog(message: string, error: unknown): void {
  if (process.env['SCIP_QUERY_DEBUG']) {
    console.error(`evidence-cache: ${message}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function connectionFor(db: ScipDatabase): EvidenceConnection | null {
  if (CONNECTIONS.has(db)) return CONNECTIONS.get(db) ?? null;
  let connection: EvidenceConnection | null = null;
  try {
    const evidence = new Database(db.config.evidenceDbPath ?? join(dirname(db.config.dbPath), EVIDENCE_DB_FILENAME));
    evidence.pragma('journal_mode = WAL');
    evidence.pragma('busy_timeout = 5000');
    // Rebuildable cache: skip the per-commit WAL fsync. A power-loss losing
    // recent rows just means recomputing them; integrity is still guaranteed.
    evidence.pragma('synchronous = NORMAL');
    evidence.exec(`
      CREATE TABLE IF NOT EXISTS file_evidence (
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        version TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (kind, relative_path)
      );
      CREATE TABLE IF NOT EXISTS project_evidence (
        kind TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        project_fingerprint TEXT NOT NULL,
        version TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (kind, cache_key)
      );
      CREATE TABLE IF NOT EXISTS semantic_callees (
        relative_path TEXT NOT NULL,
        symbol TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        deps_digest TEXT NOT NULL,
        version TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (relative_path, symbol)
      );
      CREATE TABLE IF NOT EXISTS semantic_references (
        relative_path TEXT NOT NULL,
        symbol TEXT NOT NULL,
        project_fingerprint TEXT NOT NULL,
        version TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (relative_path, symbol)
      );
    `);
    connection = {
      evidence,
      shared: openSharedEvidenceConnection(db.config.sharedEvidenceDbPath),
      readFileEvidence: evidence.prepare(
        'SELECT payload FROM file_evidence WHERE kind = ? AND relative_path = ? AND content_hash = ? AND version = ?',
      ),
      readLegacyFileEvidence: evidence.prepare(
        `SELECT payload FROM file_evidence
         WHERE kind = ? AND relative_path = ? AND content_hash = ? AND ${LEGACY_VERSION_PREDICATE}
         ORDER BY version DESC
         LIMIT 1`,
      ),
      existsFileEvidence: evidence.prepare(
        'SELECT 1 AS present FROM file_evidence WHERE kind = ? AND relative_path = ? AND content_hash = ? AND version = ?',
      ),
      existsLegacyFileEvidence: evidence.prepare(
        `SELECT 1 AS present FROM file_evidence
         WHERE kind = ? AND relative_path = ? AND content_hash = ? AND ${LEGACY_VERSION_PREDICATE}
         LIMIT 1`,
      ),
      writeFileEvidence: evidence.prepare(
        'INSERT OR REPLACE INTO file_evidence (kind, relative_path, content_hash, version, payload) VALUES (?, ?, ?, ?, ?)',
      ),
      rekeyFileEvidence: evidence.prepare(
        'UPDATE file_evidence SET content_hash = ?, version = ? WHERE kind = ? AND relative_path = ? AND content_hash = ?',
      ),
      readProjectEvidence: evidence.prepare(
        'SELECT payload FROM project_evidence WHERE kind = ? AND cache_key = ? AND project_fingerprint = ? AND version = ?',
      ),
      readLegacyProjectEvidence: evidence.prepare(
        `SELECT payload FROM project_evidence
         WHERE kind = ? AND cache_key = ? AND project_fingerprint = ? AND ${LEGACY_VERSION_PREDICATE}
         ORDER BY version DESC
         LIMIT 1`,
      ),
      writeProjectEvidence: evidence.prepare(
        'INSERT OR REPLACE INTO project_evidence (kind, cache_key, project_fingerprint, version, payload) VALUES (?, ?, ?, ?, ?)',
      ),
      rekeyProjectEvidenceKind: evidence.prepare(
        'UPDATE project_evidence SET project_fingerprint = ?, version = ? WHERE kind = ? AND project_fingerprint = ?',
      ),
      readCallees: evidence.prepare(
        `SELECT payload FROM semantic_callees
         WHERE relative_path = ? AND symbol = ? AND content_hash = ? AND deps_digest = ? AND version = ?`,
      ),
      readLegacyCallees: evidence.prepare(
        `SELECT payload FROM semantic_callees
         WHERE relative_path = ? AND symbol = ? AND content_hash = ? AND deps_digest = ? AND ${LEGACY_VERSION_PREDICATE}
         ORDER BY version DESC
         LIMIT 1`,
      ),
      readCalleesForFile: evidence.prepare(
        `SELECT symbol, payload FROM semantic_callees
         WHERE relative_path = ? AND content_hash = ? AND deps_digest = ? AND version = ?`,
      ),
      readLegacyCalleesForFile: evidence.prepare(
        `SELECT symbol, payload FROM semantic_callees
         WHERE relative_path = ? AND content_hash = ? AND deps_digest = ? AND ${LEGACY_VERSION_PREDICATE}
         ORDER BY symbol, version DESC`,
      ),
      writeCallees: evidence.prepare(
        `INSERT OR REPLACE INTO semantic_callees
           (relative_path, symbol, content_hash, deps_digest, version, payload) VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      dropStaleCallees: evidence.prepare('DELETE FROM semantic_callees WHERE relative_path = ? AND content_hash != ?'),
      readReferences: evidence.prepare(
        `SELECT payload FROM semantic_references
         WHERE relative_path = ? AND symbol = ? AND project_fingerprint = ? AND version = ?`,
      ),
      readLegacyReferences: evidence.prepare(
        `SELECT payload FROM semantic_references
         WHERE relative_path = ? AND symbol = ? AND project_fingerprint = ? AND ${LEGACY_VERSION_PREDICATE}
         ORDER BY version DESC
         LIMIT 1`,
      ),
      readReferencesForFile: evidence.prepare(
        `SELECT symbol, payload FROM semantic_references
         WHERE relative_path = ? AND project_fingerprint = ? AND version = ?`,
      ),
      readLegacyReferencesForFile: evidence.prepare(
        `SELECT symbol, payload FROM semantic_references
         WHERE relative_path = ? AND project_fingerprint = ? AND ${LEGACY_VERSION_PREDICATE}
         ORDER BY symbol, version DESC`,
      ),
      writeReferences: evidence.prepare(
        `INSERT OR REPLACE INTO semantic_references
           (relative_path, symbol, project_fingerprint, version, payload) VALUES (?, ?, ?, ?, ?)`,
      ),
      dropStaleReferences: evidence.prepare(
        'DELETE FROM semantic_references WHERE relative_path = ? AND project_fingerprint != ?',
      ),
    };
  } catch (error) {
    debugLog('disabled (open failed)', error);
  }
  CONNECTIONS.set(db, connection);
  return connection;
}

function disable(db: ScipDatabase, context: string, error: unknown): void {
  debugLog(`disabled (${context})`, error);
  CONNECTIONS.set(db, null);
}

function openSharedEvidenceConnection(path: string | undefined): SharedEvidenceConnection | null {
  if (!path) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const evidence = new Database(path);
    evidence.pragma('journal_mode = WAL');
    evidence.pragma('busy_timeout = 250');
    evidence.pragma('synchronous = NORMAL');
    evidence.exec(`
      CREATE TABLE IF NOT EXISTS file_evidence (
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        version TEXT NOT NULL,
        payload TEXT NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        PRIMARY KEY (kind, relative_path, content_hash, version)
      );
      CREATE INDEX IF NOT EXISTS idx_file_evidence_lru
        ON file_evidence(last_accessed_at, kind, relative_path, content_hash, version);
    `);
    return {
      evidence,
      readFileEvidence: evidence.prepare(
        'SELECT payload FROM file_evidence WHERE kind = ? AND relative_path = ? AND content_hash = ? AND version = ?',
      ),
      existsFileEvidence: evidence.prepare(
        'SELECT 1 AS present FROM file_evidence WHERE kind = ? AND relative_path = ? AND content_hash = ? AND version = ?',
      ),
      writeFileEvidence: evidence.prepare(
        `INSERT INTO file_evidence (kind, relative_path, content_hash, version, payload, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, relative_path, content_hash, version)
         DO UPDATE SET payload = excluded.payload, last_accessed_at = excluded.last_accessed_at`,
      ),
      touchFileEvidence: evidence.prepare(
        `UPDATE file_evidence
         SET last_accessed_at = ?
         WHERE kind = ? AND relative_path = ? AND content_hash = ? AND version = ?
           AND last_accessed_at < ?`,
      ),
    };
  } catch (error) {
    debugLog('shared cache disabled (open failed)', error);
    return null;
  }
}

function disableShared(connection: EvidenceConnection, context: string, error: unknown): void {
  debugLog(`shared cache disabled (${context})`, error);
  try {
    connection.shared?.evidence.close();
  } catch {
    // The connection is already unusable.
  }
  connection.shared = null;
}

export function maintainSharedEvidenceCache(
  path: string,
  opts: { maxRows?: number; budgetBytes?: number } = {},
): { deletedRows: number; remainingRows: number } | null {
  if (!existsSync(path)) return null;
  let evidence: Database.Database | undefined;
  try {
    evidence = new Database(path);
    evidence.pragma('busy_timeout = 50');
    evidence.exec(
      `CREATE INDEX IF NOT EXISTS idx_file_evidence_lru
       ON file_evidence(last_accessed_at, kind, relative_path, content_hash, version)`,
    );
    evidence.pragma('wal_checkpoint(TRUNCATE)');
    const count = (evidence.prepare('SELECT COUNT(*) AS count FROM file_evidence').get() as { count: number }).count;
    const maxRows = opts.maxRows ?? DEFAULT_SHARED_EVIDENCE_MAX_ROWS;
    const budgetBytes = opts.budgetBytes ?? DEFAULT_SHARED_EVIDENCE_BUDGET_BYTES;
    const pageSize = Number(evidence.pragma('page_size', { simple: true }));
    const pageCount = Number(evidence.pragma('page_count', { simple: true }));
    const freePages = Number(evidence.pragma('freelist_count', { simple: true }));
    const liveBytes = Math.max(0, pageCount - freePages) * pageSize;
    const rowsForBudget =
      count > 0 && liveBytes > budgetBytes
        ? Math.min(count, Math.ceil((liveBytes - budgetBytes) / Math.max(1, liveBytes / count)))
        : 0;
    const deletedRows = Math.max(count - maxRows, rowsForBudget);
    if (deletedRows > 0) {
      evidence
        .prepare(
          `DELETE FROM file_evidence WHERE rowid IN (
             SELECT rowid FROM file_evidence ORDER BY last_accessed_at ASC, rowid ASC LIMIT ?
           )`,
        )
        .run(deletedRows);
      evidence.pragma('wal_checkpoint(TRUNCATE)');
    }
    return { deletedRows, remainingRows: count - deletedRows };
  } catch (error) {
    debugLog('shared cache maintenance skipped', error);
    return null;
  } finally {
    try {
      evidence?.close();
    } catch {
      // Best-effort rebuildable cache maintenance.
    }
  }
}

// scip-query: ignore-wrapper — public storage boundary; callers get a
// disable-on-error read, never a raw statement.
export function readCachedFileEvidence(
  db: ScipDatabase,
  kind: FileEvidenceKind,
  relativePath: string,
  contentHash: string,
): string | null {
  const connection = connectionFor(db);
  if (!connection) return null;
  try {
    const row = (connection.readFileEvidence.get(kind, relativePath, contentHash, VERSION) ??
      connection.readLegacyFileEvidence.get(kind, relativePath, contentHash)) as { payload: string } | undefined;
    if (row?.payload !== undefined) return row.payload;
    if (!SHARED_FILE_EVIDENCE_KIND_SET.has(kind) || !connection.shared) return null;
    try {
      const shared = connection.shared.readFileEvidence.get(kind, relativePath, contentHash, VERSION) as
        | { payload: string }
        | undefined;
      if (shared?.payload !== undefined) {
        touchSharedFileEvidence(connection.shared, kind, relativePath, contentHash);
      }
      return shared?.payload ?? null;
    } catch (error) {
      disableShared(connection, 'file_evidence read', error);
      return null;
    }
  } catch (error) {
    disable(db, 'file_evidence read', error);
    return null;
  }
}

// scip-query: ignore-wrapper — public storage boundary; callers get a
// disable-on-error existence check that never transfers the payload.
export function hasCachedFileEvidence(
  db: ScipDatabase,
  kind: FileEvidenceKind,
  relativePath: string,
  contentHash: string,
): boolean {
  const connection = connectionFor(db);
  if (!connection) return false;
  try {
    const row = (connection.existsFileEvidence.get(kind, relativePath, contentHash, VERSION) ??
      connection.existsLegacyFileEvidence.get(kind, relativePath, contentHash)) as { present: number } | undefined;
    if (row?.present !== undefined) return true;
    if (!SHARED_FILE_EVIDENCE_KIND_SET.has(kind) || !connection.shared) return false;
    try {
      const shared = connection.shared.existsFileEvidence.get(kind, relativePath, contentHash, VERSION) as
        | { present: number }
        | undefined;
      if (shared?.present === undefined) return false;
      touchSharedFileEvidence(connection.shared, kind, relativePath, contentHash);
      return true;
    } catch (error) {
      disableShared(connection, 'file_evidence exists', error);
      return false;
    }
  } catch (error) {
    disable(db, 'file_evidence exists', error);
    return false;
  }
}

function touchSharedFileEvidence(
  shared: SharedEvidenceConnection,
  kind: FileEvidenceKind,
  relativePath: string,
  contentHash: string,
): void {
  const now = Date.now();
  try {
    shared.touchFileEvidence.run(
      now,
      kind,
      relativePath,
      contentHash,
      VERSION,
      now - SHARED_EVIDENCE_ACCESS_TOUCH_INTERVAL_MS,
    );
  } catch (error) {
    // Recency is eviction metadata. A failed best-effort touch must not turn
    // valid content-addressed evidence into a cache miss.
    debugLog('shared file_evidence recency touch skipped', error);
  }
}

// scip-query: ignore-wrapper — public storage boundary; callers get a
// disable-on-error write, never a raw statement.
export function writeCachedFileEvidence(
  db: ScipDatabase,
  kind: FileEvidenceKind,
  relativePath: string,
  contentHash: string,
  payload: string,
): void {
  const connection = connectionFor(db);
  if (!connection) return;
  try {
    connection.writeFileEvidence.run(kind, relativePath, contentHash, VERSION, payload);
    if (SHARED_FILE_EVIDENCE_KIND_SET.has(kind) && connection.shared) {
      try {
        connection.shared.writeFileEvidence.run(kind, relativePath, contentHash, VERSION, payload, Date.now());
      } catch (error) {
        disableShared(connection, 'file_evidence write', error);
      }
    }
  } catch (error) {
    disable(db, 'file_evidence write', error);
  }
}

// scip-query: ignore-wrapper — transactional batch storage boundary; callers
// receive the same disable-on-error cache contract as the single-entry writer.
export function writeCachedFileEvidenceBatch(db: ScipDatabase, entries: readonly FileEvidenceCacheEntry[]): void {
  if (entries.length === 0) return;
  const connection = connectionFor(db);
  if (!connection) return;
  try {
    connection.evidence.transaction(() => {
      for (const entry of entries) {
        connection.writeFileEvidence.run(entry.kind, entry.relativePath, entry.contentHash, VERSION, entry.payload);
      }
    })();
    // A batch is the natural durability point for a bulk producer, and
    // leaving its frames in the WAL makes on-disk cache size depend on when
    // the next connection happens to checkpoint; truncating here keeps the
    // evidence footprint deterministic for the cache-lifecycle accounting.
    try {
      connection.evidence.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Checkpointing is best-effort; a busy reader just defers truncation.
    }
    const shareable = entries.filter((entry) => SHARED_FILE_EVIDENCE_KIND_SET.has(entry.kind));
    if (shareable.length > 0 && connection.shared) {
      try {
        connection.shared.evidence.transaction(() => {
          for (const entry of shareable) {
            connection.shared!.writeFileEvidence.run(
              entry.kind,
              entry.relativePath,
              entry.contentHash,
              VERSION,
              entry.payload,
              Date.now(),
            );
          }
        })();
      } catch (error) {
        disableShared(connection, 'file_evidence batch write', error);
      }
    }
  } catch (error) {
    disable(db, 'file_evidence batch write', error);
  }
}

/**
 * Carries forward derived payloads whose producer has already proved that the
 * underlying file is unaffected. The payload stays inside SQLite; only its
 * validated identity changes, so large semantic products are not parsed and
 * serialized again in JavaScript.
 */
export function rekeyCachedFileEvidenceBatch(
  db: ScipDatabase,
  entries: readonly FileEvidenceCacheRekeyEntry[],
): number {
  if (entries.length === 0) return 0;
  const connection = connectionFor(db);
  if (!connection) return 0;
  try {
    return connection.evidence.transaction(() => {
      let changed = 0;
      for (const entry of entries) {
        changed += connection.rekeyFileEvidence.run(
          entry.nextContentHash,
          VERSION,
          entry.kind,
          entry.relativePath,
          entry.previousContentHash,
        ).changes;
      }
      return changed;
    })();
  } catch (error) {
    disable(db, 'file_evidence batch rekey', error);
    return 0;
  }
}

// scip-query: ignore-wrapper — public project-storage boundary; callers get a
// disable-on-error read, never a raw statement.
export function readCachedProjectEvidence(
  db: ScipDatabase,
  kind: ProjectEvidenceKind,
  cacheKey: string,
  projectFingerprint: string,
): string | null {
  const connection = connectionFor(db);
  if (!connection) return null;
  try {
    const row = (connection.readProjectEvidence.get(kind, cacheKey, projectFingerprint, VERSION) ??
      connection.readLegacyProjectEvidence.get(kind, cacheKey, projectFingerprint)) as { payload: string } | undefined;
    return row?.payload ?? null;
  } catch (error) {
    disable(db, 'project_evidence read', error);
    return null;
  }
}

// scip-query: ignore-wrapper — public project-storage boundary; callers get a
// disable-on-error write, never a raw statement.
export function writeCachedProjectEvidence(
  db: ScipDatabase,
  kind: ProjectEvidenceKind,
  cacheKey: string,
  projectFingerprint: string,
  payload: string,
): void {
  const connection = connectionFor(db);
  if (!connection) return;
  try {
    connection.writeProjectEvidence.run(kind, cacheKey, projectFingerprint, VERSION, payload);
  } catch (error) {
    disable(db, 'project_evidence write', error);
  }
}

/**
 * Carries every project-scoped payload of one kind to a new project identity
 * after its owner has proved that the underlying relationship product did not
 * change. Payloads stay inside SQLite instead of being parsed and serialized.
 */
export function rekeyCachedProjectEvidenceKind(
  db: ScipDatabase,
  kind: ProjectEvidenceKind,
  previousProjectFingerprint: string,
  nextProjectFingerprint: string,
): number {
  if (previousProjectFingerprint === nextProjectFingerprint) return 0;
  const connection = connectionFor(db);
  if (!connection) return 0;
  try {
    return connection.rekeyProjectEvidenceKind.run(nextProjectFingerprint, VERSION, kind, previousProjectFingerprint)
      .changes;
  } catch (error) {
    disable(db, 'project_evidence kind rekey', error);
    return 0;
  }
}

export function readCachedSemanticCallees(
  db: ScipDatabase,
  relativePath: string,
  symbol: string,
  contentHash: string,
  depsDigest: string,
): string | null {
  const connection = connectionFor(db);
  if (!connection) return null;
  try {
    const row = (connection.readCallees.get(relativePath, symbol, contentHash, depsDigest, VERSION) ??
      connection.readLegacyCallees.get(relativePath, symbol, contentHash, depsDigest)) as
      | { payload: string }
      | undefined;
    return row?.payload ?? null;
  } catch (error) {
    disable(db, 'semantic_callees read', error);
    return null;
  }
}

export function readCachedSemanticCalleesForFile(
  db: ScipDatabase,
  relativePath: string,
  contentHash: string,
  depsDigest: string,
): Map<string, string> {
  const connection = connectionFor(db);
  if (!connection) return new Map();
  try {
    const rows = connection.readCalleesForFile.all(relativePath, contentHash, depsDigest, VERSION) as Array<{
      symbol: string;
      payload: string;
    }>;
    const legacyRows = connection.readLegacyCalleesForFile.all(relativePath, contentHash, depsDigest) as Array<{
      symbol: string;
      payload: string;
    }>;
    return rowsBySymbol([...legacyRows, ...rows]);
  } catch (error) {
    disable(db, 'semantic_callees bulk read', error);
    return new Map();
  }
}

export function readCachedSemanticReferences(
  db: ScipDatabase,
  relativePath: string,
  symbol: string,
  projectFingerprint: string,
): string | null {
  const connection = connectionFor(db);
  if (!connection) return null;
  try {
    const row = (connection.readReferences.get(relativePath, symbol, projectFingerprint, VERSION) ??
      connection.readLegacyReferences.get(relativePath, symbol, projectFingerprint)) as { payload: string } | undefined;
    return row?.payload ?? null;
  } catch (error) {
    disable(db, 'semantic_references read', error);
    return null;
  }
}

export function readCachedSemanticReferencesForFile(
  db: ScipDatabase,
  relativePath: string,
  projectFingerprint: string,
): Map<string, string> {
  const connection = connectionFor(db);
  if (!connection) return new Map();
  try {
    const rows = connection.readReferencesForFile.all(relativePath, projectFingerprint, VERSION) as Array<{
      symbol: string;
      payload: string;
    }>;
    const legacyRows = connection.readLegacyReferencesForFile.all(relativePath, projectFingerprint) as Array<{
      symbol: string;
      payload: string;
    }>;
    return rowsBySymbol([...legacyRows, ...rows]);
  } catch (error) {
    disable(db, 'semantic_references bulk read', error);
    return new Map();
  }
}

function rowsBySymbol(rows: ReadonlyArray<{ symbol: string; payload: string }>): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) result.set(row.symbol, row.payload);
  return result;
}

/**
 * Batched write — one transaction for the whole set. A cold run on a large
 * repo writes one row per production callable; per-row autocommit would pay
 * a WAL commit each, turning a seconds-long pass into minutes.
 */
export function writeCachedSemanticCalleesBatch(db: ScipDatabase, entries: readonly SemanticCalleeCacheEntry[]): void {
  if (entries.length === 0) return;
  const connection = connectionFor(db);
  if (!connection) return;
  try {
    connection.evidence.transaction(() => {
      const staleDeleteKeys = new Set<string>();
      for (const entry of entries) {
        // Rows from previous contents of this file can never match again —
        // drop them so the table tracks the live symbol set, not its history.
        const staleDeleteKey = `${entry.relativePath}\0${entry.contentHash}`;
        if (!staleDeleteKeys.has(staleDeleteKey)) {
          staleDeleteKeys.add(staleDeleteKey);
          connection.dropStaleCallees.run(entry.relativePath, entry.contentHash);
        }
        connection.writeCallees.run(
          entry.relativePath,
          entry.symbol,
          entry.contentHash,
          entry.depsDigest,
          VERSION,
          entry.payload,
        );
      }
    })();
  } catch (error) {
    disable(db, 'semantic_callees write', error);
  }
}

export function writeCachedSemanticReferencesBatch(
  db: ScipDatabase,
  entries: readonly SemanticReferenceCacheEntry[],
): void {
  if (entries.length === 0) return;
  const connection = connectionFor(db);
  if (!connection) return;
  try {
    connection.evidence.transaction(() => {
      const staleDeleteKeys = new Set<string>();
      for (const entry of entries) {
        const staleDeleteKey = `${entry.relativePath}\0${entry.projectFingerprint}`;
        if (!staleDeleteKeys.has(staleDeleteKey)) {
          staleDeleteKeys.add(staleDeleteKey);
          connection.dropStaleReferences.run(entry.relativePath, entry.projectFingerprint);
        }
        connection.writeReferences.run(
          entry.relativePath,
          entry.symbol,
          entry.projectFingerprint,
          VERSION,
          entry.payload,
        );
      }
    })();
  } catch (error) {
    disable(db, 'semantic_references write', error);
  }
}
