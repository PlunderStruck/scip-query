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
 * The cache must never fail a query: the first SQLite error (read-only
 * filesystem, contention, corruption) disables it for the rest of the
 * process and every operation degrades to a miss/no-op.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { ScipDatabase } from './db.js';
import { createPerDbCache } from './per-db-cache.js';

export const EVIDENCE_DB_FILENAME = 'evidence.db';

/** Per-file payload kinds. Each is a pure function of one file's content. */
export type FileEvidenceKind =
  | 'source-facts'
  | 'definition-exclusions'
  | 'doc-path-tokens'
  | 'doc-path-evidence'
  | 'source-imports'
  | 'source-reexports'
  | 'source-fingerprints'
  | 'consumer-file-usage'
  | 'react-component-behavior-profiles';

interface EvidenceConnection {
  evidence: Database.Database;
  readFileEvidence: Database.Statement;
  readLegacyFileEvidence: Database.Statement;
  writeFileEvidence: Database.Statement;
  readCallees: Database.Statement;
  readLegacyCallees: Database.Statement;
  writeCallees: Database.Statement;
  dropStaleCallees: Database.Statement;
  readReferences: Database.Statement;
  readLegacyReferences: Database.Statement;
  writeReferences: Database.Statement;
  dropStaleReferences: Database.Statement;
}

export interface SemanticCalleeCacheEntry {
  relativePath: string;
  symbol: string;
  contentHash: string;
  depsDigest: string;
  payload: string;
}

export interface SemanticReferenceCacheEntry {
  relativePath: string;
  symbol: string;
  projectFingerprint: string;
  payload: string;
}

interface ReindexEvidenceMetadata {
  version?: number;
  status?: string;
  fingerprint?: unknown;
  indexedLanguages?: unknown;
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
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Per-file content hash, memoized per (db, path) like the source-text cache. */
export function fileContentHash(db: ScipDatabase, relativePath: string, content: string): string {
  return CONTENT_HASH_CACHE.get(db, relativePath, () => sha256Hex(content));
}

export function projectEvidenceFingerprint(db: ScipDatabase): string | null {
  return PROJECT_FINGERPRINT_CACHE.get(db, 'current', () => {
    try {
      const metadata = JSON.parse(
        readFileSync(join(dirname(db.config.dbPath), 'meta.json'), 'utf-8'),
      ) as ReindexEvidenceMetadata;
      if ((metadata.version !== 2 && metadata.version !== 3) || metadata.status !== 'complete') return null;
      if (metadata.fingerprint === undefined) return null;
      const indexedLanguages = Array.isArray(metadata.indexedLanguages) ? [...metadata.indexedLanguages].sort() : [];
      return sha256Hex(
        JSON.stringify({
          fingerprint: metadata.fingerprint,
          indexedLanguages,
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
    const evidence = new Database(join(dirname(db.config.dbPath), EVIDENCE_DB_FILENAME));
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
      readFileEvidence: evidence.prepare(
        'SELECT payload FROM file_evidence WHERE kind = ? AND relative_path = ? AND content_hash = ? AND version = ?',
      ),
      readLegacyFileEvidence: evidence.prepare(
        `SELECT payload FROM file_evidence
         WHERE kind = ? AND relative_path = ? AND content_hash = ? AND ${LEGACY_VERSION_PREDICATE}
         ORDER BY version DESC
         LIMIT 1`,
      ),
      writeFileEvidence: evidence.prepare(
        'INSERT OR REPLACE INTO file_evidence (kind, relative_path, content_hash, version, payload) VALUES (?, ?, ?, ?, ?)',
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
      writeReferences: evidence.prepare(
        `INSERT OR REPLACE INTO semantic_references
           (relative_path, symbol, project_fingerprint, version, payload) VALUES (?, ?, ?, ?, ?)`,
      ),
      dropStaleReferences: evidence.prepare('DELETE FROM semantic_references WHERE project_fingerprint != ?'),
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
    return row?.payload ?? null;
  } catch (error) {
    disable(db, 'file_evidence read', error);
    return null;
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
  } catch (error) {
    disable(db, 'file_evidence write', error);
  }
}

/** Rows currently cached — lets callers warn before a cold full-corpus pass. */
export function semanticCalleeRowCount(db: ScipDatabase): number {
  const connection = connectionFor(db);
  if (!connection) return 0;
  try {
    const row = connection.evidence.prepare('SELECT COUNT(*) AS count FROM semantic_callees').get() as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  } catch (error) {
    disable(db, 'semantic_callees count', error);
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
        if (!staleDeleteKeys.has(entry.projectFingerprint)) {
          staleDeleteKeys.add(entry.projectFingerprint);
          connection.dropStaleReferences.run(entry.projectFingerprint);
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
