import Database from 'better-sqlite3';
import fc from 'fast-check';
import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ScipDatabase, type ScipPreparedReadStatement } from '../../src/storage/db.js';
import {
  databaseReadsMatch,
  withDatabaseReadRecording,
  type DatabaseReadProof,
} from '../../src/storage/database-read-proof.js';

function withDatabase(run: (db: ScipDatabase, writer: Database.Database) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'scip-database-proof-'));
  const dbPath = join(root, 'index.db');
  const writer = new Database(dbPath);
  writer.exec("CREATE TABLE calls (caller INTEGER PRIMARY KEY, callee TEXT); INSERT INTO calls VALUES (1, 'fetch')");
  const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
  try {
    run(db, writer);
  } finally {
    db.close();
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('replays recorded rows and negative results across unrelated and relevant mutations', () => {
  withDatabase((db, writer) => {
    const captured = withDatabaseReadRecording(db.db, () => {
      const rows = db.all('SELECT caller FROM calls WHERE callee = ?', 'fetch');
      expect(db.db.prepare('SELECT caller FROM calls WHERE callee = ?').get('send')).toBeUndefined();
      expect(db.all('SELECT caller FROM calls WHERE callee = ?', 'send')).toEqual([]);
      return rows;
    });
    const proof = JSON.parse(JSON.stringify(captured.proof));
    captured.result[0]!.caller = -1;
    expect(databaseReadsMatch(db.db, proof)).toBe(true);
    writer.exec("INSERT INTO calls VALUES (2, 'unrelated')");
    expect(databaseReadsMatch(db.db, proof)).toBe(true);
    writer.exec("INSERT INTO calls VALUES (3, 'send')");
    expect(databaseReadsMatch(db.db, proof)).toBe(false);
    writer.exec('DELETE FROM calls WHERE caller = 3');
    expect(databaseReadsMatch(db.db, proof)).toBe(true);
    writer.exec("UPDATE calls SET callee = 'other' WHERE caller = 1");
    expect(databaseReadsMatch(db.db, proof)).toBe(false);
    writer.exec("UPDATE calls SET callee = 'fetch', caller = 4 WHERE caller = 1");
    expect(databaseReadsMatch(db.db, proof)).toBe(false);
  });
});

test('preserves positional, named, binary and bigint bindings through JSON persistence', () => {
  withDatabase((db) => {
    const captured = withDatabaseReadRecording(db.db, () => {
      expect(db.get('SELECT ? AS value', Buffer.from([0, 255]))).toEqual({ value: Buffer.from([0, 255]) });
      expect(db.db.prepare('SELECT @value AS value').get({ value: 23n })).toEqual({ value: 23 });
      expect(db.get('SELECT ? AS value', null)).toEqual({ value: null });
      expect(db.get('SELECT ? AS value', 'quotes " \\ ? $')).toEqual({ value: 'quotes " \\ ? $' });
    });
    expect(captured.proof?.reads).toHaveLength(4);
    expect(captured.proof?.statements).toHaveLength(2);
    expect(databaseReadsMatch(db.db, JSON.parse(JSON.stringify(captured.proof)))).toBe(true);
  });
});

test('deduplicates exact reads, forwards nested captures and rejects inconsistent reads', () => {
  withDatabase((db, writer) => {
    const read = () => db.get('SELECT callee FROM calls WHERE caller = ?', 1);
    const captured = withDatabaseReadRecording(db.db, () => {
      read();
      const nested = withDatabaseReadRecording(db.db, read);
      expect(nested.proof?.reads).toHaveLength(1);
      read();
    });
    expect(captured.proof?.reads).toHaveLength(1);
    const inconsistent = withDatabaseReadRecording(db.db, () => {
      read();
      writer.exec("UPDATE calls SET callee = 'changed'");
      read();
    });
    expect(inconsistent.proof).toBeUndefined();
    expect(withDatabaseReadRecording(db.db, read).proof).toBeDefined();
  });
});

test('does not confuse reads from another database with reads owned by this phase', () => {
  withDatabase((first) =>
    withDatabase((second) => {
      const captured = withDatabaseReadRecording(first.db, () => {
        first.get('SELECT 1');
        const nested = withDatabaseReadRecording(second.db, () => second.get('SELECT 1'));
        expect(nested.proof).toBeDefined();
      });
      expect(captured.proof).toBeUndefined();
    }),
  );
});

const configurations: Array<[string, (statement: ScipPreparedReadStatement) => void]> = [
  ['pluck', (statement) => statement.pluck()],
  ['expand', (statement) => statement.expand()],
  ['raw', (statement) => statement.raw()],
  ['safeIntegers', (statement) => statement.safeIntegers()],
  ['bind', (statement) => statement.bind()],
];
test.each(configurations)('%s remains usable but cannot produce a default-read proof', (_name, configure) => {
  withDatabase((db) => {
    for (const configureBefore of [false, true]) {
      const statement = db.db.prepare('SELECT caller FROM calls');
      if (configureBefore) configure(statement);
      const captured = withDatabaseReadRecording(db.db, () => {
        if (!configureBefore) configure(statement);
        return statement.all();
      });
      expect(captured.result).toHaveLength(1);
      expect(captured.proof).toBeUndefined();
    }
  });
});

test('iteration stays lazy and partial iteration and column introspection invalidate capture', () => {
  withDatabase((db, writer) => {
    writer.exec("INSERT INTO calls VALUES (2, 'send')");
    const statement = db.db.prepare('SELECT caller FROM calls ORDER BY caller');
    const captured = withDatabaseReadRecording(db.db, () => statement.iterate());
    expect(captured.proof).toBeUndefined();
    writer.exec('DELETE FROM calls WHERE caller = 2');
    expect([...captured.result]).toEqual([{ caller: 1 }]);
    const partial = withDatabaseReadRecording(db.db, () => {
      const iterator = statement.iterate();
      const first = iterator.next();
      iterator.return?.();
      return first.value;
    });
    expect(partial.result).toEqual({ caller: 1 });
    expect(partial.proof).toBeUndefined();
    expect(withDatabaseReadRecording(db.db, () => statement.columns()).proof).toBeUndefined();
  });
});

test('caught preparation, execution and nested failures cannot become stable negative answers', () => {
  withDatabase((db) => {
    for (const fail of [
      () => db.get('SELECT missing FROM calls'),
      () => db.db.prepare('SELECT missing FROM calls'),
      () => db.get('SELECT ? AS value'),
      () =>
        withDatabaseReadRecording(db.db, () => {
          throw Error('nested');
        }),
    ]) {
      const captured = withDatabaseReadRecording(db.db, () => {
        try {
          fail();
        } catch {
          /* The phase handles unavailable evidence. */
        }
        return db.get('SELECT 1');
      });
      expect(captured.proof).toBeUndefined();
    }
    expect(withDatabaseReadRecording(db.db, () => db.get('SELECT 1')).proof).toBeDefined();
  });
});

test('async captures cannot escape into a parent proof', async () => {
  let pending: Promise<unknown> | undefined;
  withDatabase((db) => {
    const captured = withDatabaseReadRecording(db.db, () => {
      pending = withDatabaseReadRecording(db.db, async () => db.get('SELECT 1')).result;
    });
    expect(captured.proof).toBeUndefined();
  });
  await pending;
});

test('accessors and proxies retain SQLite behavior without being certified as stable parameters', () => {
  withDatabase((db) => {
    let reads = 0;
    const parameter = {
      get value() {
        reads++;
        return 1;
      },
    };
    const captured = withDatabaseReadRecording(db.db, () => db.get('SELECT @value AS value', parameter));
    expect(captured.result).toEqual({ value: 1 });
    expect(reads).toBe(1);
    expect(captured.proof).toBeUndefined();
    const proxied = withDatabaseReadRecording(db.db, () =>
      db.get('SELECT @value AS value', new Proxy({ value: 1 }, {})),
    );
    expect(proxied.result).toEqual({ value: 1 });
    expect(proxied.proof).toBeUndefined();
  });
});

test('rejects corrupt, oversized and non-readonly persisted proofs without mutating the database', () => {
  withDatabase((db) => {
    const proof = withDatabaseReadRecording(db.db, () => db.get('SELECT caller FROM calls')).proof!;
    const malformed: unknown[] = [
      undefined,
      null,
      {},
      { ...proof, version: 9 },
      { ...proof, encoding: 'other' },
      { ...proof, reads: [null] },
      { ...proof, statements: [false] },
      { ...proof, reads: [{ ...proof.reads[0], statement: -1 }] },
      { ...proof, reads: [{ ...proof.reads[0], parameters: 'corrupt' }] },
      { ...proof, reads: [{ ...proof.reads[0], method: 'run' }] },
      { ...proof, statements: ['DELETE FROM calls RETURNING caller'] },
      { ...proof, statements: ['x'.repeat(9 * 1024 * 1024)] },
    ];
    for (const candidate of malformed) expect(databaseReadsMatch(db.db, candidate as DatabaseReadProof)).toBe(false);
    expect(db.all('SELECT caller FROM calls')).toEqual([{ caller: 1 }]);
  });
});

test('bounded capture stops retaining oversized query sets but preserves the computation', () => {
  withDatabase((db) => {
    const captured = withDatabaseReadRecording(db.db, () => {
      for (let i = 0; i < 20_001; i++) db.get('SELECT ? AS value', i);
      return 'completed';
    });
    expect(captured.result).toBe('completed');
    expect(captured.proof).toBeUndefined();
  });
});

test.each(Array.from({ length: 10 }, (_, index) => 20260910 + index))(
  'generated reference histories agree with direct query comparison (seed %i)',
  (seed) => {
    withDatabase((db, writer) => {
      // Keep every committed mutation visible through the separate reader, but
      // reuse SQLite's write-ahead journal instead of creating and unlinking a
      // rollback journal for each of the 20,000 generated edit checkpoints.
      // Crash durability is covered separately; these fixtures compare queries.
      writer.pragma('journal_mode = WAL');
      writer.pragma('synchronous = OFF');
      const update = writer.prepare('INSERT OR REPLACE INTO calls VALUES (?, ?)');
      const remove = writer.prepare('DELETE FROM calls WHERE caller = ?');
      const select = 'SELECT caller, callee FROM calls WHERE callee = ? ORDER BY caller';
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('fetch', 'send', 'other'), { minLength: 1, maxLength: 5 }),
          fc.array(
            fc.record({
              id: fc.integer({ min: 0, max: 8 }),
              target: fc.option(fc.constantFrom('fetch', 'send', 'other'), { nil: null }),
            }),
            { minLength: 20, maxLength: 20 },
          ),
          (targets, history) => {
            writer.exec('DELETE FROM calls');
            let previous = withDatabaseReadRecording(db.db, () => targets.map((target) => db.all(select, target)));
            for (const step of history) {
              if (step.target === null) remove.run(step.id);
              else update.run(step.id, step.target);
              const current = withDatabaseReadRecording(db.db, () => targets.map((target) => db.all(select, target)));
              const persisted = JSON.parse(JSON.stringify(previous.proof));
              expect(databaseReadsMatch(db.db, persisted)).toBe(isDeepStrictEqual(previous.result, current.result));
              previous = current;
            }
          },
        ),
        { numRuns: 100, seed },
      );
    });
  },
);
