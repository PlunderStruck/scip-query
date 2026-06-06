/**
 * import-path-resolver — turns a source-level import specifier (e.g.
 * `'./foo'`, `crate::bar::baz`, `App\Foo`) into the project-relative path
 * of the file the index already has indexed. Per-language resolvers are
 * exported individually because each per-language parser knows which one
 * to call; `resolveImportPath` is the dispatcher used by the JS/TS
 * re-export parser and by anyone else who has a specifier but not a
 * known language family.
 *
 * The resolver tries the in-database `documents` table first; when an
 * unindexed file (e.g. a `.vue` file) is referenced via a relative
 * specifier we fall back to checking disk so the import-graph for
 * un-indexable types is still populated.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbValue } from '../storage/per-db-cache.js';

const INDEXED_PATH_CACHE = createPerDbValue<Set<string>>('indexed-paths');

// Source-extension families. Kept in sync with the per-language parser
// extensions list in src/language-parsers/registry.ts. Duplicated here
// because the resolver needs to know "given a path, which extension family
// does it belong to?" without reaching into the parser registry.
export const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'] as const;
export const PYTHON_EXTENSIONS = ['.py', '.pyi'] as const;
export const JVM_EXTENSIONS = ['.java', '.scala', '.kt', '.kts'] as const;
export const RUST_EXTENSIONS = ['.rs'] as const;
export const RUBY_EXTENSIONS = ['.rb'] as const;
export const C_LIKE_EXTENSIONS = ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'] as const;
export const DOTNET_EXTENSIONS = ['.cs', '.vb'] as const;
export const DART_EXTENSIONS = ['.dart'] as const;
export const PHP_EXTENSIONS = ['.php'] as const;

const LANGUAGE_EXTENSION_FAMILIES: ReadonlyArray<readonly string[]> = [
  JS_EXTENSIONS,
  PYTHON_EXTENSIONS,
  JVM_EXTENSIONS,
  RUST_EXTENSIONS,
  RUBY_EXTENSIONS,
  C_LIKE_EXTENSIONS,
  DOTNET_EXTENSIONS,
  DART_EXTENSIONS,
  PHP_EXTENSIONS,
];

function hasExtensionIn(relativePath: string, extensions: readonly string[]): boolean {
  return (extensions as readonly string[]).includes(extname(relativePath).toLowerCase());
}

export function isPythonSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, PYTHON_EXTENSIONS); }
export function isJvmSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, JVM_EXTENSIONS); }
export function isRustSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, RUST_EXTENSIONS); }
export function isRubySourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, RUBY_EXTENSIONS); }
export function isCLikeSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, C_LIKE_EXTENSIONS); }
export function isDotNetSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, DOTNET_EXTENSIONS); }
export function isVisualBasicSourcePath(relativePath: string): boolean { return extname(relativePath).toLowerCase() === '.vb'; }
export function isDartSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, DART_EXTENSIONS); }
export function isPhpSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, PHP_EXTENSIONS); }

// scip-query: ignore-wrapper — public predicate naming the family-for-extension
// concept; called from utils.ts which uses it across many call sites.
export function extensionFamilyFor(relativePath: string): readonly string[] {
  const ext = extname(relativePath).toLowerCase();
  for (const family of LANGUAGE_EXTENSION_FAMILIES) {
    if ((family as readonly string[]).includes(ext)) return family;
  }
  return JS_EXTENSIONS;
}

function isQualifiedDotImportPath(path: string): boolean {
  return isJvmSourcePath(path) || isDotNetSourcePath(path) || isPhpSourcePath(path);
}

/**
 * Top-level dispatcher. Routes to the per-language resolver based on the
 * importer file's extension. Returns null when the specifier can't be
 * resolved to an indexed path.
 */
export function resolveImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  if (isPythonSourcePath(importerPath)) {
    return resolvePythonImportPath(db, importerPath, specifier);
  }

  if (isRustSourcePath(importerPath)) {
    return resolveRustImportPath(db, importerPath, specifier);
  }

  if (isRubySourcePath(importerPath)) {
    return resolveRubyImportPath(db, importerPath, specifier);
  }

  if (isCLikeSourcePath(importerPath)) {
    return resolveCLikeImportPath(db, importerPath, specifier);
  }

  if (isQualifiedDotImportPath(importerPath)) {
    return resolveQualifiedImportPath(db, specifier.replace(/\\/g, '.'), extensionFamilyFor(importerPath));
  }

  if (isDartSourcePath(importerPath)) {
    return resolveDartImportPath(db, importerPath, specifier);
  }

  return resolveJavaScriptImportPath(db, importerPath, specifier);
}

// scip-query: ignore-extract — this is the JavaScript import-path decision
// table: path aliases, package names, relative candidates, indexed paths, and
// disk fallback are tried in priority order.
export function resolveJavaScriptImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }

  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const absolute = resolve(importerDir, specifier);
  const indexedPaths = getIndexedPaths(db);

  for (const candidate of candidateImportPaths(absolute)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }

  return normalizePath(relative(db.config.projectRoot, absolute));
}

// scip-query: ignore-extract — this is the Python import-path decision table:
// direct module candidates, package __init__ candidates, and indexed-path
// fallback are ordered from most to least specific.
export function resolvePythonImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  const indexedPaths = getIndexedPaths(db);

  let basePath: string;
  if (specifier.startsWith('.')) {
    const match = specifier.match(/^(\.+)(.*)$/);
    if (!match) return null;

    const dots = match[1]!.length;
    const remainder = match[2]!.replace(/^\./, '');
    let baseDir = dirname(join(db.config.projectRoot, importerPath));

    for (let i = 1; i < dots; i++) {
      baseDir = dirname(baseDir);
    }

    basePath = remainder
      ? resolve(baseDir, remainder.replace(/\./g, '/'))
      : baseDir;
  } else {
    basePath = resolve(db.config.projectRoot, specifier.replace(/\./g, '/'));
  }

  for (const candidate of pythonCandidateImportPaths(basePath)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }

  return null;
}

export function resolveRustImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  if (!specifier) return null;
  const normalizedSpecifier = specifier.replace(/\s+as\s+.+$/, '').trim();
  if (!normalizedSpecifier.startsWith('crate::') && !normalizedSpecifier.startsWith('self::') && !normalizedSpecifier.startsWith('super::')) {
    return null;
  }

  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  let basePath: string;
  if (normalizedSpecifier.startsWith('crate::')) {
    basePath = resolve(db.config.projectRoot, 'src', normalizedSpecifier.slice('crate::'.length).replace(/::/g, '/'));
  } else if (normalizedSpecifier.startsWith('self::')) {
    basePath = resolve(importerDir, normalizedSpecifier.slice('self::'.length).replace(/::/g, '/'));
  } else {
    basePath = resolve(dirname(importerDir), normalizedSpecifier.slice('super::'.length).replace(/::/g, '/'));
  }

  return firstIndexedOrExistingPath(db, rustCandidateImportPaths(basePath));
}

export function resolveRubyImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const absolute = resolve(importerDir, specifier);
  return firstIndexedOrExistingPath(db, rubyCandidateImportPaths(absolute));
}

export function resolveCLikeImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const candidates = [
    resolve(importerDir, specifier),
    resolve(db.config.projectRoot, specifier),
    resolve(db.config.projectRoot, 'include', specifier),
    resolve(db.config.projectRoot, 'src', specifier),
  ];

  return firstIndexedOrExistingPath(db, candidates);
}

export function resolveQualifiedImportPath(
  db: ScipDatabase,
  specifier: string,
  extensions: readonly string[],
): string | null {
  const indexedPaths = getIndexedPaths(db);
  const normalized = specifier.replace(/\\/g, '.').replace(/::/g, '.').replace(/^global::/, '');
  const pathified = normalized.replace(/\./g, '/');
  const basenameOnly = normalized.split('.').pop() ?? normalized;

  for (const ext of extensions) {
    const exactSuffix = `${pathified}${ext}`;
    const exact = [...indexedPaths].find((relativePath) => relativePath.endsWith(exactSuffix));
    if (exact) return exact;
  }

  for (const ext of extensions) {
    const basenameMatch = [...indexedPaths].find((relativePath) => basename(relativePath) === `${basenameOnly}${ext}`);
    if (basenameMatch) return basenameMatch;
  }

  const folderMatches = [...indexedPaths]
    .filter((relativePath) => extensions.includes(extname(relativePath).toLowerCase()))
    .filter((relativePath) => (
      relativePath.includes(`/${pathified}/`)
      || relativePath.includes(`/${basenameOnly}/`)
    ))
    .sort((left, right) => left.localeCompare(right));
  if (folderMatches.length === 1) {
    return folderMatches[0]!;
  }

  return null;
}

// scip-query: ignore-extract — this is the Dart import-path decision table:
// package, relative, and indexed-path candidates are intentionally tried in a
// single priority order.
export function resolveDartImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  const indexedPaths = getIndexedPaths(db);
  if (specifier.startsWith('package:')) {
    const withoutScheme = specifier.slice('package:'.length);
    const slashIndex = withoutScheme.indexOf('/');
    if (slashIndex < 0) return null;
    const packageRelative = withoutScheme.slice(slashIndex + 1);
    const candidate = normalizePath(packageRelative.startsWith('lib/')
      ? packageRelative
      : `lib/${packageRelative}`);
    if (indexedPaths.has(candidate)) return candidate;
    return null;
  }

  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const absolute = resolve(importerDir, specifier);
  for (const candidate of dartCandidateImportPaths(absolute)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }
  return null;
}

function pythonCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (PYTHON_EXTENSIONS.includes(ext as typeof PYTHON_EXTENSIONS[number])) {
    return [basePath];
  }

  return [
    `${basePath}.py`,
    `${basePath}.pyi`,
    join(basePath, '__init__.py'),
    join(basePath, '__init__.pyi'),
  ];
}

function firstIndexedOrExistingPath(
  db: ScipDatabase,
  candidates: readonly string[],
): string | null {
  const indexedPaths = getIndexedPaths(db);
  for (const candidate of candidates) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }
  return null;
}

function rustCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (RUST_EXTENSIONS.includes(ext as typeof RUST_EXTENSIONS[number])) {
    return [basePath];
  }

  return [
    `${basePath}.rs`,
    join(basePath, 'mod.rs'),
  ];
}

function rubyCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (RUBY_EXTENSIONS.includes(ext as typeof RUBY_EXTENSIONS[number])) {
    return [basePath];
  }

  return [
    `${basePath}.rb`,
    join(basePath, 'index.rb'),
  ];
}

function dartCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (DART_EXTENSIONS.includes(ext as typeof DART_EXTENSIONS[number])) {
    return [basePath];
  }

  return [`${basePath}.dart`, basePath];
}

function candidateImportPaths(absolute: string): string[] {
  const ext = extname(absolute);
  const candidates = new Set<string>();

  if (ext) {
    candidates.add(absolute);
    for (const sourceExt of JS_EXTENSIONS) {
      candidates.add(absolute.slice(0, -ext.length) + sourceExt);
    }
  } else {
    for (const sourceExt of JS_EXTENSIONS) {
      candidates.add(`${absolute}${sourceExt}`);
      candidates.add(join(absolute, `index${sourceExt}`));
    }
  }

  return [...candidates];
}

function getIndexedPaths(db: ScipDatabase): Set<string> {
  return INDEXED_PATH_CACHE.get(db, () =>
    new Set(
      db.all<{ relative_path: string }>(
        `SELECT relative_path
         FROM documents
         WHERE 1 = 1
           ${db.pathExclusionsFor('documents')}`,
      )
        .map((row) => normalizePath(row.relative_path))
        .filter((relativePath) => !db.isIgnored(relativePath)),
    ),
  );
}

// scip-query: ignore-wrapper — single line but expresses the project-wide
// "always forward-slash paths" contract; replacing call sites would scatter
// the convention.
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}
