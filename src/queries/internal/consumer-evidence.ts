import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectIndex } from './project-index.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { profileEnabled, profileSpan } from '../../instrumentation/profile.js';
import { semanticCallerMap } from '../../semantic/shared-primitives.js';
import { detectAstLanguage, type SyntaxNode, type Tree } from '../../source/ast.js';
import { sourceEvidence } from '../../source/source-evidence.js';
import type { ScipDatabase } from '../../storage/db.js';
import { fileContentHash, projectEvidenceFingerprint } from '../../storage/evidence-cache.js';
import { createFileEvidenceProduct, evidenceProductInvalidation } from '../../storage/evidence-products.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import { leafName } from '../../symbols/symbol-parser.js';

export interface DefinitionConsumerEvidenceOptions {
  semantic: boolean;
  sourceFallback?: boolean;
}

export type DefinitionConsumerSource = 'indexed' | 'semantic' | 'source-fallback';
export type DefinitionConsumerClassification = 'real' | 'reexport-only' | 'import-only';

export interface DefinitionConsumerPartition {
  realConsumers: string[];
  barrelConsumers: number;
  importOnlyConsumers: number;
}

export interface DefinitionConsumerFileEvidence {
  file: string;
  sources: DefinitionConsumerSource[];
  classification: DefinitionConsumerClassification;
}

export interface DefinitionConsumerEvidence extends DefinitionConsumerPartition {
  definition: IndexedDefinition;
  files: DefinitionConsumerFileEvidence[];
}

export type DefinitionConsumerEvidenceMap = Map<number, DefinitionConsumerEvidence>;

export interface ConsumerEvidenceProduct {
  forDefinitions(
    definitions: readonly IndexedDefinition[],
    opts: DefinitionConsumerEvidenceOptions,
  ): DefinitionConsumerEvidenceMap;
}

interface FileLeafUsage {
  importedLeaves: Set<string>;
  usedLeaves: Set<string>;
}

interface SerializedFileLeafUsage {
  importedLeaves: string[];
  usedLeaves: string[];
}

interface ConsumerClassificationStats {
  definitions: number;
  consumerFiles: number;
  nativeAttempted: boolean;
  nativeUsed: boolean;
  nativeReason: string;
}

const FILE_USAGE_CACHE = createPerDbCache<string, FileLeafUsage>('definition-consumer-file-usage', {
  clearGroups: ['whole-project', 'source-file'],
});
const FILE_USAGE_PRODUCT = createFileEvidenceProduct<FileLeafUsage>({
  kind: 'consumer-file-usage',
  invalidation: evidenceProductInvalidation('consumer-file-usage'),
  serialize: serializeFileLeafUsage,
  deserialize: deserializeFileLeafUsage,
});

export function consumerEvidenceProduct(db: ScipDatabase, index: ProjectIndex): ConsumerEvidenceProduct {
  return {
    forDefinitions(definitions, opts) {
      return buildDefinitionConsumerEvidence(db, index, definitions, opts);
    },
  };
}

export function consumerFileMapFromEvidence(evidence: DefinitionConsumerEvidenceMap): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  for (const [symbolId, entry] of evidence) {
    result.set(symbolId, new Set(entry.files.map((fileEvidence) => fileEvidence.file)));
  }
  return result;
}

/**
 * Split consumer files into detector-ready buckets. "Real" consumers use the
 * definition outside a passthrough re-export or unused import-only reference.
 */
export function partitionDefinitionConsumers(
  db: ScipDatabase,
  definition: Pick<IndexedDefinition, 'relativePath' | 'symbol'>,
  consumerFiles: readonly string[],
): DefinitionConsumerPartition {
  return classifyDefinitionConsumers(db, definition, consumerFiles).partition;
}

function buildDefinitionConsumerEvidence(
  db: ScipDatabase,
  index: ProjectIndex,
  definitions: readonly IndexedDefinition[],
  opts: DefinitionConsumerEvidenceOptions,
): DefinitionConsumerEvidenceMap {
  let counters = emptyConsumerEvidenceCounters(definitions.length);
  const projectFingerprint = profileEnabled() ? projectEvidenceFingerprint(db) : null;
  const workIdentity = projectFingerprint
    ? consumerEvidenceWorkIdentity(definitions, opts, projectFingerprint)
    : undefined;
  const workMetadata = workIdentity ? { workIdentity, workOutcome: 'computed' as const } : {};
  return profileSpan(
    'consumer-evidence.product',
    () => {
      const provenance = profileSpan(
        'consumer-evidence.provenance',
        () => consumerProvenanceMap(db, index, definitions, opts),
        () => ({
          ...workMetadata,
          definitions: definitions.length,
          semantic: opts.semantic,
          sourceFallback: opts.sourceFallback !== false,
        }),
      );
      const result: DefinitionConsumerEvidenceMap = new Map();
      counters = { ...counters, ...provenance.counters };
      const classificationStats = emptyConsumerClassificationStats(definitions, provenance.sources);
      profileSpan(
        'consumer-evidence.classify',
        () => {
          const classifiedById = classifyDefinitionConsumersBatch(
            db,
            definitions,
            provenance.sources,
            classificationStats,
          );
          for (const definition of definitions) {
            const classified = classifiedById.get(definition.symbolId) ?? emptyDefinitionConsumerClassification();
            counters.realFiles += classified.partition.realConsumers.length;
            counters.reexportOnlyFiles += classified.partition.barrelConsumers;
            counters.importOnlyFiles += classified.partition.importOnlyConsumers;
            result.set(definition.symbolId, {
              definition,
              files: classified.files,
              ...classified.partition,
            });
          }
        },
        () => ({
          ...workMetadata,
          ...classificationStats,
          realFiles: counters.realFiles,
          reexportOnlyFiles: counters.reexportOnlyFiles,
          importOnlyFiles: counters.importOnlyFiles,
        }),
      );
      return result;
    },
    () => ({ ...workMetadata, ...counters }),
  );
}

function consumerEvidenceWorkIdentity(
  definitions: readonly IndexedDefinition[],
  opts: DefinitionConsumerEvidenceOptions,
  projectFingerprint: string,
): string {
  const hash = createHash('sha256')
    .update('consumer-evidence-v1\0')
    .update(projectFingerprint)
    .update('\0')
    .update(opts.semantic ? 'semantic\0' : 'indexed\0')
    .update(opts.sourceFallback === false ? 'no-source-fallback' : 'source-fallback');
  for (const symbol of definitions.map((definition) => definition.symbol).sort()) {
    hash.update('\0').update(symbol);
  }
  return hash.digest('hex').slice(0, 24);
}

interface ConsumerProvenanceMap {
  sources: Map<number, Map<string, Set<DefinitionConsumerSource>>>;
  counters: ConsumerEvidenceCounters;
}

interface ConsumerEvidenceCounters {
  definitions: number;
  indexedFiles: number;
  semanticFiles: number;
  fallbackFiles: number;
  totalFiles: number;
  realFiles: number;
  reexportOnlyFiles: number;
  importOnlyFiles: number;
}

function emptyConsumerEvidenceCounters(definitions: number): ConsumerEvidenceCounters {
  return {
    definitions,
    indexedFiles: 0,
    semanticFiles: 0,
    fallbackFiles: 0,
    totalFiles: 0,
    realFiles: 0,
    reexportOnlyFiles: 0,
    importOnlyFiles: 0,
  };
}

// scip-query: ignore-extract - provenance counters and source maps are one evidence aggregation pass.
function consumerProvenanceMap(
  db: ScipDatabase,
  index: ProjectIndex,
  definitions: readonly IndexedDefinition[],
  opts: DefinitionConsumerEvidenceOptions,
): ConsumerProvenanceMap {
  const counters = emptyConsumerEvidenceCounters(definitions.length);
  const sources = new Map<number, Map<string, Set<DefinitionConsumerSource>>>();
  recordConsumerSourceMap(sources, counters, 'indexed', index.crossFileCallerMap(definitions, { semantic: false }));
  if (opts.semantic) {
    recordConsumerSourceMap(sources, counters, 'semantic', semanticCallerMap(db, definitions));
  }
  if (opts.sourceFallback !== false) {
    recordConsumerSourceMap(sources, counters, 'source-fallback', index.sourceFallbackCallerFiles(definitions));
  }
  counters.totalFiles = [...sources.values()].reduce((sum, files) => sum + files.size, 0);
  return { sources, counters };
}

function emptyConsumerClassificationStats(
  definitions: readonly IndexedDefinition[],
  sources: ReadonlyMap<number, ReadonlyMap<string, ReadonlySet<DefinitionConsumerSource>>>,
): ConsumerClassificationStats {
  return {
    definitions: definitions.length,
    consumerFiles: [...sources.values()].reduce((sum, files) => sum + files.size, 0),
    nativeAttempted: false,
    nativeUsed: false,
    nativeReason: 'not-attempted',
  };
}

function recordConsumerSourceMap(
  target: Map<number, Map<string, Set<DefinitionConsumerSource>>>,
  counters: ConsumerEvidenceCounters,
  source: DefinitionConsumerSource,
  sourceMap: ReadonlyMap<number, ReadonlySet<string>>,
): void {
  let files = 0;
  for (const [symbolId, consumerFiles] of sourceMap) {
    let byFile = target.get(symbolId);
    if (!byFile) {
      byFile = new Map();
      target.set(symbolId, byFile);
    }
    for (const file of consumerFiles) {
      files++;
      const sources = byFile.get(file) ?? new Set<DefinitionConsumerSource>();
      sources.add(source);
      byFile.set(file, sources);
    }
  }
  if (source === 'indexed') counters.indexedFiles += files;
  else if (source === 'semantic') counters.semanticFiles += files;
  else counters.fallbackFiles += files;
}

function classifyDefinitionConsumersBatch(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  sources: ReadonlyMap<number, ReadonlyMap<string, ReadonlySet<DefinitionConsumerSource>>>,
  stats: ConsumerClassificationStats,
): Map<number, { partition: DefinitionConsumerPartition; files: DefinitionConsumerFileEvidence[] }> {
  const native = classifyDefinitionConsumersNative(db, definitions, sources, stats);
  if (native) return native;
  return classifyDefinitionConsumersFallback(db, definitions, sources);
}

function classifyDefinitionConsumersFallback(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  sources: ReadonlyMap<number, ReadonlyMap<string, ReadonlySet<DefinitionConsumerSource>>>,
): Map<number, { partition: DefinitionConsumerPartition; files: DefinitionConsumerFileEvidence[] }> {
  const result = new Map<number, { partition: DefinitionConsumerPartition; files: DefinitionConsumerFileEvidence[] }>();
  for (const definition of definitions) {
    const fileSources = sources.get(definition.symbolId) ?? new Map<string, Set<DefinitionConsumerSource>>();
    result.set(definition.symbolId, classifyDefinitionConsumers(db, definition, [...fileSources.keys()], fileSources));
  }
  return result;
}

function classifyDefinitionConsumers(
  db: ScipDatabase,
  definition: Pick<IndexedDefinition, 'relativePath' | 'symbol'>,
  consumerFiles: readonly string[],
  provenance: ReadonlyMap<string, ReadonlySet<DefinitionConsumerSource>> = new Map(),
): { partition: DefinitionConsumerPartition; files: DefinitionConsumerFileEvidence[] } {
  const realConsumers: string[] = [];
  let barrelConsumers = 0;
  let importOnlyConsumers = 0;
  const leaf = leafName(definition.symbol);
  const files: DefinitionConsumerFileEvidence[] = [];

  for (const consumer of consumerFiles) {
    let classification: DefinitionConsumerClassification;
    if (isReExportOnlyConsumer(db, consumer, definition.relativePath, leaf)) {
      barrelConsumers++;
      classification = 'reexport-only';
    } else if (isImportOnlyConsumer(db, consumer, leaf)) {
      importOnlyConsumers++;
      classification = 'import-only';
    } else {
      realConsumers.push(consumer);
      classification = 'real';
    }
    files.push({
      file: consumer,
      sources: [...(provenance.get(consumer) ?? [])],
      classification,
    });
  }

  return {
    partition: { realConsumers, barrelConsumers, importOnlyConsumers },
    files,
  };
}

function emptyDefinitionConsumerClassification(): {
  partition: DefinitionConsumerPartition;
  files: DefinitionConsumerFileEvidence[];
} {
  return {
    partition: { realConsumers: [], barrelConsumers: 0, importOnlyConsumers: 0 },
    files: [],
  };
}

export function isImportOnlyConsumer(db: ScipDatabase, consumerFile: string, leaf: string): boolean {
  if (!leaf) return false;
  const lang = detectAstLanguage(consumerFile);
  if (!lang) return false;
  const usage = FILE_USAGE_CACHE.get(db, consumerFile, () => computeFileLeafUsage(db, consumerFile, lang));
  return usage.importedLeaves.has(leaf) && !usage.usedLeaves.has(leaf);
}

// scip-query: ignore-passthrough — cache lifecycle hook for consumer
// classification; callers should not know the FILE_USAGE_CACHE key or shape.
function computeFileLeafUsage(db: ScipDatabase, file: string, lang: string): FileLeafUsage {
  const evidence = sourceEvidence(db).forFile(file, { text: true, ast: true });
  const source = evidence.text;
  if (!source) return emptyFileLeafUsage();
  const contentHash = fileContentHash(db, file, source);
  const cached = FILE_USAGE_PRODUCT.read(db, file, contentHash);
  if (cached) return cached;

  const usage = computeFileLeafUsageFromAst(evidence.ast, lang);
  FILE_USAGE_PRODUCT.write(db, file, contentHash, usage);
  return usage;
}

function computeFileLeafUsageFromAst(tree: Tree | null | undefined, lang: string): FileLeafUsage {
  const importedLeaves = new Set<string>();
  const usedLeaves = new Set<string>();
  if (!tree) return { importedLeaves, usedLeaves };

  const importTypes =
    lang === 'rust'
      ? new Set(['use_declaration'])
      : lang === 'python'
        ? new Set(['import_statement', 'import_from_statement'])
        : new Set(['import_statement']);

  const walk = (node: SyntaxNode, insideImport: boolean): void => {
    const nowInside = insideImport || importTypes.has(node.type);
    if (
      node.type === 'identifier' ||
      node.type === 'type_identifier' ||
      node.type === 'property_identifier' ||
      node.type === 'field_identifier'
    ) {
      if (nowInside) importedLeaves.add(node.text);
      else usedLeaves.add(node.text);
    }
    for (const child of node.children) walk(child, nowInside);
  };
  walk(tree.rootNode, false);
  return { importedLeaves, usedLeaves };
}

function emptyFileLeafUsage(): FileLeafUsage {
  return { importedLeaves: new Set(), usedLeaves: new Set() };
}

function serializeFileLeafUsage(usage: FileLeafUsage): string {
  return JSON.stringify({
    importedLeaves: [...usage.importedLeaves],
    usedLeaves: [...usage.usedLeaves],
  } satisfies SerializedFileLeafUsage);
}

function deserializeFileLeafUsage(payload: string): FileLeafUsage | null {
  try {
    const raw = JSON.parse(payload) as SerializedFileLeafUsage;
    if (!Array.isArray(raw.importedLeaves) || !Array.isArray(raw.usedLeaves)) return null;
    return {
      importedLeaves: new Set(raw.importedLeaves.filter((value): value is string => typeof value === 'string')),
      usedLeaves: new Set(raw.usedLeaves.filter((value): value is string => typeof value === 'string')),
    };
  } catch {
    return null;
  }
}

/**
 * True when every mention of `leaf` in `consumerFile` sits inside a
 * re-export statement (`export { X } from '...'` or `export * from '...'`).
 */
function isReExportOnlyConsumer(
  db: ScipDatabase,
  consumerFile: string,
  _definitionFile: string,
  leaf: string,
): boolean {
  if (!leaf) return false;
  const evidence = sourceEvidence(db).forFile(consumerFile, { lines: true, reexports: true });
  const lines = evidence.lines ?? [];
  if (lines.length === 0) return false;

  const reExports = evidence.reexports ?? [];
  return isReExportOnlyLeaf(lines, reExports, leaf);
}

function isReExportOnlyLeaf(
  lines: readonly string[],
  reExports: readonly { startLine: number; endLine: number }[],
  leaf: string,
): boolean {
  if (lines.length === 0 || reExports.length === 0) return false;
  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRegex = new RegExp(`\\b${escaped}\\b`);

  let occurrenceCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!wordRegex.test(lines[i] ?? '')) continue;
    occurrenceCount++;
    const coveredBy = reExports.find((r) => r.startLine <= i && i <= r.endLine);
    if (!coveredBy) return false;
  }

  return occurrenceCount > 0;
}

type NativeConsumerClassifySources = DefinitionConsumerSource[];

interface NativeConsumerClassifyRequest {
  definitions: NativeConsumerClassifyDefinition[];
  file_usages: Record<string, { imported_leaves: string[]; used_leaves: string[] }>;
  reexport_only_leaves: Record<string, string[]>;
}

interface NativeConsumerClassifyDefinition {
  symbol_id: number;
  leaf: string;
  consumer_files: Array<{ file: string; sources: NativeConsumerClassifySources }>;
}

interface NativeConsumerClassifyResponse {
  entries?: unknown;
}

interface NativeConsumerClassifyEntry {
  symbol_id: number;
  real_consumers: string[];
  barrel_consumers: number;
  import_only_consumers: number;
  files: Array<{ file: string; sources: DefinitionConsumerSource[]; classification: DefinitionConsumerClassification }>;
}

const NATIVE_CONSUMER_CLASSIFY_ENV = 'SCIP_QUERY_NATIVE_CONSUMER_CLASSIFY';
const NATIVE_KERNEL_BIN_ENV = 'SCIP_QUERY_NATIVE_KERNELS_BIN';
const NATIVE_CONSUMER_CLASSIFY_MIN_FILES_ENV = 'SCIP_QUERY_NATIVE_CONSUMER_CLASSIFY_MIN_FILES';
const DEFAULT_NATIVE_CONSUMER_CLASSIFY_MIN_FILES = 1_000;
const NATIVE_CONSUMER_CLASSIFY_TIMEOUT_MS = 5_000;
const NATIVE_CONSUMER_CLASSIFY_MAX_BUFFER = 64 * 1024 * 1024;
let cachedNativeKernelBinary: string | null | undefined;

function classifyDefinitionConsumersNative(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  sources: ReadonlyMap<number, ReadonlyMap<string, ReadonlySet<DefinitionConsumerSource>>>,
  stats: ConsumerClassificationStats,
): Map<number, { partition: DefinitionConsumerPartition; files: DefinitionConsumerFileEvidence[] }> | null {
  const setting = process.env[NATIVE_CONSUMER_CLASSIFY_ENV]?.toLowerCase();
  if (setting !== '1' && setting !== 'true') {
    stats.nativeReason = setting === '0' || setting === 'false' ? 'disabled' : 'opt-in-required';
    return null;
  }
  if (stats.consumerFiles < nativeConsumerClassifyMinFiles()) {
    stats.nativeReason = 'below-threshold';
    return null;
  }
  const binary = nativeKernelBinary();
  if (!binary) {
    stats.nativeReason = 'binary-missing';
    return null;
  }
  stats.nativeAttempted = true;
  const payload = nativeConsumerClassifyPayload(db, definitions, sources);
  const result = spawnSync(binary, ['consumer-classify'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: NATIVE_CONSUMER_CLASSIFY_TIMEOUT_MS,
    maxBuffer: NATIVE_CONSUMER_CLASSIFY_MAX_BUFFER,
  });
  if (result.status !== 0 || result.error) {
    stats.nativeReason = result.error ? `spawn-error:${result.error.message}` : `exit-${result.status ?? 'null'}`;
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as NativeConsumerClassifyResponse;
    const converted = nativeConsumerClassifyResult(parsed, definitions);
    if (!converted) {
      stats.nativeReason = 'invalid-response';
      return null;
    }
    stats.nativeUsed = true;
    stats.nativeReason = 'used';
    return converted;
  } catch {
    stats.nativeReason = 'invalid-json';
    return null;
  }
}

function nativeConsumerClassifyPayload(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  sources: ReadonlyMap<number, ReadonlyMap<string, ReadonlySet<DefinitionConsumerSource>>>,
): NativeConsumerClassifyRequest {
  const leavesByFile = new Map<string, Set<string>>();
  const nativeDefinitions: NativeConsumerClassifyDefinition[] = [];
  for (const definition of definitions) {
    const leaf = leafName(definition.symbol);
    const fileSources = sources.get(definition.symbolId) ?? new Map<string, Set<DefinitionConsumerSource>>();
    const consumer_files = [...fileSources.entries()].map(([file, sourceSet]) => {
      const leaves = leavesByFile.get(file) ?? new Set<string>();
      if (leaf) leaves.add(leaf);
      leavesByFile.set(file, leaves);
      return { file, sources: [...sourceSet] };
    });
    nativeDefinitions.push({ symbol_id: definition.symbolId, leaf, consumer_files });
  }

  const file_usages: NativeConsumerClassifyRequest['file_usages'] = {};
  const reexport_only_leaves: NativeConsumerClassifyRequest['reexport_only_leaves'] = {};
  for (const [file, leaves] of leavesByFile) {
    const lang = detectAstLanguage(file);
    if (lang) {
      const usage = FILE_USAGE_CACHE.get(db, file, () => computeFileLeafUsage(db, file, lang));
      file_usages[file] = {
        imported_leaves: [...usage.importedLeaves],
        used_leaves: [...usage.usedLeaves],
      };
    }
    const reexportLeaves = reExportOnlyLeavesForFile(db, file, leaves);
    if (reexportLeaves.length > 0) reexport_only_leaves[file] = reexportLeaves;
  }

  return { definitions: nativeDefinitions, file_usages, reexport_only_leaves };
}

function reExportOnlyLeavesForFile(db: ScipDatabase, file: string, leaves: ReadonlySet<string>): string[] {
  if (leaves.size === 0) return [];
  const evidence = sourceEvidence(db).forFile(file, { lines: true, reexports: true });
  const lines = evidence.lines ?? [];
  const reExports = evidence.reexports ?? [];
  if (lines.length === 0 || reExports.length === 0) return [];
  return [...leaves].filter((leaf) => isReExportOnlyLeaf(lines, reExports, leaf));
}

function nativeConsumerClassifyResult(
  response: NativeConsumerClassifyResponse,
  definitions: readonly IndexedDefinition[],
): Map<number, { partition: DefinitionConsumerPartition; files: DefinitionConsumerFileEvidence[] }> | null {
  if (!Array.isArray(response.entries)) return null;
  if (response.entries.length !== definitions.length) return null;
  const ids = new Set(definitions.map((definition) => definition.symbolId));
  const result = new Map<number, { partition: DefinitionConsumerPartition; files: DefinitionConsumerFileEvidence[] }>();
  for (const rawEntry of response.entries) {
    const entry = nativeConsumerClassifyEntry(rawEntry);
    if (!entry || !ids.has(entry.symbol_id)) return null;
    result.set(entry.symbol_id, {
      partition: {
        realConsumers: entry.real_consumers,
        barrelConsumers: entry.barrel_consumers,
        importOnlyConsumers: entry.import_only_consumers,
      },
      files: entry.files,
    });
  }
  for (const id of ids) {
    if (!result.has(id)) return null;
  }
  return result;
}

function nativeConsumerClassifyEntry(value: unknown): NativeConsumerClassifyEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<NativeConsumerClassifyEntry>;
  if (
    typeof candidate.symbol_id !== 'number' ||
    !Array.isArray(candidate.real_consumers) ||
    typeof candidate.barrel_consumers !== 'number' ||
    typeof candidate.import_only_consumers !== 'number' ||
    !Array.isArray(candidate.files)
  ) {
    return null;
  }
  if (!candidate.real_consumers.every((file): file is string => typeof file === 'string')) return null;
  const files: NativeConsumerClassifyEntry['files'] = [];
  for (const file of candidate.files) {
    if (!file || typeof file !== 'object') return null;
    const item = file as Partial<NativeConsumerClassifyEntry['files'][number]>;
    if (
      typeof item.file !== 'string' ||
      !Array.isArray(item.sources) ||
      !item.sources.every(isDefinitionConsumerSource) ||
      !isDefinitionConsumerClassification(item.classification)
    ) {
      return null;
    }
    files.push({
      file: item.file,
      sources: item.sources,
      classification: item.classification,
    });
  }
  return {
    symbol_id: candidate.symbol_id,
    real_consumers: candidate.real_consumers,
    barrel_consumers: candidate.barrel_consumers,
    import_only_consumers: candidate.import_only_consumers,
    files,
  };
}

function isDefinitionConsumerSource(value: unknown): value is DefinitionConsumerSource {
  return value === 'indexed' || value === 'semantic' || value === 'source-fallback';
}

function isDefinitionConsumerClassification(value: unknown): value is DefinitionConsumerClassification {
  return value === 'real' || value === 'reexport-only' || value === 'import-only';
}

function nativeConsumerClassifyMinFiles(): number {
  const raw = process.env[NATIVE_CONSUMER_CLASSIFY_MIN_FILES_ENV];
  if (!raw) return DEFAULT_NATIVE_CONSUMER_CLASSIFY_MIN_FILES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_NATIVE_CONSUMER_CLASSIFY_MIN_FILES;
}

function nativeKernelBinary(): string | null {
  if (cachedNativeKernelBinary !== undefined) return cachedNativeKernelBinary;
  const envPath = process.env[NATIVE_KERNEL_BIN_ENV];
  const binaryName = process.platform === 'win32' ? 'scip-query-kernels.exe' : 'scip-query-kernels';
  const candidates = [
    ...(envPath ? [envPath] : []),
    ...candidatePackageRoots().map((root) => join(root, 'target', 'release', binaryName)),
  ];
  cachedNativeKernelBinary = candidates.find((path) => existsSync(path)) ?? null;
  return cachedNativeKernelBinary;
}

function candidatePackageRoots(): string[] {
  const roots = new Set<string>();
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    roots.add(current);
    current = dirname(current);
  }
  return [...roots];
}
