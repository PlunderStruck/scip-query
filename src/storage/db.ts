import Database from 'better-sqlite3';
import type { ScipQueryConfig } from '../domain/types.js';

/** The path-exclusion capability storage consumes from project source policy. */
export interface PathExclusionPolicy {
  isIgnored(relativePath: string): boolean;
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
  readonly db: Database.Database;
  readonly config: ScipQueryConfig;
  private pathFilter: PathExclusionPolicy | null;
  private statementCache = new Map<string, Database.Statement>();

  // scip-query: ignore-wrapper — public storage boundary; callers construct
  // ScipDatabase, not better-sqlite3 connections plus pragma setup.
  constructor(config: ScipQueryConfig, pathFilter?: PathExclusionPolicy) {
    this.config = config;
    this.pathFilter = pathFilter ?? null;
    this.db = new Database(config.dbPath, { readonly: true });
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('query_only = ON');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('mmap_size = 268435456');
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
    this.db.close();
  }

  private statement(sql: string): Database.Statement {
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statementCache.set(sql, statement);
    }
    return statement;
  }
}
