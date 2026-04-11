import Database from 'better-sqlite3';

export const advancedFixture = {
  files: {
    entry: 'app/entry.ts',
    controller: 'app/controller.ts',
    service: 'app/service.ts',
    math: 'core/math.ts',
    state: 'core/state.ts',
    http: 'infra/http.ts',
    view: 'ui/view.ts',
    utils: 'shared/utils.ts',
    types: 'shared/types.ts',
    extra: 'shared/extra.ts',
  },
  symbols: {
    start: 'scip-typescript npm my-app 1.0.0 app/`entry.ts`/start().',
    handle: 'scip-typescript npm my-app 1.0.0 app/`controller.ts`/handle().',
    process: 'scip-typescript npm my-app 1.0.0 app/`service.ts`/process().',
    prepare: 'scip-typescript npm my-app 1.0.0 app/`service.ts`/prepare().',
    add: 'scip-typescript npm my-app 1.0.0 core/`math.ts`/add().',
    mul: 'scip-typescript npm my-app 1.0.0 core/`math.ts`/mul().',
    pipeline: 'scip-typescript npm my-app 1.0.0 core/`math.ts`/pipeline().',
    state: 'scip-typescript npm my-app 1.0.0 core/`state.ts`/State#',
    fetchData: 'scip-typescript npm my-app 1.0.0 infra/`http.ts`/fetchData().',
    render: 'scip-typescript npm my-app 1.0.0 ui/`view.ts`/render().',
    normalize: 'scip-typescript npm my-app 1.0.0 shared/`utils.ts`/normalize().',
    response: 'scip-typescript npm my-app 1.0.0 shared/`types.ts`/Response#',
    extra: 'scip-typescript npm my-app 1.0.0 shared/`extra.ts`/Extra#',
  },
} as const;

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

const documents = [
  { id: 1, language: 'typescript', relativePath: advancedFixture.files.entry },
  { id: 2, language: 'typescript', relativePath: advancedFixture.files.controller },
  { id: 3, language: 'typescript', relativePath: advancedFixture.files.service },
  { id: 4, language: 'typescript', relativePath: advancedFixture.files.math },
  { id: 5, language: 'typescript', relativePath: advancedFixture.files.state },
  { id: 6, language: 'typescript', relativePath: advancedFixture.files.http },
  { id: 7, language: 'typescript', relativePath: advancedFixture.files.view },
  { id: 8, language: 'typescript', relativePath: advancedFixture.files.utils },
  { id: 9, language: 'typescript', relativePath: advancedFixture.files.types },
  { id: 10, language: 'typescript', relativePath: advancedFixture.files.extra },
] as const;

const symbols = [
  { id: 1, symbol: advancedFixture.symbols.start, displayName: 'start', kind: 2, documentation: 'Entry point' },
  { id: 2, symbol: advancedFixture.symbols.handle, displayName: 'handle', kind: 2, documentation: 'Controller' },
  { id: 3, symbol: advancedFixture.symbols.process, displayName: 'process', kind: 2, documentation: 'Service' },
  { id: 4, symbol: advancedFixture.symbols.prepare, displayName: 'prepare', kind: 2, documentation: 'Service prep' },
  { id: 5, symbol: advancedFixture.symbols.add, displayName: 'add', kind: 2, documentation: 'Math helper' },
  { id: 6, symbol: advancedFixture.symbols.mul, displayName: 'mul', kind: 2, documentation: 'Math helper' },
  { id: 7, symbol: advancedFixture.symbols.pipeline, displayName: 'pipeline', kind: 2, documentation: 'Math pipeline' },
  { id: 8, symbol: advancedFixture.symbols.state, displayName: 'State', kind: 1, documentation: 'Shared state type' },
  { id: 9, symbol: advancedFixture.symbols.fetchData, displayName: 'fetchData', kind: 2, documentation: 'HTTP fetch' },
  { id: 10, symbol: advancedFixture.symbols.render, displayName: 'render', kind: 2, documentation: 'View render' },
  { id: 11, symbol: advancedFixture.symbols.normalize, displayName: 'normalize', kind: 2, documentation: 'Shared normalization' },
  { id: 12, symbol: advancedFixture.symbols.response, displayName: 'Response', kind: 1, documentation: 'HTTP response type' },
  { id: 13, symbol: advancedFixture.symbols.extra, displayName: 'Extra', kind: 1, documentation: 'Extra type' },
] as const;

const definitions = [
  { id: 1, documentId: 1, symbolId: 1, startLine: 1, endLine: 24 },
  { id: 2, documentId: 2, symbolId: 2, startLine: 1, endLine: 26 },
  { id: 3, documentId: 3, symbolId: 4, startLine: 1, endLine: 8 },
  { id: 4, documentId: 3, symbolId: 3, startLine: 10, endLine: 44 },
  { id: 5, documentId: 4, symbolId: 5, startLine: 1, endLine: 6 },
  { id: 6, documentId: 4, symbolId: 6, startLine: 8, endLine: 13 },
  { id: 7, documentId: 4, symbolId: 7, startLine: 15, endLine: 34 },
  { id: 8, documentId: 5, symbolId: 8, startLine: 1, endLine: 7 },
  { id: 9, documentId: 6, symbolId: 9, startLine: 1, endLine: 20 },
  { id: 10, documentId: 7, symbolId: 10, startLine: 1, endLine: 18 },
  { id: 11, documentId: 8, symbolId: 11, startLine: 1, endLine: 12 },
  { id: 12, documentId: 9, symbolId: 12, startLine: 1, endLine: 9 },
  { id: 13, documentId: 10, symbolId: 13, startLine: 1, endLine: 8 },
] as const;

const chunks = [
  { id: 1, documentId: 1, startLine: 1, endLine: 24 },
  { id: 2, documentId: 2, startLine: 1, endLine: 26 },
  { id: 3, documentId: 3, startLine: 1, endLine: 8 },
  { id: 4, documentId: 3, startLine: 10, endLine: 44 },
  { id: 5, documentId: 4, startLine: 1, endLine: 6 },
  { id: 6, documentId: 4, startLine: 8, endLine: 13 },
  { id: 7, documentId: 4, startLine: 15, endLine: 34 },
  { id: 8, documentId: 5, startLine: 1, endLine: 7 },
  { id: 9, documentId: 6, startLine: 1, endLine: 20 },
  { id: 10, documentId: 7, startLine: 1, endLine: 18 },
  { id: 11, documentId: 8, startLine: 1, endLine: 12 },
  { id: 12, documentId: 9, startLine: 1, endLine: 9 },
  { id: 13, documentId: 10, startLine: 1, endLine: 8 },
] as const;

const mentions = [
  // Definitions
  { chunkId: 1, symbolId: 1, role: 1 },
  { chunkId: 2, symbolId: 2, role: 1 },
  { chunkId: 3, symbolId: 4, role: 1 },
  { chunkId: 4, symbolId: 3, role: 1 },
  { chunkId: 5, symbolId: 5, role: 1 },
  { chunkId: 6, symbolId: 6, role: 1 },
  { chunkId: 7, symbolId: 7, role: 1 },
  { chunkId: 8, symbolId: 8, role: 1 },
  { chunkId: 9, symbolId: 9, role: 1 },
  { chunkId: 10, symbolId: 10, role: 1 },
  { chunkId: 11, symbolId: 11, role: 1 },
  { chunkId: 12, symbolId: 12, role: 1 },
  { chunkId: 13, symbolId: 13, role: 1 },
  // app/entry.ts
  { chunkId: 1, symbolId: 2, role: 0 },
  { chunkId: 1, symbolId: 3, role: 0 },
  { chunkId: 1, symbolId: 10, role: 0 },
  { chunkId: 1, symbolId: 11, role: 0 },
  // app/controller.ts
  { chunkId: 2, symbolId: 3, role: 0 },
  { chunkId: 2, symbolId: 5, role: 0 },
  { chunkId: 2, symbolId: 9, role: 0 },
  { chunkId: 2, symbolId: 10, role: 0 },
  { chunkId: 2, symbolId: 11, role: 0 },
  // app/service.ts - prepare helper then process hot path
  { chunkId: 3, symbolId: 11, role: 0 },
  { chunkId: 4, symbolId: 5, role: 0 },
  { chunkId: 4, symbolId: 6, role: 0 },
  { chunkId: 4, symbolId: 9, role: 0 },
  { chunkId: 4, symbolId: 10, role: 0 },
  { chunkId: 4, symbolId: 11, role: 0 },
  { chunkId: 4, symbolId: 8, role: 0 },
  // core/math.ts
  { chunkId: 7, symbolId: 5, role: 0 },
  { chunkId: 7, symbolId: 6, role: 0 },
  { chunkId: 7, symbolId: 11, role: 0 },
  // infra/http.ts
  { chunkId: 9, symbolId: 11, role: 0 },
  { chunkId: 9, symbolId: 12, role: 0 },
  // ui/view.ts
  { chunkId: 10, symbolId: 11, role: 0 },
  { chunkId: 10, symbolId: 12, role: 0 },
  // shared/utils.ts
  { chunkId: 11, symbolId: 12, role: 0 },
  { chunkId: 11, symbolId: 13, role: 0 },
  // shared/types.ts
  { chunkId: 12, symbolId: 13, role: 0 },
] as const;

export function createAdvancedFixtureDb(dbPath: string): void {
  const sqliteDb = new Database(dbPath);
  const exec = (sql: string) => sqliteDb.exec(sql); // better-sqlite3 exec, not shell exec

  exec(schemaSql);

  const documentStmt = sqliteDb.prepare(
    'INSERT INTO documents (id, language, relative_path) VALUES (?, ?, ?)',
  );
  for (const doc of documents) {
    documentStmt.run(doc.id, doc.language, doc.relativePath);
  }

  const symbolStmt = sqliteDb.prepare(
    'INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES (?, ?, ?, ?, ?)',
  );
  for (const symbol of symbols) {
    symbolStmt.run(symbol.id, symbol.symbol, symbol.displayName, symbol.kind, symbol.documentation);
  }

  const defnStmt = sqliteDb.prepare(
    `INSERT INTO defn_enclosing_ranges
      (id, document_id, symbol_id, start_line, start_char, end_line, end_char)
     VALUES (?, ?, ?, ?, 0, ?, 0)`,
  );
  for (const defn of definitions) {
    defnStmt.run(defn.id, defn.documentId, defn.symbolId, defn.startLine, defn.endLine);
  }

  const chunkStmt = sqliteDb.prepare(
    'INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES (?, ?, 0, ?, ?, X\'00\')',
  );
  for (const chunk of chunks) {
    chunkStmt.run(chunk.id, chunk.documentId, chunk.startLine, chunk.endLine);
  }

  const mentionStmt = sqliteDb.prepare(
    'INSERT INTO mentions (chunk_id, symbol_id, role) VALUES (?, ?, ?)',
  );
  for (const mention of mentions) {
    mentionStmt.run(mention.chunkId, mention.symbolId, mention.role);
  }

  sqliteDb.close();
}
