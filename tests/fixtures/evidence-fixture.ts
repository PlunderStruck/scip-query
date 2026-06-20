import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const schemaSql = `
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
`;

export function createEvidenceSchema(sqliteDb: Database.Database): void {
  sqliteDb.exec(schemaSql);
}

export function writeFixtureFiles(
  projectRoot: string,
  files: Record<string, readonly string[] | string>,
): void {
  for (const [relativePath, source] of Object.entries(files)) {
    const fullPath = join(projectRoot, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, Array.isArray(source) ? `${source.join('\n')}\n` : source);
  }
}

export function evidenceFixtureDb(dbPath: string): EvidenceFixtureDb {
  return new EvidenceFixtureDb(dbPath);
}

class EvidenceFixtureDb {
  private readonly documents: Array<{
    id: number;
    language: string | null;
    relativePath: string;
  }> = [];
  private readonly symbols: Array<{
    id: number;
    symbol: string;
    displayName: string;
    kind: number | null;
    documentation: string | null;
  }> = [];
  private readonly definitions: Array<{
    id: number;
    documentId: number;
    symbolId: number;
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
  }> = [];
  private readonly chunks: Array<{
    id: number;
    documentId: number;
    chunkIndex: number;
    startLine: number;
    endLine: number;
  }> = [];
  private readonly mentions: Array<{
    chunkId: number;
    symbolId: number;
    role: number;
  }> = [];

  constructor(private readonly dbPath: string) {}

  document(id: number, language: string | null, relativePath: string): this {
    this.documents.push({ id, language, relativePath });
    return this;
  }

  symbol(
    id: number,
    symbol: string,
    displayName: string,
    kind: number | null = null,
    documentation: string | null = null,
  ): this {
    this.symbols.push({ id, symbol, displayName, kind, documentation });
    return this;
  }

  definition(
    id: number,
    documentId: number,
    symbolId: number,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ): this {
    this.definitions.push({ id, documentId, symbolId, startLine, startChar, endLine, endChar });
    return this;
  }

  chunk(
    id: number,
    documentId: number,
    startLine: number,
    endLine: number,
    chunkIndex = 0,
  ): this {
    this.chunks.push({ id, documentId, chunkIndex, startLine, endLine });
    return this;
  }

  mention(chunkId: number, symbolId: number, role: number): this {
    this.mentions.push({ chunkId, symbolId, role });
    return this;
  }

  write(): void {
    const sqliteDb = new Database(this.dbPath);
    try {
      createEvidenceSchema(sqliteDb);
      this.insertDocuments(sqliteDb);
      this.insertSymbols(sqliteDb);
      this.insertDefinitions(sqliteDb);
      this.insertChunks(sqliteDb);
      this.insertMentions(sqliteDb);
    } finally {
      sqliteDb.close();
    }
  }

  private insertDocuments(sqliteDb: Database.Database): void {
    const stmt = sqliteDb.prepare(
      'INSERT INTO documents (id, language, relative_path) VALUES (?, ?, ?)',
    );
    for (const doc of this.documents) stmt.run(doc.id, doc.language, doc.relativePath);
  }

  private insertSymbols(sqliteDb: Database.Database): void {
    const stmt = sqliteDb.prepare(
      `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const symbol of this.symbols) {
      stmt.run(symbol.id, symbol.symbol, symbol.displayName, symbol.kind, symbol.documentation);
    }
  }

  private insertDefinitions(sqliteDb: Database.Database): void {
    const stmt = sqliteDb.prepare(
      `INSERT INTO defn_enclosing_ranges
       (id, document_id, symbol_id, start_line, start_char, end_line, end_char)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const def of this.definitions) {
      stmt.run(def.id, def.documentId, def.symbolId, def.startLine, def.startChar, def.endLine, def.endChar);
    }
  }

  private insertChunks(sqliteDb: Database.Database): void {
    const stmt = sqliteDb.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences)
       VALUES (?, ?, ?, ?, ?, X'00')`,
    );
    for (const chunk of this.chunks) {
      stmt.run(chunk.id, chunk.documentId, chunk.chunkIndex, chunk.startLine, chunk.endLine);
    }
  }

  private insertMentions(sqliteDb: Database.Database): void {
    const stmt = sqliteDb.prepare(
      'INSERT INTO mentions (chunk_id, symbol_id, role) VALUES (?, ?, ?)',
    );
    for (const mention of this.mentions) stmt.run(mention.chunkId, mention.symbolId, mention.role);
  }
}
