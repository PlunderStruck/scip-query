import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import * as queries from '../../../src/queries/index.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';

/**
 * Creates a minimal SCIP SQLite database with fixture data
 * that exercises all query commands. This simulates what
 * `scip expt-convert` produces, but with controlled test data.
 *
 * NOTE: db.exec() below is better-sqlite3's SQL execution method,
 * NOT child_process.exec(). No shell commands are being run.
 */
function createFixtureDb(dbPath: string): void {
  const sqliteDb = new Database(dbPath);
  const run = (sql: string) => sqliteDb.exec(sql);

  // Create the SCIP SQLite schema
  run(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      language TEXT,
      relative_path TEXT NOT NULL UNIQUE,
      position_encoding TEXT,
      text TEXT
    );
    CREATE TABLE global_symbols (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      display_name TEXT,
      kind INTEGER,
      documentation TEXT,
      signature BLOB,
      enclosing_symbol TEXT,
      relationships BLOB
    );
    CREATE TABLE defn_enclosing_ranges (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      start_char INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_char INTEGER NOT NULL
    );
    CREATE TABLE mentions (
      chunk_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      role INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, symbol_id, role)
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      occurrences BLOB NOT NULL
    );
    CREATE INDEX idx_mentions_symbol_id_role ON mentions(symbol_id, role);
    CREATE INDEX idx_defn_enclosing_ranges_symbol_id ON defn_enclosing_ranges(symbol_id);
    CREATE INDEX idx_defn_enclosing_ranges_document ON defn_enclosing_ranges(document_id, start_line, end_line);
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
  `);

  // Insert test documents
  run(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'src/services/auth.service.ts'),
      (2, 'typescript', 'src/services/user.service.ts'),
      (3, 'typescript', 'src/controllers/auth.controller.ts'),
      (4, 'typescript', 'src/__tests__/auth.test.ts'),
      (5, 'python', 'lib/utils.py'),
      (6, 'python', 'lib/models.py'),
      (7, 'rust', 'src/main.rs');
  `);

  // Insert test symbols
  const insertSymbol = sqliteDb.prepare(
    `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES (?, ?, ?, ?, ?)`
  );
  insertSymbol.run(1, "scip-typescript npm my-app 1.0.0 src/services/`auth.service.ts`/AuthService#", 'AuthService', 1, 'AuthService class|class AuthService');
  insertSymbol.run(2, "scip-typescript npm my-app 1.0.0 src/services/`auth.service.ts`/AuthService#login().", 'login', 2, "Login method|```ts\n(method) login(email: string): Promise<Token>\n```");
  insertSymbol.run(3, "scip-typescript npm my-app 1.0.0 src/services/`auth.service.ts`/AuthService#logout().", 'logout', 2, "Logout method|```ts\n(method) logout(): void\n```");
  insertSymbol.run(4, "scip-typescript npm my-app 1.0.0 src/services/`user.service.ts`/UserService#", 'UserService', 1, 'User service|class UserService');
  insertSymbol.run(5, "scip-typescript npm my-app 1.0.0 src/services/`user.service.ts`/UserService#findById().", 'findById', 2, "Find by ID|```ts\n(method) findById(id: string): Promise<User>\n```");
  insertSymbol.run(6, "scip-typescript npm my-app 1.0.0 src/services/`user.service.ts`/deadExport.", 'deadExport', 3, 'Not used anywhere|function deadExport(): void');
  insertSymbol.run(7, "scip-python pip my-lib 1.0.0 lib/`utils.py`/format_name.", 'format_name', 3, 'Format name|def format_name(name: str) -> str');
  insertSymbol.run(8, "rust-analyzer cargo my-crate 0.1.0 src/`main.rs`/Config#", 'Config', 1, 'Config struct|struct Config');

  // Insert definition ranges
  run(`
    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 1, 1, 1, 0, 50, 1),
      (2, 1, 2, 5, 2, 20, 3),
      (3, 1, 3, 22, 2, 35, 3),
      (4, 2, 4, 1, 0, 40, 1),
      (5, 2, 5, 5, 2, 25, 3),
      (6, 2, 6, 27, 2, 45, 3),
      (7, 5, 7, 10, 0, 25, 0),
      (8, 7, 8, 1, 0, 15, 1);
  `);

  // Insert chunks
  run(`
    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 50, X'00'),
      (2, 2, 0, 0, 45, X'00'),
      (3, 3, 0, 0, 30, X'00'),
      (4, 4, 0, 0, 20, X'00'),
      (5, 5, 0, 0, 30, X'00'),
      (6, 6, 0, 0, 20, X'00'),
      (7, 7, 0, 0, 20, X'00');
  `);

  // Insert mentions (role: 0 = reference, 1 = definition)
  run(`
    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 2, 1), (3, 2, 0), (4, 2, 0),
      (1, 3, 1), (3, 3, 0),
      (2, 5, 1), (1, 5, 0),
      (2, 6, 1),
      (5, 7, 1), (6, 7, 0),
      (7, 8, 1),
      (1, 1, 1), (3, 1, 0),
      (2, 4, 1), (1, 4, 0);
  `);

  sqliteDb.close();
}

// ── Test Suite ──────────────────────────────────────────────

describe('query engine', () => {
  let db: ScipDatabase;
  let tempDir: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-test-'));
    dbPath = join(tempDir, 'index.db');
    createFixtureDb(dbPath);

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
  });

  describe('stats', () => {
    it('returns correct counts', () => {
      const s = queries.stats(db);
      expect(s.documents).toBe(7);
      expect(s.symbols).toBe(8);
      expect(s.definitions).toBeGreaterThan(0);
      expect(s.references).toBeGreaterThan(0);
    });
  });

  describe('files', () => {
    it('finds files matching a pattern', () => {
      const results = queries.files(db, 'auth');
      const paths = results.map((r) => r.relativePath);
      expect(paths).toContain('src/services/auth.service.ts');
      expect(paths).toContain('src/controllers/auth.controller.ts');
    });

    it('finds Python files', () => {
      const results = queries.files(db, 'utils');
      expect(results).toHaveLength(1);
      expect(results[0]!.relativePath).toBe('lib/utils.py');
    });

    it('finds Rust files', () => {
      const results = queries.files(db, 'main.rs');
      expect(results).toHaveLength(1);
    });
  });

  describe('symbols', () => {
    it('lists symbols in a TypeScript file', () => {
      const results = queries.symbols(db, 'auth.service.ts');
      expect(results.length).toBeGreaterThan(0);

      const loginSymbol = results.find((s) => s.shortName.includes('login'));
      expect(loginSymbol).toBeDefined();
      expect(loginSymbol!.startLine).toBe(5);
      expect(loginSymbol!.endLine).toBe(20);
    });

    it('returns cleaned signatures', () => {
      const results = queries.symbols(db, 'auth.service.ts');
      const login = results.find((s) => s.shortName.includes('login'));
      expect(login?.signature).toBeDefined();
      expect(login?.signature).not.toContain('```');
      expect(login?.signature).not.toContain('(method)');
    });
  });

  describe('methods', () => {
    it('lists methods of a class', () => {
      const results = queries.methods(db, 'AuthService');
      expect(results.length).toBe(2);
      const names = results.map((m) => m.name);
      expect(names).toContain('login');
      expect(names).toContain('logout');
    });
  });

  describe('refs', () => {
    it('finds cross-file references', () => {
      const results = queries.refs(db, 'login');
      const files = results.map((r) => r.relativePath);
      expect(files).toContain('src/controllers/auth.controller.ts');
    });
  });

  describe('trace', () => {
    it('returns definitions and references', () => {
      const result = queries.trace(db, 'login');
      expect(result.definitions.length).toBeGreaterThan(0);
      expect(result.definitions[0]!.relativePath).toBe('src/services/auth.service.ts');
      expect(result.referencedBy.length).toBeGreaterThan(0);
    });
  });

  describe('deps', () => {
    it('finds forward dependencies', () => {
      const results = queries.deps(db, 'auth.service.ts');
      const paths = results.map((r) => r.relativePath);
      expect(paths).toContain('src/services/user.service.ts');
    });
  });

  describe('rdeps', () => {
    it('finds reverse dependencies', () => {
      const results = queries.rdeps(db, 'auth.service.ts');
      const paths = results.map((r) => r.relativePath);
      expect(paths).toContain('src/controllers/auth.controller.ts');
    });
  });

  describe('system', () => {
    it('returns full module map', () => {
      const result = queries.system(db, 'services');
      expect(result.files.length).toBe(2);
      expect(result.symbols.length).toBeGreaterThan(0);
      expect(result.dependedOnBy.length).toBeGreaterThan(0);
    });
  });

  describe('surface', () => {
    it('finds externally consumed symbols', () => {
      const results = queries.surface(db, 'auth.service');
      expect(results.length).toBeGreaterThan(0);
      const consumers = results.map((r) => r.consumer);
      expect(consumers).toContain('src/controllers/auth.controller.ts');
    });
  });

  describe('dead', () => {
    it('finds dead exports', () => {
      const result = queries.dead(db, { minLoc: 1 });
      const deadNames = result.symbols.map((s) => s.shortName);
      const hasDead = deadNames.some((n) => n.includes('deadExport'));
      expect(hasDead).toBe(true);
    });

    it('respects scope filter', () => {
      const result = queries.dead(db, { scope: 'lib/', minLoc: 1 });
      for (const s of result.symbols) {
        expect(s.relativePath).toMatch(/^lib\//);
      }
    });

    it('classifies dead-code vs dead-export correctly', () => {
      const result = queries.dead(db, { minLoc: 1 });
      const deadExportSymbol = result.symbols.find((s) => s.shortName.includes('deadExport'));
      expect(deadExportSymbol?.kind).toBe('dead-code');
    });

    it('excludes test files by default', () => {
      const result = queries.dead(db, { minLoc: 1 });
      for (const s of result.symbols) {
        expect(s.relativePath).not.toContain('__tests__');
      }
    });
  });
});
