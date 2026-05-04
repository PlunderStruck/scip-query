/**
 * Source-fileset module — owns the answer to "which files in this project
 * should an analysis consider?"
 *
 * Two file sets matter:
 *
 * 1. **Indexed files** — what the SCIP `documents` table contains. The
 *    indexer chose these; gitignore + scip-query's path-exclusions already
 *    apply. Used by every cross-file query.
 *
 * 2. **Auxiliary files** — source files that exist on disk but the indexer
 *    didn't include (Vue SFCs are the canonical case — scip-typescript
 *    doesn't recognize the `.vue` extension). Source-text scans (`refs`,
 *    `dead`, etc.) need to include these so references in unindexed files
 *    don't silently disappear.
 *
 * Pre-this-module the two sets were managed in three places (query-support,
 * dead.ts, the import-resolver) with three different extension lists and
 * three different skip-dir lists. Vue support touched all three; the next
 * file type would too.
 */
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ScipDatabase } from './db.js';
import { createPerDbCache, createPerDbValue } from './per-db-cache.js';

/**
 * The complete set of source-file extensions scip-query knows how to
 * scan. Includes every language with a per-language parser plus
 * extensions like `.vue` that aren't indexed by SCIP indexers.
 */
export const ALL_SOURCE_EXTENSIONS: readonly string[] = [
  // JS/TS family
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  // Vue SFCs
  '.vue',
  // Other AST-supported languages
  '.rs', '.py', '.pyi',
  // JVM
  '.java', '.kt', '.kts', '.scala', '.sc',
  // Ruby
  '.rb',
  // C/C++
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx',
  // .NET
  '.cs', '.vb',
  // PHP / Dart
  '.php', '.dart',
];

/**
 * Source-file extensions the SCIP indexers we shell out to don't natively
 * include. Walking these from disk supplements the `documents` table.
 */
export const AUXILIARY_EXTENSIONS: readonly string[] = ['.vue'];

/**
 * Directories that never contain project source. Skipped during disk
 * walks. Owned here so every consumer agrees.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'target', 'dist', 'build',
  '.next', '.nuxt', '.cache', '.turbo', 'out', 'coverage',
  '.scipquery-cache', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode',
]);

export interface SourceFilesetOptions {
  /** Include indexed files (the SCIP `documents` table). Default true. */
  includeIndexed?: boolean;
  /** Include on-disk source files of unindexed types like `.vue`. Default true. */
  includeAuxiliary?: boolean;
  /**
   * Restrict to these extensions. Default: every supported source extension.
   * Pass an explicit list when a query only cares about, say, JS/TS.
   */
  extensions?: readonly string[];
}

/**
 * Project source fileset. Returns relative-to-projectRoot paths the
 * caller can pass to source-text or AST helpers.
 *
 * Cached per (db, options-shape). The cache is keyed on a stable
 * stringification of the options so repeated calls with the same
 * filter share the result.
 */
export function getSourceFiles(
  db: ScipDatabase,
  opts: SourceFilesetOptions = {},
): string[] {
  const includeIndexed = opts.includeIndexed ?? true;
  const includeAuxiliary = opts.includeAuxiliary ?? true;
  const extensions = opts.extensions
    ? new Set(opts.extensions.map((e) => e.toLowerCase()))
    : new Set(ALL_SOURCE_EXTENSIONS.map((e) => e.toLowerCase()));
  const cacheKey = `${includeIndexed ? '1' : '0'}|${includeAuxiliary ? '1' : '0'}|${[...extensions].sort().join(',')}`;
  return SOURCE_FILES_CACHE.get(db, cacheKey, () => {
    const out = new Set<string>();
    if (includeIndexed) {
      const rows = db.all<{ relative_path: string }>(
        `SELECT relative_path
         FROM documents
         WHERE 1 = 1
           ${db.pathExclusionsFor('documents')}`,
      );
      for (const row of rows) {
        if (db.isIgnored(row.relative_path)) continue;
        if (!extensions.has(extname(row.relative_path).toLowerCase())) continue;
        out.add(row.relative_path);
      }
    }
    if (includeAuxiliary) {
      for (const file of listOnDiskSources(db.config.projectRoot, extensions)) {
        if (db.isIgnored(file)) continue;
        out.add(file);
      }
    }
    return [...out].sort();
  });
}

const SOURCE_FILES_CACHE = createPerDbCache<string, string[]>('source-files');

/**
 * Just the auxiliary set — files on disk that match an auxiliary extension
 * (.vue today). Cheaper than getSourceFiles when a caller only needs
 * "what's the unindexed-but-source set?" Cached per DB.
 */
export function getAuxiliarySourceFiles(db: ScipDatabase): string[] {
  return AUX_SOURCE_FILES_CACHE.get(db, () => {
    const ext = new Set(AUXILIARY_EXTENSIONS.map((e) => e.toLowerCase()));
    return [...listOnDiskSources(db.config.projectRoot, ext)]
      .filter((file) => !db.isIgnored(file))
      .sort();
  });
}

const AUX_SOURCE_FILES_CACHE = createPerDbValue<string[]>('aux-source-files');

function listOnDiskSources(absRoot: string, extensions: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const visit = (relDir: string): void => {
    const absDir = relDir ? join(absRoot, relDir) : absRoot;
    let entries: { name: string; isDirectory(): boolean }[] = [];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        visit(relDir ? `${relDir}/${entry.name}` : entry.name);
        continue;
      }
      if (!extensions.has(extname(entry.name).toLowerCase())) continue;
      out.add(relDir ? `${relDir}/${entry.name}` : entry.name);
    }
  };
  visit('');
  return out;
}
