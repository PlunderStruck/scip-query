import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedOccurrence } from './augment-vue-contracts.js';
import {
  readTextFileWithinLimit,
  SMALL_ARTIFACT_MAX_BYTES,
  SOURCE_ARTIFACT_MAX_BYTES,
} from '../../platform/bounded-file.js';

export interface DefinitionInfo {
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

export interface TsModule {
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
  readConfigFile(
    configPath: string,
    readFile: (path: string) => string | undefined,
  ): {
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

export interface TsScriptSnapshot {
  getLength(): number;
  getText(start: number, end: number): string;
}

export interface TsLanguageService {
  getDefinitionAtPosition(fileName: string, position: number): DefinitionInfo[] | undefined;
  getDocumentHighlights?(
    fileName: string,
    position: number,
    filesToSearch: string[],
  ):
    | {
        fileName: string;
        highlightSpans: { textSpan: { start: number; length: number } }[];
      }[]
    | undefined;
  getProgram(): { getSourceFile(fileName: string): unknown } | undefined;
}

export interface VueCoreModule {
  createParsedCommandLine(
    ts: TsModule,
    host: unknown,
    configFileName: string,
  ): {
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
  createLanguage(plugins: unknown[], scripts: Map<string, unknown>, sync: (id: string) => void): VolarLanguage;
}

export interface VolarTsModule {
  createLanguageServiceHost(
    ts: TsModule,
    sys: unknown,
    language: VolarLanguage,
    asScriptId: (id: string) => string,
    projectHost: unknown,
  ): { languageServiceHost: unknown };
}

export interface VolarLanguage {
  scripts: {
    get(id: string, includeFsFiles?: boolean, shouldRegister?: boolean): VolarSourceScript | undefined;
    set(id: string, snapshot: TsScriptSnapshot, languageId?: string): VolarSourceScript | undefined;
  };
  maps: {
    get(virtualCode: VolarVirtualCode, sourceScript: VolarSourceScript): VolarMapper;
  };
}

export interface VolarSourceScript {
  generated?: {
    root: VolarVirtualCode;
    languagePlugin: {
      typescript?: {
        getServiceScript(root: VolarVirtualCode): { code: VolarVirtualCode } | undefined;
      };
    };
  };
}

export interface VolarVirtualCode {
  id: string;
  snapshot: TsScriptSnapshot;
}

interface VolarMapper {
  toGeneratedLocation(
    sourceOffset: number,
    filter?: (data: { navigation?: unknown }) => boolean,
  ): Generator<readonly [number, { data: { navigation?: unknown } }]>;
}

interface VueIdentifierToken {
  text: string;
  start: number;
  end: number;
}

export interface SourceTextInfo {
  text: string;
  lineStarts: number[];
}

export interface SourcePosition {
  line: number;
  character: number;
}

interface VueSourceReader {
  get(fileName: string): SourceTextInfo | null;
  positionAt(source: SourceTextInfo, offset: number): SourcePosition;
}

interface VueLanguageDependencies {
  vueCore: VueCoreModule;
  ts: TsModule;
  volarTs: VolarTsModule;
}

interface DefinitionRangeLookup {
  containingByLine: Map<number, { symbolId: number; displayName: string | null }>;
  starts: { line: number; symbolId: number; displayName: string | null }[];
}

function clearVueDocumentChunks(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.prepare(
      `
      DELETE FROM mentions
      WHERE chunk_id IN (
        SELECT c.id
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.language = 'vue' OR d.relative_path LIKE '%.vue'
      )
    `,
    ).run();
    db.prepare(
      `
      DELETE FROM chunks
      WHERE document_id IN (
        SELECT id
        FROM documents
        WHERE language = 'vue' OR relative_path LIKE '%.vue'
      )
    `,
    ).run();
  });
  tx();
}

// scip-query: ignore-wrapper — DB read-side for the Vue augmentation input set;
// callers should not duplicate the Vue document predicate.
export function listVueDocumentFiles(db: Database.Database, projectRoot: string): string[] {
  const rows = db
    .prepare(
      `
    SELECT relative_path AS relativePath
    FROM documents
    WHERE language = 'vue' OR relative_path LIKE '%.vue'
    ORDER BY relative_path
  `,
    )
    .all() as { relativePath: string }[];
  return rows.map((row) => resolve(projectRoot, row.relativePath));
}

// scip-query: ignore-extract — this creates the Volar/TypeScript language
// context; dependency loading, tsconfig parsing, project host construction, and
// language creation are one initialization boundary.
export function createVueLanguageContext(projectRoot: string, configPath: string): VueLanguageContext {
  const { vueCore, ts, volarTs } = loadVueLanguageDependencies(projectRoot);
  const { parsed, vueOptions } = parseVueTsConfig(vueCore, ts, configPath);

  const configDir = dirname(configPath);
  const vuePlugin = vueCore.createVueLanguagePlugin(ts, parsed.options, vueOptions, (id) => id);
  const language = createVolarLanguage(vueCore, ts, vuePlugin);
  const projectHost = createVueProjectHost(configDir, parsed);

  const { languageServiceHost } = volarTs.createLanguageServiceHost(ts, ts.sys, language, (id) => id, projectHost);
  const languageService = ts.createLanguageService(languageServiceHost);

  return {
    ts,
    language,
    languageService,
    fileNames: parsed.fileNames,
    configDir,
  };
}

function loadVueLanguageDependencies(projectRoot: string): VueLanguageDependencies {
  const requireFromProject = createRequire(pathToFileURL(join(projectRoot, 'package.json')).href);
  return {
    vueCore: requireVueAugmentDependency(requireFromProject, '@vue/language-core', projectRoot) as VueCoreModule,
    ts: requireVueAugmentDependency(requireFromProject, 'typescript', projectRoot) as TsModule,
    volarTs: requireVueAugmentDependency(requireFromProject, '@volar/typescript', projectRoot) as VolarTsModule,
  };
}

function parseVueTsConfig(
  vueCore: VueCoreModule,
  ts: TsModule,
  configPath: string,
): {
  parsed: ReturnType<TsModule['parseJsonConfigFileContent']>;
  vueOptions: Record<string, unknown>;
} {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error || !config.config) {
    throw new Error(`Failed to read ${configPath}`);
  }

  const vueParsed = vueCore.createParsedCommandLine(ts, ts.sys, configPath);
  const vueOptions = vueParsed.vueOptions;
  if (typeof vueCore.createGlobalTypesWriter === 'function') {
    vueOptions['globalTypesPath'] = vueCore.createGlobalTypesWriter(vueOptions, ts.sys.writeFile);
  }

  return {
    parsed: ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
      undefined,
      vueCore.getAllExtensions(vueOptions).map((extension) => ({
        extension: extension.slice(1),
        isMixedContent: true,
        scriptKind: ts.ScriptKind['Deferred'],
      })),
    ),
    vueOptions,
  };
}

function createVolarLanguage(
  vueCore: VueCoreModule,
  ts: TsModule,
  vuePlugin: { getLanguageId(id: string): string | undefined },
): VolarLanguage {
  const languageRef: { current?: VolarLanguage } = {};
  const language = vueCore.createLanguage([vuePlugin], new Map(), (id) => {
    if (!existsSync(id)) return;
    const text = readTextFileWithinLimit(id, {
      maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
      inputKind: 'Vue language-service source file',
    });
    languageRef.current?.scripts.set(
      id,
      ts.ScriptSnapshot.fromString(text),
      vuePlugin.getLanguageId(id) ?? volarLanguageIdForPath(id),
    );
  });
  languageRef.current = language;
  return language;
}

function createVueProjectHost(configDir: string, parsed: ReturnType<TsModule['parseJsonConfigFileContent']>): unknown {
  return {
    getCurrentDirectory: () => configDir,
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getProjectReferences: () => parsed.projectReferences,
    getProjectVersion: () => '0',
  };
}

function requireVueAugmentDependency(
  requireFromProject: ReturnType<typeof createRequire>,
  packageName: string,
  projectRoot: string,
): unknown {
  try {
    return requireFromProject(packageName);
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : null;
    if (code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `Vue augmentation requires ${packageName} to be installed in ${projectRoot}. ` +
          'Install Vue/Volar dependencies for that project, then rerun augment-vue.',
        { cause: err },
      );
    }
    throw err;
  }
}

// scip-query: ignore-extract — this creates the Vue generated-source symbol
// lookup; definition ranges, source-map position conversion, nearest-start
// matching, and path normalization are one bridge.
export function createSymbolLookup(
  db: Database.Database,
  projectRoot: string,
  sourceReader: VueSourceReader,
): (definition: DefinitionInfo) => number | null {
  const rangesByFile = loadDefinitionRanges(db);

  return (definition: DefinitionInfo): number | null => {
    if (!definition.name) return null;
    const relativePath = toRelativePath(projectRoot, definition.fileName);
    const sourceInfo = sourceReader.get(definition.fileName);
    if (!sourceInfo) return null;
    const pos = sourceReader.positionAt(sourceInfo, definition.textSpan.start);
    const lookup = rangesByFile.get(relativePath);
    if (!lookup) return null;
    const exact = lookup.starts.find(
      (candidate) => candidate.line === pos.line && candidate.displayName === definition.name,
    );
    if (exact) return exact.symbolId;
    const containing = lookup.containingByLine.get(pos.line);
    if (containing && containing.displayName === definition.name) return containing.symbolId;
    return findNearestStart(lookup.starts, pos.line, 2, definition.name);
  };
}

function loadDefinitionRanges(db: Database.Database): Map<string, DefinitionRangeLookup> {
  const rows = db
    .prepare(
      `
    SELECT
      d.relative_path AS relativePath,
      der.start_line AS startLine,
      der.end_line AS endLine,
      der.symbol_id AS symbolId,
      gs.display_name AS displayName
    FROM defn_enclosing_ranges der
    JOIN documents d ON d.id = der.document_id
    JOIN global_symbols gs ON gs.id = der.symbol_id
    ORDER BY d.relative_path, (der.end_line - der.start_line) DESC
  `,
    )
    .all() as {
    relativePath: string;
    startLine: number;
    endLine: number;
    symbolId: number;
    displayName: string | null;
  }[];

  const byFile = new Map<string, DefinitionRangeLookup>();
  for (const row of rows) {
    let lookup = byFile.get(row.relativePath);
    if (!lookup) {
      lookup = { containingByLine: new Map(), starts: [] };
      byFile.set(row.relativePath, lookup);
    }
    lookup.starts.push({ line: row.startLine, symbolId: row.symbolId, displayName: row.displayName });
    for (let line = row.startLine; line <= row.endLine; line++) {
      lookup.containingByLine.set(line, { symbolId: row.symbolId, displayName: row.displayName });
    }
  }

  for (const lookup of byFile.values()) {
    lookup.starts.sort((a, b) => a.line - b.line);
  }
  return byFile;
}

function findNearestStart(
  starts: readonly { line: number; symbolId: number; displayName: string | null }[],
  targetLine: number,
  maxDistance: number,
  definitionName: string,
): number | null {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid]!.line < targetLine) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  let best: { distance: number; symbolId: number } | null = null;
  for (const index of [high, low]) {
    const candidate = starts[index];
    if (!candidate) continue;
    if (candidate.displayName !== definitionName) continue;
    const distance = Math.abs(candidate.line - targetLine);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) {
      best = { distance, symbolId: candidate.symbolId };
    }
  }
  return best?.symbolId ?? null;
}

// scip-query: ignore-wrapper — transaction phase for materializing synthetic
// Vue component symbols and exposing the lookup used by definition/mention writes.
export function createVueComponentSymbolLookup(
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

  let syntheticSymbols = 0;
  const byFile = new Map<string, number>();
  const tx = db.transaction(() => {
    for (const fileName of vueFiles) {
      const relativePath = toRelativePath(projectRoot, fileName);
      const symbol = vueDefaultExportSymbol(packageInfo.name, packageInfo.version, relativePath);
      insertSymbol.run(symbol, 'default', 7, `Vue component|${relativePath}`);
      const symbolId = findVueSymbolId(select, packageInfo, projectRoot, fileName);
      if (!symbolId) continue;
      syntheticSymbols++;
      byFile.set(fileName, symbolId);
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

// scip-query: ignore-wrapper — transaction boundary for replacing generated Vue
// chunks; callers pass facts, this function owns delete/definition/mention order.
export function replaceVueDocumentChunks(
  db: Database.Database,
  projectRoot: string,
  vueFiles: readonly string[],
  vueSymbolLookup: { get(fileName: string): number | null },
  occurrences: ResolvedOccurrence[],
): number {
  const tx = db.transaction(() => {
    clearVueDocumentChunks(db);
    insertVueDefinitionMentions(db, projectRoot, vueFiles, vueSymbolLookup);
    return insertOccurrencesWithoutTransaction(db, occurrences);
  });
  return tx() as number;
}

function insertVueDefinitionMentions(
  db: Database.Database,
  projectRoot: string,
  vueFiles: readonly string[],
  vueSymbolLookup: { get(fileName: string): number | null },
): void {
  const selectDoc = db.prepare(`SELECT id FROM documents WHERE relative_path = ?`);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (document_id, chunk_index, start_line, end_line, occurrences)
    VALUES (?, ?, ?, ?, X'00')
  `);
  const insertMention = db.prepare(`
    INSERT OR IGNORE INTO mentions (chunk_id, symbol_id, role)
    VALUES (?, ?, 1)
  `);

  for (const fileName of vueFiles) {
    const symbolId = vueSymbolLookup.get(fileName);
    if (!symbolId) continue;
    const relativePath = toRelativePath(projectRoot, fileName);
    const docRow = selectDoc.get(relativePath) as { id: number } | undefined;
    if (!docRow) continue;
    const chunk = insertChunk.run(docRow.id, -1, 0, 0);
    insertMention.run(Number(chunk.lastInsertRowid), symbolId);
  }
}

// scip-query: ignore-wrapper — memoized Vue symbol lookup shared by direct and
// worker augmentation paths; hides package-info and SQL lookup details.
export function createVueSymbolIdLookup(
  db: Database.Database,
  projectRoot: string,
): { get(fileName: string): number | null } {
  const packageInfo = readPackageInfo(projectRoot);
  const select = db.prepare(`SELECT id FROM global_symbols WHERE symbol = ?`);
  const byFile = new Map<string, number | null>();

  return {
    get(fileName: string) {
      if (byFile.has(fileName)) {
        return byFile.get(fileName) ?? null;
      }
      const id = findVueSymbolId(select, packageInfo, projectRoot, fileName);
      byFile.set(fileName, id);
      return id;
    },
  };
}

// scip-query: ignore-wrapper — bridge from Volar definitions to SCIP symbol ids;
// Vue component definitions and generated TypeScript definitions follow different
// evidence paths and should not be re-decided by token-resolution callers.
export function resolveVueDefinitionSymbolId(
  definition: DefinitionInfo,
  symbolLookup: (definition: DefinitionInfo) => number | null,
  vueSymbolLookup: { get(fileName: string): number | null },
  context: VueLanguageContext,
  projectRoot: string,
): number | null {
  if (definition.fileName.endsWith('.vue')) {
    const sourceScript = context.language.scripts.get(definition.fileName);
    const serviceScript = sourceScript?.generated?.languagePlugin.typescript?.getServiceScript(
      sourceScript.generated.root,
    )?.code;
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

// scip-query: ignore-wrapper — public normalization step shared by direct and
// worker modes before writing resolved mentions.
export function dedupeOccurrences(occurrences: ResolvedOccurrence[]): ResolvedOccurrence[] {
  const seen = new Set<string>();
  const deduped: ResolvedOccurrence[] = [];
  for (const occurrence of occurrences) {
    const key = occurrenceKey(occurrence);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(occurrence);
  }
  return deduped;
}

function occurrenceKey(occurrence: ResolvedOccurrence): string {
  return [
    occurrence.sourceFile,
    occurrence.sourceLine,
    occurrence.sourceStartChar,
    occurrence.sourceEndChar,
    occurrence.symbolId,
  ].join(':');
}

function insertOccurrencesWithoutTransaction(db: Database.Database, occurrences: ResolvedOccurrence[]): number {
  const docIds = selectDocumentIds(db, [...new Set(occurrences.map((occurrence) => occurrence.sourceFile))]);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (document_id, chunk_index, start_line, end_line, occurrences)
    VALUES (?, ?, ?, ?, X'00')
  `);
  const insertMention = db.prepare(`
    INSERT OR IGNORE INTO mentions (chunk_id, symbol_id, role)
    VALUES (?, ?, 0)
  `);

  const seen = new Set<string>();
  let inserted = 0;
  let chunkIndex = 0;
  for (const occurrence of occurrences) {
    const key = occurrenceKey(occurrence);
    if (seen.has(key)) continue;
    seen.add(key);

    const documentId = docIds.get(occurrence.sourceFile);
    if (!documentId) continue;
    const chunk = insertChunk.run(documentId, chunkIndex++, occurrence.sourceLine, occurrence.sourceLine);
    const info = insertMention.run(Number(chunk.lastInsertRowid), occurrence.symbolId);
    inserted += Number(info.changes);
  }
  return inserted;
}

// scip-query: ignore-passthrough — owns Vue lexical token filtering; Set.has is incidental.
export function* identifierTokens(source: string): Generator<VueIdentifierToken> {
  const re = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  const ignored = new Set([
    'script',
    'setup',
    'template',
    'style',
    'lang',
    'scoped',
    'true',
    'false',
    'null',
    'undefined',
    'const',
    'let',
    'var',
    'import',
    'from',
    'export',
    'return',
    'if',
    'else',
    'for',
    'while',
    'function',
    'class',
    'type',
    'interface',
    'as',
    'await',
    'async',
  ]);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const text = match[0]!;
    if (ignored.has(text)) continue;
    yield { text, start: match.index, end: match.index + text.length };
  }
}

// scip-query: ignore-wrapper — Volar mapper adapter; hides generator semantics
// and the navigation-data predicate from the token resolver.
export function firstGeneratedOffset(map: VolarMapper, sourceOffset: number): number | null {
  for (const [offset] of map.toGeneratedLocation(sourceOffset, (data) => !!data.navigation)) {
    return offset;
  }
  return null;
}

// scip-query: ignore-wrapper — inverse Volar mapper adapter; keeps highlight and
// definition mapping on the same navigation-data policy.
export function firstSourceOffset(map: VolarMapper, generatedOffset: number): number | null {
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

function offsetToLineChar(source: SourceTextInfo, offset: number): { line: number; character: number } {
  let low = 0;
  let high = source.lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = source.lineStarts[mid]!;
    if (lineStart <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const line = Math.max(0, high);
  return { line, character: offset - source.lineStarts[line]! };
}

// scip-query: ignore-passthrough — names the project-boundary policy for Vue
// definitions; the relative-path check is the current implementation.
export function isExternalDefinition(projectRoot: string, fileName: string): boolean {
  const rel = toRelativePath(projectRoot, fileName);
  return rel.startsWith('node_modules/');
}

// scip-query: ignore-wrapper — canonical path normalization for Vue augmentation
// DB lookups and generated SCIP symbol names.
export function toRelativePath(projectRoot: string, fileName: string): string {
  return relative(projectRoot, fileName).replaceAll('\\', '/');
}

// LSP languageId for a TS/Vue language service request (Volar's
// getLanguageId fallback) -- 'typescriptreact', 'javascriptreact', etc.
// Distinct vocabulary from the project's SupportedLanguage enum; not the
// same concept as queries/navigation/code.ts's supportedLanguageFromPath.
function volarLanguageIdForPath(fileName: string): string {
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

// scip-query: ignore-wrapper — source-text pipeline primitive for Vue direct
// and worker modes; owns both cached reads and offset-to-line conversion.
export function createVueSourceReader(): VueSourceReader {
  const cache = new Map<string, SourceTextInfo | null>();
  return {
    get(fileName: string) {
      if (cache.has(fileName)) {
        return cache.get(fileName) ?? null;
      }
      try {
        const text = readTextFileWithinLimit(fileName, {
          maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
          inputKind: 'Vue source file',
        });
        const info = { text, lineStarts: createLineStarts(text) };
        cache.set(fileName, info);
        return info;
      } catch {
        cache.set(fileName, null);
        return null;
      }
    },
    positionAt: offsetToLineChar,
  };
}

function createLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function selectDocumentIds(db: Database.Database, relativePaths: readonly string[]): Map<string, number> {
  const ids = new Map<string, number>();
  const chunkSize = 500;
  for (let start = 0; start < relativePaths.length; start += chunkSize) {
    const chunk = relativePaths.slice(start, start + chunkSize);
    const rows = db
      .prepare(
        `SELECT id, relative_path AS relativePath FROM documents WHERE relative_path IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as { id: number; relativePath: string }[];
    for (const row of rows) {
      ids.set(row.relativePath, row.id);
    }
  }
  return ids;
}

function readPackageInfo(projectRoot: string): { name: string; version: string } {
  try {
    const raw = JSON.parse(
      readTextFileWithinLimit(join(projectRoot, 'package.json'), {
        maxBytes: SMALL_ARTIFACT_MAX_BYTES,
        inputKind: 'project package manifest',
      }),
    ) as {
      name?: string;
      version?: string;
    };
    return { name: raw.name ?? 'workspace', version: raw.version ?? '0.0.0' };
  } catch {
    return { name: 'workspace', version: '0.0.0' };
  }
}

function findVueSymbolId(
  select: Database.Statement,
  packageInfo: { name: string; version: string },
  projectRoot: string,
  fileName: string,
): number | null {
  const relativePath = toRelativePath(projectRoot, fileName);
  const symbol = vueDefaultExportSymbol(packageInfo.name, packageInfo.version, relativePath);
  const row = select.get(symbol) as { id: number } | undefined;
  return row?.id ?? null;
}

function vueDefaultExportSymbol(packageName: string, version: string, relativePath: string): string {
  const escaped = relativePath
    .split('/')
    .map((part) => `\`${part.replaceAll('`', '')}\``)
    .join('/');
  return `scip-vue npm ${packageName} ${version} ${escaped}/default.`;
}
