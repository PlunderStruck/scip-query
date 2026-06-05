import type { ScipDatabase } from '../storage/db.js';
import { getInactiveBarrelPaths, isEntrySurface, isRootedSymbol, TEST_FILE_PATTERNS, TEST_SUPPORT_PATH_PATTERNS } from '../analysis/file-classifier.js';
import { enclosingTypeNames, getAllDefinitions } from '../symbols/definition-catalog.js';
import { getDefinitionExclusions } from '../analysis/framework-patterns.js';
import type { DeadOptions, DeadSymbolResult, DeadSummary } from '../domain/types.js';
import { isFunctionLikeSymbol, isInRustTestModule, isModuleLikeSymbol, isRustTraitImplMember, shortenSymbol } from '../symbols/symbol-parser.js';
import { ProjectIndex } from '../core/project-index.js';

/**
 * Find dead exports: symbols defined locally with no cross-file references.
 * Language-agnostic — works with any SCIP index.
 */
export function dead(db: ScipDatabase, opts: DeadOptions = {}): DeadSummary {
  const {
    scope,
    minLoc = 1,
    includeTests = false,
    skipBarrels = false,
    includeMembers = false,
  } = opts;

  const inactiveBarrelPaths = skipBarrels ? new Set(getInactiveBarrelPaths(db)) : new Set<string>();
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

  const referencesBySymbol = new Map<number, Map<string, number>>();
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

  supplementReferencesFromAst(db, referencesBySymbol, inactiveBarrelPaths);

  const isExcluded = buildFileExclusionPredicate(db);

  const definitions = getAllDefinitions(db, { scope })
    .filter((definition) => !db.isIgnored(definition.relativePath))
    .filter((definition) => !isModuleLikeSymbol(definition.symbol))
    .filter((definition) => looksValueLikeDefinition(definition.symbol))
    .filter((definition) => (
      definition.isFunctionLike
      || !definition.enclosingSymbol
      || !looksValueLikeDefinition(definition.enclosingSymbol)
    ))
    .filter((definition) => includeTests || passesTestFileFilter(definition.relativePath))
    .filter((definition) => includeTests || !isExcluded(definition.relativePath, definition.startLine, definition.symbol, definition.parentTypeName))
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
    .filter((definition) => includeMembers || looksValueLikeDefinition(definition.symbol))
    .filter((definition) => (definition.endLine - definition.startLine + 1) >= minLoc);

  const rows = definitions
    .map((definition) => {
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
    })
    .filter((row) => row.cross_file_refs === 0)
    .sort((a, b) => b.loc - a.loc || a.relative_path.localeCompare(b.relative_path) || a.start_line - b.start_line);

  let deadCodeCount = 0;
  let fileInternalCount = 0;
  let totalLoc = 0;

  const symbols: DeadSymbolResult[] = rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .filter((r) => !isEntrySurface(db, r.relative_path))
    .filter((r) => !isRootedSymbol(db, r.symbol, r.relative_path))
    .map((r) => {
      // dead-code: zero references anywhere (not even in same file) — safe to delete
      // file-internal: referenced within same file but never cross-file —
      //   may be a private helper (fine) or a forgotten export (needs review)
      const kind = r.same_file_refs === 0 ? 'dead-code' : 'file-internal';
      if (kind === 'dead-code') deadCodeCount++;
      else fileInternalCount++;
      totalLoc += r.loc;

      return {
        relativePath: r.relative_path,
        startLine: r.start_line,
        endLine: r.end_line,
        loc: r.loc,
        symbol: r.symbol,
        shortName: shortenSymbol(r.symbol),
        sameFileRefs: r.same_file_refs,
        kind,
      };
    });

  return {
    symbols,
    totalCount: symbols.length,
    deadCodeCount,
    fileInternalCount,
    totalLoc,
  };
}

/**
 * Walk projectRoot and return every source file with an AST-supported
 * extension as a relative path. Skips obvious directories that shouldn't
 * contain user code (node_modules, target, .git, dist, build, .next, etc.).
 *
 * Used by the AST identifier supplement so unindexed source files
 * (rust-analyzer often skips part of a workspace; tsc-batch indexers can
 * miss files too) still contribute their references to the dead-code
 * detector.
 */

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
function supplementReferencesFromAst(
  db: ScipDatabase,
  referencesBySymbol: Map<number, Map<string, number>>,
  inactiveBarrelPaths: ReadonlySet<string>,
): void {
  const index = new ProjectIndex(db);
  const docRows = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`,
  );
  const indexedPaths = new Set(docRows.map((r) => r.relative_path));
  // Indexers (especially rust-analyzer) don't always cover every source
  // file — partial workspace indexing is common. We extend the AST scan to
  // every source file the project owns (indexed + auxiliary types like
  // Vue SFCs), so a reference from an unindexed file still credits the
  // symbol it reaches.
  const scanPaths = new Set<string>(index.sourceFiles());
  for (const p of indexedPaths) scanPaths.add(p);

  const recordRef = (symbolId: number, file: string, occurrences: number): void => {
    if (occurrences <= 0) return;
    let refsForSymbol = referencesBySymbol.get(symbolId);
    if (!refsForSymbol) {
      refsForSymbol = new Map<string, number>();
      referencesBySymbol.set(symbolId, refsForSymbol);
    }
    refsForSymbol.set(file, (refsForSymbol.get(file) ?? 0) + occurrences);
  };

  index.scanSourceReferences({
    paths: scanPaths,
    includeVueSfc: true,
    includeCrossLanguageDispatchNames: true,
    includeRustAttributeNames: true,
    identifierResolution: 'permissive',
    skipPath: (relativePath) => inactiveBarrelPaths.has(relativePath),
  }, (hit) => {
    if (hit.kind === 'cross-language-dispatch' && hit.target.relativePath === hit.sourceFile) return;
    const occurrences = hit.kind === 'identifier' && hit.target.relativePath === hit.sourceFile
      ? Math.max(0, hit.occurrences - 1)
      : hit.occurrences;
    recordRef(hit.target.symbolId, hit.sourceFile, occurrences);
  });
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
