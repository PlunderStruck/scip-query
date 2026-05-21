import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { augmentAuxiliaryDocuments } from './augment.js';

export interface AugmentVueResolvedOptions {
  projectRoot: string;
  dbPath: string;
  tsconfig: string;
  onStatus?: (message: string) => void;
}

export interface AugmentVueResolvedResult {
  vueFiles: number;
  resolvedReferences: number;
  insertedMentions: number;
  skippedReferences: number;
  syntheticSymbols: number;
}

interface DefinitionInfo {
  fileName: string;
  textSpan: { start: number; length: number };
  name?: string;
  kind?: string;
}

interface VueLanguageContext {
  ts: TsModule;
  language: VolarLanguage;
  languageService: TsLanguageService;
  fileNames: string[];
  configDir: string;
}

interface TsModule {
  sys: {
    fileExists(path: string): boolean;
    readFile(path: string): string | undefined;
    readDirectory: (...args: unknown[]) => string[];
    directoryExists?(path: string): boolean;
    getDirectories?(path: string): string[];
    realpath?(path: string): string;
    useCaseSensitiveFileNames: boolean;
    newLine: string;
    writeFile(path: string, data: string): void;
  };
  ScriptKind: Record<string, number>;
  ScriptSnapshot: { fromString(text: string): TsScriptSnapshot };
  readConfigFile(configPath: string, readFile: (path: string) => string | undefined): {
    config?: unknown;
    error?: unknown;
  };
  parseJsonConfigFileContent(
    config: unknown,
    host: unknown,
    basePath: string,
    existingOptions?: unknown,
    configFileName?: string,
    resolutionStack?: unknown,
    extraFileExtensions?: unknown[],
  ): { options: unknown; fileNames: string[]; projectReferences?: unknown[] };
  createLanguageService(host: unknown): TsLanguageService;
  getDefaultLibFilePath(options: unknown): string;
}

interface TsScriptSnapshot {
  getLength(): number;
  getText(start: number, end: number): string;
}

interface TsLanguageService {
  getDefinitionAtPosition(fileName: string, position: number): DefinitionInfo[] | undefined;
  getProgram(): { getSourceFile(fileName: string): unknown } | undefined;
}

interface VolarLanguage {
  scripts: {
    get(id: string, includeFsFiles?: boolean, shouldRegister?: boolean): VolarSourceScript | undefined;
    set(id: string, snapshot: TsScriptSnapshot, languageId?: string): VolarSourceScript | undefined;
  };
  maps: {
    get(virtualCode: VolarVirtualCode, sourceScript: VolarSourceScript): VolarMapper;
  };
}

interface VolarSourceScript {
  generated?: {
    root: VolarVirtualCode;
    languagePlugin: {
      typescript?: {
        getServiceScript(root: VolarVirtualCode): { code: VolarVirtualCode } | undefined;
      };
    };
  };
}

interface VolarVirtualCode {
  id: string;
  snapshot: TsScriptSnapshot;
}

interface VolarMapper {
  toGeneratedLocation(
    sourceOffset: number,
    filter?: (data: { navigation?: unknown }) => boolean,
  ): Generator<readonly [number, { data: { navigation?: unknown } }]>;
}

interface ResolvedOccurrence {
  sourceFile: string;
  sourceLine: number;
  sourceStartChar: number;
  sourceEndChar: number;
  symbolId: number;
}

export function augmentVueResolvedReferences(
  opts: AugmentVueResolvedOptions,
): AugmentVueResolvedResult {
  augmentAuxiliaryDocuments({
    projectRoot: opts.projectRoot,
    dbPath: opts.dbPath,
  });

  const configPath = resolve(opts.projectRoot, opts.tsconfig);
  if (!existsSync(configPath)) {
    throw new Error(`Vue tsconfig not found at ${configPath}`);
  }

  const context = createVueLanguageContext(opts.projectRoot, configPath);
  const vueFiles = context.fileNames.filter((file) => file.endsWith('.vue'));
  const db = new Database(opts.dbPath);

  try {
    clearVueDocumentChunks(db);
    const symbolLookup = createSymbolLookup(db, opts.projectRoot);
    const vueSymbolLookup = createVueSymbolLookup(db, opts.projectRoot, vueFiles);
    const occurrences: ResolvedOccurrence[] = [];
    let skippedReferences = 0;

    for (const fileName of vueFiles) {
      const sourceScript = context.language.scripts.get(fileName);
      const serviceScript = sourceScript?.generated?.languagePlugin.typescript
        ?.getServiceScript(sourceScript.generated.root)?.code;
      if (!sourceScript || !serviceScript) {
        skippedReferences++;
        continue;
      }

      const map = context.language.maps.get(serviceScript, sourceScript);
      const source = readFileSync(fileName, 'utf-8');
      for (const token of identifierTokens(source)) {
        const generated = firstGeneratedOffset(map, token.start);
        if (generated === null) continue;

        const definitions = context.languageService.getDefinitionAtPosition(fileName, generated + 1) ?? [];
        const definition = definitions.find((def) => !isExternalDefinition(opts.projectRoot, def.fileName));
        if (!definition) {
          skippedReferences++;
          continue;
        }

        const symbolId = resolveDefinitionSymbolId(
          definition,
          symbolLookup,
          vueSymbolLookup,
          context,
          opts.projectRoot,
        );
        if (symbolId === null) {
          skippedReferences++;
          continue;
        }

        const sourcePos = offsetToLineChar(source, token.start);
        occurrences.push({
          sourceFile: toRelativePath(opts.projectRoot, fileName),
          sourceLine: sourcePos.line,
          sourceStartChar: sourcePos.character,
          sourceEndChar: sourcePos.character + token.text.length,
          symbolId,
        });
      }
    }

    const insertedMentions = insertOccurrences(db, occurrences);
    opts.onStatus?.(
      `Resolved ${occurrences.length} Vue references with Volar; inserted ${insertedMentions} mentions.`,
    );

    return {
      vueFiles: vueFiles.length,
      resolvedReferences: occurrences.length,
      insertedMentions,
      skippedReferences,
      syntheticSymbols: vueSymbolLookup.syntheticSymbols,
    };
  } finally {
    db.close();
  }
}

function clearVueDocumentChunks(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM mentions
      WHERE chunk_id IN (
        SELECT c.id
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.language = 'vue' OR d.relative_path LIKE '%.vue'
      )
    `).run();
    db.prepare(`
      DELETE FROM chunks
      WHERE document_id IN (
        SELECT id
        FROM documents
        WHERE language = 'vue' OR relative_path LIKE '%.vue'
      )
    `).run();
  });
  tx();
}

function createVueLanguageContext(projectRoot: string, configPath: string): VueLanguageContext {
  const requireFromProject = createRequire(pathToFileURL(join(projectRoot, 'package.json')).href);
  const ts = requireFromProject('typescript') as TsModule;
  const vueCore = requireFromProject('@vue/language-core') as {
    createParsedCommandLine(ts: TsModule, host: unknown, configFileName: string): {
      vueOptions: Record<string, unknown>;
    };
    createGlobalTypesWriter?(options: unknown, writeFile: (path: string, data: string) => void): unknown;
    getAllExtensions(options: Record<string, unknown>): string[];
    createVueLanguagePlugin(
      ts: TsModule,
      compilerOptions: unknown,
      vueOptions: unknown,
      asFileName: (id: string) => string,
    ): {
      getLanguageId(id: string): string | undefined;
    };
    createLanguage(
      plugins: unknown[],
      scripts: Map<string, unknown>,
      sync: (id: string) => void,
    ): VolarLanguage;
  };
  const volarTs = requireFromProject('@volar/typescript') as {
    createLanguageServiceHost(
      ts: TsModule,
      sys: unknown,
      language: VolarLanguage,
      asScriptId: (id: string) => string,
      projectHost: unknown,
    ): { languageServiceHost: unknown };
  };

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error || !config.config) {
    throw new Error(`Failed to read ${configPath}`);
  }

  const vueParsed = vueCore.createParsedCommandLine(ts, ts.sys, configPath);
  const vueOptions = vueParsed.vueOptions;
  if (typeof vueCore.createGlobalTypesWriter === 'function') {
    vueOptions['globalTypesPath'] = vueCore.createGlobalTypesWriter(vueOptions, ts.sys.writeFile);
  }
  const extraFileExtensions = vueCore.getAllExtensions(vueOptions).map((extension) => ({
    extension: extension.slice(1),
    isMixedContent: true,
    scriptKind: ts.ScriptKind['Deferred'],
  }));

  const configDir = dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    configDir,
    undefined,
    configPath,
    undefined,
    extraFileExtensions,
  );
  const vuePlugin = vueCore.createVueLanguagePlugin(ts, parsed.options, vueOptions, (id) => id);

  let language: VolarLanguage;
  language = vueCore.createLanguage([vuePlugin], new Map(), (id) => {
    if (!existsSync(id)) return;
    const text = readFileSync(id, 'utf-8');
    language.scripts.set(
      id,
      ts.ScriptSnapshot.fromString(text),
      vuePlugin.getLanguageId(id) ?? languageIdForPath(id),
    );
  });

  const projectHost = {
    getCurrentDirectory: () => configDir,
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getProjectReferences: () => parsed.projectReferences,
    getProjectVersion: () => '0',
  };

  const { languageServiceHost } = volarTs.createLanguageServiceHost(
    ts,
    ts.sys,
    language,
    (id) => id,
    projectHost,
  );
  const languageService = ts.createLanguageService(languageServiceHost);

  return {
    ts,
    language,
    languageService,
    fileNames: parsed.fileNames,
    configDir,
  };
}

function createSymbolLookup(db: Database.Database, projectRoot: string): (definition: DefinitionInfo) => number | null {
  const findContaining = db.prepare(`
    SELECT der.symbol_id AS symbolId
    FROM defn_enclosing_ranges der
    JOIN documents d ON d.id = der.document_id
    WHERE d.relative_path = ?
      AND der.start_line <= ?
      AND der.end_line >= ?
    ORDER BY (der.end_line - der.start_line) ASC
    LIMIT 1
  `);
  const findNear = db.prepare(`
    SELECT der.symbol_id AS symbolId
    FROM defn_enclosing_ranges der
    JOIN documents d ON d.id = der.document_id
    WHERE d.relative_path = ?
      AND der.start_line BETWEEN ? AND ?
    ORDER BY ABS(der.start_line - ?) ASC
    LIMIT 1
  `);

  return (definition: DefinitionInfo): number | null => {
    const relativePath = toRelativePath(projectRoot, definition.fileName);
    const source = safeRead(definition.fileName);
    if (!source) return null;
    const pos = offsetToLineChar(source, definition.textSpan.start);
    const containing = findContaining.get(relativePath, pos.line, pos.line) as { symbolId: number } | undefined;
    if (containing) return containing.symbolId;
    const near = findNear.get(relativePath, Math.max(0, pos.line - 2), pos.line + 2, pos.line) as
      | { symbolId: number }
      | undefined;
    return near?.symbolId ?? null;
  };
}

function createVueSymbolLookup(
  db: Database.Database,
  projectRoot: string,
  vueFiles: string[],
): { get(fileName: string): number | null; syntheticSymbols: number } {
  const packageInfo = readPackageInfo(projectRoot);
  const select = db.prepare(`SELECT id FROM global_symbols WHERE symbol = ?`);
  const insertSymbol = db.prepare(`
    INSERT OR IGNORE INTO global_symbols (symbol, display_name, kind, documentation)
    VALUES (?, ?, ?, ?)
  `);
  const selectDoc = db.prepare(`SELECT id FROM documents WHERE relative_path = ?`);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (document_id, chunk_index, start_line, end_line, occurrences)
    VALUES (?, ?, ?, ?, X'00')
  `);
  const insertMention = db.prepare(`
    INSERT OR IGNORE INTO mentions (chunk_id, symbol_id, role)
    VALUES (?, ?, 1)
  `);

  let syntheticSymbols = 0;
  const byFile = new Map<string, number>();
  const tx = db.transaction(() => {
    for (const fileName of vueFiles) {
      const relativePath = toRelativePath(projectRoot, fileName);
      const symbol = vueDefaultExportSymbol(packageInfo.name, packageInfo.version, relativePath);
      insertSymbol.run(symbol, 'default', 7, `Vue component|${relativePath}`);
      const symbolRow = select.get(symbol) as { id: number } | undefined;
      if (!symbolRow) continue;
      syntheticSymbols++;
      byFile.set(fileName, symbolRow.id);

      const docRow = selectDoc.get(relativePath) as { id: number } | undefined;
      if (!docRow) continue;
      const chunk = insertChunk.run(docRow.id, -1, 0, 0);
      insertMention.run(Number(chunk.lastInsertRowid), symbolRow.id);
    }
  });
  tx();

  return {
    get(fileName: string) {
      return byFile.get(fileName) ?? null;
    },
    syntheticSymbols,
  };
}

function resolveDefinitionSymbolId(
  definition: DefinitionInfo,
  symbolLookup: (definition: DefinitionInfo) => number | null,
  vueSymbolLookup: { get(fileName: string): number | null },
  context: VueLanguageContext,
  projectRoot: string,
): number | null {
  if (definition.fileName.endsWith('.vue')) {
    const sourceScript = context.language.scripts.get(definition.fileName);
    const serviceScript = sourceScript?.generated?.languagePlugin.typescript
      ?.getServiceScript(sourceScript.generated.root)?.code;
    if (sourceScript && serviceScript) {
      const map = context.language.maps.get(serviceScript, sourceScript);
      const sourceLoc = firstSourceOffset(map, definition.textSpan.start);
      if (sourceLoc !== null) {
        return vueSymbolLookup.get(definition.fileName);
      }
    }
    if (definition.fileName.startsWith(projectRoot)) {
      return vueSymbolLookup.get(definition.fileName);
    }
    return null;
  }
  return symbolLookup(definition);
}

function insertOccurrences(db: Database.Database, occurrences: ResolvedOccurrence[]): number {
  const selectDoc = db.prepare(`SELECT id FROM documents WHERE relative_path = ?`);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (document_id, chunk_index, start_line, end_line, occurrences)
    VALUES (?, ?, ?, ?, X'00')
  `);
  const insertMention = db.prepare(`
    INSERT OR IGNORE INTO mentions (chunk_id, symbol_id, role)
    VALUES (?, ?, 0)
  `);

  const seen = new Set<string>();
  const tx = db.transaction(() => {
    let inserted = 0;
    let chunkIndex = 0;
    for (const occurrence of occurrences) {
      const key = `${occurrence.sourceFile}:${occurrence.sourceLine}:${occurrence.sourceStartChar}:${occurrence.symbolId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const doc = selectDoc.get(occurrence.sourceFile) as { id: number } | undefined;
      if (!doc) continue;
      const chunk = insertChunk.run(doc.id, chunkIndex++, occurrence.sourceLine, occurrence.sourceLine,);
      const info = insertMention.run(Number(chunk.lastInsertRowid), occurrence.symbolId);
      inserted += Number(info.changes);
    }
    return inserted;
  });
  return tx() as number;
}

function* identifierTokens(source: string): Generator<{ text: string; start: number; end: number }> {
  const re = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  const ignored = new Set([
    'script', 'setup', 'template', 'style', 'lang', 'scoped', 'true', 'false',
    'null', 'undefined', 'const', 'let', 'var', 'import', 'from', 'export',
    'return', 'if', 'else', 'for', 'while', 'function', 'class', 'type',
    'interface', 'as', 'await', 'async',
  ]);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const text = match[0]!;
    if (ignored.has(text)) continue;
    yield { text, start: match.index, end: match.index + text.length };
  }
}

function firstGeneratedOffset(map: VolarMapper, sourceOffset: number): number | null {
  for (const [offset] of map.toGeneratedLocation(sourceOffset, (data) => !!data.navigation)) {
    return offset;
  }
  return null;
}

function firstSourceOffset(map: VolarMapper, generatedOffset: number): number | null {
  const anyMap = map as unknown as {
    toSourceLocation(
      generatedOffset: number,
      filter?: (data: { navigation?: unknown }) => boolean,
    ): Generator<readonly [number, { data: { navigation?: unknown } }]>;
  };
  for (const [offset] of anyMap.toSourceLocation(generatedOffset, (data) => !!data.navigation)) {
    return offset;
  }
  return null;
}

function offsetToLineChar(source: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

function isExternalDefinition(projectRoot: string, fileName: string): boolean {
  const rel = toRelativePath(projectRoot, fileName);
  return rel.startsWith('node_modules/');
}

function toRelativePath(projectRoot: string, fileName: string): string {
  return relative(projectRoot, fileName).replaceAll('\\', '/');
}

function languageIdForPath(fileName: string): string {
  switch (extname(fileName)) {
    case '.vue':
      return 'vue';
    case '.tsx':
      return 'typescriptreact';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.jsx':
      return 'javascriptreact';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.json':
      return 'json';
    default:
      return 'typescript';
  }
}

function safeRead(fileName: string): string | null {
  try {
    return readFileSync(fileName, 'utf-8');
  } catch {
    return null;
  }
}

function readPackageInfo(projectRoot: string): { name: string; version: string } {
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as {
      name?: string;
      version?: string;
    };
    return { name: raw.name ?? 'workspace', version: raw.version ?? '0.0.0' };
  } catch {
    return { name: 'workspace', version: '0.0.0' };
  }
}

function vueDefaultExportSymbol(packageName: string, version: string, relativePath: string): string {
  const escaped = relativePath.split('/').map((part) => `\`${part.replaceAll('`', '')}\``).join('/');
  return `scip-vue npm ${packageName} ${version} ${escaped}/default.`;
}
