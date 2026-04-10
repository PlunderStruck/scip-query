import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import type { PathFilter } from './gitignore-filter.js';
import type { ScipQueryConfig } from './types.js';

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
  private pathFilter: PathFilter | null;

  constructor(config: ScipQueryConfig, pathFilter?: PathFilter) {
    this.config = config;
    this.pathFilter = pathFilter ?? null;
    this.db = new Database(config.dbPath, { readonly: true });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
  }

  /** Attach a gitignore-based path filter for query results */
  setPathFilter(filter: PathFilter): void {
    this.pathFilter = filter;
  }

  /** Check if a path should be excluded based on .gitignore rules */
  isIgnored(relativePath: string): boolean {
    return this.pathFilter?.isIgnored(relativePath) ?? false;
  }

  /** Filter an array of paths using the gitignore filter */
  filterPaths(paths: string[]): string[] {
    return this.pathFilter?.filter(paths) ?? paths;
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
    return `EXISTS (
      SELECT 1
      FROM defn_enclosing_ranges local_der
      JOIN documents local_d ON local_der.document_id = local_d.id
      WHERE local_der.symbol_id = gs.id
        AND local_d.relative_path NOT LIKE 'node_modules/%'
        AND local_d.relative_path NOT LIKE '.git/%'
    )`;
  }

  /**
   * SQL WHERE clause fragments to exclude common build/dependency paths.
   * Complements the JS-level gitignore filtering for performance.
   */
  get pathExclusions(): string {
    return `
      AND d.relative_path NOT LIKE 'node_modules/%'
      AND d.relative_path NOT LIKE '.git/%'
    `;
  }

  /** Run a raw SQL query and return all rows */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** Run a raw SQL query and return the first row */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** Get the database file size in bytes */
  sizeBytes(): number {
    try {
      return statSync(this.config.dbPath).size;
    } catch {
      return 0;
    }
  }

  /** Get the last modification time of the database file */
  lastModified(): Date | null {
    try {
      return statSync(this.config.dbPath).mtime;
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}
