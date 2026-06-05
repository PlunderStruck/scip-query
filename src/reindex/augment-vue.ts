import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { augmentAuxiliaryDocuments } from './augment.js';
import { fingerprintProjectFiles } from './project-files.js';

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
  getDocumentHighlights?(
    fileName: string,
    position: number,
    filesToSearch: string[],
  ): {
    fileName: string;
    highlightSpans: { textSpan: { start: number; length: number } }[];
  }[] | undefined;
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

interface VueReferenceComputationResult {
  occurrences: ResolvedOccurrence[];
  skippedReferences: number;
}

interface VueReferenceTask {
  fileName: string;
  startOffset: number;
  endOffset: number;
  countFileSkip: boolean;
}

interface VueIdentifierToken {
  text: string;
  start: number;
  end: number;
}

interface SourceTextInfo {
  text: string;
  lineStarts: number[];
}

interface DefinitionRangeLookup {
  containingByLine: Map<number, number>;
  starts: { line: number; symbolId: number }[];
}

interface AugmentVueFingerprint {
  version: 2;
  tsconfig: string;
  files: ReturnType<typeof fingerprintProjectFiles>;
  db: {
    documents: number;
    symbols: number;
    chunks: number;
    mentions: number;
    ranges: number;
    maxChunkId: number | null;
    maxSymbolId: number | null;
  };
}

interface AugmentVueCache {
  fingerprint: AugmentVueFingerprint;
  result: AugmentVueResolvedResult;
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

  const db = new Database(opts.dbPath);

  try {
    const vueFiles = listVueDocumentFiles(db, opts.projectRoot);
    const cachePath = join(dirname(opts.dbPath), 'augment-vue-meta.json');
    const cacheFingerprint = computeAugmentVueFingerprint(db, opts.projectRoot, opts.tsconfig);
    const cachedResult = readAugmentVueCache(cachePath, cacheFingerprint);
    if (cachedResult) {
      opts.onStatus?.(
        `Vue references unchanged; reused ${cachedResult.resolvedReferences} cached resolved references.`,
      );
      return cachedResult;
    }

    const sourceCache = createSourceTextCache();
    const symbolLookup = createSymbolLookup(db, opts.projectRoot, sourceCache);
    const vueSymbolLookup = createVueSymbolLookup(db, opts.projectRoot, vueFiles);
    const computation = shouldUseVueWorkers(vueFiles)
      ? awaitVueReferenceWorkers({
        projectRoot: opts.projectRoot,
        dbPath: opts.dbPath,
        tsconfig: opts.tsconfig,
        vueFiles,
      })
      : (() => {
        const context = createVueLanguageContext(opts.projectRoot, configPath);
        const contextVueFiles = context.fileNames.filter((file) => file.endsWith('.vue'));
        return computeVueResolvedReferencesForFiles({
          projectRoot: opts.projectRoot,
          vueFiles: contextVueFiles,
          context,
          symbolLookup,
          vueSymbolLookup,
          sourceCache,
        });
      })();

    const occurrences = dedupeOccurrences(computation.occurrences);
    const insertedMentions = replaceVueDocumentChunks(
      db,
      opts.projectRoot,
      vueFiles,
      vueSymbolLookup,
      occurrences,
    );
    opts.onStatus?.(
      `Resolved ${occurrences.length} Vue references with Volar; inserted ${insertedMentions} mentions.`,
    );

    const result = {
      vueFiles: vueFiles.length,
      resolvedReferences: occurrences.length,
      insertedMentions,
      skippedReferences: computation.skippedReferences,
      syntheticSymbols: vueSymbolLookup.syntheticSymbols,
    };
    writeAugmentVueCache(
      cachePath,
      computeAugmentVueFingerprint(db, opts.projectRoot, opts.tsconfig),
      result,
    );
    return result;
  } finally {
    db.close();
  }
}

function readAugmentVueCache(
  cachePath: string,
  fingerprint: AugmentVueFingerprint,
): AugmentVueResolvedResult | null {
  try {
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as AugmentVueCache;
    return JSON.stringify(cache.fingerprint) === JSON.stringify(fingerprint)
      ? cache.result
      : null;
  } catch {
    return null;
  }
}

function writeAugmentVueCache(
  cachePath: string,
  fingerprint: AugmentVueFingerprint,
  result: AugmentVueResolvedResult,
): void {
  writeFileSync(cachePath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    fingerprint,
    result,
  }, null, 2) + '\n');
}

function computeAugmentVueFingerprint(
  db: Database.Database,
  projectRoot: string,
  tsconfig: string,
): AugmentVueFingerprint {
  const dbStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents) AS documents,
      (SELECT COUNT(*) FROM global_symbols) AS symbols,
      (SELECT COUNT(*) FROM chunks) AS chunks,
      (SELECT COUNT(*) FROM mentions) AS mentions,
      (SELECT COUNT(*) FROM defn_enclosing_ranges) AS ranges,
      (SELECT MAX(id) FROM chunks) AS maxChunkId,
      (SELECT MAX(id) FROM global_symbols) AS maxSymbolId
  `).get() as AugmentVueFingerprint['db'];

  return {
    version: 2,
    tsconfig,
    files: fingerprintProjectFiles(projectRoot),
    db: dbStats,
  };
}

export function computeVueResolvedReferencesForWorker(opts: {
  projectRoot: string;
  dbPath: string;
  tsconfig: string;
  vueFiles?: string[];
  tasks?: VueReferenceTask[];
}): VueReferenceComputationResult {
  const configPath = resolve(opts.projectRoot, opts.tsconfig);
  const context = createVueLanguageContext(opts.projectRoot, configPath);
  const db = new Database(opts.dbPath, { readonly: true });
  try {
    const sourceCache = createSourceTextCache();
    return computeVueResolvedReferencesForFiles({
      projectRoot: opts.projectRoot,
      vueFiles: opts.vueFiles ?? [],
      tasks: opts.tasks,
      context,
      symbolLookup: createSymbolLookup(db, opts.projectRoot, sourceCache),
      vueSymbolLookup: createVueSymbolIdLookup(db, opts.projectRoot),
      sourceCache,
    });
  } finally {
    db.close();
  }
}

function computeVueResolvedReferencesForFiles(opts: {
  projectRoot: string;
  vueFiles: string[];
  tasks?: VueReferenceTask[];
  context: VueLanguageContext;
  symbolLookup: (definition: DefinitionInfo) => number | null;
  vueSymbolLookup: { get(fileName: string): number | null };
  sourceCache: (fileName: string) => SourceTextInfo | null;
}): VueReferenceComputationResult {
  const occurrences: ResolvedOccurrence[] = [];
  let skippedReferences = 0;
  const tasks = opts.tasks ?? opts.vueFiles.map((fileName) => ({
    fileName,
    startOffset: 0,
    endOffset: Number.POSITIVE_INFINITY,
    countFileSkip: true,
  }));

  for (const task of tasks) {
    const fileName = task.fileName;
    const sourceScript = opts.context.language.scripts.get(fileName);
    const serviceScript = sourceScript?.generated?.languagePlugin.typescript
      ?.getServiceScript(sourceScript.generated.root)?.code;
    if (!sourceScript || !serviceScript) {
      if (task.countFileSkip) skippedReferences++;
      continue;
    }

    const map = opts.context.language.maps.get(serviceScript, sourceScript);
    const sourceInfo = opts.sourceCache(fileName);
    if (!sourceInfo) {
      if (task.countFileSkip) skippedReferences++;
      continue;
    }
    const sourceFile = toRelativePath(opts.projectRoot, fileName);
    const fileTokens = [...identifierTokens(sourceInfo.text)];
    const tokens = fileTokens
      .filter((token) => token.start >= task.startOffset && token.start < task.endOffset);
    const tokenByStart = new Map(fileTokens.map((token) => [token.start, token]));
    const tokenTextCounts = countTokenTexts(fileTokens);
    const processedStarts = new Set<number>();

    for (const token of tokens) {
      if (processedStarts.has(token.start)) continue;
      const generated = firstGeneratedOffset(map, token.start);
      if (generated === null) continue;

      const definitions = opts.context.languageService.getDefinitionAtPosition(fileName, generated + 1) ?? [];
      const definition = definitions.find((def) => !isExternalDefinition(opts.projectRoot, def.fileName));
      if (!definition) {
        skippedReferences++;
        continue;
      }

      const symbolId = resolveDefinitionSymbolId(
        definition,
        opts.symbolLookup,
        opts.vueSymbolLookup,
        opts.context,
        opts.projectRoot,
      );
      if (symbolId === null) {
        skippedReferences++;
        continue;
      }

      addVueOccurrence(occurrences, sourceInfo, sourceFile, token, symbolId);
      processedStarts.add(token.start);

      if ((tokenTextCounts.get(token.text) ?? 0) > 1) {
        for (const highlightedStart of sameSymbolSourceStarts(
          opts.context.languageService,
          fileName,
          generated + 1,
          map,
          token,
          tokenByStart,
        )) {
          if (processedStarts.has(highlightedStart)) continue;
          const highlightedToken = tokenByStart.get(highlightedStart);
          if (!highlightedToken) continue;
          addVueOccurrence(occurrences, sourceInfo, sourceFile, highlightedToken, symbolId);
          processedStarts.add(highlightedStart);
        }
      }
    }
  }

  return { occurrences, skippedReferences };
}

function addVueOccurrence(
  occurrences: ResolvedOccurrence[],
  sourceInfo: SourceTextInfo,
  sourceFile: string,
  token: VueIdentifierToken,
  symbolId: number,
): void {
  const sourcePos = offsetToLineChar(sourceInfo, token.start);
  occurrences.push({
    sourceFile,
    sourceLine: sourcePos.line,
    sourceStartChar: sourcePos.character,
    sourceEndChar: sourcePos.character + token.text.length,
    symbolId,
  });
}

function countTokenTexts(tokens: readonly VueIdentifierToken[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token.text, (counts.get(token.text) ?? 0) + 1);
  }
  return counts;
}

function sameSymbolSourceStarts(
  languageService: TsLanguageService,
  fileName: string,
  generatedPosition: number,
  map: VolarMapper,
  token: VueIdentifierToken,
  tokenByStart: ReadonlyMap<number, VueIdentifierToken>,
): number[] {
  const highlights = languageService.getDocumentHighlights?.(fileName, generatedPosition, [fileName]) ?? [];
  const starts: number[] = [];
  for (const fileHighlights of highlights) {
    if (fileHighlights.fileName !== fileName) continue;
    for (const span of fileHighlights.highlightSpans) {
      const start = sourceStartForHighlight(map, span.textSpan.start, tokenByStart, token.text);
      if (start !== null) {
        starts.push(start);
      }
    }
  }
  return starts;
}

function sourceStartForHighlight(
  map: VolarMapper,
  highlightStart: number,
  tokenByStart: ReadonlyMap<number, VueIdentifierToken>,
  tokenText: string,
): number | null {
  const direct = tokenByStart.get(highlightStart);
  if (direct?.text === tokenText) {
    return direct.start;
  }

  const sourceStart = firstSourceOffset(map, highlightStart);
  if (sourceStart === null) {
    return null;
  }
  const mapped = tokenByStart.get(sourceStart);
  return mapped?.text === tokenText ? mapped.start : null;
}

function shouldUseVueWorkers(vueFiles: readonly string[]): boolean {
  return vueFiles.length >= 8 && resolveVueWorkerCount(vueFiles.length) > 1;
}

function awaitVueReferenceWorkers(opts: {
  projectRoot: string;
  dbPath: string;
  tsconfig: string;
  vueFiles: string[];
}): VueReferenceComputationResult {
  const workerCount = resolveVueWorkerCount(opts.vueFiles.length);
  const tasks = createVueReferenceTasks(opts.vueFiles);
  const partitions = partitionTasks(tasks, workerCount);
  const workerUrl = new URL('./augment-vue-worker.js', import.meta.url);
  const resultDir = mkdtempSync(join(tmpdir(), 'scip-query-vue-workers-'));
  const sharedBuffer = new SharedArrayBuffer(4);
  const signal = new Int32Array(sharedBuffer);
  const timeoutMs = resolveVueWorkerTimeoutMs();
  const startedAt = Date.now();

  try {
    for (let index = 0; index < partitions.length; index++) {
      new Worker(workerUrl, {
        workerData: {
          projectRoot: opts.projectRoot,
          dbPath: opts.dbPath,
          tsconfig: opts.tsconfig,
          tasks: partitions[index],
          resultPath: join(resultDir, `${index}.json`),
          sharedBuffer,
        },
      });
    }

    while (Atomics.load(signal, 0) < partitions.length) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Vue reference workers timed out after ${(timeoutMs / 1000).toFixed(0)}s`);
      }
      Atomics.wait(signal, 0, Atomics.load(signal, 0), 100);
    }

    const results = partitions.map((_, index) => {
      const raw = JSON.parse(readFileSync(join(resultDir, `${index}.json`), 'utf-8')) as
        | { ok: true; result: VueReferenceComputationResult }
        | { ok: false; error: string };
      if (!raw.ok) {
        throw new Error(`Vue reference worker failed: ${raw.error}`);
      }
      return raw.result;
    });

    return {
      occurrences: results.flatMap((result) => result.occurrences),
      skippedReferences: results.reduce((sum, result) => sum + result.skippedReferences, 0),
    };
  } finally {
    rmSync(resultDir, { recursive: true, force: true });
  }
}

function resolveVueWorkerCount(fileCount: number): number {
  const configured = Number(process.env['SCIP_QUERY_AUGMENT_VUE_WORKERS'] ?? 0);
  const maxWorkers = Number.isFinite(configured) && configured > 0
    ? configured
    : Math.min(8, Math.max(1, cpus().length - 1));
  return Math.max(1, Math.min(fileCount, maxWorkers));
}

function resolveVueWorkerTimeoutMs(): number {
  const configured = Number(process.env['SCIP_QUERY_AUGMENT_VUE_WORKER_TIMEOUT_MS'] ?? 0);
  return Number.isFinite(configured) && configured > 0 ? configured : 300_000;
}

function createVueReferenceTasks(files: readonly string[]): VueReferenceTask[] {
  const targetBytes = resolveVueShardBytes();
  const tasks: VueReferenceTask[] = [];
  for (const fileName of files) {
    const weight = fileWeight(fileName);
    const shardCount = Math.max(1, Math.ceil(weight / targetBytes));
    for (let shard = 0; shard < shardCount; shard++) {
      tasks.push({
        fileName,
        startOffset: Math.floor((weight * shard) / shardCount),
        endOffset: shard === shardCount - 1
          ? Number.POSITIVE_INFINITY
          : Math.floor((weight * (shard + 1)) / shardCount),
        countFileSkip: shard === 0,
      });
    }
  }
  return tasks;
}

function resolveVueShardBytes(): number {
  return Number.POSITIVE_INFINITY;
}

function partitionTasks(tasks: readonly VueReferenceTask[], workerCount: number): VueReferenceTask[][] {
  const partitions = Array.from({ length: workerCount }, () => ({
    tasks: [] as VueReferenceTask[],
    weight: 0,
  }));
  const weightedTasks = tasks
    .map((task) => ({ task, weight: taskWeight(task) }))
    .sort((a, b) => b.weight - a.weight);

  for (const entry of weightedTasks) {
    const partition = partitions.reduce((lightest, current) => (
      current.weight < lightest.weight ? current : lightest
    ));
    partition.tasks.push(entry.task);
    partition.weight += entry.weight;
  }
  return partitions.map((partition) => partition.tasks).filter((partition) => partition.length > 0);
}

function taskWeight(task: VueReferenceTask): number {
  if (!Number.isFinite(task.endOffset)) {
    return Math.max(1, fileWeight(task.fileName) - task.startOffset);
  }
  return Math.max(1, task.endOffset - task.startOffset);
}

function fileWeight(fileName: string): number {
  try {
    return statSync(fileName).size;
  } catch {
    return 1;
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

function listVueDocumentFiles(db: Database.Database, projectRoot: string): string[] {
  const rows = db.prepare(`
    SELECT relative_path AS relativePath
    FROM documents
    WHERE language = 'vue' OR relative_path LIKE '%.vue'
    ORDER BY relative_path
  `).all() as { relativePath: string }[];
  return rows.map((row) => resolve(projectRoot, row.relativePath));
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

  const languageRef: { current?: VolarLanguage } = {};
  const language = vueCore.createLanguage([vuePlugin], new Map(), (id) => {
    if (!existsSync(id)) return;
    const text = readFileSync(id, 'utf-8');
    languageRef.current?.scripts.set(
      id,
      ts.ScriptSnapshot.fromString(text),
      vuePlugin.getLanguageId(id) ?? languageIdForPath(id),
    );
  });
  languageRef.current = language;

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

function createSymbolLookup(
  db: Database.Database,
  projectRoot: string,
  sourceCache: (fileName: string) => SourceTextInfo | null,
): (definition: DefinitionInfo) => number | null {
  const rangesByFile = loadDefinitionRanges(db);

  return (definition: DefinitionInfo): number | null => {
    const relativePath = toRelativePath(projectRoot, definition.fileName);
    const sourceInfo = sourceCache(definition.fileName);
    if (!sourceInfo) return null;
    const pos = offsetToLineChar(sourceInfo, definition.textSpan.start);
    const lookup = rangesByFile.get(relativePath);
    if (!lookup) return null;
    const containing = lookup.containingByLine.get(pos.line);
    if (containing !== undefined) return containing;
    return findNearestStart(lookup.starts, pos.line, 2);
  };
}

function loadDefinitionRanges(db: Database.Database): Map<string, DefinitionRangeLookup> {
  const rows = db.prepare(`
    SELECT
      d.relative_path AS relativePath,
      der.start_line AS startLine,
      der.end_line AS endLine,
      der.symbol_id AS symbolId
    FROM defn_enclosing_ranges der
    JOIN documents d ON d.id = der.document_id
    ORDER BY d.relative_path, (der.end_line - der.start_line) DESC
  `).all() as {
    relativePath: string;
    startLine: number;
    endLine: number;
    symbolId: number;
  }[];

  const byFile = new Map<string, DefinitionRangeLookup>();
  for (const row of rows) {
    let lookup = byFile.get(row.relativePath);
    if (!lookup) {
      lookup = { containingByLine: new Map(), starts: [] };
      byFile.set(row.relativePath, lookup);
    }
    lookup.starts.push({ line: row.startLine, symbolId: row.symbolId });
    for (let line = row.startLine; line <= row.endLine; line++) {
      lookup.containingByLine.set(line, row.symbolId);
    }
  }

  for (const lookup of byFile.values()) {
    lookup.starts.sort((a, b) => a.line - b.line);
  }
  return byFile;
}

function findNearestStart(
  starts: readonly { line: number; symbolId: number }[],
  targetLine: number,
  maxDistance: number,
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
    const distance = Math.abs(candidate.line - targetLine);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) {
      best = { distance, symbolId: candidate.symbolId };
    }
  }
  return best?.symbolId ?? null;
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

function replaceVueDocumentChunks(
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

function createVueSymbolIdLookup(
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
      const relativePath = toRelativePath(projectRoot, fileName);
      const symbol = vueDefaultExportSymbol(packageInfo.name, packageInfo.version, relativePath);
      const row = select.get(symbol) as { id: number } | undefined;
      const id = row?.id ?? null;
      byFile.set(fileName, id);
      return id;
    },
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

function dedupeOccurrences(occurrences: ResolvedOccurrence[]): ResolvedOccurrence[] {
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

function insertOccurrencesWithoutTransaction(
  db: Database.Database,
  occurrences: ResolvedOccurrence[],
): number {
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
function* identifierTokens(source: string): Generator<VueIdentifierToken> {
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

function createSourceTextCache(): (fileName: string) => SourceTextInfo | null {
  const cache = new Map<string, SourceTextInfo | null>();
  return (fileName: string) => {
    if (cache.has(fileName)) {
      return cache.get(fileName) ?? null;
    }
    try {
      const text = readFileSync(fileName, 'utf-8');
      const info = { text, lineStarts: createLineStarts(text) };
      cache.set(fileName, info);
      return info;
    } catch {
      cache.set(fileName, null);
      return null;
    }
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
    const rows = db.prepare(
      `SELECT id, relative_path AS relativePath FROM documents WHERE relative_path IN (${chunk.map(() => '?').join(',')})`,
    ).all(...chunk) as { id: number; relativePath: string }[];
    for (const row of rows) {
      ids.set(row.relativePath, row.id);
    }
  }
  return ids;
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
