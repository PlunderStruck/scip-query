import type { ScipDatabase } from '../storage/db.js';
import { getCrossLanguageDispatchNames, getRustAttrReferencedNames } from '../analysis/framework-patterns.js';
import { getInactiveBarrelPaths, isEntrySurface, isRootedSymbol, TEST_FILE_PATTERNS, TEST_SUPPORT_PATH_PATTERNS } from '../analysis/file-classifier.js';
import { clearDefinitionCacheForFile, enclosingTypeNames, getDefinitionsForFile } from '../symbols/definition-catalog.js';
import { getDefinitionExclusions } from '../analysis/framework-patterns.js';
import type { DeadOptions, DeadSymbolResult, DeadSummary, IndexedDefinition } from '../domain/types.js';
import { isCallableSymbol, isFunctionLikeSymbol, isInRustTestModule, isModuleLikeSymbol, isRustTraitImplMember, shortenSymbol } from '../symbols/symbol-parser.js';
import { getCallerRowsForSymbol } from '../symbols/reference-graph.js';
import { ProjectIndex } from '../core/project-index.js';
import { clearLanguageParserCachesForFile, getSourceImports } from '../language-parsers/index.js';
import { clearAstCacheForFile, detectAstLanguage, isVueSfcPath } from '../source/ast.js';
import { clearSourceStripperCacheForFile } from '../source/source-stripper.js';
import { clearSourceTextCacheForFile } from '../source/source-text.js';
import { clearIdentifierIndexCacheForFile, getIdentifierLineMap } from '../symbols/identifier-index.js';

type ReferenceCounts = Map<number, Map<string, number>>;
const SQLITE_PARAM_BATCH_SIZE = 750;

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
  same_file_refs: number;
  cross_file_refs: number;
}

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
  } = opts;

  const definitions = deadCandidateDefinitions(db, {
    scope,
    minLoc,
    includeTests,
    includeMembers,
  });

  const inactiveBarrelPaths = skipBarrels ? new Set(getInactiveBarrelPaths(db)) : new Set<string>();
  const referencesBySymbol = deadCodeOnly
    ? new Map<number, Map<string, number>>()
    : loadMentionReferenceCounts(db, inactiveBarrelPaths);
  const scipReferencedIds = deadCodeOnly
    ? loadMentionReferencedSymbolIds(db, definitions.map((definition) => definition.symbolId), inactiveBarrelPaths)
    : new Set<number>();

  const sourceCandidates = deadCodeOnly
    ? definitions.filter((definition) => !scipReferencedIds.has(definition.symbolId))
    : definitions;
  if (deadCodeOnly) {
    supplementDeadCodeOnlySourceReferences(db, sourceCandidates, referencesBySymbol, inactiveBarrelPaths);
  } else {
    supplementReferencesFromAst(db, sourceCandidates, referencesBySymbol, inactiveBarrelPaths);
  }

  const callerCandidates = deadCodeOnly
    ? sourceCandidates.filter((definition) => !hasAnyReference(referencesBySymbol, definition.symbolId))
    : definitions;
  supplementReferencesFromCallerMap(db, callerCandidates, referencesBySymbol, {
    includeTests,
    inactiveBarrelPaths,
    includeSemantic: !deadCodeOnly,
  });

  const reportedDefinitions = deadCodeOnly
    ? sourceCandidates.filter((definition) => !hasAnyReference(referencesBySymbol, definition.symbolId))
    : definitions;
  return deadSummary(db, deadRows(reportedDefinitions, referencesBySymbol));
}

function loadMentionReferenceCounts(
  db: ScipDatabase,
  inactiveBarrelPaths: ReadonlySet<string>,
): ReferenceCounts {
  const referenceRows = db.all<{
    symbol_id: number;
    relative_path: string;
    ref_count: number;
  }>(
    `SELECT
      m.symbol_id,
      d.relative_path,
      COUNT(*) AS ref_count
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.role != 1
       ${db.pathExclusionsFor('d')}
     GROUP BY m.symbol_id, d.relative_path`,
  );

  const referencesBySymbol: ReferenceCounts = new Map();
  for (const row of referenceRows) {
    if (db.isIgnored(row.relative_path)) continue;
    if (inactiveBarrelPaths.has(row.relative_path)) continue;

    let refsForSymbol = referencesBySymbol.get(row.symbol_id);
    if (!refsForSymbol) {
      refsForSymbol = new Map<string, number>();
      referencesBySymbol.set(row.symbol_id, refsForSymbol);
    }
    refsForSymbol.set(row.relative_path, row.ref_count);
  }
  return referencesBySymbol;
}

function loadMentionReferencedSymbolIds(
  db: ScipDatabase,
  symbolIds: readonly number[],
  inactiveBarrelPaths: ReadonlySet<string>,
): Set<number> {
  const result = new Set<number>();
  for (let offset = 0; offset < symbolIds.length; offset += SQLITE_PARAM_BATCH_SIZE) {
    for (const row of loadMentionReferencedSymbolIdBatch(db, symbolIds.slice(offset, offset + SQLITE_PARAM_BATCH_SIZE))) {
      if (db.isIgnored(row.relative_path)) continue;
      if (inactiveBarrelPaths.has(row.relative_path)) continue;
      result.add(row.symbol_id);
    }
  }
  return result;
}

function loadMentionReferencedSymbolIdBatch(
  db: ScipDatabase,
  symbolIds: readonly number[],
): Array<{ symbol_id: number; relative_path: string }> {
  if (symbolIds.length === 0) return [];
  return db.all<{ symbol_id: number; relative_path: string }>(
    `SELECT DISTINCT m.symbol_id, d.relative_path
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.role != 1
       AND m.symbol_id IN (${symbolIds.map(() => '?').join(',')})
       ${db.pathExclusionsFor('d')}`,
    ...symbolIds,
  ).filter((row) => row.symbol_id !== null);
}

// scip-query: ignore-extract — this is the shared dead-code candidate gate:
// ignore rules, test-file policy, callable/top-level shape, and value-like
// filtering define the command's candidate set.
function deadCandidateDefinitions(
  db: ScipDatabase,
  opts: DeadCandidateOptions,
): IndexedDefinition[] {
  const isExcluded = buildFileExclusionPredicate(db);
  const candidates: IndexedDefinition[] = [];

  for (const relativePath of deadCandidateDefinitionPaths(db, opts.scope)) {
    try {
      for (const definition of getDefinitionsForFile(db, relativePath)) {
        if (db.isIgnored(definition.relativePath)) continue;
        if (isModuleLikeSymbol(definition.symbol)) continue;
        if (!looksValueLikeDefinition(definition.symbol)) continue;
        if (
          !definition.isFunctionLike
          && definition.enclosingSymbol
          && looksValueLikeDefinition(definition.enclosingSymbol)
        ) continue;
        if (!opts.includeTests && !passesTestFileFilter(definition.relativePath)) continue;
        if (
          !opts.includeTests
          && isExcluded(definition.relativePath, definition.startLine, definition.symbol, definition.parentTypeName)
        ) continue;
        // rust-analyzer encodes trait impls as `impl#[Type][Trait]Member.` and
        // inherent impls as `impl#[Type]Member.`. Trait-impl members (methods,
        // associated consts, associated types) are reached through the trait —
        // SCIP can't see those calls, and the AST line-range exclusion only
        // catches them when the symbol's reported range actually sits inside
        // the impl block. For associated consts, rust-analyzer often emits no
        // `defn_enclosing_range` row, so the fallback chunk range pushes them
        // outside any AST exclusion. Filtering by symbol structure side-steps
        // that whole issue.
        if (isRustTraitImplMember(definition.symbol)) continue;
        // Inline test mods (`#[cfg(test)] mod tests`) live in regular source
        // files but the items inside them aren't shippable code — treating
        // them as "potentially dead" floods the report with helper fns.
        if (isInRustTestModule(definition.symbol)) continue;
        if (!opts.includeMembers && !isTopLevelOrCallable(definition)) continue;
        if ((definition.endLine - definition.startLine + 1) < opts.minLoc) continue;
        candidates.push(definition);
      }
    } finally {
      clearDefinitionCacheForFile(db, relativePath);
      clearDeadSourceFileCaches(db, relativePath);
    }
  }

  return candidates;
}

function deadCandidateDefinitionPaths(db: ScipDatabase, scope?: string): string[] {
  const scopeFilter = scope ? 'AND relative_path LIKE ?' : '';
  const params = scope ? [`%${scope}%`] : [];
  return db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
       ${scopeFilter}
     ORDER BY relative_path`,
    ...params,
  ).map((row) => row.relative_path);
}

function deadRows(
  definitions: readonly IndexedDefinition[],
  referencesBySymbol: ReferenceCounts,
): DeadRow[] {
  return definitions
    .map((definition) => deadRow(definition, referencesBySymbol))
    .filter((row) => row.cross_file_refs === 0)
    .sort((a, b) => b.loc - a.loc || a.relative_path.localeCompare(b.relative_path) || a.start_line - b.start_line);
}

function deadRow(
  definition: IndexedDefinition,
  referencesBySymbol: ReferenceCounts,
): DeadRow {
  const refMap = referencesBySymbol.get(definition.symbolId) ?? new Map<string, number>();
  const sameFileRefs = refMap.get(definition.relativePath) ?? 0;
  let crossFileRefs = 0;
  for (const [relativePath, count] of refMap) {
    if (relativePath === definition.relativePath) continue;
    crossFileRefs += count;
  }

  return {
    relative_path: definition.relativePath,
    start_line: definition.startLine,
    end_line: definition.endLine,
    loc: definition.endLine - definition.startLine + 1,
    symbol: definition.symbol,
    same_file_refs: sameFileRefs,
    cross_file_refs: crossFileRefs,
  };
}

function deadSummary(
  db: ScipDatabase,
  rows: readonly DeadRow[],
): DeadSummary {
  const symbols: DeadSymbolResult[] = [];
  let deadCodeCount = 0;
  let fileInternalCount = 0;
  let totalLoc = 0;

  for (const row of rows) {
    if (db.isIgnored(row.relative_path)) continue;
    if (isEntrySurface(db, row.relative_path)) continue;
    if (isRootedSymbol(db, row.symbol, row.relative_path)) continue;

    // dead-code: zero references anywhere (not even in same file) — safe to delete
    // file-internal: referenced within same file but never cross-file —
    //   may be a private helper (fine) or a forgotten export (needs review)
    const kind = row.same_file_refs === 0 ? 'dead-code' : 'file-internal';
    if (kind === 'dead-code') deadCodeCount++;
    else fileInternalCount++;
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
    });
  }

  return {
    symbols,
    totalCount: symbols.length,
    deadCodeCount,
    fileInternalCount,
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
  inactiveBarrelPaths: ReadonlySet<string>,
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
  for (const path of indexedDocumentPaths(db)) scanPaths.add(path);

  index.scanSourceReferences({
    paths: scanPaths,
    includeVueSfc: true,
    includeCrossLanguageDispatchNames: true,
    includeRustAttributeNames: true,
    identifierResolution: 'permissive',
    candidateNames,
    skipPath: (relativePath) => inactiveBarrelPaths.has(relativePath),
  }, (hit) => {
    if (!targetIds.has(hit.target.symbolId)) return;
    if (shouldSkipAstReferenceHit(db, hit)) return;
    recordReference(
      referencesBySymbol,
      hit.target.symbolId,
      hit.sourceFile,
      astReferenceOccurrences(hit),
    );
  });
}

function supplementDeadCodeOnlySourceReferences(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  referencesBySymbol: ReferenceCounts,
  inactiveBarrelPaths: ReadonlySet<string>,
): void {
  if (definitions.length === 0) return;

  const index = new ProjectIndex(db);
  const candidatesByLeaf = definitionsByLeaf(definitions);
  const scanPaths = new Set<string>(index.sourceFiles());
  for (const path of indexedDocumentPaths(db)) scanPaths.add(path);

  for (const sourceFile of scanPaths) {
    const astLanguage = detectAstLanguage(sourceFile);
    if (!astLanguage && !isVueSfcPath(sourceFile)) continue;
    if (db.isIgnored(sourceFile)) continue;
    if (inactiveBarrelPaths.has(sourceFile)) continue;

    try {
      const importsByName = readFileImports(db, sourceFile);
      const lineMap = getIdentifierLineMap(db, sourceFile);
      for (const [name, lines] of lineMap) {
        const candidates = candidatesByLeaf.get(name);
        if (!candidates) continue;
        const targets = deadSourceTargets(sourceFile, name, candidates, importsByName, { permissive: true });
        for (const target of targets) {
          const occurrences = sourceFile === target.relativePath ? Math.max(0, lines.length - 1) : lines.length;
          if (isUnusedImportOnlyHit(db, {
            sourceFile,
            name,
            target,
            occurrences,
          })) continue;
          recordReference(referencesBySymbol, target.symbolId, sourceFile, occurrences);
        }
      }

      for (const name of getCrossLanguageDispatchNames(db, sourceFile)) {
        const candidates = candidatesByLeaf.get(name);
        if (!candidates) continue;
        for (const target of deadSourceTargets(sourceFile, name, candidates, importsByName, { permissive: false })) {
          recordReference(referencesBySymbol, target.symbolId, sourceFile, 1);
        }
      }

      if (astLanguage === 'rust') {
        for (const name of getRustAttrReferencedNames(db, sourceFile)) {
          const candidates = candidatesByLeaf.get(name);
          if (!candidates) continue;
          for (const target of deadSourceTargets(sourceFile, name, candidates, importsByName, { permissive: true })) {
            recordReference(referencesBySymbol, target.symbolId, sourceFile, 1);
          }
        }
      }
    } finally {
      clearDeadSourceFileCaches(db, sourceFile);
    }
  }
}

function clearDeadSourceFileCaches(db: ScipDatabase, sourceFile: string): void {
  clearIdentifierIndexCacheForFile(db, sourceFile);
  clearLanguageParserCachesForFile(db, sourceFile);
  clearSourceStripperCacheForFile(db, sourceFile);
  clearAstCacheForFile(db, sourceFile);
  clearSourceTextCacheForFile(db, sourceFile);
}

function definitionsByLeaf(
  definitions: readonly IndexedDefinition[],
): Map<string, IndexedDefinition[]> {
  const result = new Map<string, IndexedDefinition[]>();
  for (const definition of definitions) {
    if (!definition.leaf) continue;
    const bucket = result.get(definition.leaf) ?? [];
    bucket.push(definition);
    result.set(definition.leaf, bucket);
  }
  return result;
}

function deadSourceTargets(
  sourceFile: string,
  name: string,
  candidates: readonly IndexedDefinition[],
  importsByName: ReadonlyMap<string, ReadonlySet<string>>,
  opts: { permissive: boolean },
): IndexedDefinition[] {
  const sameFile = candidates.filter((candidate) => candidate.relativePath === sourceFile);
  if (sameFile.length > 0) return sameFile;

  const directlyImportedFrom = importsByName.get(name);
  if (directlyImportedFrom) {
    for (const sourcePath of directlyImportedFrom) {
      const matches = candidates.filter((candidate) => pathsResolveSame(sourcePath, candidate.relativePath));
      if (matches.length > 0) return matches;
    }
  }

  const allImportedSourcePaths = new Set<string>();
  for (const sourcePaths of importsByName.values()) {
    for (const sourcePath of sourcePaths) allImportedSourcePaths.add(sourcePath);
  }
  for (const sourcePath of allImportedSourcePaths) {
    const matches = candidates.filter((candidate) => pathsResolveSame(sourcePath, candidate.relativePath));
    if (matches.length > 0 && matches.length === candidates.length) return matches;
  }

  return opts.permissive ? [...candidates] : [];
}

function hasAnyReference(
  referencesBySymbol: ReferenceCounts,
  symbolId: number,
): boolean {
  const refs = referencesBySymbol.get(symbolId);
  if (!refs) return false;
  for (const count of refs.values()) {
    if (count > 0) return true;
  }
  return false;
}

function indexedDocumentPaths(db: ScipDatabase): Set<string> {
  const rows = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`,
  );
  return new Set(rows.map((row) => row.relative_path));
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

function recordReference(
  referencesBySymbol: ReferenceCounts,
  symbolId: number,
  file: string,
  occurrences: number,
): void {
  if (occurrences <= 0) return;
  let refsForSymbol = referencesBySymbol.get(symbolId);
  if (!refsForSymbol) {
    refsForSymbol = new Map<string, number>();
    referencesBySymbol.set(symbolId, refsForSymbol);
  }
  refsForSymbol.set(file, (refsForSymbol.get(file) ?? 0) + occurrences);
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

function readFileImports(db: ScipDatabase, file: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of getSourceImports(db, file)) {
    if (!entry.sourcePath) continue;
    const localName = entry.localName ?? entry.importedName;
    if (localName) {
      let bucket = map.get(localName);
      if (!bucket) {
        bucket = new Set();
        map.set(localName, bucket);
      }
      bucket.add(entry.sourcePath);
    }
    if (entry.kind === 'namespace') {
      for (const member of entry.usedMembers) {
        let bucket = map.get(member);
        if (!bucket) {
          bucket = new Set();
          map.set(member, bucket);
        }
        bucket.add(entry.sourcePath);
      }
    }
  }
  return map;
}

function pathsResolveSame(a: string, b: string): boolean {
  const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalize(a) === normalize(b);
}

function supplementReferencesFromCallerMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<{
    documentId: number;
    symbolId: number;
    symbol: string;
    relativePath: string;
    startLine: number;
    endLine: number;
  }>,
  referencesBySymbol: ReferenceCounts,
  opts: { includeTests: boolean; inactiveBarrelPaths: ReadonlySet<string>; includeSemantic?: boolean },
): void {
  for (const definition of definitions) {
    const callers = getCallerRowsForSymbol(db, definition, { semantic: opts.includeSemantic !== false });
    if (callers.length === 0) continue;
    let refsForSymbol = referencesBySymbol.get(definition.symbolId);
    if (!refsForSymbol) {
      refsForSymbol = new Map<string, number>();
      referencesBySymbol.set(definition.symbolId, refsForSymbol);
    }
    for (const caller of callers) {
      const callerFile = caller.file;
      if (callerFile === definition.relativePath || db.isIgnored(callerFile)) continue;
      if (opts.inactiveBarrelPaths.has(callerFile)) continue;
      if (!opts.includeTests && !passesTestFileFilter(callerFile)) continue;
      refsForSymbol.set(callerFile, Math.max(1, refsForSymbol.get(callerFile) ?? 0));
    }
  }
}

/**
 * Build a per-file exclusion predicate: returns true when (file, startLine)
 * sits inside a framework-owned definition range (Tauri command handlers,
 * `#[cfg(test)] mod`, serde-derived fields, etc.) that the SCIP graph can't
 * see callers for. Range-based matching because SCIP fields' start_line
 * often points at the struct's opening line.
 */
function buildFileExclusionPredicate(
  db: ScipDatabase,
): (relativePath: string, startLine: number, symbol: string, parentTypeName: string | null) => boolean {
  interface FileExclusions {
    ranges: Array<{ startLine: number; endLine: number }>;
    containers: Set<string>;
  }
  const exclusionsByFile = new Map<string, FileExclusions>();
  const ensure = (relativePath: string): FileExclusions => {
    let cached = exclusionsByFile.get(relativePath);
    if (cached) return cached;
    const entries = getDefinitionExclusions(db, relativePath);
    cached = {
      ranges: entries.map((e) => ({ startLine: e.startLine, endLine: e.endLine })),
      containers: new Set(entries.map((e) => e.containerName).filter((n): n is string => Boolean(n))),
    };
    exclusionsByFile.set(relativePath, cached);
    return cached;
  };
  return (relativePath, startLine, symbol, parentTypeName) => {
    const ex = ensure(relativePath);
    for (const r of ex.ranges) {
      if (startLine >= r.startLine && startLine <= r.endLine) return true;
    }
    if (parentTypeName && ex.containers.has(parentTypeName)) return true;
    // Walk the full enclosing-type chain: enum-variant fields' immediate
    // parent type is the variant, but we want the exclusion registered
    // against the enum to apply (thiserror error fields, sea-orm value
    // structs, anything where the framework-touched type is the outermost
    // wrapper rather than the closest parent).
    for (const name of enclosingTypeNames(symbol)) {
      if (ex.containers.has(name)) return true;
    }
    return false;
  };
}

function passesTestFileFilter(relativePath: string): boolean {
  const patterns = [...new Set([...TEST_FILE_PATTERNS, ...TEST_SUPPORT_PATH_PATTERNS])];
  return patterns.every((pattern) => !likeMatches(relativePath, pattern));
}

function likeMatches(value: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.')}$`);
  return regex.test(value);
}

function looksValueLikeDefinition(rawSymbol: string): boolean {
  return isFunctionLikeSymbol(rawSymbol) || rawSymbol.endsWith('().') || rawSymbol.endsWith('.');
}

function isTopLevelOrCallable(definition: { isFunctionLike: boolean; parentTypeName: string | null; symbol: string }): boolean {
  return isCallableSymbol(definition.symbol) || enclosingTypeNames(definition.symbol).length === 0;
}
