import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { create } from '@bufbuild/protobuf';
import {
  DocumentSchema,
  IndexSchema,
  OccurrenceSchema,
  serializeSCIP,
  SymbolInformationSchema,
  SymbolRole,
} from '@c4312/scip';
import {
  chunkOccurrenceRecords,
  convertScipBufferToSqlite,
  ScipSqliteConversionError,
} from '../../src/reindex/scip-sqlite-converter.js';
import { resolveScipBinary } from '../../src/platform/scip-cli.js';

const SYM = (name: string): string => `scip-typescript npm pkg 1.0.0 \`src/a.ts\`/${name}.`;

describe('SCIP SQLite converter', () => {
  let tempDir: string | null = null;
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function dbPath(name: string): string {
    tempDir ??= mkdtempSync(join(tmpdir(), 'scip-sqlite-converter-'));
    return join(tempDir, name);
  }

  it('chunks occurrences like the Go converter, never splitting a line', () => {
    const rec = (startLine: number): { startLine: number } => ({ startLine });
    // Boundary occurrences sharing a line extend the chunk.
    const sameLine = [rec(0), rec(1), rec(2), rec(2), rec(2), rec(3)];
    expect(chunkOccurrenceRecords(sameLine, 3).map((chunk) => chunk.length)).toEqual([5, 1]);
    // Exact multiples split cleanly.
    expect(chunkOccurrenceRecords([rec(0), rec(1), rec(2), rec(3)], 2).map((chunk) => chunk.length)).toEqual([2, 2]);
    // Fewer records than the chunk size produce one chunk.
    expect(chunkOccurrenceRecords([rec(5), rec(9)], 200)).toEqual([[rec(5), rec(9)]]);
    expect(chunkOccurrenceRecords([], 200)).toEqual([]);
  });

  function fixtureIndexBytes(): Buffer {
    const index = create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          language: 'typescript',
          relativePath: 'src/a.ts',
          text: 'const x = 1;\n',
          symbols: [
            create(SymbolInformationSchema, {
              symbol: SYM('run()'),
              displayName: 'run',
              kind: 17,
              documentation: ['first doc'],
            }),
            // A duplicate SymbolInformation merges documentation.
            create(SymbolInformationSchema, { symbol: SYM('run()'), documentation: ['second doc', 'first doc'] }),
            create(SymbolInformationSchema, { symbol: 'local 1', documentation: ['never stored'] }),
          ],
          occurrences: [
            // Out of order on purpose: canonicalization sorts by range.
            create(OccurrenceSchema, {
              symbol: SYM('helper()'),
              symbolRoles: 0,
              range: [4, 0, 6],
            }),
            create(OccurrenceSchema, {
              symbol: SYM('run()'),
              symbolRoles: SymbolRole.Definition,
              range: [0, 0, 0, 3],
              enclosingRange: [0, 0, 2, 1],
            }),
            // Same range and symbol twice: flattening merges the roles.
            create(OccurrenceSchema, { symbol: SYM('helper()'), symbolRoles: 0, range: [4, 0, 6] }),
            create(OccurrenceSchema, { symbol: 'local 1', symbolRoles: SymbolRole.Definition, range: [1, 2, 5] }),
            // No range: dropped like RemoveIllegalOccurrences.
            create(OccurrenceSchema, { symbol: SYM('ghost()'), symbolRoles: 0 }),
          ],
        }),
        create(DocumentSchema, {
          relativePath: 'src/b.ts',
          occurrences: [create(OccurrenceSchema, { symbol: SYM('run()'), symbolRoles: 0, range: [3, 1, 4] })],
        }),
        // Duplicate path: skipped entirely.
        create(DocumentSchema, {
          relativePath: 'src/a.ts',
          occurrences: [create(OccurrenceSchema, { symbol: SYM('dup()'), symbolRoles: 0, range: [9, 0, 1] })],
        }),
      ],
    });
    return Buffer.from(serializeSCIP(index));
  }

  it('converts documents, symbols, chunks, mentions, and enclosing ranges exactly', async () => {
    const out = dbPath('js.db');
    const stats = await convertScipBufferToSqlite(fixtureIndexBytes(), out);
    expect(stats).toMatchObject({
      documents: 2,
      duplicateDocumentsSkipped: 1,
      occurrences: 4,
      illegalOccurrencesDropped: 1,
      mergedOccurrences: 1,
      chunks: 2,
      enclosingRanges: 1,
    });

    const db = new Database(out, { readonly: true });
    try {
      expect(
        db.prepare('SELECT language, relative_path, position_encoding, text FROM documents ORDER BY id').all(),
      ).toEqual([
        { language: 'typescript', relative_path: 'src/a.ts', position_encoding: null, text: 'const x = 1;\n' },
        { language: null, relative_path: 'src/b.ts', position_encoding: null, text: null },
      ]);
      const symbols = db
        .prepare('SELECT symbol, display_name, kind, documentation FROM global_symbols ORDER BY symbol')
        .all() as { symbol: string; display_name: string | null; kind: number | null; documentation: string | null }[];
      // Locals are never stored; helper() arrives via its occurrence with no
      // SymbolInformation; run()'s duplicate entries merged documentation.
      expect(symbols).toEqual([
        { symbol: SYM('helper()'), display_name: null, kind: null, documentation: null },
        { symbol: SYM('run()'), display_name: 'run', kind: 17, documentation: 'first doc\nsecond doc' },
      ]);
      const mentions = db
        .prepare(
          `SELECT d.relative_path, s.symbol, m.role FROM mentions m
           JOIN chunks c ON m.chunk_id = c.id JOIN documents d ON c.document_id = d.id
           JOIN global_symbols s ON m.symbol_id = s.id ORDER BY d.relative_path, s.symbol, m.role`,
        )
        .all();
      expect(mentions).toEqual([
        { relative_path: 'src/a.ts', symbol: SYM('helper()'), role: 0 },
        { relative_path: 'src/a.ts', symbol: SYM('run()'), role: 1 },
        { relative_path: 'src/b.ts', symbol: SYM('run()'), role: 0 },
      ]);
      expect(
        db
          .prepare(
            `SELECT s.symbol, r.start_line, r.start_char, r.end_line, r.end_char FROM defn_enclosing_ranges r
             JOIN global_symbols s ON r.symbol_id = s.id`,
          )
          .all(),
      ).toEqual([{ symbol: SYM('run()'), start_line: 0, start_char: 0, end_line: 2, end_char: 1 }]);
      // The blob decodes to one frame per surviving occurrence in the chunk.
      const blobs = db.prepare('SELECT occurrences FROM chunks ORDER BY id').all() as { occurrences: Buffer }[];
      expect(blobs.map((row) => countFrames(zstdDecompressSync(row.occurrences)))).toEqual([3, 1]);
    } finally {
      db.close();
    }
  });

  it('rejects the failure cases the Go converter rejects', async () => {
    const emptyPath = Buffer.from(serializeSCIP(create(IndexSchema, { documents: [create(DocumentSchema, {})] })));
    await expect(convertScipBufferToSqlite(emptyPath, dbPath('e1.db'))).rejects.toThrow('relative path');

    const emptySymbol = Buffer.from(
      serializeSCIP(
        create(IndexSchema, {
          documents: [create(DocumentSchema, { relativePath: 'a.ts', symbols: [create(SymbolInformationSchema, {})] })],
        }),
      ),
    );
    await expect(convertScipBufferToSqlite(emptySymbol, dbPath('e2.db'))).rejects.toThrow('empty symbol');

    const danglingDefinition = Buffer.from(
      serializeSCIP(
        create(IndexSchema, {
          documents: [
            create(DocumentSchema, {
              relativePath: 'a.ts',
              occurrences: [
                create(OccurrenceSchema, {
                  symbol: SYM('ghost()'),
                  symbolRoles: SymbolRole.Definition,
                  range: [0, 0, 3],
                  enclosingRange: [0, 0, 1, 0],
                }),
              ],
            }),
          ],
        }),
      ),
    );
    await expect(convertScipBufferToSqlite(danglingDefinition, dbPath('e3.db'))).rejects.toThrow(
      'no SymbolInformation',
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      convertScipBufferToSqlite(fixtureIndexBytes(), dbPath('e4.db'), { signal: controller.signal }),
    ).rejects.toThrow(ScipSqliteConversionError);
  });

  it.each([1, 3])('rolls back partial writes when interrupted at document yield %i', async (yieldNumber) => {
    const controller = new AbortController();
    const out = dbPath(`interrupted-${yieldNumber}.db`);
    const buffer = Buffer.from(
      serializeSCIP(
        create(IndexSchema, {
          documents: Array.from({ length: 128 }, (_, i) =>
            create(DocumentSchema, {
              relativePath: `src/${i}.ts`,
              symbols: [create(SymbolInformationSchema, { symbol: SYM(`f${i}()`) })],
              occurrences: [
                create(OccurrenceSchema, {
                  symbol: SYM(`f${i}()`),
                  symbolRoles: SymbolRole.Definition,
                  range: [0, 0, 3],
                  enclosingRange: [0, 0, 1, 0],
                }),
              ],
            }),
          ),
        }),
      ),
    );
    let remaining = yieldNumber;
    const interrupt = (): void => {
      remaining -= 1;
      if (remaining === 0) controller.abort();
      else setImmediate(interrupt);
    };
    setImmediate(interrupt);
    await expect(convertScipBufferToSqlite(buffer, out, { signal: controller.signal })).rejects.toThrow(
      'conversion aborted',
    );
    const db = new Database(out);
    try {
      for (const table of ['documents', 'global_symbols', 'chunks', 'mentions', 'defn_enclosing_ranges']) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      // The failed converter released its connection and transaction.
      db.exec('BEGIN EXCLUSIVE; ROLLBACK;');
    } finally {
      db.close();
    }
  });

  it('resolves declarations from later documents before writing enclosing ranges', async () => {
    const symbol = SYM('later()');
    const out = dbPath('forward-declaration.db');
    const bytes = Buffer.from(
      serializeSCIP(
        create(IndexSchema, {
          documents: [
            create(DocumentSchema, {
              relativePath: 'first.ts',
              occurrences: [
                create(OccurrenceSchema, {
                  symbol,
                  symbolRoles: SymbolRole.Definition,
                  range: [0, 0, 3],
                  enclosingRange: [0, 0, 1, 0],
                }),
              ],
            }),
            create(DocumentSchema, {
              relativePath: 'later.ts',
              symbols: [create(SymbolInformationSchema, { symbol })],
            }),
          ],
        }),
      ),
    );
    expect(await convertScipBufferToSqlite(bytes, out)).toMatchObject({
      documents: 2,
      globalSymbols: 1,
      enclosingRanges: 1,
    });
    const db = new Database(out, { readonly: true });
    try {
      expect(
        db
          .prepare(
            'SELECT d.relative_path, s.symbol FROM defn_enclosing_ranges r JOIN documents d ON d.id = r.document_id JOIN global_symbols s ON s.id = r.symbol_id',
          )
          .all(),
      ).toEqual([{ relative_path: 'first.ts', symbol }]);
    } finally {
      db.close();
    }
  });

  const scipBinary = resolveScipBinary();
  it.skipIf(!scipBinary)('matches scip expt-convert row for row on the same index', async () => {
    const scipFile = dbPath('index.scip');
    writeFileSync(scipFile, fixtureIndexBytes());
    const goDb = dbPath('go.db');
    execFileSync(scipBinary!, ['expt-convert', '--output', goDb, scipFile]);
    const jsDb = dbPath('js-parity.db');
    await convertScipBufferToSqlite(fixtureIndexBytes(), jsDb);
    expect(canonicalRows(jsDb)).toEqual(canonicalRows(goDb));
  });
});

function countFrames(raw: Buffer): number {
  let frames = 0;
  let pos = 0;
  while (pos < raw.length) {
    let shift = 0;
    let tag = 0;
    for (;;) {
      const byte = raw[pos]!;
      pos += 1;
      tag += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    if (tag % 8 !== 2) throw new Error('unexpected wire type in occurrences blob');
    let length = 0;
    shift = 0;
    for (;;) {
      const byte = raw[pos]!;
      pos += 1;
      length += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    pos += length;
    frames += 1;
  }
  return frames;
}

function canonicalRows(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    return {
      schema: db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .all(),
      documents: db
        .prepare('SELECT language, relative_path, position_encoding, text FROM documents ORDER BY relative_path')
        .all(),
      symbols: db
        .prepare(
          'SELECT symbol, display_name, kind, documentation, enclosing_symbol FROM global_symbols ORDER BY symbol',
        )
        .all(),
      chunks: db
        .prepare(
          `SELECT d.relative_path, c.chunk_index, c.start_line, c.end_line FROM chunks c
           JOIN documents d ON c.document_id = d.id ORDER BY d.relative_path, c.chunk_index`,
        )
        .all(),
      mentions: db
        .prepare(
          `SELECT d.relative_path, c.chunk_index, s.symbol, m.role FROM mentions m
           JOIN chunks c ON m.chunk_id = c.id JOIN documents d ON c.document_id = d.id
           JOIN global_symbols s ON m.symbol_id = s.id ORDER BY d.relative_path, c.chunk_index, s.symbol, m.role`,
        )
        .all(),
      enclosing: db
        .prepare(
          `SELECT d.relative_path, s.symbol, r.start_line, r.start_char, r.end_line, r.end_char
           FROM defn_enclosing_ranges r JOIN documents d ON r.document_id = d.id
           JOIN global_symbols s ON r.symbol_id = s.id
           ORDER BY d.relative_path, s.symbol, r.start_line`,
        )
        .all(),
    };
  } finally {
    db.close();
  }
}
