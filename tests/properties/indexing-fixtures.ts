import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createEvidenceSchema } from '../fixtures/evidence-fixture.js';

export function writePropertyDatabase(path: string, state: ReadonlyMap<number, number>): void {
  const db = new Database(path);
  try {
    createEvidenceSchema(db);
    db.exec('CREATE INDEX idx_chunks_line_range ON chunks(document_id, start_line, end_line)');
    for (const [file, value] of state) {
      const id = file + 1;
      const name = `value${file}_${value}`;
      db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?)').run(id, 'typescript', `f${file}.ts`, 'UTF8', name);
      db.prepare('INSERT INTO global_symbols VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        `symbol/${name}`,
        name,
        13,
        `documentation:${name}`,
        null,
        null,
        null,
      );
      db.prepare('INSERT INTO defn_enclosing_ranges VALUES (?, ?, ?, 0, 0, 0, 1)').run(id, id, id);
      db.prepare('INSERT INTO chunks VALUES (?, ?, 0, 0, 1, ?)').run(id, id, Buffer.from(name));
      db.prepare('INSERT INTO mentions VALUES (?, ?, 1)').run(id, id);
    }
  } finally {
    db.close();
  }
}

export function assertPropertyDatabase(path: string, state: ReadonlyMap<number, number>): void {
  const db = new Database(path, { readonly: true });
  try {
    const facts = db
      .prepare(
        `SELECT d.relative_path AS path, d.text, s.symbol, s.documentation,
      r.start_line, r.end_char, m.role, c.occurrences
      FROM documents d JOIN defn_enclosing_ranges r ON r.document_id=d.id
      JOIN global_symbols s ON s.id=r.symbol_id JOIN chunks c ON c.document_id=d.id
      JOIN mentions m ON m.chunk_id=c.id AND m.symbol_id=s.id ORDER BY d.relative_path`,
      )
      .all();
    const expected = [...state]
      .sort(([a], [b]) => a - b)
      .map(([file, value]) => {
        const name = `value${file}_${value}`;
        return {
          path: `f${file}.ts`,
          text: name,
          symbol: `symbol/${name}`,
          documentation: `documentation:${name}`,
          start_line: 0,
          end_char: 1,
          role: 1,
          occurrences: Buffer.from(name),
        };
      });
    assert.deepEqual(facts, expected);
    for (const table of ['documents', 'global_symbols', 'defn_enclosing_ranges', 'mentions', 'chunks']) {
      assert.deepEqual(db.prepare(`SELECT count(*) AS count FROM ${table}`).get(), { count: state.size });
    }
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
}
