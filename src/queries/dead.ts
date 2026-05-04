import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ScipDatabase } from '../db.js';
import { getInactiveBarrelPaths, isEntrySurface } from '../entry-surfaces.js';
import { getAllDefinitions, TEST_FILE_PATTERNS, TEST_SUPPORT_PATH_PATTERNS } from '../query-support.js';
import { detectAstLanguage, getCrossLanguageDispatchNames, getDefinitionExclusions, isVueSfcPath } from '../ast.js';
import { getIdentifierLineMap, getSourceImports } from '../source-analysis.js';
import type { DeadOptions, DeadSymbolResult, DeadSummary } from '../types.js';
import { isFunctionLikeSymbol, isModuleLikeSymbol, leafName, shortenSymbol } from '../symbol-parser.js';

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
  // Restricting to unique-leaf candidates avoids over-attribution: a method
  // named `new` exists on dozens of types, so a textual match of `new` in
  // some file shouldn't satisfy "is this specific type's `new` method used."
  // Build a leaf index. For unique leaves we have a single global mapping.
  // For ambiguous leaves (e.g. `SYSTEM_PROMPT` defined in two crates), we
  // also keep a per-file index so a same-file reference can resolve to the
  // right symbol — important when scip-rust drops in-file mentions.
  const leafToSymbolGlobal = new Map<string, Array<{ symbolId: number; relativePath: string }>>();
  for (const row of db.all<{ id: number; symbol: string; relative_path: string | null }>(
    `SELECT gs.id, gs.symbol,
            COALESCE(der_doc.relative_path, mention_doc.relative_path) AS relative_path
     FROM global_symbols gs
     LEFT JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
     LEFT JOIN documents der_doc ON der_doc.id = der.document_id
     LEFT JOIN (
       SELECT m.symbol_id, MIN(d.relative_path) AS relative_path
       FROM mentions m
       JOIN chunks c ON m.chunk_id = c.id
       JOIN documents d ON c.document_id = d.id
       WHERE m.role = 1
       GROUP BY m.symbol_id
     ) mention_doc ON mention_doc.symbol_id = gs.id
     WHERE 1 = 1 ${db.symbolNoiseFor('gs')}`,
  )) {
    if (!row.relative_path) continue;
    const leaf = leafName(row.symbol);
    if (!leaf) continue;
    let bucket = leafToSymbolGlobal.get(leaf);
    if (!bucket) { bucket = []; leafToSymbolGlobal.set(leaf, bucket); }
    if (!bucket.some((e) => e.symbolId === row.id)) {
      bucket.push({ symbolId: row.id, relativePath: row.relative_path });
    }
  }
  // Ambiguous-leaf disambiguation via imports. When a leaf is defined by N
  // symbols and a referencing file imports `name` from path P, attribute the
  // textual hit to the symbol whose defining file is P. Cached per file so
  // we don't reparse imports for every leaf encountered in the file.
  const importsByFile = new Map<string, Map<string, Set<string>>>();
  const importsForFile = (file: string): Map<string, Set<string>> => {
    const cached = importsByFile.get(file);
    if (cached) return cached;
    const map = new Map<string, Set<string>>();
    for (const entry of getSourceImports(db, file)) {
      if (!entry.sourcePath) continue;
      const localName = entry.localName ?? entry.importedName;
      if (localName) {
        let s = map.get(localName);
        if (!s) { s = new Set(); map.set(localName, s); }
        s.add(entry.sourcePath);
      }
      if (entry.kind === 'namespace') {
        for (const member of entry.usedMembers) {
          let s = map.get(member);
          if (!s) { s = new Set(); map.set(member, s); }
          s.add(entry.sourcePath);
        }
      }
    }
    importsByFile.set(file, map);
    return map;
  };
  const pathsResolveSame = (a: string, b: string): boolean => {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
    return norm(a) === norm(b);
  };

  // Resolve to one OR many candidates. Multiple come back for interface-impl
  // dispatch: when a file declares `interface PaymentProcessor { foo() }`
  // alongside `class StripePaymentProcessor implements PaymentProcessor
  // { foo() }`, a call `processor.foo()` statically resolves to the
  // interface symbol but at runtime can land on any impl. So every
  // same-file candidate should stay live, not just the interface.
  const resolveLeaf = (leaf: string, refFile: string): Array<{ symbolId: number; relativePath: string }> => {
    const bucket = leafToSymbolGlobal.get(leaf);
    if (!bucket || bucket.length === 0) return [];
    if (bucket.length === 1) return [bucket[0]!];

    // 1. Same-reference-file resolution wins outright.
    const sameFile = bucket.find((e) => e.relativePath === refFile);
    if (sameFile) return [sameFile];

    // 2. Direct import: refFile explicitly imports `leaf` from a path that
    // matches a candidate's defining file. Credit all same-file candidates
    // (interface dispatch could land on any impl at runtime).
    const fileImports = importsForFile(refFile);
    const directlyImportedFrom = fileImports.get(leaf);
    if (directlyImportedFrom) {
      for (const sourcePath of directlyImportedFrom) {
        const matches = bucket.filter((e) => pathsResolveSame(sourcePath, e.relativePath));
        if (matches.length > 0) return matches;
      }
    }

    // 3. Indirect access (method-on-instance via a factory). The leaf isn't
    // imported by name, but the consumer imports SOMETHING from a file
    // where ALL the candidates live — and a textual hit on the leaf in
    // this consumer is most likely a method call on an instance whose
    // type comes from that file. Example: tests import `getPaymentProcessor`
    // from `provider.ts`, then call `processor.createIntent(...)`. Credit
    // all candidates in the imported file.
    const importedSourcePaths = new Set<string>();
    for (const set of fileImports.values()) for (const p of set) importedSourcePaths.add(p);
    for (const sourcePath of importedSourcePaths) {
      const matches = bucket.filter((e) => pathsResolveSame(sourcePath, e.relativePath));
      if (matches.length > 0 && matches.length === bucket.length) {
        return matches;
      }
    }
    return [];
  };

  const docRows = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`,
  );
  const indexedPaths = new Set(docRows.map((r) => r.relative_path));
  // Indexers (especially rust-analyzer) don't always cover every source
  // file — partial workspace indexing is common. We extend the AST scan to
  // ANY source file under projectRoot, so a reference from an unindexed
  // file still credits the symbol it reaches. Without this, a constant
  // imported by one Tauri command file (often unindexed) but defined in
  // an indexed crate looks dead.
  const allSourcePaths = collectSourceFilesInProject(db.config.projectRoot);
  const scanPaths = new Set<string>([...indexedPaths, ...allSourcePaths]);
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
      const targets = resolveLeaf(name, doc.relative_path);
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
      const targets = resolveLeaf(cmdName, doc.relative_path);
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
const SOURCE_EXTENSIONS = new Set(['.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi', '.vue']);
const SKIP_DIRS = new Set([
  'node_modules', 'target', '.git', 'dist', 'build', '.next', '.turbo',
  '.cache', 'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
]);
function collectSourceFilesInProject(projectRoot: string): Set<string> {
  const out = new Set<string>();
  const visit = (absDir: string): void => {
    let entries: string[];
    try { entries = readdirSync(absDir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.') && SKIP_DIRS.has(name)) continue;
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(absDir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        visit(abs);
      } else if (st.isFile()) {
        const dot = name.lastIndexOf('.');
        if (dot < 0) continue;
        const ext = name.slice(dot).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        out.add(relative(projectRoot, abs).replace(/\\/g, '/'));
      }
    }
  };
  visit(projectRoot);
  return out;
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
