import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SCIP_DATABASE_INITIALIZATION_PRAGMAS,
  ScipDatabase,
  ScipDatabaseConnectionOwnership,
} from '../../src/storage/db.js';

describe('ScipDatabase connection ownership', () => {
  it.each(SCIP_DATABASE_INITIALIZATION_PRAGMAS)(
    'releases the connection and generation lease when %s fails',
    (failedPragma) => {
      const connection = {
        pragma: vi.fn((pragma: string) => {
          if (pragma === failedPragma) throw new Error(`failed ${pragma}`);
        }),
        close: vi.fn(),
      };
      const release = vi.fn();
      const ownership = new ScipDatabaseConnectionOwnership(connection, release);

      expect(() => ownership.initialize(() => undefined)).toThrow(`failed ${failedPragma}`);
      expect(connection.close).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it('releases the connection and generation lease when validation fails', () => {
    const connection = {
      pragma: vi.fn(),
      close: vi.fn(),
    };
    const release = vi.fn();
    const ownership = new ScipDatabaseConnectionOwnership(connection, release);

    expect(() =>
      ownership.initialize(() => {
        throw new Error('invalid indexed path');
      }),
    ).toThrow('invalid indexed path');
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the generation lease even when connection close fails', () => {
    const connection = {
      pragma: vi.fn(() => {
        throw new Error('pragma failed');
      }),
      close: vi.fn(() => {
        throw new Error('close failed');
      }),
    };
    const release = vi.fn();
    const ownership = new ScipDatabaseConnectionOwnership(connection, release);

    expect(() => ownership.initialize(() => undefined)).toThrow(AggregateError);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('reports both cleanup failures and still makes ownership terminal', () => {
    const connection = {
      pragma: vi.fn(),
      close: vi.fn(() => {
        throw new Error('close failed');
      }),
    };
    const release = vi.fn(() => {
      throw new Error('release failed');
    });
    const ownership = new ScipDatabaseConnectionOwnership(connection, release);
    ownership.initialize(() => undefined);

    expect(() => ownership.close()).toThrow(
      expect.objectContaining({
        name: 'AggregateError',
        errors: [
          expect.objectContaining({ message: 'close failed' }),
          expect.objectContaining({ message: 'release failed' }),
        ],
      }),
    );
    expect(() => ownership.close()).not.toThrow();
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('closes and releases a published ownership exactly once', () => {
    const connection = {
      pragma: vi.fn(),
      close: vi.fn(),
    };
    const release = vi.fn();
    const ownership = new ScipDatabaseConnectionOwnership(connection, release);
    ownership.initialize(() => undefined);

    ownership.close();
    ownership.close();

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('exposes a read-query port without raw lifecycle methods', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-db-port-'));
    const dbPath = join(tempDir, 'index.db');
    const sqlite = new Database(dbPath);
    sqlite.exec("CREATE TABLE fixture (value TEXT NOT NULL); INSERT INTO fixture VALUES ('visible')");
    sqlite.close();

    const db = new ScipDatabase({
      projectRoot: tempDir,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    try {
      expect(db.db.prepare('SELECT value FROM fixture').pluck().get()).toBe('visible');
      expect(db.db).not.toHaveProperty('close');
      expect(db.db).not.toHaveProperty('pragma');
      expect(db.db.prepare('SELECT value FROM fixture')).not.toHaveProperty('database');
      expect(db.db.prepare('SELECT value FROM fixture')).not.toHaveProperty('run');
      expect(() => db.db.prepare('PRAGMA query_only = OFF')).toThrow(
        'ScipDatabase.db only permits read-only statements that return rows.',
      );
      expect(() => db.db.prepare('CREATE TABLE escaped (value TEXT)')).toThrow(
        'ScipDatabase.db only permits read-only statements that return rows.',
      );
    } finally {
      db.close();
    }
  });
});
