import type { ScipDatabase } from '../storage/db.js';
import { getInactiveBarrelPaths, isEntrySurface, isRootedSymbol, TEST_FILE_PATTERNS, TEST_SUPPORT_PATH_PATTERNS } from '../analysis/file-classifier.js';
import { enclosingTypeNames, getAllDefinitions } from '../symbols/definition-catalog.js';
import { getDefinitionExclusions } from '../analysis/framework-patterns.js';
import type { DeadOptions, DeadSymbolResult, DeadSummary, IndexedDefinition } from '../domain/types.js';
import { isCallableSymbol, isFunctionLikeSymbol, isInRustTestModule, isModuleLikeSymbol, isRustTraitImplMember, shortenSymbol } from '../symbols/symbol-parser.js';
import { getCallerRowsForSymbol } from '../symbols/reference-graph.js';
import { ProjectIndex } from '../core/project-index.js';
import { getSourceImports } from '../language-parsers/index.js';

type ReferenceCounts = Map<number, Map<string, number>>;

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
  } = opts;

  const inactiveBarrelPaths = skipBarrels ? new Set(getInactiveBarrelPaths(db)) : new Set<string>();
  const referencesBySymbol = loadMentionReferenceCounts(db, inactiveBarrelPaths);
  supplementReferencesFromAst(db, referencesBySymbol, inactiveBarrelPaths);

  const definitions = deadCandidateDefinitions(db, {
    scope,
    minLoc,
    includeTests,
    includeMembers,
  });
  supplementReferencesFromCallerMap(db, definitions, referencesBySymbol, {
    includeTests,
    inactiveBarrelPaths,
  });

  return deadSummary(db, deadRows(definitions, referencesBySymbol));
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

// scip-query: ignore-extract — this is the shared dead-code candidate gate:
// ignore rules, test-file policy, callable/top-level shape, and value-like
// filtering define the command's candidate set.
function deadCandidateDefinitions(
  db: ScipDatabase,
  opts: DeadCandidateOptions,
): IndexedDefinition[] {
  const isExcluded = buildFileExclusionPredicate(db);
  return getAllDefinitions(db, { scope: opts.scope })
    .filter((definition) => !db.isIgnored(definition.relativePath))
    .filter((definition) => !isModuleLikeSymbol(definition.symbol))
    .filter((definition) => looksValueLikeDefinition(definition.symbol))
    .filter((definition) => (
      definition.isFunctionLike
      || !definition.enclosingSymbol
      || !looksValueLikeDefinition(definition.enclosingSymbol)
    ))
    .filter((definition) => opts.includeTests || passesTestFileFilter(definition.relativePath))
    .filter((definition) => opts.includeTests || !isExcluded(definition.relativePath, definition.startLine, definition.symbol, definition.parentTypeName))
    // rust-analyzer encodes trait impls as `impl#[Type][Trait]Member.` and
    // inherent impls as `impl#[Type]Member.`. Trait-impl members (methods,
    // associated consts, associated types) are reached through the trait —
    // SCIP can't see those calls, and the AST line-range exclusion only
    // catches them when the symbol's reported range actually sits inside
    // the impl block. For associated consts, rust-analyzer often emits no
    // `defn_enclosing_range` row, so the fallback chunk range pushes them
    // outside any AST exclusion. Filtering by symbol structure side-steps
    // that whole issue.
    .filter((definition) => !isRustTraitImplMember(definition.symbol))
    // Inline test mods (`#[cfg(test)] mod tests`) live in regular source
    // files but the items inside them aren't shippable code — treating
    // them as "potentially dead" floods the report with helper fns.
    .filter((definition) => !isInRustTestModule(definition.symbol))
    .filter((definition) => opts.includeMembers || isTopLevelOrCallable(definition))
    .filter((definition) => (definition.endLine - definition.startLine + 1) >= opts.minLoc);
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
  referencesBySymbol: ReferenceCounts,
  inactiveBarrelPaths: ReadonlySet<string>,
): void {
  const index = new ProjectIndex(db);
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
    skipPath: (relativePath) => inactiveBarrelPaths.has(relativePath),
  }, (hit) => {
    if (shouldSkipAstReferenceHit(db, hit)) return;
    recordReference(
      referencesBySymbol,
      hit.target.symbolId,
      hit.sourceFile,
      astReferenceOccurrences(hit),
    );
  });
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
  opts: { includeTests: boolean; inactiveBarrelPaths: ReadonlySet<string> },
): void {
  for (const definition of definitions) {
    const callers = getCallerRowsForSymbol(db, definition);
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
