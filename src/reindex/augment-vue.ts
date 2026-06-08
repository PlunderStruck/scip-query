import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { augmentAuxiliaryDocuments } from './augment.js';
import { fingerprintProjectFiles } from './project-files.js';
import { awaitVueReferenceWorkers, shouldUseVueWorkers } from './augment-vue-workers.js';
import { createSymbolLookup, createVueComponentSymbolLookup, createVueLanguageContext, createVueSourceReader, createVueSymbolIdLookup, dedupeOccurrences, firstGeneratedOffset, firstSourceOffset, identifierTokens, isExternalDefinition, listVueDocumentFiles, replaceVueDocumentChunks, resolveVueDefinitionSymbolId, toRelativePath } from './augment-vue-runtime.js';

import type { AugmentVueResolvedResult, ResolvedOccurrence, VueReferenceComputationResult, VueReferenceTask } from './augment-vue-contracts.js';

type VueLanguageContext = ReturnType<typeof createVueLanguageContext>;
type VueSourceReader = ReturnType<typeof createVueSourceReader>;
type DefinitionInfo = Parameters<ReturnType<typeof createSymbolLookup>>[0];
type SourceTextInfo = NonNullable<ReturnType<VueSourceReader['get']>>;
type TsLanguageService = VueLanguageContext['languageService'];
type VolarMapper = ReturnType<VueLanguageContext['language']['maps']['get']>;
type VueIdentifierToken = ReturnType<typeof identifierTokens> extends Generator<infer Token> ? Token : never;
type VueSymbolLookup = { get(fileName: string): number | null };

export interface AugmentVueResolvedOptions {
  projectRoot: string;
  dbPath: string;
  tsconfig: string;
  onStatus?: (message: string) => void;
}

interface VueReferenceComputationOptions {
  projectRoot: string;
  vueFiles: string[];
  tasks?: VueReferenceTask[];
  context: VueLanguageContext;
  symbolLookup: (definition: DefinitionInfo) => number | null;
  vueSymbolLookup: VueSymbolLookup;
  sourceReader: VueSourceReader;
}

interface VueReferenceComputationContext {
  projectRoot: string;
  context: VueLanguageContext;
  symbolLookup: (definition: DefinitionInfo) => number | null;
  vueSymbolLookup: VueSymbolLookup;
  sourceReader: VueSourceReader;
}

interface AugmentVueCache {
  fingerprint: AugmentVueFingerprint;
  result: AugmentVueResolvedResult;
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

interface VueAugmentationTransactionContext {
  db: Database.Database;
  projectRoot: string;
  dbPath: string;
  tsconfig: string;
  configPath: string;
  vueFiles: string[];
  onStatus?: (message: string) => void;
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
    const cachedResult = reuseCachedVueAugmentation(cachePath, cacheFingerprint, opts.onStatus);
    if (cachedResult) return cachedResult;

    const result = runVueAugmentationTransaction({
      db,
      projectRoot: opts.projectRoot,
      dbPath: opts.dbPath,
      tsconfig: opts.tsconfig,
      configPath,
      vueFiles,
      onStatus: opts.onStatus,
    });
    writeAugmentVueCache(cachePath, computeAugmentVueFingerprint(db, opts.projectRoot, opts.tsconfig), result);
    return result;
  } finally {
    db.close();
  }
}

function reuseCachedVueAugmentation(
  cachePath: string,
  cacheFingerprint: AugmentVueFingerprint,
  onStatus?: (message: string) => void,
): AugmentVueResolvedResult | null {
  const cachedResult = readAugmentVueCache(cachePath, cacheFingerprint);
  if (cachedResult) {
    onStatus?.(
      `Vue references unchanged; reused ${cachedResult.resolvedReferences} cached resolved references.`,
    );
  }
  return cachedResult;
}

// scip-query: ignore-extract — Vue augmentation is a transaction: create the
// component-symbol view, compute Volar-backed references, normalize occurrence
// facts, replace generated chunks, and return the persisted summary as one unit.
function runVueAugmentationTransaction(
  ctx: VueAugmentationTransactionContext,
): AugmentVueResolvedResult {
  const vueSymbolLookup = createVueComponentSymbolLookup(ctx.db, ctx.projectRoot, ctx.vueFiles);
  const computation = computeVueReferenceComputation(ctx, vueSymbolLookup);
  const occurrences = dedupeOccurrences(computation.occurrences);
  const insertedMentions = replaceVueDocumentChunks(
    ctx.db,
    ctx.projectRoot,
    ctx.vueFiles,
    vueSymbolLookup,
    occurrences,
  );
  const result: AugmentVueResolvedResult = {
    vueFiles: ctx.vueFiles.length,
    resolvedReferences: occurrences.length,
    insertedMentions,
    skippedReferences: computation.skippedReferences,
    syntheticSymbols: vueSymbolLookup.syntheticSymbols,
  };

  ctx.onStatus?.(
    `Resolved ${result.resolvedReferences} Vue references with Volar; inserted ${result.insertedMentions} mentions.`,
  );
  return result;
}

function computeVueReferenceComputation(
  ctx: VueAugmentationTransactionContext,
  vueSymbolLookup: ReturnType<typeof createVueComponentSymbolLookup>,
): VueReferenceComputationResult {
  if (shouldUseVueWorkers(ctx.vueFiles)) {
    return awaitVueReferenceWorkers({
      projectRoot: ctx.projectRoot,
      dbPath: ctx.dbPath,
      tsconfig: ctx.tsconfig,
      vueFiles: ctx.vueFiles,
    });
  }

  const computationContext = createVueReferenceComputationContext({
    db: ctx.db,
    projectRoot: ctx.projectRoot,
    configPath: ctx.configPath,
    vueSymbolLookup,
  });
  return computeVueResolvedReferencesForFiles({
    ...computationContext,
    vueFiles: computationContext.context.fileNames.filter((file) => file.endsWith('.vue')),
  });
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
  const db = new Database(opts.dbPath, { readonly: true });
  try {
    const computationContext = createVueReferenceComputationContext({
      db,
      projectRoot: opts.projectRoot,
      configPath,
      vueSymbolLookup: createVueSymbolIdLookup(db, opts.projectRoot),
    });
    return computeVueResolvedReferencesForFiles({
      vueFiles: opts.vueFiles ?? [],
      tasks: opts.tasks,
      ...computationContext,
    });
  } finally {
    db.close();
  }
}

function createVueReferenceComputationContext(opts: {
  db: Database.Database;
  projectRoot: string;
  configPath: string;
  vueSymbolLookup: VueSymbolLookup;
}): VueReferenceComputationContext {
  const sourceReader = createVueSourceReader();
  return {
    projectRoot: opts.projectRoot,
    context: createVueLanguageContext(opts.projectRoot, opts.configPath),
    symbolLookup: createSymbolLookup(opts.db, opts.projectRoot, sourceReader),
    vueSymbolLookup: opts.vueSymbolLookup,
    sourceReader,
  };
}

function computeVueResolvedReferencesForFiles(
  opts: VueReferenceComputationOptions,
): VueReferenceComputationResult {
  const occurrences: ResolvedOccurrence[] = [];
  let skippedReferences = 0;
  const tasks = opts.tasks ?? opts.vueFiles.map((fileName) => ({
    fileName,
    startOffset: 0,
    endOffset: Number.POSITIVE_INFINITY,
    countFileSkip: true,
  }));

  for (const task of tasks) {
    const result = computeVueReferenceTask(opts, task);
    occurrences.push(...result.occurrences);
    skippedReferences += result.skippedReferences;
  }

  return { occurrences, skippedReferences };
}

// scip-query: ignore-extract — this prepares one bounded Vue reference task:
// service script lookup, source cache lookup, token windows, and mapper context
// are the setup contract for the resolver.
function computeVueReferenceTask(
  opts: VueReferenceComputationOptions,
  task: VueReferenceTask,
): VueReferenceComputationResult {
  const sourceScript = opts.context.language.scripts.get(task.fileName);
  const serviceScript = sourceScript?.generated?.languagePlugin.typescript
    ?.getServiceScript(sourceScript.generated.root)?.code;
  if (!sourceScript || !serviceScript) {
    return { occurrences: [], skippedReferences: task.countFileSkip ? 1 : 0 };
  }

  const sourceInfo = opts.sourceReader.get(task.fileName);
  if (!sourceInfo) {
    return { occurrences: [], skippedReferences: task.countFileSkip ? 1 : 0 };
  }

  const map = opts.context.language.maps.get(serviceScript, sourceScript);
  const sourceFile = toRelativePath(opts.projectRoot, task.fileName);
  const fileTokens = [...identifierTokens(sourceInfo.text)];
  const tokenContext = {
    tokens: fileTokens.filter((token) => token.start >= task.startOffset && token.start < task.endOffset),
    tokenByStart: new Map(fileTokens.map((token) => [token.start, token])),
    tokenTextCounts: countTokenTexts(fileTokens),
    processedStarts: new Set<number>(),
  };

  return resolveVueTokenReferences({
    ...opts,
    fileName: task.fileName,
    sourceInfo,
    sourceFile,
    map,
    tokenContext,
  });
}

// scip-query: ignore-extract — this is the per-token Volar resolution loop:
// generated offsets, definitions, symbol IDs, primary occurrences, and
// highlighted occurrences all advance the same processed-starts state.
function resolveVueTokenReferences(opts: VueReferenceComputationOptions & {
  fileName: string;
  sourceInfo: SourceTextInfo;
  sourceFile: string;
  map: VolarMapper;
  tokenContext: {
    tokens: VueIdentifierToken[];
    tokenByStart: Map<number, VueIdentifierToken>;
    tokenTextCounts: Map<string, number>;
    processedStarts: Set<number>;
  };
}): VueReferenceComputationResult {
  const occurrences: ResolvedOccurrence[] = [];
  let skippedReferences = 0;

  for (const token of opts.tokenContext.tokens) {
    if (opts.tokenContext.processedStarts.has(token.start)) continue;
    const generated = firstGeneratedOffset(opts.map, token.start);
    if (generated === null) continue;

    const definitions = opts.context.languageService.getDefinitionAtPosition(opts.fileName, generated + 1) ?? [];
    const definition = definitions.find((def) => !isExternalDefinition(opts.projectRoot, def.fileName));
    if (!definition) {
      skippedReferences++;
      continue;
    }

    const symbolId = resolveVueDefinitionSymbolId(
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

    addVueOccurrence(occurrences, opts.sourceReader, opts.sourceInfo, opts.sourceFile, token, symbolId);
    opts.tokenContext.processedStarts.add(token.start);
    addVueHighlightedOccurrences(occurrences, opts, token, generated, symbolId);
  }

  return { occurrences, skippedReferences };
}

function addVueHighlightedOccurrences(
  occurrences: ResolvedOccurrence[],
  opts: Parameters<typeof resolveVueTokenReferences>[0],
  token: VueIdentifierToken,
  generated: number,
  symbolId: number,
): void {
  if ((opts.tokenContext.tokenTextCounts.get(token.text) ?? 0) <= 1) return;
  for (const highlightedStart of sameSymbolSourceStarts(
    opts.context.languageService,
    opts.fileName,
    generated + 1,
    opts.map,
    token,
    opts.tokenContext.tokenByStart,
  )) {
    if (opts.tokenContext.processedStarts.has(highlightedStart)) continue;
    const highlightedToken = opts.tokenContext.tokenByStart.get(highlightedStart);
    if (!highlightedToken) continue;
    addVueOccurrence(occurrences, opts.sourceReader, opts.sourceInfo, opts.sourceFile, highlightedToken, symbolId);
    opts.tokenContext.processedStarts.add(highlightedStart);
  }
}

function addVueOccurrence(
  occurrences: ResolvedOccurrence[],
  sourceReader: VueReferenceComputationOptions['sourceReader'],
  sourceInfo: SourceTextInfo,
  sourceFile: string,
  token: VueIdentifierToken,
  symbolId: number,
): void {
  const sourcePos = sourceReader.positionAt(sourceInfo, token.start);
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
