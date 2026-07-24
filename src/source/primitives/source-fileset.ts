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
import { execFileSync } from 'node:child_process';
import { extname, join } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';

/**
 * The complete set of source-file extensions scip-query knows how to
 * scan. Includes every language with a per-language parser plus
 * extensions like `.vue` that aren't indexed by SCIP indexers.
 */
export const ALL_SOURCE_EXTENSIONS: readonly string[] = [
  // JS/TS family
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  // Vue SFCs
  '.vue',
  // Other AST-supported languages
  '.rs',
  '.py',
  '.pyi',
  // JVM
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.sc',
  // Clojure
  '.clj',
  '.cljs',
  '.cljc',
  // Ruby
  '.rb',
  // C/C++
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.hh',
  '.hxx',
  // .NET
  '.cs',
  '.vb',
  // PHP / Dart
  '.php',
  '.dart',
];

/**
 * Source-file extensions the SCIP indexers we shell out to don't natively
 * include. Walking these from disk supplements the `documents` table.
 */
export const AUXILIARY_EXTENSIONS: readonly string[] = ['.vue'];
const REACT_SOURCE_EXTENSIONS: readonly string[] = ['.tsx', '.jsx'];
const VUE_SOURCE_EXTENSIONS: readonly string[] = ['.vue'];
const FRAMEWORK_SOURCE_EXTENSIONS: readonly string[] = [...REACT_SOURCE_EXTENSIONS, ...VUE_SOURCE_EXTENSIONS];
const REACT_SOURCE_EXTENSION_SET: ReadonlySet<string> = new Set(REACT_SOURCE_EXTENSIONS);
const VUE_SOURCE_EXTENSION_SET: ReadonlySet<string> = new Set(VUE_SOURCE_EXTENSIONS);
const DEFAULT_EXTENSION_SET: ReadonlySet<string> = new Set(ALL_SOURCE_EXTENSIONS.map((e) => e.toLowerCase()));
const DEFAULT_EXTENSION_CACHE_KEY = [...DEFAULT_EXTENSION_SET].sort().join(',');

/**
 * Directories that never contain project source. Skipped during disk
 * walks. Owned here so every consumer agrees.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.nbb',
  '.cpcache',
  '.shadow-cljs',
  'out',
  'coverage',
  '.scipquery-cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
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
// scip-query: ignore-extract — this is the canonical source-file set builder:
// indexed documents, on-disk fallback files, ignore rules, and extension
// filtering must agree for every source-scanning query.
export function getSourceFiles(db: ScipDatabase, opts: SourceFilesetOptions = {}): string[] {
  const includeIndexed = opts.includeIndexed ?? true;
  const includeAuxiliary = opts.includeAuxiliary ?? true;
  const customExtensions = opts.extensions?.map((e) => e.toLowerCase());
  const extensions = customExtensions ? new Set(customExtensions) : DEFAULT_EXTENSION_SET;
  const extensionKey = customExtensions ? [...extensions].sort().join(',') : DEFAULT_EXTENSION_CACHE_KEY;
  const cacheKey = `${includeIndexed ? '1' : '0'}|${includeAuxiliary ? '1' : '0'}|${extensionKey}`;
  return SOURCE_FILES_CACHE.get(db, cacheKey, () => {
    const out = new Set<string>();
    if (includeIndexed) {
      for (const relativePath of indexedDocumentPaths(db, { includeIgnored: false })) {
        if (!extensions.has(extname(relativePath).toLowerCase())) continue;
        out.add(relativePath);
      }
    }
    if (includeAuxiliary) {
      for (const file of listProjectSources(db.config.projectRoot, extensions)) {
        if (db.isIgnored(file)) continue;
        if (includeIndexed && out.has(file)) continue;
        out.add(file);
      }
    }
    return [...out].sort();
  });
}

export function sourceFrameworkApplicability(db: ScipDatabase, opts: { scope?: string } = {}) {
  let react = false;
  let vue = false;
  for (const file of getSourceFiles(db, { extensions: FRAMEWORK_SOURCE_EXTENSIONS })) {
    if (opts.scope && !file.includes(opts.scope)) continue;
    const extension = extname(file).toLowerCase();
    react ||= REACT_SOURCE_EXTENSION_SET.has(extension);
    vue ||= VUE_SOURCE_EXTENSION_SET.has(extension);
    if (react && vue) break;
  }
  return { react, vue };
}

// Derived from the read-only index — valid for the connection's lifetime.
const SOURCE_FILES_CACHE = createPerDbCache<string, string[]>('source-files', { clearGroups: [] });

function listProjectSources(absRoot: string, extensions: ReadonlySet<string>): Set<string> {
  return listGitSources(absRoot, extensions) ?? listOnDiskSources(absRoot, extensions);
}

function listGitSources(absRoot: string, extensions: ReadonlySet<string>): Set<string> | null {
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: absRoot,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out = new Set<string>();
    for (const line of output.split('\n')) {
      const file = line.trim();
      if (!file) continue;
      if (hasSkippedSegment(file)) continue;
      if (!extensions.has(extname(file).toLowerCase())) continue;
      out.add(file);
    }
    return out;
  } catch {
    return null;
  }
}

function hasSkippedSegment(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => SKIP_DIRS.has(segment));
}

function listOnDiskSources(absRoot: string, extensions: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const visit = (relDir: string): void => {
    const absDir = relDir ? join(absRoot, relDir) : absRoot;
    let entries: { name: string; isDirectory(): boolean }[];
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
