import type { ProjectIndex } from '../../core/project-index.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { semanticCallerMap } from '../../semantic/shared-primitives.js';
import { detectAstLanguage, type SyntaxNode, type Tree } from '../../source/ast.js';
import { sourceEvidence } from '../../source/source-evidence.js';
import type { ScipDatabase } from '../../storage/db.js';
import { fileContentHash } from '../../storage/evidence-cache.js';
import { createFileEvidenceProduct } from '../../storage/evidence-products.js';
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

const FILE_USAGE_CACHE = createPerDbCache<string, FileLeafUsage>('definition-consumer-file-usage', {
  clearGroups: ['whole-project', 'source-file'],
});
const FILE_USAGE_PRODUCT = createFileEvidenceProduct<FileLeafUsage>({
  kind: 'consumer-file-usage',
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
    result.set(
      symbolId,
      new Set(entry.files.map((fileEvidence) => fileEvidence.file)),
    );
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
  return profileSpan(
    'consumer-evidence.product',
    () => {
      const provenance = consumerProvenanceMap(db, index, definitions, opts);
      const result: DefinitionConsumerEvidenceMap = new Map();
      counters = { ...counters, ...provenance.counters };
      for (const definition of definitions) {
        const fileSources = provenance.sources.get(definition.symbolId) ?? new Map<string, Set<DefinitionConsumerSource>>();
        const classified = classifyDefinitionConsumers(db, definition, [...fileSources.keys()], fileSources);
        counters.realFiles += classified.partition.realConsumers.length;
        counters.reexportOnlyFiles += classified.partition.barrelConsumers;
        counters.importOnlyFiles += classified.partition.importOnlyConsumers;
        result.set(definition.symbolId, {
          definition,
          files: classified.files,
          ...classified.partition,
        });
      }
      return result;
    },
    () => ({ ...counters }),
  );
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

export function isImportOnlyConsumer(db: ScipDatabase, consumerFile: string, leaf: string): boolean {
  if (!leaf) return false;
  const lang = detectAstLanguage(consumerFile);
  if (!lang) return false;
  const usage = FILE_USAGE_CACHE.get(db, consumerFile, () => computeFileLeafUsage(db, consumerFile, lang));
  return usage.importedLeaves.has(leaf) && !usage.usedLeaves.has(leaf);
}

// scip-query: ignore-passthrough — cache lifecycle hook for consumer
// classification; callers should not know the FILE_USAGE_CACHE key or shape.
function computeFileLeafUsage(
  db: ScipDatabase,
  file: string,
  lang: string,
): FileLeafUsage {
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
  if (reExports.length === 0) return false;

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
