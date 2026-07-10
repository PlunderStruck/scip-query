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
  deleteFindingOutcomeLedgerForCheck: Database.Statement;
  writeFindingOutcomeLedgerRow: Database.Statement;
}

/** Ledger rows are ids + timestamps only — no finding content, no prompt text. */
export interface FindingOutcomeRow {
  check: string;
  findingId: string;
  firstSeen: number;
  lastSeen: number;
  timesShown: number;
  outcome: string;
}

/** Per-check FIFO cap — the ledger stores ids/timestamps only, but a repo with
 * many checks and long history should not grow without bound. */
export const FINDING_OUTCOME_LEDGER_CAP_PER_CHECK = 5_000;

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
      if (metadata.version !== 2 && metadata.version !== 3) return null;
      if (metadata.status !== 'complete' && metadata.status !== 'partial') return null;
      if (metadata.fingerprint === undefined) return null;
      const indexedLanguages = Array.isArray(metadata.indexedLanguages) ? [...metadata.indexedLanguages].sort() : [];
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
      deleteFindingOutcomeLedgerForCheck: evidence.prepare('DELETE FROM finding_outcome_ledger WHERE check_name = ?'),
      writeFindingOutcomeLedgerRow: evidence.prepare(
        `INSERT INTO finding_outcome_ledger
           (check_name, finding_id, first_seen, last_seen, times_shown, outcome) VALUES (?, ?, ?, ?, ?, ?)`,
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
  } catch (error) {
    disable(db, 'finding_outcome_ledger read', error);
    return [];
  }
}

/**
 * Replace-all write: the caller computes the full next-state ledger (a pure
 * transition — see queries/health/finding-outcome-ledger.ts) and this
 * persists it. Applies the per-check FIFO cap here (keep the most-recently-
 * seen rows) so a caller never has to reason about eviction.
 */
export function writeFindingOutcomeLedger(db: ScipDatabase, rows: readonly FindingOutcomeRow[]): void {
  const connection = connectionFor(db);
  if (!connection) return;
  try {
    const byCheck = new Map<string, FindingOutcomeRow[]>();
    for (const row of rows) {
      const bucket = byCheck.get(row.check) ?? [];
      bucket.push(row);
      byCheck.set(row.check, bucket);
    }
    connection.evidence.transaction(() => {
      for (const [check, checkRows] of byCheck) {
        connection.deleteFindingOutcomeLedgerForCheck.run(check);
        const capped = [...checkRows]
          .sort((left, right) => right.lastSeen - left.lastSeen)
          .slice(0, FINDING_OUTCOME_LEDGER_CAP_PER_CHECK);
        for (const row of capped) {
          connection.writeFindingOutcomeLedgerRow.run(
            row.check,
            row.findingId,
            row.firstSeen,
            row.lastSeen,
            row.timesShown,
            row.outcome,
          );
        }
      }
    })();
  } catch (error) {
    disable(db, 'finding_outcome_ledger write', error);
  }
}
