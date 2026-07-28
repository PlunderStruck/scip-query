import Database from 'better-sqlite3';
import type { ScipQueryConfig } from '../domain/types.js';
import { normalizeSafeProjectRelativePath } from '../domain/path-normalization.js';
import {
  acquireSqliteGenerationReader,
  fileIdentity,
  resolveSqliteGeneration,
  type SqliteGenerationHandle,
} from './sqlite-generation.js';

/** The path-exclusion capability storage consumes from project source policy. */
export interface PathExclusionPolicy {
  isIgnored(relativePath: string): boolean;
}

/** Read operations exposed by a prepared SQLite statement. */
export interface ScipPreparedReadStatement<BindParameters extends unknown[] = unknown[], Result = unknown> {
  get(...params: BindParameters): Result | undefined;
  all(...params: BindParameters): Result[];
  iterate(...params: BindParameters): IterableIterator<Result>;
  pluck(toggleState?: boolean): this;
  expand(toggleState?: boolean): this;
  raw(toggleState?: boolean): this;
  bind(...params: BindParameters): this;
  columns(): Database.ColumnDefinition[];
  safeIntegers(toggleState?: boolean): this;
}

/** Query-only facade that cannot close or reconfigure the owned connection. */
export interface ScipDatabaseQueryPort {
  prepare<BindParameters extends unknown[] = unknown[], Result = unknown>(
    source: string,
  ): ScipPreparedReadStatement<BindParameters, Result>;
}

export interface ScipDatabaseInitializationConnection {
  pragma(source: string): unknown;
  close(): unknown;
}

export const SCIP_DATABASE_INITIALIZATION_PRAGMAS = [
  'busy_timeout = 5000',
  'query_only = ON',
  'temp_store = MEMORY',
  'cache_size = -64000',
  'mmap_size = 268435456',
] as const;

/**
 * Owns one SQLite connection together with the reader lease that keeps its
 * immutable generation alive.
 *
 * This is exported from the internal storage module for production-shaped
 * failure injection. It is not part of the package-root API.
 */
export class ScipDatabaseConnectionOwnership<Connection extends ScipDatabaseInitializationConnection> {
  private active = true;

  constructor(
    readonly connection: Connection,
    private readonly releaseGenerationReader: () => void,
  ) {}

  initialize(validate: (connection: Connection) => void): void {
    try {
      for (const pragma of SCIP_DATABASE_INITIALIZATION_PRAGMAS) {
        this.connection.pragma(pragma);
      }
      validate(this.connection);
    } catch (initializationError) {
      try {
        this.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [initializationError, cleanupError],
          'SQLite initialization and rollback both failed.',
          { cause: cleanupError },
        );
      }
      throw initializationError;
    }
  }

  close(): void {
    if (!this.active) return;
    this.active = false;

    let connectionError: unknown;
    let releaseError: unknown;
    try {
      this.connection.close();
    } catch (error) {
      connectionError = error;
    }
    try {
      this.releaseGenerationReader();
    } catch (error) {
      releaseError = error;
    }

    if (connectionError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [connectionError, releaseError],
        'SQLite connection close and generation-reader release both failed.',
      );
    }
    if (connectionError !== undefined) throw connectionError;
    if (releaseError !== undefined) throw releaseError;
  }
}

const SQL_EXCLUDED_PATH_SEGMENTS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.nbb',
  '.cpcache',
  '.shadow-cljs',
  '.scipquery-cache',
  '__pycache__',
  '.venv',
  'venv',
] as const;

/**
 * Thin wrapper around better-sqlite3 with a pre-configured connection
 * and helper methods for the SCIP SQLite schema.
 *
 * The schema is produced by `scip expt-convert` and is identical
 * regardless of source language (TypeScript, Rust, Python, etc.).
 *
 * Tables:
 *   documents             — indexed files (id, language, relative_path)
 *   global_symbols        — all symbols (id, symbol, display_name, kind, documentation)
 *   defn_enclosing_ranges — definition locations (document_id, symbol_id, start/end line/char)
 *   mentions              — references & definitions (chunk_id, symbol_id, role)
 *   chunks                — code segments (document_id, chunk_index, start/end line, occurrences)
 */
export class ScipDatabase {
  readonly db: ScipDatabaseQueryPort;
  readonly config: ScipQueryConfig;
  readonly generation: SqliteGenerationHandle;
  private pathFilter: PathExclusionPolicy | null;
  private readonly connection: Database.Database;
  private readonly connectionOwnership: ScipDatabaseConnectionOwnership<Database.Database>;
  private statementCache = new Map<string, Database.Statement>();

  // scip-query: ignore-wrapper — public storage boundary; callers construct
  // ScipDatabase, not better-sqlite3 connections plus pragma setup.
  constructor(config: ScipQueryConfig, pathFilter?: PathExclusionPolicy) {
    this.config = config;
    this.pathFilter = pathFilter ?? null;
    const opened = openPublishedGeneration(config);
    const ownership = new ScipDatabaseConnectionOwnership(opened.db, opened.release);
    try {
      ownership.initialize(assertSafeIndexedDocumentPaths);
      this.generation = opened.generation;
      this.connection = opened.db;
      this.connectionOwnership = ownership;
      this.db = createScipDatabaseQueryPort(opened.db);
    } catch (constructionError) {
      try {
        ownership.close();
      } catch (cleanupError) {
        throw new AggregateError([constructionError, cleanupError], 'SQLite construction and rollback both failed.', {
          cause: cleanupError,
        });
      }
      throw constructionError;
    }
  }

  /** Check if a path should be excluded based on .gitignore rules */
  isIgnored(relativePath: string): boolean {
    return this.pathFilter?.isIgnored(relativePath) ?? false;
  }

  /**
   * The local-symbol predicate: only match symbols that are defined
   * in files NOT excluded by gitignore. This replaces the old hardcoded
   * `NOT LIKE 'node_modules/%'` check.
   *
   * Since SQLite can't evaluate JS gitignore rules inline, we use a
   * simpler approach: query broadly, then filter in JS. For queries
   * that need SQL-level filtering, use excludedPathPatterns().
   */
  get localSymbolPredicate(): string {
    // Basic SQL-level exclusions for the most common cases.
    // JS-level gitignore filtering handles the rest post-query.
    return `(
      EXISTS (
        SELECT 1
        FROM defn_enclosing_ranges local_der
        JOIN documents local_d ON local_der.document_id = local_d.id
        WHERE local_der.symbol_id = gs.id
          ${this.pathExclusionsFor('local_d').trimStart()}
      )
      OR EXISTS (
        SELECT 1
        FROM mentions local_m
        JOIN chunks local_c ON local_m.chunk_id = local_c.id
        JOIN documents local_d ON local_c.document_id = local_d.id
        WHERE local_m.symbol_id = gs.id
          AND local_m.role = 1
          ${this.pathExclusionsFor('local_d').trimStart()}
      )
    )`;
  }

  /**
   * SQL WHERE clause fragments to exclude common build/dependency paths.
   * Complements the JS-level gitignore filtering for performance.
   */
  get pathExclusions(): string {
    return this.pathExclusionsFor('d');
  }

  /** Reusable SQL fragment: filter out synthetic/internal symbol noise */
  get symbolNoise(): string {
    return this.symbolNoiseFor('gs');
  }

  /** Build SQL path exclusions for one or more document table aliases */
  pathExclusionsFor(...aliases: string[]): string {
    return aliases
      .flatMap((alias) =>
        SQL_EXCLUDED_PATH_SEGMENTS.flatMap((segment) => [
          `AND ${alias}.relative_path NOT LIKE '${segment}/%'`,
          `AND ${alias}.relative_path NOT LIKE '%/${segment}/%'`,
        ]),
      )
      .join('\n      ');
  }

  /** Build SQL symbol exclusions for the given global_symbols alias */
  symbolNoiseFor(alias: string): string {
    return `AND ${alias}.symbol NOT LIKE '%().(%' AND ${alias}.symbol NOT LIKE '%typeLiteral%'`;
  }

  /** Run a raw SQL query and return all rows */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /** Run a raw SQL query and return the first row */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  close(): void {
    this.statementCache.clear();
    this.connectionOwnership.close();
  }

  private statement(sql: string): Database.Statement {
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.connection.prepare(sql);
      this.statementCache.set(sql, statement);
    }
    return statement;
  }
}

function createScipDatabaseQueryPort(connection: Database.Database): ScipDatabaseQueryPort {
  return Object.freeze({
    prepare<BindParameters extends unknown[] = unknown[], Result = unknown>(source: string) {
      const statement = connection.prepare<BindParameters, Result>(source);
      if (!statement.readonly || !statement.reader) {
        throw new Error('ScipDatabase.db only permits read-only statements that return rows.');
      }
      return createScipPreparedReadStatement(statement);
    },
  });
}

function createScipPreparedReadStatement<BindParameters extends unknown[], Result>(
  statement: Database.Statement<BindParameters, Result>,
): ScipPreparedReadStatement<BindParameters, Result> {
  const prepared: ScipPreparedReadStatement<BindParameters, Result> = {
    get: (...params) => statement.get(...params),
    all: (...params) => statement.all(...params),
    iterate: (...params) => statement.iterate(...params),
    pluck(toggleState) {
      if (toggleState === undefined) statement.pluck();
      else statement.pluck(toggleState);
      return prepared;
    },
    expand(toggleState) {
      if (toggleState === undefined) statement.expand();
      else statement.expand(toggleState);
      return prepared;
    },
    raw(toggleState) {
      if (toggleState === undefined) statement.raw();
      else statement.raw(toggleState);
      return prepared;
    },
    bind(...params) {
      statement.bind(...params);
      return prepared;
    },
    columns: () => statement.columns(),
    safeIntegers(toggleState) {
      if (toggleState === undefined) statement.safeIntegers();
      else statement.safeIntegers(toggleState);
      return prepared;
    },
  };
  return Object.freeze(prepared);
}

function assertSafeIndexedDocumentPaths(db: Database.Database): void {
  const documentsTable = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'documents'")
    .get() as { present: 1 } | undefined;
  if (!documentsTable) return;
  const documents = db.prepare('SELECT relative_path FROM documents').iterate() as Iterable<{
    relative_path: string;
  }>;
  for (const document of documents) {
    normalizeSafeProjectRelativePath(document.relative_path);
  }
}

function openPublishedGeneration(config: ScipQueryConfig): {
  db: Database.Database;
  generation: SqliteGenerationHandle;
  release(): void;
} {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const leased = acquireSqliteGenerationReader(config);
    const generation = leased.generation;
    let db: Database.Database;
    try {
      db = new Database(generation.databasePath, { readonly: true, fileMustExist: true });
    } catch (error) {
      leased.release();
      throw error;
    }
    if (generation.source === 'immutable') {
      return { db, generation, release: leased.release };
    }
    try {
      const observed = resolveSqliteGeneration(config);
      if (
        generation.databaseFileIdentity === fileIdentity(generation.databasePath) &&
        observed.source === 'legacy' &&
        observed.identity === generation.identity &&
        observed.databaseFileIdentity === generation.databaseFileIdentity &&
        observed.metadataRaw === generation.metadataRaw
      ) {
        return { db, generation, release: leased.release };
      }
    } catch (error) {
      db.close();
      leased.release();
      throw error;
    }
    db.close();
    leased.release();
  }
  throw new Error('SQLite index publication changed repeatedly while opening a coherent generation.');
}
