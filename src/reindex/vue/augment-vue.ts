import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fingerprintProjectFiles } from '../../platform/project-files.js';
import { auxiliaryDocumentsAugmentationStage } from '../augmentation/augment.js';
import {
  runFingerprintCachedPostIndexAugmentation,
  runFingerprintCachedPostIndexAugmentationAsync,
  runPostIndexAugmentation,
  type PostIndexAugmentationStage,
} from '../augmentation/post-index-augmentation.js';
import { awaitVueReferenceWorkers, shouldUseVueWorkers } from './augment-vue-workers.js';
import {
  createSymbolLookup,
  createVueComponentSymbolLookup,
  createVueLanguageContext,
  createVueSourceReader,
  createVueSymbolIdLookup,
  dedupeOccurrences,
  firstGeneratedOffset,
  firstSourceOffset,
  identifierTokens,
  isExternalDefinition,
  listVueDocumentFiles,
  replaceVueDocumentChunks,
  resolveVueDefinitionSymbolId,
  toRelativePath,
} from './augment-vue-runtime.js';

import type {
  AugmentVueResolvedResult,
  ResolvedOccurrence,
  VueReferenceComputationResult,
  VueReferenceTask,
  VueSkippedReferenceReason,
  VueSkippedReferenceSample,
} from './augment-vue-contracts.js';
import {
  emptySkippedReferenceDiagnostics,
  mergeSkippedReferenceDiagnostics,
  SKIPPED_REFERENCE_SAMPLES_PER_FILE_REASON,
} from './augment-vue-contracts.js';

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

// scip-query: ignore-stale — reviewed S1 owned contract; the Vue augmenter consumes this computation policy as one unit.
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

interface AugmentVueFingerprint {
  version: 3;
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

export function vueResolvedReferencesAugmentationStage(opts: {
  tsconfig: string;
}): PostIndexAugmentationStage<AugmentVueResolvedResult> {
  return {
    id: 'vue-resolved-references',
    facts: [
      'synthetic-symbol',
      'source-mapped-occurrence',
      'definition-mention',
      'replacement-chunk',
      'fingerprint-cache',
    ],
    run: (context) =>
      augmentVueResolvedReferencesFromIndexedDocuments({
        projectRoot: context.projectRoot,
        dbPath: context.dbPath,
        tsconfig: opts.tsconfig,
        onStatus: context.onStatus,
      }),
  };
}

export function augmentVueResolvedReferences(opts: AugmentVueResolvedOptions): AugmentVueResolvedResult {
  runPostIndexAugmentation(auxiliaryDocumentsAugmentationStage(), {
    projectRoot: opts.projectRoot,
    dbPath: opts.dbPath,
  });
  return runPostIndexAugmentation(vueResolvedReferencesAugmentationStage({ tsconfig: opts.tsconfig }), {
    projectRoot: opts.projectRoot,
    dbPath: opts.dbPath,
    onStatus: opts.onStatus,
  }).result;
}

/**
 * Async Vue augmentation enables the opt-in worker policy while preserving the
 * synchronous public entry point's existing return type and reliable
 * single-context execution.
 */
export async function augmentVueResolvedReferencesAsync(
  opts: AugmentVueResolvedOptions,
): Promise<AugmentVueResolvedResult> {
  runPostIndexAugmentation(auxiliaryDocumentsAugmentationStage(), {
    projectRoot: opts.projectRoot,
    dbPath: opts.dbPath,
  });
  return augmentVueResolvedReferencesFromIndexedDocumentsAsync(opts);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function augmentVueResolvedReferencesFromIndexedDocuments(opts: AugmentVueResolvedOptions): AugmentVueResolvedResult {
  const configPath = resolve(opts.projectRoot, opts.tsconfig);
  if (!existsSync(configPath)) {
    throw new Error(`Vue tsconfig not found at ${configPath}`);
  }

  const db = new Database(opts.dbPath);

  try {
    const vueFiles = listVueDocumentFiles(db, opts.projectRoot);
    const cachePath = join(dirname(opts.dbPath), 'augment-vue-meta.json');
    return runFingerprintCachedPostIndexAugmentation({
      cachePath,
      readFingerprint: () => computeAugmentVueFingerprint(db, opts.projectRoot, opts.tsconfig),
      compute: () =>
        runVueAugmentationTransaction({
          db,
          projectRoot: opts.projectRoot,
          dbPath: opts.dbPath,
          tsconfig: opts.tsconfig,
          configPath,
          vueFiles,
          onStatus: opts.onStatus,
        }),
      onCacheHit: (cachedResult) =>
        opts.onStatus?.(
          `Vue references unchanged; reused ${cachedResult.resolvedReferences} cached resolved references.`,
        ),
    });
  } finally {
    db.close();
  }
}

async function augmentVueResolvedReferencesFromIndexedDocumentsAsync(
  opts: AugmentVueResolvedOptions,
): Promise<AugmentVueResolvedResult> {
  const configPath = resolve(opts.projectRoot, opts.tsconfig);
  if (!existsSync(configPath)) {
    throw new Error(`Vue tsconfig not found at ${configPath}`);
  }

  const db = new Database(opts.dbPath);
  try {
    const vueFiles = listVueDocumentFiles(db, opts.projectRoot);
    const cachePath = join(dirname(opts.dbPath), 'augment-vue-meta.json');
    return await runFingerprintCachedPostIndexAugmentationAsync({
      cachePath,
      readFingerprint: () => computeAugmentVueFingerprint(db, opts.projectRoot, opts.tsconfig),
      compute: () =>
        runVueAugmentationTransactionAsync({
          db,
          projectRoot: opts.projectRoot,
          dbPath: opts.dbPath,
          tsconfig: opts.tsconfig,
          configPath,
          vueFiles,
          onStatus: opts.onStatus,
        }),
      onCacheHit: (cachedResult) =>
        opts.onStatus?.(
          `Vue references unchanged; reused ${cachedResult.resolvedReferences} cached resolved references.`,
        ),
    });
  } finally {
    db.close();
  }
}

// scip-query: ignore-extract — Vue augmentation is a transaction: create the
// component-symbol view, compute Volar-backed references, normalize occurrence
// facts, replace generated chunks, and return the persisted summary as one unit.
function runVueAugmentationTransaction(ctx: VueAugmentationTransactionContext): AugmentVueResolvedResult {
  const vueSymbolLookup = createVueComponentSymbolLookup(ctx.db, ctx.projectRoot, ctx.vueFiles);
  const computation = computeVueReferenceComputationInProcess(ctx, vueSymbolLookup);
  return persistVueReferenceComputation(ctx, vueSymbolLookup, computation);
}

async function runVueAugmentationTransactionAsync(
  ctx: VueAugmentationTransactionContext,
): Promise<AugmentVueResolvedResult> {
  const vueSymbolLookup = createVueComponentSymbolLookup(ctx.db, ctx.projectRoot, ctx.vueFiles);
  const computation = shouldUseVueWorkers(ctx.vueFiles)
    ? await awaitVueReferenceWorkers({
        projectRoot: ctx.projectRoot,
        dbPath: ctx.dbPath,
        tsconfig: ctx.tsconfig,
        vueFiles: ctx.vueFiles,
      })
    : computeVueReferenceComputationInProcess(ctx, vueSymbolLookup);
  return persistVueReferenceComputation(ctx, vueSymbolLookup, computation);
}

function persistVueReferenceComputation(
  ctx: VueAugmentationTransactionContext,
  vueSymbolLookup: ReturnType<typeof createVueComponentSymbolLookup>,
  computation: VueReferenceComputationResult,
): AugmentVueResolvedResult {
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
    resolvedReferenceSamples: resolvedReferenceSamples(ctx.db, occurrences, 20),
    insertedMentions,
    skippedReferences: computation.skippedReferences,
    skippedReferenceReasons: computation.skippedReferenceReasons,
    skippedReferenceSamples: sampleSkippedReferences(computation.skippedReferenceSamples, 20),
    syntheticSymbols: vueSymbolLookup.syntheticSymbols,
  };

  ctx.onStatus?.(
    `Resolved ${result.resolvedReferences} Vue references with Volar; inserted ${result.insertedMentions} mentions.`,
  );
  return result;
}

function computeVueReferenceComputationInProcess(
  ctx: VueAugmentationTransactionContext,
  vueSymbolLookup: ReturnType<typeof createVueComponentSymbolLookup>,
): VueReferenceComputationResult {
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

function computeAugmentVueFingerprint(
  db: Database.Database,
  projectRoot: string,
  tsconfig: string,
): AugmentVueFingerprint {
  const dbStats = db
    .prepare(
      `
    SELECT
      (SELECT COUNT(*) FROM documents) AS documents,
      (SELECT COUNT(*) FROM global_symbols) AS symbols,
      (SELECT COUNT(*) FROM chunks) AS chunks,
      (SELECT COUNT(*) FROM mentions) AS mentions,
      (SELECT COUNT(*) FROM defn_enclosing_ranges) AS ranges,
      (SELECT MAX(id) FROM chunks) AS maxChunkId,
      (SELECT MAX(id) FROM global_symbols) AS maxSymbolId
  `,
    )
    .get() as AugmentVueFingerprint['db'];

  return {
    version: 3,
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

function computeVueResolvedReferencesForFiles(opts: VueReferenceComputationOptions): VueReferenceComputationResult {
  const occurrences: ResolvedOccurrence[] = [];
  const diagnostics = emptySkippedReferenceDiagnostics();
  const tasks =
    opts.tasks ??
    opts.vueFiles.map((fileName) => ({
      fileName,
      startOffset: 0,
      endOffset: Number.POSITIVE_INFINITY,
      countFileSkip: true,
    }));

  for (const task of tasks) {
    const result = computeVueReferenceTask(opts, task);
    occurrences.push(...result.occurrences);
    mergeSkippedReferenceDiagnostics(diagnostics, result);
  }

  return { occurrences, ...diagnostics };
}

// scip-query: ignore-extract — this prepares one bounded Vue reference task:
// service script lookup, source cache lookup, token windows, and mapper context
// are the setup contract for the resolver.
export function computeVueReferenceTask(
  opts: VueReferenceComputationOptions,
  task: VueReferenceTask,
): VueReferenceComputationResult {
  const sourceInfo = opts.sourceReader.get(task.fileName);
  if (!sourceInfo) {
    return skippedFileResult(opts.projectRoot, task, 'missing-source-file');
  }

  const sourceScript = opts.context.language.scripts.get(task.fileName);
  const serviceScript = sourceScript?.generated?.languagePlugin.typescript?.getServiceScript(
    sourceScript.generated.root,
  )?.code;
  if (!sourceScript || !serviceScript) {
    return skippedFileResult(opts.projectRoot, task, 'missing-service-script');
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
function resolveVueTokenReferences(
  opts: VueReferenceComputationOptions & {
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
  },
): VueReferenceComputationResult {
  const occurrences: ResolvedOccurrence[] = [];
  const diagnostics = emptySkippedReferenceDiagnostics();

  for (const token of opts.tokenContext.tokens) {
    if (opts.tokenContext.processedStarts.has(token.start)) continue;
    if (isVueModulePathToken(opts.sourceInfo.text, token.start)) continue;
    const generated = firstGeneratedOffset(opts.map, token.start);
    if (generated === null) continue;

    const definitions = opts.context.languageService.getDefinitionAtPosition(opts.fileName, generated + 1) ?? [];
    const definition = definitions.find((def) => !isExternalDefinition(opts.projectRoot, def.fileName));
    if (!definition) {
      addSkippedReference(diagnostics, opts.sourceReader, opts.sourceInfo, opts.sourceFile, token, 'no-definition');
      continue;
    }

    const definitionFile = toRelativePath(opts.projectRoot, definition.fileName);
    const omissionReason = vueDefinitionOmissionReason(opts.sourceFile, token.text, definitionFile);
    if (omissionReason) {
      addSkippedReference(diagnostics, opts.sourceReader, opts.sourceInfo, opts.sourceFile, token, omissionReason);
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
      addSkippedReference(
        diagnostics,
        opts.sourceReader,
        opts.sourceInfo,
        opts.sourceFile,
        token,
        'unindexed-definition',
      );
      continue;
    }

    addVueOccurrence(occurrences, opts.sourceReader, opts.sourceInfo, opts.sourceFile, token, definitionFile, symbolId);
    opts.tokenContext.processedStarts.add(token.start);
    addVueHighlightedOccurrences(occurrences, opts, token, generated, definitionFile, symbolId);
  }

  return { occurrences, ...diagnostics };
}

export function isVueModulePathToken(source: string, tokenStart: number): boolean {
  const lineStart = source.lastIndexOf('\n', tokenStart - 1) + 1;
  const prefix = source.slice(lineStart, tokenStart);
  return /\bfrom\s+['"][^'"]*$/.test(prefix) || /\bimport\s*\(\s*['"][^'"]*$/.test(prefix);
}

export function vueDefinitionOmissionReason(
  sourceFile: string,
  sourceToken: string,
  definitionFile: string,
): Extract<VueSkippedReferenceReason, 'same-file-definition' | 'unindexed-definition'> | null {
  if (definitionFile === sourceFile) return 'same-file-definition';
  if (
    definitionFile.endsWith('.vue') &&
    sourceToken !==
      definitionFile
        .split('/')
        .at(-1)
        ?.replace(/\.vue$/, '')
  ) {
    return 'unindexed-definition';
  }
  return null;
}

function skippedFileResult(
  projectRoot: string,
  task: VueReferenceTask,
  reason: Extract<VueSkippedReferenceReason, 'missing-source-file' | 'missing-service-script'>,
): VueReferenceComputationResult {
  const diagnostics = emptySkippedReferenceDiagnostics();
  if (task.countFileSkip) {
    diagnostics.skippedReferences = 1;
    diagnostics.skippedReferenceReasons[reason] = 1;
    diagnostics.skippedReferenceSamples.push({
      sourceFile: toRelativePath(projectRoot, task.fileName),
      sourceLine: 0,
      sourceStartChar: 0,
      sourceEndChar: 0,
      token: '',
      reason,
    });
  }
  return { occurrences: [], ...diagnostics };
}

function addSkippedReference(
  diagnostics: Omit<VueReferenceComputationResult, 'occurrences'>,
  sourceReader: VueSourceReader,
  sourceInfo: SourceTextInfo,
  sourceFile: string,
  token: VueIdentifierToken,
  reason: Extract<VueSkippedReferenceReason, 'no-definition' | 'same-file-definition' | 'unindexed-definition'>,
): void {
  diagnostics.skippedReferences++;
  diagnostics.skippedReferenceReasons[reason]++;
  if (
    diagnostics.skippedReferenceSamples.filter((sample) => sample.reason === reason && sample.sourceFile === sourceFile)
      .length >= SKIPPED_REFERENCE_SAMPLES_PER_FILE_REASON
  ) {
    return;
  }
  const sourcePos = sourceReader.positionAt(sourceInfo, token.start);
  diagnostics.skippedReferenceSamples.push({
    sourceFile,
    sourceLine: sourcePos.line,
    sourceStartChar: sourcePos.character,
    sourceEndChar: sourcePos.character + token.text.length,
    token: token.text,
    reason,
  });
}

function sampleAcrossVueFiles<T extends { sourceFile: string }>(items: readonly T[], limit: number): T[] {
  const byFile = new Map<string, T[]>();
  for (const item of items) {
    const bucket = byFile.get(item.sourceFile) ?? [];
    bucket.push(item);
    byFile.set(item.sourceFile, bucket);
  }
  const files = [...byFile.keys()].sort();
  const sampled: T[] = [];
  for (let offset = 0; sampled.length < limit; offset++) {
    let added = false;
    for (const file of files) {
      const item = byFile.get(file)?.[offset];
      if (!item) continue;
      sampled.push(item);
      added = true;
      if (sampled.length === limit) break;
    }
    if (!added) break;
  }
  return sampled;
}

function sampleResolvedReferences(items: readonly ResolvedOccurrence[], limit: number): ResolvedOccurrence[] {
  const crossFile = sampleAcrossVueFiles(
    items.filter((item) => item.sourceFile !== item.definitionFile),
    Math.ceil(limit / 2),
  );
  const selected = new Set(
    crossFile.map(
      (item) => `${item.sourceFile}:${item.sourceLine}:${item.sourceStartChar}:${item.sourceEndChar}:${item.symbolId}`,
    ),
  );
  const sameAndRemaining = sampleAcrossVueFiles(
    items.filter(
      (item) =>
        !selected.has(
          `${item.sourceFile}:${item.sourceLine}:${item.sourceStartChar}:${item.sourceEndChar}:${item.symbolId}`,
        ),
    ),
    limit - crossFile.length,
  );
  return [...crossFile, ...sameAndRemaining];
}

function sampleSkippedReferences(
  items: readonly VueSkippedReferenceSample[],
  limit: number,
): VueSkippedReferenceSample[] {
  const reasons = [...new Set(items.map((item) => item.reason))].sort();
  const sampled: VueSkippedReferenceSample[] = [];
  for (const [index, reason] of reasons.entries()) {
    const remainingReasons = reasons.length - index;
    const allocation = Math.ceil((limit - sampled.length) / remainingReasons);
    sampled.push(
      ...sampleAcrossVueFiles(
        items.filter((item) => item.reason === reason),
        allocation,
      ),
    );
  }
  return sampled.slice(0, limit);
}

function resolvedReferenceSamples(
  db: Database.Database,
  items: readonly ResolvedOccurrence[],
  limit: number,
): AugmentVueResolvedResult['resolvedReferenceSamples'] {
  const symbolQuery = db.prepare('SELECT symbol FROM global_symbols WHERE id = ?');
  return sampleResolvedReferences(items, limit).map(({ symbolId, ...sample }) => ({
    ...sample,
    definitionSymbol: (symbolQuery.get(symbolId) as { symbol: string } | undefined)?.symbol ?? `symbol-id:${symbolId}`,
  }));
}

function addVueHighlightedOccurrences(
  occurrences: ResolvedOccurrence[],
  opts: Parameters<typeof resolveVueTokenReferences>[0],
  token: VueIdentifierToken,
  generated: number,
  definitionFile: string,
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
    addVueOccurrence(
      occurrences,
      opts.sourceReader,
      opts.sourceInfo,
      opts.sourceFile,
      highlightedToken,
      definitionFile,
      symbolId,
    );
    opts.tokenContext.processedStarts.add(highlightedStart);
  }
}

function addVueOccurrence(
  occurrences: ResolvedOccurrence[],
  sourceReader: VueReferenceComputationOptions['sourceReader'],
  sourceInfo: SourceTextInfo,
  sourceFile: string,
  token: VueIdentifierToken,
  definitionFile: string,
  symbolId: number,
): void {
  const sourcePos = sourceReader.positionAt(sourceInfo, token.start);
  occurrences.push({
    sourceFile,
    sourceLine: sourcePos.line,
    sourceStartChar: sourcePos.character,
    sourceEndChar: sourcePos.character + token.text.length,
    sourceToken: token.text,
    definitionFile,
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
