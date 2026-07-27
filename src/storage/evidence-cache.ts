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
  writeFileEvidence: Database.Statement;
  readProjectEvidence: Database.Statement;
  readLegacyProjectEvidence: Database.Statement;
  writeProjectEvidence: Database.Statement;
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
  readFindingOutcomeLedger: Database.Statement;
  claimFindingOutcomeObservation: Database.Statement;
  readFindingOutcomeObservation: Database.Statement;
  upsertFindingOutcomeLedgerRow: Database.Statement;
  updateFindingOutcomeLedgerRow: Database.Statement;
  trimFindingOutcomeLedgerCheck: Database.Statement;
}

interface SharedEvidenceConnection {
  evidence: Database.Database;
  readFileEvidence: Database.Statement;
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

/** Ledger rows are ids + timestamps only — no finding content, no prompt text. */
export interface FindingOutcomeRow {
  check: string;
  findingId: string;
  firstSeen: number;
  lastSeen: number;
  timesShown: number;
  outcome: string;
}

/**
 * One logical detector run. The caller owns the stable id and fingerprints
 * the evidence that id names; storage rejects an id reused for other evidence.
 */
export interface FindingOutcomeObservation {
  observationId: string;
  fingerprint: string;
  observedAt: number;
}

export type FindingOutcomeApplyStatus = 'applied' | 'duplicate' | 'conflict' | 'busy' | 'unavailable';

export interface FindingOutcomeApplyResult {
  status: FindingOutcomeApplyStatus;
  previous: FindingOutcomeRow[];
  current: FindingOutcomeRow[];
}

export interface FindingOutcomeApplyOptions {
  /** Maximum SQLite writer-lock wait for this best-effort metric update. */
  busyTimeoutMs?: number;
}

/** Per-check recency cap — the ledger stores ids/timestamps only, but a repo with
 * many checks and long history should not grow without bound. */
export const FINDING_OUTCOME_LEDGER_CAP_PER_CHECK = 5_000;

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
      CREATE TABLE IF NOT EXISTS finding_outcome_ledger (
        check_name TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        times_shown INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        PRIMARY KEY (check_name, finding_id)
      );
      CREATE TABLE IF NOT EXISTS finding_outcome_observations (
        observation_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        observed_at INTEGER NOT NULL
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
      writeFileEvidence: evidence.prepare(
        'INSERT OR REPLACE INTO file_evidence (kind, relative_path, content_hash, version, payload) VALUES (?, ?, ?, ?, ?)',
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
      readFindingOutcomeLedger: evidence.prepare(
        'SELECT check_name, finding_id, first_seen, last_seen, times_shown, outcome FROM finding_outcome_ledger',
      ),
      claimFindingOutcomeObservation: evidence.prepare(
        `INSERT OR IGNORE INTO finding_outcome_observations
           (observation_id, fingerprint, observed_at) VALUES (?, ?, ?)`,
      ),
      readFindingOutcomeObservation: evidence.prepare(
        'SELECT fingerprint FROM finding_outcome_observations WHERE observation_id = ?',
      ),
      upsertFindingOutcomeLedgerRow: evidence.prepare(
        `INSERT INTO finding_outcome_ledger
           (check_name, finding_id, first_seen, last_seen, times_shown, outcome)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(check_name, finding_id) DO UPDATE SET
           first_seen = MIN(finding_outcome_ledger.first_seen, excluded.first_seen),
           last_seen = MAX(finding_outcome_ledger.last_seen, excluded.last_seen),
           times_shown = finding_outcome_ledger.times_shown + excluded.times_shown,
           outcome = excluded.outcome`,
      ),
      updateFindingOutcomeLedgerRow: evidence.prepare(
        `UPDATE finding_outcome_ledger
         SET first_seen = MIN(first_seen, ?),
             last_seen = MAX(last_seen, ?),
             outcome = ?
         WHERE check_name = ? AND finding_id = ?`,
      ),
      trimFindingOutcomeLedgerCheck: evidence.prepare(
        `DELETE FROM finding_outcome_ledger
         WHERE rowid IN (
           SELECT rowid
           FROM finding_outcome_ledger
           WHERE check_name = ?
           ORDER BY last_seen DESC, first_seen DESC, finding_id DESC
           LIMIT -1 OFFSET ?
         )`,
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

// scip-query: ignore-wrapper — public storage boundary; callers get a
// disable-on-error read, never a raw statement.
export function readFindingOutcomeLedger(db: ScipDatabase): FindingOutcomeRow[] {
  const connection = connectionFor(db);
  if (!connection) return [];
  try {
    return readFindingOutcomeRows(connection);
  } catch (error) {
    disable(db, 'finding_outcome_ledger read', error);
    return [];
  }
}

/**
 * Serialize one logical ledger transition with every other process writing
 * evidence.db. The transition runs after BEGIN IMMEDIATE has acquired SQLite's
 * writer reservation, so it can only derive from the latest committed rows.
 *
 * New or repeated findings use an UPSERT whose conflict branch adds the
 * transition's count delta. Retrying the same observation id and fingerprint
 * is a no-op; reusing an id for different evidence is an explicit conflict.
 */
export function applyFindingOutcomeLedgerTransition(
  db: ScipDatabase,
  observation: FindingOutcomeObservation,
  transition: (previous: readonly FindingOutcomeRow[]) => readonly FindingOutcomeRow[],
  options: FindingOutcomeApplyOptions = {},
): FindingOutcomeApplyResult {
  const connection = connectionFor(db);
  if (!connection) return { status: 'unavailable', previous: [], current: [] };

  const configuredTimeout = options.busyTimeoutMs;
  let priorTimeout: number | undefined;

  try {
    if (configuredTimeout !== undefined) {
      priorTimeout = Number(connection.evidence.pragma('busy_timeout', { simple: true }));
      const busyTimeoutMs = Math.max(0, Math.min(60_000, Math.floor(configuredTimeout)));
      connection.evidence.pragma(`busy_timeout = ${busyTimeoutMs}`);
    }

    const runTransition = connection.evidence.transaction((): FindingOutcomeApplyResult => {
      const previous = readFindingOutcomeRows(connection);
      const claimed = connection.claimFindingOutcomeObservation.run(
        observation.observationId,
        observation.fingerprint,
        observation.observedAt,
      );
      if (claimed.changes === 0) {
        const existing = connection.readFindingOutcomeObservation.get(observation.observationId) as
          | { fingerprint: string }
          | undefined;
        return {
          status: existing?.fingerprint === observation.fingerprint ? 'duplicate' : 'conflict',
          previous,
          current: previous,
        };
      }

      const next = [...transition(previous)];
      const previousByKey = new Map(previous.map((row) => [findingOutcomeRowKey(row), row]));
      const nextByKey = new Map<string, FindingOutcomeRow>();
      const touchedChecks = new Set<string>();

      for (const row of next) {
        const key = findingOutcomeRowKey(row);
        if (nextByKey.has(key)) {
          throw new Error(`duplicate finding-outcome row in transition: ${row.check}/${row.findingId}`);
        }
        nextByKey.set(key, row);
        const before = previousByKey.get(key);
        if (!before) {
          if (row.timesShown < 1) {
            throw new Error(`new finding-outcome row has a non-positive count: ${row.check}/${row.findingId}`);
          }
          touchedChecks.add(row.check);
          connection.upsertFindingOutcomeLedgerRow.run(
            row.check,
            row.findingId,
            row.firstSeen,
            row.lastSeen,
            row.timesShown,
            row.outcome,
          );
          continue;
        }

        const countDelta = row.timesShown - before.timesShown;
        if (countDelta < 0) {
          throw new Error(`finding-outcome count regressed: ${row.check}/${row.findingId}`);
        }
        if (countDelta > 0) {
          touchedChecks.add(row.check);
          connection.upsertFindingOutcomeLedgerRow.run(
            row.check,
            row.findingId,
            row.firstSeen,
            row.lastSeen,
            countDelta,
            row.outcome,
          );
        } else if (
          row.firstSeen !== before.firstSeen ||
          row.lastSeen !== before.lastSeen ||
          row.outcome !== before.outcome
        ) {
          touchedChecks.add(row.check);
          connection.updateFindingOutcomeLedgerRow.run(
            row.firstSeen,
            row.lastSeen,
            row.outcome,
            row.check,
            row.findingId,
          );
        }
      }

      for (const row of previous) {
        if (!nextByKey.has(findingOutcomeRowKey(row))) {
          throw new Error(`finding-outcome transition removed a row: ${row.check}/${row.findingId}`);
        }
      }
      for (const check of touchedChecks) {
        connection.trimFindingOutcomeLedgerCheck.run(check, FINDING_OUTCOME_LEDGER_CAP_PER_CHECK);
      }

      return { status: 'applied', previous, current: readFindingOutcomeRows(connection) };
    });
    return runTransition.immediate();
  } catch (error) {
    if (isSqliteBusy(error)) {
      let current: FindingOutcomeRow[] = [];
      try {
        current = readFindingOutcomeRows(connection);
      } catch {
        // A transient writer-lock timeout must not disable the entire evidence cache.
      }
      return { status: 'busy', previous: current, current };
    }
    disable(db, 'finding_outcome_ledger transition', error);
    return { status: 'unavailable', previous: [], current: [] };
  } finally {
    if (priorTimeout !== undefined) {
      try {
        connection.evidence.pragma(`busy_timeout = ${Math.max(0, Math.floor(priorTimeout))}`);
      } catch {
        // The connection was disabled by the failure path above.
      }
    }
  }
}

function readFindingOutcomeRows(connection: EvidenceConnection): FindingOutcomeRow[] {
  const rows = connection.readFindingOutcomeLedger.all() as Array<{
    check_name: string;
    finding_id: string;
    first_seen: number;
    last_seen: number;
    times_shown: number;
    outcome: string;
  }>;
  return rows.map((row) => ({
    check: row.check_name,
    findingId: row.finding_id,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    timesShown: row.times_shown,
    outcome: row.outcome,
  }));
}

function findingOutcomeRowKey(row: Pick<FindingOutcomeRow, 'check' | 'findingId'>): string {
  return `${row.check}\0${row.findingId}`;
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_TIMEOUT' || code === 'SQLITE_LOCKED';
}
