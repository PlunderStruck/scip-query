import Database from 'better-sqlite3';
import { zstdCompressSync } from 'node:zlib';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { eachWireField, encodeLengthDelimitedTag, encodeVarint } from './scip-wire.js';

/**
 * Streaming SCIP → SQLite conversion, a byte-compatible replacement for
 * `scip expt-convert` (sourcegraph/scip cmd/scip/convert.go). The relational
 * output — DDL, indexes, documents, global_symbols, chunk boundaries,
 * mentions, and defn_enclosing_ranges — reproduces the Go converter exactly
 * (row ids aside, which no consumer interprets). The `chunks.occurrences`
 * blob keeps the same shape (zstd-compressed `Document{occurrences}`) but is
 * built from verbatim input frames, so its exact bytes may differ from the Go
 * encoder's; no reader decodes that blob positionally, and parity for it is
 * semantic (same occurrences), not byte-level.
 *
 * The walker reads only the classic `repeated int32 range`/`enclosing_range`
 * encodings that every supported indexer emits; an occurrence without one is
 * dropped exactly like the Go binding's RemoveIllegalOccurrences.
 */
export class ScipSqliteConversionError extends Error {}

/** Occurrences per chunk before extending to a line boundary (Go: chunkSizeHint). */
export const SCIP_SQLITE_CHUNK_SIZE = 200;

const INDEX_DOCUMENT_FIELD = 2;
const DOC_RELATIVE_PATH = 1;
const DOC_OCCURRENCES = 2;
const DOC_SYMBOLS = 3;
const DOC_LANGUAGE = 4;
const DOC_TEXT = 5;
const DOC_POSITION_ENCODING = 6;
const OCC_RANGE = 1;
const OCC_SYMBOL = 2;
const OCC_SYMBOL_ROLES = 3;
const OCC_ENCLOSING_RANGE = 7;
const SYM_SYMBOL = 1;
const SYM_DOCUMENTATION = 3;
const SYM_KIND = 5;
const SYM_DISPLAY_NAME = 6;
const SYM_ENCLOSING_SYMBOL = 8;
const SYMBOL_ROLE_DEFINITION = 1;
const CONVERSION_YIELD_INTERVAL_DOCUMENTS = 64;

// The DDL, pragma, and index statements are copied verbatim from
// cmd/scip/convert.go so `sqlite_master` is byte-identical to the Go tool's.
const CREATE_STATEMENTS = [
  `CREATE TABLE documents (
			id INTEGER PRIMARY KEY,
			language TEXT,
			relative_path TEXT NOT NULL UNIQUE,
			position_encoding TEXT,
			text TEXT
		)`,
  `CREATE TABLE chunks (
			id INTEGER PRIMARY KEY,
			document_id INTEGER NOT NULL,
			chunk_index INTEGER NOT NULL,
			start_line INTEGER NOT NULL,
			end_line INTEGER NOT NULL,
			occurrences BLOB NOT NULL,
			FOREIGN KEY (document_id) REFERENCES documents(id)
		)`,
  `CREATE TABLE global_symbols (
			id INTEGER PRIMARY KEY,
			symbol TEXT NOT NULL UNIQUE,
			display_name TEXT,
			kind INTEGER,
			documentation TEXT,
			signature BLOB,
			enclosing_symbol TEXT,
			relationships BLOB
		)`,
  `CREATE TABLE mentions (
			chunk_id INTEGER NOT NULL,
			symbol_id INTEGER NOT NULL,
			role INTEGER NOT NULL,
			PRIMARY KEY (chunk_id, symbol_id, role),
			FOREIGN KEY (chunk_id) REFERENCES chunks(id),
			FOREIGN KEY (symbol_id) REFERENCES global_symbols(id)
		)`,
  `CREATE TABLE defn_enclosing_ranges (
			id INTEGER PRIMARY KEY,
			document_id INTEGER NOT NULL,
			symbol_id INTEGER NOT NULL,
			start_line INTEGER NOT NULL,
			start_char INTEGER NOT NULL,
			end_line INTEGER NOT NULL,
			end_char INTEGER NOT NULL,
			FOREIGN KEY (document_id) REFERENCES documents(id),
			FOREIGN KEY (symbol_id) REFERENCES global_symbols(id)
		)`,
];

const INDEX_STATEMENTS = [
  `CREATE INDEX idx_chunks_line_range ON chunks(document_id, start_line, end_line)`,
  `CREATE INDEX idx_mentions_symbol_id_role ON mentions(symbol_id, role)`,
  `CREATE INDEX idx_defn_enclosing_ranges_symbol_id ON defn_enclosing_ranges(symbol_id)`,
  `CREATE INDEX idx_defn_enclosing_ranges_document ON defn_enclosing_ranges(document_id, start_line, end_line)`,
  `CREATE INDEX idx_chunks_doc_id ON chunks(document_id)`,
  `CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol)`,
];

export interface ScipSqliteConversionStats {
  documents: number;
  duplicateDocumentsSkipped: number;
  occurrences: number;
  illegalOccurrencesDropped: number;
  mergedOccurrences: number;
  chunks: number;
  mentions: number;
  globalSymbols: number;
  enclosingRanges: number;
}

interface OccurrenceRecord {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  symbol: string;
  roles: number;
  /** Verbatim field frame (tag + length + payload) in the input buffer. */
  frameStart: number;
  frameEnd: number;
  /** Set when flattening merged another occurrence into this one. */
  merged: boolean;
  enclosing: readonly [number, number, number, number] | null;
}

interface SymbolRecord {
  symbol: string;
  displayName: string | null;
  kind: number | null;
  documentation: string[];
  enclosingSymbol: string | null;
}

function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith('local ');
}

function readPackedInt32s(buffer: Uint8Array, start: number, end: number, into: number[]): void {
  let pos = start;
  let value = 0;
  let shift = 0;
  while (pos < end) {
    const byte = buffer[pos]!;
    pos += 1;
    if (shift < 53) value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      into.push(value);
      value = 0;
      shift = 0;
    } else {
      shift += 7;
    }
  }
}

function normalizeRange(values: readonly number[]): readonly [number, number, number, number] | null {
  if (values.length === 3) return [values[0]!, values[1]!, values[0]!, values[2]!];
  if (values.length === 4) return [values[0]!, values[1]!, values[2]!, values[3]!];
  return null;
}

// Go orders occurrences by Range.CompareStrict then strings.Compare on the
// symbol. Symbols in practice are ASCII, where JS string comparison matches
// Go's byte order.
function compareOccurrences(left: OccurrenceRecord, right: OccurrenceRecord): number {
  if (left.startLine !== right.startLine) return left.startLine - right.startLine;
  if (left.startChar !== right.startChar) return left.startChar - right.startChar;
  if (left.endLine !== right.endLine) return left.endLine - right.endLine;
  if (left.endChar !== right.endChar) return left.endChar - right.endChar;
  return left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0;
}

function parseOccurrence(buffer: Uint8Array, frameStart: number, start: number, end: number): OccurrenceRecord | null {
  const range: number[] = [];
  const enclosing: number[] = [];
  let symbol = '';
  let roles = 0;
  for (const field of eachWireField(buffer, start, end)) {
    if (field.fieldNumber === OCC_RANGE) {
      if (field.wireType === 2) readPackedInt32s(buffer, field.valueStart, field.valueEnd, range);
      else if (field.wireType === 0) range.push(field.varint);
    } else if (field.fieldNumber === OCC_SYMBOL && field.wireType === 2) {
      symbol = textDecoder.decode(buffer.subarray(field.valueStart, field.valueEnd));
    } else if (field.fieldNumber === OCC_SYMBOL_ROLES && field.wireType === 0) {
      roles = field.varint;
    } else if (field.fieldNumber === OCC_ENCLOSING_RANGE) {
      if (field.wireType === 2) readPackedInt32s(buffer, field.valueStart, field.valueEnd, enclosing);
      else if (field.wireType === 0) enclosing.push(field.varint);
    }
  }
  const normalized = normalizeRange(range);
  if (!normalized) return null;
  return {
    startLine: normalized[0],
    startChar: normalized[1],
    endLine: normalized[2],
    endChar: normalized[3],
    symbol,
    roles,
    frameStart,
    frameEnd: end,
    merged: false,
    enclosing: normalizeRange(enclosing),
  };
}

function parseSymbolInformation(buffer: Uint8Array, start: number, end: number): SymbolRecord {
  const record: SymbolRecord = { symbol: '', displayName: null, kind: null, documentation: [], enclosingSymbol: null };
  for (const field of eachWireField(buffer, start, end)) {
    if (field.wireType === 2) {
      const text = () => textDecoder.decode(buffer.subarray(field.valueStart, field.valueEnd));
      if (field.fieldNumber === SYM_SYMBOL) record.symbol = text();
      else if (field.fieldNumber === SYM_DOCUMENTATION) record.documentation.push(text());
      else if (field.fieldNumber === SYM_DISPLAY_NAME) record.displayName = text();
      else if (field.fieldNumber === SYM_ENCLOSING_SYMBOL) record.enclosingSymbol = text();
    } else if (field.fieldNumber === SYM_KIND && field.wireType === 0) {
      record.kind = field.varint;
    }
  }
  return record;
}

const textDecoder = new TextDecoder();

/** Go's chunkOccurrences: ~chunkSize occurrences, never splitting a line. */
export function chunkOccurrenceRecords<T extends { startLine: number }>(
  records: readonly T[],
  chunkSize: number,
): T[][] {
  if (records.length === 0) return [];
  const chunks: T[][] = [];
  let hi = Math.min(records.length, chunkSize);
  for (let lo = 0; lo < hi && hi <= records.length; ) {
    while (hi <= records.length - 1 && records[hi - 1]!.startLine === records[hi]!.startLine) hi += 1;
    chunks.push(records.slice(lo, hi));
    lo = hi;
    hi = Math.min(records.length, hi + chunkSize);
  }
  return chunks;
}

function encodeMergedOccurrence(record: OccurrenceRecord): Uint8Array {
  // Re-encode a flatten-merged occurrence with combined roles, using the
  // canonical compact range form. Merged occurrences require identical
  // range+symbol duplicates in the input, which supported indexers do not
  // emit; the minimal field set matches what conversion consumes.
  const range =
    record.startLine === record.endLine
      ? [record.startLine, record.startChar, record.endChar]
      : [record.startLine, record.startChar, record.endLine, record.endChar];
  const parts: Uint8Array[] = [];
  const packed = Buffer.concat(range.map((value) => encodeVarint(value)));
  parts.push(encodeLengthDelimitedTag(OCC_RANGE), encodeVarint(packed.length), packed);
  const symbolBytes = Buffer.from(record.symbol, 'utf8');
  parts.push(encodeLengthDelimitedTag(OCC_SYMBOL), encodeVarint(symbolBytes.length), symbolBytes);
  if (record.roles !== 0) {
    parts.push(encodeVarint(OCC_SYMBOL_ROLES * 8), encodeVarint(record.roles));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([encodeLengthDelimitedTag(INDEX_DOCUMENT_FIELD), encodeVarint(body.length), body]);
}

function chunkOccurrencesBlob(buffer: Uint8Array, records: readonly OccurrenceRecord[]): Buffer {
  const frames: Uint8Array[] = [];
  for (const record of records) {
    if (record.merged) {
      frames.push(encodeMergedOccurrence(record));
    } else {
      frames.push(buffer.subarray(record.frameStart, record.frameEnd));
    }
  }
  return zstdCompressSync(Buffer.concat(frames));
}

function readDocumentDeclarations(buffer: Uint8Array, start: number, end: number) {
  let relativePath = '';
  let language: string | null = null;
  let text: string | null = null;
  let positionEncoding: string | null = null;
  const declaredSymbols: SymbolRecord[] = [];
  for (const docField of eachWireField(buffer, start, end)) {
    if (docField.wireType === 2) {
      if (docField.fieldNumber === DOC_RELATIVE_PATH) {
        relativePath = textDecoder.decode(buffer.subarray(docField.valueStart, docField.valueEnd));
      } else if (docField.fieldNumber === DOC_SYMBOLS) {
        declaredSymbols.push(parseSymbolInformation(buffer, docField.valueStart, docField.valueEnd));
      } else if (docField.fieldNumber === DOC_LANGUAGE) {
        language = textDecoder.decode(buffer.subarray(docField.valueStart, docField.valueEnd));
      } else if (docField.fieldNumber === DOC_TEXT) {
        text = textDecoder.decode(buffer.subarray(docField.valueStart, docField.valueEnd));
      }
    } else if (docField.fieldNumber === DOC_POSITION_ENCODING && docField.wireType === 0) {
      positionEncoding = positionEncodingName(docField.varint);
    }
  }
  return { relativePath, language, text, positionEncoding, declaredSymbols };
}

function flattenDeclaredSymbols(declaredSymbols: SymbolRecord[], relativePath: string): SymbolRecord[] {
  const flattened = new Map<string, SymbolRecord>();
  for (const symbol of declaredSymbols) {
    if (symbol.symbol === '') {
      throw new ScipSqliteConversionError(`empty symbol in SymbolInformation for document ${relativePath}`);
    }
    const existing = flattened.get(symbol.symbol);
    if (!existing) {
      flattened.set(symbol.symbol, symbol);
      continue;
    }
    for (const doc of symbol.documentation) {
      if (!existing.documentation.includes(doc)) existing.documentation.push(doc);
    }
  }
  return [...flattened.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

function readDocumentOccurrences(buffer: Uint8Array, start: number, end: number, stats: ScipSqliteConversionStats) {
  let relativePath = '';
  const records: OccurrenceRecord[] = [];
  for (const docField of eachWireField(buffer, start, end)) {
    if (docField.wireType !== 2) continue;
    if (docField.fieldNumber === DOC_RELATIVE_PATH) {
      relativePath = textDecoder.decode(buffer.subarray(docField.valueStart, docField.valueEnd));
    } else if (docField.fieldNumber === DOC_OCCURRENCES) {
      const record = parseOccurrence(buffer, docField.fieldStart, docField.valueStart, docField.valueEnd);
      if (record) records.push(record);
      else stats.illegalOccurrencesDropped += 1;
    }
  }
  return { relativePath, records };
}

function flattenOccurrences(records: OccurrenceRecord[], stats: ScipSqliteConversionStats): OccurrenceRecord[] {
  records.sort(compareOccurrences);
  const occurrences: OccurrenceRecord[] = [];
  for (const record of records) {
    const top = occurrences[occurrences.length - 1];
    if (
      top &&
      top.startLine === record.startLine &&
      top.startChar === record.startChar &&
      top.endLine === record.endLine &&
      top.endChar === record.endChar &&
      top.symbol === record.symbol
    ) {
      top.roles |= record.roles;
      top.merged = true;
      stats.mergedOccurrences += 1;
      continue;
    }
    occurrences.push(record);
  }
  stats.occurrences += occurrences.length;
  return occurrences;
}

function validateEnclosingRange(range: NonNullable<OccurrenceRecord['enclosing']>, symbol: string, file: string): void {
  const [startLine, startChar, endLine, endChar] = range;
  if (startLine < 0 || startChar < 0 || endLine < startLine || (endLine === startLine && endChar < startChar)) {
    throw new ScipSqliteConversionError(`bad enclosing range for symbol ${symbol} in ${file}`);
  }
}

class ConversionWriter {
  private readonly insertDocument: Database.Statement;
  private readonly insertChunk: Database.Statement;
  private readonly insertEnclosing: Database.Statement;
  private readonly insertSymbol: Database.Statement;
  private readonly insertMention: Database.Statement;
  constructor(
    db: Database.Database,
    private readonly stats: ScipSqliteConversionStats,
  ) {
    this.insertDocument = db.prepare(
      'INSERT INTO documents (id, language, relative_path, position_encoding, text) VALUES (?, ?, ?, ?, ?)',
    );
    this.insertChunk = db.prepare(
      'INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.insertEnclosing = db.prepare(
      'INSERT INTO defn_enclosing_ranges (document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.insertSymbol = db.prepare(
      'INSERT INTO global_symbols (id, symbol, display_name, kind, documentation, enclosing_symbol) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.insertMention = db.prepare('INSERT INTO mentions (chunk_id, symbol_id, role) VALUES (?, ?, ?)');
  }
  readonly documentIds = new Map<string, number>();
  private readonly symbolIds = new Map<string, number>();
  // Ids are assigned in insertion order in JS, so no insert needs a
  // lastInsertRowid round-trip. Rows stay single-statement on purpose:
  // multi-row VALUES batches into global_symbols measured pathologically
  // slow here (SQLite spent whole seconds in b-tree scans per batch), while
  // single-row prepared inserts complete the whole index in a few seconds.
  private nextDocumentId = 1;
  private nextChunkId = 1;
  private nextSymbolId = 1;
  private addSymbol(
    symbol: string,
    displayName: string | null,
    kind: number | null,
    documentation: string | null,
    enclosingSymbol: string | null,
  ): number {
    const id = this.nextSymbolId;
    this.nextSymbolId += 1;
    this.symbolIds.set(symbol, id);
    this.insertSymbol.run(id, symbol, displayName, kind, documentation, enclosingSymbol);
    this.stats.globalSymbols += 1;
    return id;
  }

  writeDeclarations(document: ReturnType<typeof readDocumentDeclarations>): void {
    const { relativePath, language, text, positionEncoding, declaredSymbols } = document;
    if (relativePath === '') throw new ScipSqliteConversionError('relative path must not be empty');
    if (this.documentIds.has(relativePath)) {
      this.stats.duplicateDocumentsSkipped += 1;
      return;
    }
    const documentId = this.nextDocumentId;
    this.nextDocumentId += 1;
    this.insertDocument.run(
      documentId,
      language === '' ? null : language,
      relativePath,
      positionEncoding,
      text === '' ? null : text,
    );
    this.documentIds.set(relativePath, documentId);
    this.stats.documents += 1;

    this.writeDeclaredSymbols(flattenDeclaredSymbols(declaredSymbols, relativePath));
  }

  private writeDeclaredSymbols(symbols: SymbolRecord[]): void {
    for (const symbol of symbols) {
      if (isLocalSymbol(symbol.symbol) || this.symbolIds.has(symbol.symbol)) continue;
      this.addSymbol(
        symbol.symbol,
        symbol.displayName === '' ? null : symbol.displayName,
        symbol.kind === 0 ? null : symbol.kind,
        symbol.documentation.length === 0 ? null : symbol.documentation.join('\n'),
        symbol.enclosingSymbol === '' ? null : symbol.enclosingSymbol,
      );
    }
  }

  writeEnclosingRanges(documentId: number, relativePath: string, occurrences: OccurrenceRecord[]): void {
    // Enclosing ranges precede this document's occurrence-discovered
    // symbols, matching the Go converter's lookup semantics.
    for (const record of occurrences) {
      if ((record.roles & SYMBOL_ROLE_DEFINITION) === 0 || isLocalSymbol(record.symbol) || !record.enclosing) {
        continue;
      }
      const [startLine, startChar, endLine, endChar] = record.enclosing;
      validateEnclosingRange(record.enclosing, record.symbol, relativePath);
      const symbolId = this.symbolIds.get(record.symbol);
      if (symbolId === undefined) {
        throw new ScipSqliteConversionError(
          `symbol ${record.symbol} has definition occurrence, but no SymbolInformation`,
        );
      }
      this.insertEnclosing.run(documentId, symbolId, startLine, startChar, endLine, endChar);
      this.stats.enclosingRanges += 1;
    }
  }

  writeChunks(buffer: Uint8Array, documentId: number, occurrences: OccurrenceRecord[], chunkSize: number): void {
    for (const [chunkIndex, chunk] of chunkOccurrenceRecords(occurrences, chunkSize).entries()) {
      const chunkId = this.nextChunkId;
      this.nextChunkId += 1;
      this.insertChunk.run(
        chunkId,
        documentId,
        chunkIndex,
        chunk[0]!.startLine,
        chunk[chunk.length - 1]!.startLine,
        chunkOccurrencesBlob(buffer, chunk),
      );
      this.stats.chunks += 1;
      this.writeMentions(chunkId, chunk);
    }
  }

  private writeMentions(chunkId: number, chunk: readonly OccurrenceRecord[]): void {
    const roleSets = new Map<string, Set<number>>();
    for (const record of chunk) {
      if (isLocalSymbol(record.symbol)) continue;
      let roles = roleSets.get(record.symbol);
      if (!roles) roleSets.set(record.symbol, (roles = new Set()));
      roles.add(record.roles);
      if (!this.symbolIds.has(record.symbol)) this.addSymbol(record.symbol, null, null, null, null);
    }
    for (const [symbol, roles] of roleSets) {
      const symbolId = this.symbolIds.get(symbol)!;
      for (const role of roles) {
        this.insertMention.run(chunkId, symbolId, role);
        this.stats.mentions += 1;
      }
    }
  }
}

// Both passes visit wire documents in index order and yield at the same boundaries.
async function visitIndexDocuments(
  buffer: Uint8Array,
  signal: AbortSignal | undefined,
  visit: (start: number, end: number) => void,
): Promise<void> {
  let documentsSinceYield = 0;
  for (const field of eachWireField(buffer)) {
    if (field.fieldNumber !== INDEX_DOCUMENT_FIELD || field.wireType !== 2) continue;
    throwIfAborted(signal);
    documentsSinceYield += 1;
    if (documentsSinceYield >= CONVERSION_YIELD_INTERVAL_DOCUMENTS) {
      documentsSinceYield = 0;
      await yieldToEventLoop();
    }
    visit(field.valueStart, field.valueEnd);
  }
}

/**
 * Converts one SCIP index file (already read into memory) into a fresh SQLite
 * database at `outputDbPath`. Two streaming
 * passes mirror the Go converter's phases: documents plus their declared
 * symbols first, then occurrence-derived rows, so symbol ids exist before
 * enclosing-range rows reference them.
 */
export async function convertScipBufferToSqlite(
  buffer: Uint8Array,
  outputDbPath: string,
  opts: { chunkSize?: number; signal?: AbortSignal } = {},
): Promise<ScipSqliteConversionStats> {
  const chunkSize = opts.chunkSize ?? SCIP_SQLITE_CHUNK_SIZE;
  const stats: ScipSqliteConversionStats = {
    documents: 0,
    duplicateDocumentsSkipped: 0,
    occurrences: 0,
    illegalOccurrencesDropped: 0,
    mergedOccurrences: 0,
    chunks: 0,
    mentions: 0,
    globalSymbols: 0,
    enclosingRanges: 0,
  };
  const db = new Database(outputDbPath);
  try {
    db.pragma('synchronous = normal');
    db.pragma('temp_store = memory');
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    for (const statement of CREATE_STATEMENTS) db.exec(statement);

    const writer = new ConversionWriter(db, stats);
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      // All declarations must exist before occurrence-derived rows are written.
      await visitIndexDocuments(buffer, opts.signal, (start, end) => {
        writer.writeDeclarations(readDocumentDeclarations(buffer, start, end));
      });
      const seenPaths = new Set<string>();
      await visitIndexDocuments(buffer, opts.signal, (start, end) => {
        const { relativePath, records } = readDocumentOccurrences(buffer, start, end, stats);
        if (seenPaths.has(relativePath)) return;
        seenPaths.add(relativePath);
        const documentId = writer.documentIds.get(relativePath);
        if (documentId === undefined) return;
        const occurrences = flattenOccurrences(records, stats);
        writer.writeEnclosingRanges(documentId, relativePath, occurrences);
        writer.writeChunks(buffer, documentId, occurrences, chunkSize);
      });
      db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The transaction may already be gone; the surrounding error wins.
        }
      }
    }
    db.exec('BEGIN IMMEDIATE');
    for (const statement of INDEX_STATEMENTS) db.exec(statement);
    db.exec('COMMIT');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  return stats;
}

function positionEncodingName(value: number): string | null {
  if (value === 0) return null;
  if (value === 1) return 'UTF-8';
  if (value === 2) return 'UTF-16';
  if (value === 3) return 'UTF-32';
  throw new ScipSqliteConversionError(`unknown position encoding ${value}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ScipSqliteConversionError('SCIP SQLite conversion aborted');
}
