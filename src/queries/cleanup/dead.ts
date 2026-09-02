import type { ScipDatabase } from '../../storage/db.js';
import { buildFileExclusionClassifier, buildFileExclusionPredicate } from './dead-exclusions.js';
import { getInactiveBarrelPaths, isEntrySurface, isRootedSymbol } from '../../analysis/file-classifier.js';
import { isGeneratedArtifactPath } from '../../analysis/generated-artifacts.js';
import { definitionsGroupedByLeaf, getScopedDefinitionsMatchingSymbols } from '../../symbols/definition-catalog.js';
import type { DeadOptions, IndexedDefinition } from '../../domain/types.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { getCallerRowsForSymbol, getCallerRowsMapForSymbols } from '../../symbols/graph/call-graph-evidence.js';
import { ProjectIndex } from '../internal/project-index.js';
import { clearSourceFileEvidenceCaches } from '../internal/cache-invalidation.js';
import { deadCandidateDecision, looksValueLikeDefinition } from '../internal/dead-candidate-gate.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { applyScanLimit } from '../query-utils.js';
import { pathsResolveSame } from '../../domain/path-normalization.js';
import { sourceImportPathsByLocalName } from '../../language-parsers/import-index.js';
import { exactSemanticCallerMap } from '../../semantic/shared-primitives.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { indexedDocumentPaths as listIndexedDocumentPaths } from '../../storage/scip-documents.js';
import {
  emptyReferenceCounts,
  hasAnyReference,
  hasCrossFileReference,
  loadMentionReferencedSymbolIds,
  loadMentionReferenceCounts,
  referenceOccurrences,
  recordReferenceAtLeast,
  recordReference,
} from '../internal/reference-counts.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { getAst } from '../../source/ast.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { isFrameworkContractCallable } from './callable-contracts.js';

export interface DeadSymbolResult {
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
  symbol: string;
  shortName: string;
  sameFileRefs: number;
  kind: 'dead-code' | 'file-internal' | 'implicit-usage';
  implicitUsageReason?: string;
}

export interface DeadCounts {
  total: number;
  deadCode: number;
  fileInternal: number;
  implicitUsage: number;
  loc: number;
}

export interface DeadSummary {
  symbols: DeadSymbolResult[];
  counts: DeadCounts;
  applicability: {
    entrySurfaceExcluded: number;
    externalRootExcluded: number;
    /** Zero-reference symbols in generated artifacts (migration dumps, codegen output); the generator owns them. */
    generatedArtifactExcluded?: number;
    implicitUsageSignals: number;
  };
  totalCount: number;
  /** Symbols with zero references anywhere; verify before deleting */
  deadCodeCount: number;
  /** Symbols referenced only within their own file — no cross-file consumers.
   *  May be private helpers (fine) or forgotten exports (needs review). */
  fileInternalCount: number;
  /** Symbols reached through traits, attributes, generated code, or reflection. */
  implicitUsageCount: number;
  totalLoc: number;
}

interface DeadCandidateOptions {
  scope?: string;
  minLoc: number;
  includeTests: boolean;
  includeMembers: boolean;
}

interface DeadRow {
  relative_path: string;
  start_line: number;
  end_line: number;
  loc: number;
  symbol: string;
  parent_type_name: string | null;
  same_file_refs: number;
  cross_file_refs: number;
}

type ReferenceCounts = ReturnType<typeof emptyReferenceCounts>;

// Scalar semantic caller lookup materializes the project-wide TypeScript
// reference-fragment view once per definition. Switch medium candidate sets to
// the exact bulk path before those repeated scans dominate time and memory.
const BULK_SEMANTIC_CALLER_MIN_DEFINITIONS = 64;
const BULK_SEMANTIC_CALLER_MIN_INDEXED_FILES = 300;

/**
 * Find dead exports: symbols defined locally with no cross-file references.
 * Language-agnostic — works with any SCIP index.
 */
// scip-query: ignore-extract — this is the dead-code command pipeline:
// mention counts, caller-map supplements, AST fallback supplements, candidate
// loading, row projection, and summary all define one result.
export function dead(db: ScipDatabase, opts: DeadOptions = {}): DeadSummary {
  const {
    scope,
    minLoc = 1,
    includeTests = false,
    skipBarrels = false,
    includeMembers = false,
    deadCodeOnly = false,
    scanLimit,
    semantic = true,
  } = opts;

  let candidateDefinitionCount = 0;
  const definitions = profileSpan(
    'dead.candidates',
    () => {
      const candidates = applyScanLimit(
        deadCandidateDefinitions(db, {
          scope,
          minLoc,
          includeTests,
          includeMembers,
        }),
        scanLimit,
      );
      candidateDefinitionCount = candidates.length;
      return candidates;
    },
    () => ({ definitions: candidateDefinitionCount }),
  );

  let inactiveBarrelCount = 0;
  const inactiveBarrelPaths = skipBarrels
    ? profileSpan(
        'dead.inactive-barrels',
        () => {
          const paths = new Set(getInactiveBarrelPaths(db));
          inactiveBarrelCount = paths.size;
          return paths;
        },
        () => ({ paths: inactiveBarrelCount }),
      )
    : new Set<string>();
  let symbolsWithReferences = 0;
  const referencesBySymbol = deadCodeOnly
    ? emptyReferenceCounts()
    : profileSpan(
        'dead.mention-reference-counts',
        () => {
          const counts = loadMentionReferenceCounts(
            db,
            inactiveBarrelPaths,
            definitions.map((definition) => definition.symbolId),
          );
          symbolsWithReferences = counts.size;
          return counts;
        },
        () => ({ definitions: definitions.length, symbolsWithReferences }),
      );
  let mentionedSymbolCount = 0;
  const scipReferencedIds = deadCodeOnly
    ? profileSpan(
        'dead.mentioned-symbol-ids',
        () => {
          const ids = loadMentionReferencedSymbolIds(
            db,
            definitions.map((definition) => definition.symbolId),
            inactiveBarrelPaths,
            { conservative: inactiveBarrelPaths.size === 0 },
          );
          mentionedSymbolCount = ids.size;
          return ids;
        },
        () => ({ definitions: definitions.length, referencedSymbols: mentionedSymbolCount }),
      )
    : new Set<number>();

  const sourceCandidates = deadCodeOnly
    ? definitions.filter((definition) => !scipReferencedIds.has(definition.symbolId))
    : definitions.filter(
        (definition) => !hasCrossFileReference(referencesBySymbol, definition.symbolId, definition.relativePath),
      );
  if (deadCodeOnly) {
    profileSpan(
      'dead.source-fallback.dead-code-only',
      () =>
        supplementDeadCodeOnlySourceReferences(db, sourceCandidates, referencesBySymbol, {
          inactiveBarrelPaths,
        }),
      () => ({ definitions: sourceCandidates.length, testReferencesIncluded: true }),
    );
  } else {
    profileSpan(
      'dead.source-fallback.ast',
      () =>
        supplementReferencesFromAst(db, sourceCandidates, referencesBySymbol, {
          inactiveBarrelPaths,
        }),
      () => ({ definitions: sourceCandidates.length, testReferencesIncluded: true }),
    );
  }

  const callerCandidates = deadCodeOnly
    ? sourceCandidates.filter((definition) => !hasAnyReference(referencesBySymbol, definition.symbolId))
    : sourceCandidates.filter(
        (definition) => !hasCrossFileReference(referencesBySymbol, definition.symbolId, definition.relativePath),
      );
  profileSpan(
    'dead.caller-map-supplement',
    () =>
      supplementReferencesFromCallerMap(db, callerCandidates, referencesBySymbol, {
        inactiveBarrelPaths,
        includeSemantic: !deadCodeOnly && semantic,
      }),
    () => ({ definitions: callerCandidates.length, semantic: !deadCodeOnly && semantic }),
  );

  const reportedDefinitions = deadCodeOnly
    ? sourceCandidates.filter((definition) => !hasAnyReference(referencesBySymbol, definition.symbolId))
    : definitions;
  return deadSummary(db, deadRows(reportedDefinitions, referencesBySymbol));
}

// scip-query: ignore-extract — this is the shared dead-code candidate gate:
// ignore rules, test-file policy, callable/top-level shape, and value-like
// filtering define the command's candidate set.
function deadCandidateDefinitions(db: ScipDatabase, opts: DeadCandidateOptions): IndexedDefinition[] {
  const isExcluded = buildFileExclusionPredicate(db);
  const candidates: IndexedDefinition[] = [];

  for (const definition of getScopedDefinitionsMatchingSymbols(db, {
    scope: opts.scope,
    symbolMatches: looksValueLikeDefinition,
    sqlPrefilter: 'function-like',
  })) {
    const decision = deadCandidateDecision(definition, {
      minLoc: opts.minLoc,
      includeTests: opts.includeTests,
      includeMembers: opts.includeMembers,
      isIgnoredPath: (path) => db.isIgnored(path),
      isExcludedRegion: isExcluded,
      isDeclarationOnlyCallable: () => isDeclarationOnlyCallable(db, definition),
      isFrameworkContractCallable: () => isFrameworkContractCallable(db, definition),
    });
    if (decision.accepted) candidates.push(definition);
  }

  return candidates;
}

const DECLARATION_ONLY_NODE_TYPES = [
  'method_signature',
  'abstract_method_signature',
  'call_signature',
  'construct_signature',
] as const;

function isDeclarationOnlyCallable(db: ScipDatabase, definition: IndexedDefinition): boolean {
  if (!definition.parentTypeName || !/\.[cm]?[jt]sx?$/.test(definition.relativePath)) return false;

  const tree = getAst(db, definition.relativePath);
  if (tree) {
    return tree.rootNode
      .descendantsOfType([...DECLARATION_ONLY_NODE_TYPES])
      .some((node) => node.startPosition.row <= definition.startLine && node.endPosition.row >= definition.endLine);
  }

  // Source-only fallback for environments where the optional parser cannot
  // load. A declaration member ends in `;` and has no implementation body.
  const declaration = getSourceLines(db, definition.relativePath)
    .slice(definition.startLine, definition.endLine + 1)
    .join('\n')
    .trim();
  return declaration.endsWith(';') && !declaration.includes('=>') && !declaration.includes('{');
}

function deadRows(definitions: readonly IndexedDefinition[], referencesBySymbol: ReferenceCounts): DeadRow[] {
  return definitions
    .map((definition) => deadRow(definition, referencesBySymbol))
    .filter((row) => row.cross_file_refs === 0)
    .sort((a, b) => b.loc - a.loc || a.relative_path.localeCompare(b.relative_path) || a.start_line - b.start_line);
}

function deadRow(definition: IndexedDefinition, referencesBySymbol: ReferenceCounts): DeadRow {
  const refMap = referencesBySymbol.get(definition.symbolId) ?? new Map();
  const sameFileRefs = referenceOccurrences(refMap.get(definition.relativePath));
  let crossFileRefs = 0;
  for (const [relativePath, evidence] of refMap) {
    if (relativePath === definition.relativePath) continue;
    crossFileRefs += evidence.occurrences;
  }

  return {
    relative_path: definition.relativePath,
    start_line: definition.startLine,
    end_line: definition.endLine,
    loc: definition.endLine - definition.startLine + 1,
    symbol: definition.symbol,
    parent_type_name: definition.parentTypeName,
    same_file_refs: sameFileRefs,
    cross_file_refs: crossFileRefs,
  };
}

function deadSummary(db: ScipDatabase, rows: readonly DeadRow[]): DeadSummary {
  const classifyExclusion = buildFileExclusionClassifier(db);
  const symbols: DeadSymbolResult[] = [];
  let deadCodeCount = 0;
  let fileInternalCount = 0;
  let implicitUsageCount = 0;
  let entrySurfaceExcluded = 0;
  let externalRootExcluded = 0;
  let generatedArtifactExcluded = 0;
  let totalLoc = 0;

  for (const row of rows) {
    if (db.isIgnored(row.relative_path)) continue;
    if (isEntrySurface(db, row.relative_path)) {
      entrySurfaceExcluded++;
      continue;
    }
    // `drizzle-kit pull` dumps, codegen output, and migration snapshots are
    // rewritten by their generator; a zero-reference export there is the
    // generator's shape, not code a person can delete.
    if (isGeneratedArtifactPath(row.relative_path)) {
      generatedArtifactExcluded++;
      continue;
    }
    if (isRootedSymbol(db, row.symbol, row.relative_path)) {
      externalRootExcluded++;
      continue;
    }

    const usageClassification = classifyExclusion(row.relative_path, row.start_line, row.symbol, row.parent_type_name);
    const implicitUsageReason =
      usageClassification?.disposition === 'implicit-usage' ? usageClassification.reason : undefined;
    // dead-code: zero references anywhere (not even in same file); verify before deleting
    // file-internal: referenced within same file but never cross-file —
    //   may be a private helper (fine) or a forgotten export (needs review)
    // implicit-usage: a trait, macro, attribute, ABI, or reflection boundary
    //   provides a caller that the static reference graph cannot represent.
    const kind = implicitUsageReason ? 'implicit-usage' : row.same_file_refs === 0 ? 'dead-code' : 'file-internal';
    if (kind === 'dead-code') deadCodeCount++;
    else if (kind === 'file-internal') fileInternalCount++;
    else implicitUsageCount++;
    totalLoc += row.loc;

    symbols.push({
      relativePath: row.relative_path,
      startLine: row.start_line,
      endLine: row.end_line,
      loc: row.loc,
      symbol: row.symbol,
      shortName: shortenSymbol(row.symbol),
      sameFileRefs: row.same_file_refs,
      kind,
      ...(implicitUsageReason ? { implicitUsageReason } : {}),
    });
  }

  return {
    symbols,
    counts: {
      total: symbols.length,
      deadCode: deadCodeCount,
      fileInternal: fileInternalCount,
      implicitUsage: implicitUsageCount,
      loc: totalLoc,
    },
    applicability: {
      entrySurfaceExcluded,
      externalRootExcluded,
      generatedArtifactExcluded,
      implicitUsageSignals: implicitUsageCount,
    },
    totalCount: symbols.length,
    deadCodeCount,
    fileInternalCount,
    implicitUsageCount,
    totalLoc,
  };
}

/**
 * Augment `referencesBySymbol` with AST-based identifier hits.
 *
 * scip-rust (and most SCIP indexers) doesn't record every identifier
 * reference. The biggest gap on Rust codebases: `self.field` and `Self::X`
 * accesses inside an impl block are not emitted as cross-symbol mentions,
 * so a struct field that's used heavily within its own impl appears dead.
 *
 * We compensate by walking each AST-supported file's identifier set
 * (already cached from earlier queries) and for any identifier whose name
 * matches a unique-leaf candidate symbol, attribute it as a reference.
 * Same-file matches register as same-file refs (becoming "file-internal"
 * rather than "dead-code"); other-file matches register as cross-file refs
 * (eliminating the dead-code flag entirely).
 *
 * attributeIdentifier owns the same-file > direct-import > interface-
 * dispatch disambiguation that used to live inline here.
 */
// scip-query: ignore-extract — this is the AST/source fallback reference pass:
// scan scope, framework dispatch names, unused-import filtering, and same-file
// occurrence adjustment are one accuracy guardrail.
function supplementReferencesFromAst(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  referencesBySymbol: ReferenceCounts,
  opts: { inactiveBarrelPaths: ReadonlySet<string> },
): void {
  if (definitions.length === 0) return;

  const index = new ProjectIndex(db);
  const targetIds = new Set(definitions.map((definition) => definition.symbolId));
  const candidateNames = new Set(definitions.map((definition) => definition.leaf).filter(Boolean));
  // Indexers (especially rust-analyzer) don't always cover every source
  // file — partial workspace indexing is common. We extend the AST scan to
  // every source file the project owns (indexed + auxiliary types like
  // Vue SFCs), so a reference from an unindexed file still credits the
  // symbol it reaches.
  const scanPaths = new Set<string>(index.sourceFiles());
  for (const path of listIndexedDocumentPaths(db)) scanPaths.add(path);

  index.scanSourceReferences(
    {
      paths: scanPaths,
      includeVueSfc: true,
      includeCrossLanguageDispatchNames: true,
      includeRustAttributeNames: true,
      identifierResolution: 'permissive',
      candidateNames,
      // `includeTests` controls whether test definitions are candidates. Test
      // files still consume production code, so their references always count
      // when the command claims a definition is repository-dead.
      skipPath: (relativePath) => opts.inactiveBarrelPaths.has(relativePath),
    },
    (hit) => {
      if (!targetIds.has(hit.target.symbolId)) return;
      if (shouldSkipAstReferenceHit(db, hit)) return;
      recordReference(
        referencesBySymbol,
        hit.target.symbolId,
        hit.sourceFile,
        astReferenceOccurrences(hit),
        'source-fallback',
      );
    },
  );
}

// scip-query: ignore-extract — this is the dead-code-only source fallback
// pass: candidate indexing, import-scoped resolution, source scanning,
// unused-import filtering, reference recording, and cache cleanup are one
// lifecycle.
function supplementDeadCodeOnlySourceReferences(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  referencesBySymbol: ReferenceCounts,
  opts: { inactiveBarrelPaths: ReadonlySet<string> },
): void {
  if (definitions.length === 0) return;

  const index = new ProjectIndex(db);
  const candidatesByLeaf = definitionsGroupedByLeaf(definitions);
  const scanPaths = new Set<string>(index.sourceFiles());
  for (const path of listIndexedDocumentPaths(db)) scanPaths.add(path);
  const candidateNames = new Set(candidatesByLeaf.keys());
  const importsBySource = new Map<string, Map<string, Set<string>>>();

  const importsForSource = (sourceFile: string): Map<string, Set<string>> => {
    let importsByName = importsBySource.get(sourceFile);
    if (!importsByName) {
      importsByName = sourceImportPathsByLocalName(db, sourceFile);
      importsBySource.set(sourceFile, importsByName);
    }
    return importsByName;
  };

  index.scanSourceReferences(
    {
      paths: scanPaths,
      includeVueSfc: true,
      includeCrossLanguageDispatchNames: true,
      includeRustAttributeNames: true,
      identifierResolution: 'permissive',
      candidateNames,
      skipPath: (sourceFile) => opts.inactiveBarrelPaths.has(sourceFile),
      resolveTargets: ({ sourceFile, name, kind }) => {
        const candidates = candidatesByLeaf.get(name);
        if (!candidates) return [];
        return deadSourceTargets(sourceFile, name, candidates, () => importsForSource(sourceFile), {
          permissive: kind !== 'cross-language-dispatch',
        });
      },
      afterPath: (sourceFile) => {
        importsBySource.delete(sourceFile);
        clearSourceFileEvidenceCaches(db, sourceFile);
      },
    },
    (hit) => {
      const occurrences =
        hit.kind === 'identifier' && hit.sourceFile === hit.target.relativePath
          ? Math.max(0, hit.occurrences - 1)
          : hit.occurrences;
      if (
        hit.kind === 'identifier' &&
        isUnusedImportOnlyHit(db, {
          sourceFile: hit.sourceFile,
          name: hit.name,
          target: hit.target,
          occurrences,
        })
      ) {
        return;
      }
      recordReference(referencesBySymbol, hit.target.symbolId, hit.sourceFile, occurrences, 'source-fallback');
    },
  );
}

function deadSourceTargets(
  sourceFile: string,
  name: string,
  candidates: readonly IndexedDefinition[],
  importsByName: () => ReadonlyMap<string, ReadonlySet<string>>,
  opts: { permissive: boolean },
): IndexedDefinition[] {
  const sameFile = candidates.filter((candidate) => candidate.relativePath === sourceFile);
  if (sameFile.length > 0) return sameFile;
  // Strict framework references, such as Tauri command strings, can still
  // credit a unique project-wide target even when no import names it.
  if (!opts.permissive && candidates.length === 1) return [...candidates];

  const imports = importsByName();
  const directlyImportedFrom = imports.get(name);
  if (directlyImportedFrom) {
    for (const sourcePath of directlyImportedFrom) {
      const matches = candidates.filter((candidate) => pathsResolveSame(sourcePath, candidate.relativePath));
      if (matches.length > 0) return matches;
    }
  }

  const allImportedSourcePaths = new Set<string>();
  for (const sourcePaths of imports.values()) {
    for (const sourcePath of sourcePaths) allImportedSourcePaths.add(sourcePath);
  }
  for (const sourcePath of allImportedSourcePaths) {
    const matches = candidates.filter((candidate) => pathsResolveSame(sourcePath, candidate.relativePath));
    if (matches.length > 0 && matches.length === candidates.length) return matches;
  }

  return opts.permissive ? [...candidates] : [];
}

function shouldSkipAstReferenceHit(
  db: ScipDatabase,
  hit: {
    kind: string;
    sourceFile: string;
    name: string;
    target: { relativePath: string };
    occurrences: number;
  },
): boolean {
  if (hit.kind === 'cross-language-dispatch' && hit.target.relativePath === hit.sourceFile) return true;
  return hit.kind === 'identifier' && isUnusedImportOnlyHit(db, hit);
}

function astReferenceOccurrences(hit: {
  kind: string;
  sourceFile: string;
  target: { relativePath: string };
  occurrences: number;
}): number {
  return hit.kind === 'identifier' && hit.target.relativePath === hit.sourceFile
    ? Math.max(0, hit.occurrences - 1)
    : hit.occurrences;
}

function isUnusedImportOnlyHit(
  db: ScipDatabase,
  hit: {
    sourceFile: string;
    name: string;
    target: { relativePath: string };
    occurrences: number;
  },
): boolean {
  if (hit.occurrences > 1) return false;
  return getSourceImports(db, hit.sourceFile).some((entry) => {
    if (entry.used || entry.sourcePath !== hit.target.relativePath) return false;
    return entry.importedName === hit.name || entry.localName === hit.name;
  });
}

function supplementReferencesFromCallerMap(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  referencesBySymbol: ReferenceCounts,
  opts: { inactiveBarrelPaths: ReadonlySet<string>; includeSemantic?: boolean },
): void {
  const canUseSemantic = opts.includeSemantic !== false;
  const useBulkSemanticCallers =
    canUseSemantic &&
    definitions.length >= BULK_SEMANTIC_CALLER_MIN_DEFINITIONS &&
    listIndexedDocumentPaths(db).length >= BULK_SEMANTIC_CALLER_MIN_INDEXED_FILES;

  const recordCallerFile = (definition: IndexedDefinition, callerFile: string): void => {
    if (callerFile === definition.relativePath || db.isIgnored(callerFile)) return;
    if (opts.inactiveBarrelPaths.has(callerFile)) return;
    recordReferenceAtLeast(referencesBySymbol, definition.symbolId, callerFile, 1, 'caller-map');
  };

  if (useBulkSemanticCallers) {
    profileSpan(
      'dead.caller-map.per-symbol-non-semantic',
      () => {
        const callersBySymbol = getCallerRowsMapForSymbols(db, definitions, {
          semantic: false,
          semanticEvidence: symbolSemanticEvidence,
        });
        for (const definition of definitions) {
          const callers = callersBySymbol.get(definition.symbolId) ?? [];
          for (const caller of callers) recordCallerFile(definition, caller.file);
        }
      },
      () => ({ definitions: definitions.length, semantic: false, batched: true }),
    );
  } else {
    profileSpan(
      'dead.caller-map.per-symbol',
      () => {
        for (const definition of definitions) {
          const callers = getCallerRowsForSymbol(db, definition, {
            semantic: canUseSemantic,
            semanticEvidence: symbolSemanticEvidence,
          });
          if (callers.length === 0) continue;
          for (const caller of callers) {
            recordCallerFile(definition, caller.file);
          }
        }
      },
      () => ({ definitions: definitions.length, semantic: canUseSemantic }),
    );
  }

  if (!useBulkSemanticCallers) return;
  let semanticCandidateCount = 0;
  const semanticCandidates = profileSpan(
    'dead.caller-map.semantic-candidates',
    () => {
      const candidates = definitions.filter(
        (definition) => !hasCrossFileReference(referencesBySymbol, definition.symbolId, definition.relativePath),
      );
      semanticCandidateCount = candidates.length;
      return candidates;
    },
    () => ({ definitions: definitions.length, semanticCandidates: semanticCandidateCount }),
  );
  if (semanticCandidates.length === 0) return;
  const semanticCallersBySymbol = exactSemanticCallerMap(db, semanticCandidates);
  for (const definition of semanticCandidates) {
    const callerFiles = semanticCallersBySymbol.get(definition.symbolId);
    if (!callerFiles) continue;
    for (const callerFile of callerFiles) recordCallerFile(definition, callerFile);
  }
}
