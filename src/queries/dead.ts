import type { ScipDatabase } from '../db.js';
import { getInactiveBarrelPaths, isEntrySurface, TEST_FILE_PATTERNS, TEST_SUPPORT_PATH_PATTERNS } from '../file-classifier.js';
import { attributeIdentifier } from '../identifier-attribution.js';
import { getAllDefinitions } from '../query-support.js';
import { detectAstLanguage, isVueSfcPath } from '../ast.js';
import { getCrossLanguageDispatchNames, getDefinitionExclusions } from '../framework-patterns.js';
import { getIdentifierLineMap } from '../source-analysis.js';
import { getSourceFiles } from '../source-fileset.js';
import type { DeadOptions, DeadSymbolResult, DeadSummary } from '../types.js';
import { isFunctionLikeSymbol, isModuleLikeSymbol, shortenSymbol } from '../symbol-parser.js';

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

  // ── AST-based reference supplement ──────────────────────────
  //
  // scip-rust (and most SCIP indexers) doesn't record every identifier
  // reference. The biggest gap on Rust codebases: `self.field` and `Self::X`
  // accesses inside an impl block are not emitted as cross-symbol mentions,
  // so a struct field that's used heavily within its own impl appears dead.
  //
  // We compensate by walking each AST-supported file's identifier set
  // (already cached from earlier queries) and for any identifier whose name
  // matches a unique-leaf candidate symbol, attribute it as a reference.
  // Same-file matches register as same-file refs (becoming "file-internal"
  // rather than "dead-code"); other-file matches register as cross-file refs
  // (eliminating the dead-code flag entirely).
  //
  // attributeIdentifier owns the same-file > direct-import > interface-
  // dispatch disambiguation that used to live inline here.

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
  const scanPaths = new Set<string>(getSourceFiles(db));
  for (const p of indexedPaths) scanPaths.add(p);
  for (const relativePath of scanPaths) {
    const doc = { relative_path: relativePath };
    // Skip files we can't parse at all. Vue SFCs go through `getAst`'s
    // script-block extraction (returns a TS/JS tree), so they pass even
    // though detectAstLanguage('.vue') returns null.
    if (!detectAstLanguage(doc.relative_path) && !isVueSfcPath(doc.relative_path)) continue;
    if (db.isIgnored(doc.relative_path)) continue;
    if (inactiveBarrelPaths.has(doc.relative_path)) continue;
    const lineMap = getIdentifierLineMap(db, doc.relative_path);
    for (const [name, lines] of lineMap) {
      const targets = attributeIdentifier(db, doc.relative_path, name);
      if (targets.length === 0) continue;
      // Each line is one occurrence. The defining file's count includes the
      // declaration itself; subtract one occurrence on that file so we don't
      // count the def as a reference to itself.
      for (const target of targets) {
        let occurrences = lines.length;
        if (target.relativePath === doc.relative_path) occurrences = Math.max(0, occurrences - 1);
        if (occurrences === 0) continue;

        let refsForSymbol = referencesBySymbol.get(target.symbolId);
        if (!refsForSymbol) {
          refsForSymbol = new Map<string, number>();
          referencesBySymbol.set(target.symbolId, refsForSymbol);
        }
        refsForSymbol.set(doc.relative_path, (refsForSymbol.get(doc.relative_path) ?? 0) + occurrences);
      }
    }

    const dispatchNames = getCrossLanguageDispatchNames(db, doc.relative_path);
    for (const cmdName of dispatchNames) {
      const targets = attributeIdentifier(db, doc.relative_path, cmdName);
      for (const target of targets) {
        if (target.relativePath === doc.relative_path) continue;

        let refsForSymbol = referencesBySymbol.get(target.symbolId);
        if (!refsForSymbol) {
          refsForSymbol = new Map<string, number>();
          referencesBySymbol.set(target.symbolId, refsForSymbol);
        }
        refsForSymbol.set(doc.relative_path, (refsForSymbol.get(doc.relative_path) ?? 0) + 1);
      }
    }
  }

  // Per-file framework-owned exclusion ranges (Tauri command handlers, test
  // functions, serde-derived struct/enum fields, anything inside
  // #[cfg(test)] mod). These items are invoked by the framework, not by code
  // in the SCIP graph, so they look "dead" without this filter and dominate
  // the report. Range-based matching because SCIP fields' start_line often
  // points at the struct's opening line.
  interface FileExclusions {
    ranges: Array<{ startLine: number; endLine: number }>;
    containers: Set<string>;
  }
  const exclusionsByFile = new Map<string, FileExclusions>();
  const ensureFileExclusions = (relativePath: string): FileExclusions => {
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
  const isExcluded = (
    relativePath: string,
    startLine: number,
    parentTypeName: string | null,
  ): boolean => {
    const ex = ensureFileExclusions(relativePath);
    for (const r of ex.ranges) {
      if (startLine >= r.startLine && startLine <= r.endLine) return true;
    }
    if (parentTypeName && ex.containers.has(parentTypeName)) return true;
    return false;
  };

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
    .filter((definition) => includeTests || !isExcluded(definition.relativePath, definition.startLine, definition.parentTypeName))
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
