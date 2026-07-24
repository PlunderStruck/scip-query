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
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type * as TypeScriptModule from 'typescript';
import type { ScipDatabase } from '../storage/db.js';
import { sha256Hex } from '../storage/evidence-cache.js';
import { createPerDbCache, createPerDbValue } from '../storage/per-db-cache.js';
import { indexedDocumentPaths } from '../storage/scip-documents.js';
import { normalizePathSeparators as normalizePath } from '../domain/path-normalization.js';
import { discoverWorkspacePackages, type WorkspacePackage } from '../platform/workspace-packages.js';

export { normalizePath };

// Derived from the read-only index — valid for the connection's lifetime.
const INDEXED_PATH_CACHE = createPerDbValue<Set<string>>('indexed-paths', { clearGroups: [] });
const INDEXED_PATH_DIGEST_CACHE = createPerDbValue<string>('indexed-path-digest', { clearGroups: [] });

// tsconfig `compilerOptions.paths` alias resolution for bare-specifier JS/TS
// imports (e.g. `@/features/x` -> `./src/features/x`). Keyed by the
// importer's directory so repeated imports from the same directory reuse one
// upward tsconfig walk. Filesystem-derived, stable for the db connection's
// lifetime — same invalidation posture as INDEXED_PATH_CACHE above.
const TSCONFIG_ALIAS_CONFIG_CACHE = createPerDbCache<string, TsconfigAliasConfig | null>('tsconfig-alias-config', {
  clearGroups: ['whole-project'],
});
const TSCONFIG_ALIAS_DIR_CACHE = createPerDbCache<string, TsconfigAliasConfig | null>('tsconfig-alias-config-for-dir', {
  clearGroups: ['whole-project'],
});

// tsconfig.json files routinely use comments/trailing commas (JSONC) and
// `extends` chains; the `typescript` package is the one parser that already
// handles both correctly, so it's used here instead of a hand-rolled parser.
// `typescript` is an optional runtime capability elsewhere in this codebase
// (see semantic/typescript) — load it the same defensive way so a project
// without it installed still resolves relative imports normally.
const require = createRequire(import.meta.url);
let typeScriptModule: typeof TypeScriptModule | null | undefined;

function loadTypeScriptForPathAliases(): typeof TypeScriptModule | null {
  if (typeScriptModule !== undefined) return typeScriptModule;
  try {
    typeScriptModule = require('typescript') as typeof TypeScriptModule;
  } catch {
    typeScriptModule = null;
  }
  return typeScriptModule;
}

interface TsconfigAliasConfig {
  baseUrl: string;
  paths: Readonly<Record<string, readonly string[]>>;
}

const TSCONFIG_ALIAS_CANDIDATE_NAMES = [
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'tsconfig.base.json',
];

// Workspace-package (`@scope/pkg`, `@scope/pkg/subpath`) specifier
// resolution for pnpm/npm/yarn monorepos. Project-wide (unlike the tsconfig
// alias cache above, package names are unique across the whole workspace,
// not per-directory), so one discovery pass per db connection is enough.
const WORKSPACE_PACKAGES_CACHE = createPerDbValue<readonly WorkspacePackage[]>('workspace-packages', {
  clearGroups: ['whole-project'],
});

// Source-extension families. The language-parser registry imports these
// constants too, so adding an extension changes resolution and parser dispatch
// from one source of truth.
export const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'] as const;
export const PYTHON_EXTENSIONS = ['.py', '.pyi'] as const;
export const JVM_EXTENSIONS = ['.java', '.scala', '.kt', '.kts'] as const;
export const RUST_EXTENSIONS = ['.rs'] as const;
export const RUBY_EXTENSIONS = ['.rb'] as const;
export const C_LIKE_EXTENSIONS = ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'] as const;
export const DOTNET_EXTENSIONS = ['.cs', '.vb'] as const;
export const DART_EXTENSIONS = ['.dart'] as const;
export const PHP_EXTENSIONS = ['.php'] as const;
export const CLOJURE_EXTENSIONS = ['.clj', '.cljs', '.cljc'] as const;

const JS_EXTENSION_SET = new Set<string>(JS_EXTENSIONS);
const PYTHON_EXTENSION_SET = new Set<string>(PYTHON_EXTENSIONS);
const JVM_EXTENSION_SET = new Set<string>(JVM_EXTENSIONS);
const RUST_EXTENSION_SET = new Set<string>(RUST_EXTENSIONS);
const RUBY_EXTENSION_SET = new Set<string>(RUBY_EXTENSIONS);
const C_LIKE_EXTENSION_SET = new Set<string>(C_LIKE_EXTENSIONS);
const DOTNET_EXTENSION_SET = new Set<string>(DOTNET_EXTENSIONS);
const DART_EXTENSION_SET = new Set<string>(DART_EXTENSIONS);
const PHP_EXTENSION_SET = new Set<string>(PHP_EXTENSIONS);
const CLOJURE_EXTENSION_SET = new Set<string>(CLOJURE_EXTENSIONS);

const LANGUAGE_EXTENSION_FAMILIES: ReadonlyArray<{
  extensions: readonly string[];
  lookup: ReadonlySet<string>;
}> = [
  { extensions: JS_EXTENSIONS, lookup: JS_EXTENSION_SET },
  { extensions: PYTHON_EXTENSIONS, lookup: PYTHON_EXTENSION_SET },
  { extensions: JVM_EXTENSIONS, lookup: JVM_EXTENSION_SET },
  { extensions: RUST_EXTENSIONS, lookup: RUST_EXTENSION_SET },
  { extensions: RUBY_EXTENSIONS, lookup: RUBY_EXTENSION_SET },
  { extensions: C_LIKE_EXTENSIONS, lookup: C_LIKE_EXTENSION_SET },
  { extensions: DOTNET_EXTENSIONS, lookup: DOTNET_EXTENSION_SET },
  { extensions: DART_EXTENSIONS, lookup: DART_EXTENSION_SET },
  { extensions: PHP_EXTENSIONS, lookup: PHP_EXTENSION_SET },
  { extensions: CLOJURE_EXTENSIONS, lookup: CLOJURE_EXTENSION_SET },
];

function hasExtensionIn(relativePath: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(extname(relativePath).toLowerCase());
}

export function isPythonSourcePath(relativePath: string): boolean {
  return hasExtensionIn(relativePath, PYTHON_EXTENSION_SET);
}
export function isJvmSourcePath(relativePath: string): boolean {
  return hasExtensionIn(relativePath, JVM_EXTENSION_SET);
}
export function isRustSourcePath(relativePath: string): boolean {
  return hasExtensionIn(relativePath, RUST_EXTENSION_SET);
}
export function isRubySourcePath(relativePath: string): boolean {
  return hasExtensionIn(relativePath, RUBY_EXTENSION_SET);
}
export function isCLikeSourcePath(relativePath: string): boolean {
  return hasExtensionIn(relativePath, C_LIKE_EXTENSION_SET);
}
export function isDotNetSourcePath(relativePath: string): boolean {
  return hasExtensionIn(relativePath, DOTNET_EXTENSION_SET);
}
export function isVisualBasicSourcePath(relativePath: string): boolean {
  return extname(relativePath).toLowerCase() === '.vb';
}
export function isDartSourcePath(relativePath: string): boolean {
  return hasExtensionIn(relativePath, DART_EXTENSION_SET);
}
export function isPhpSourcePath(relativePath: string): boolean {
  return hasExtensionIn(relativePath, PHP_EXTENSION_SET);
}
export function isClojureSourcePath(relativePath: string): boolean {
  return hasExtensionIn(relativePath, CLOJURE_EXTENSION_SET);
}

// scip-query: ignore-wrapper — public predicate naming the family-for-extension
// concept; called from utils.ts which uses it across many call sites.
export function extensionFamilyFor(relativePath: string): readonly string[] {
  const ext = extname(relativePath).toLowerCase();
  for (const family of LANGUAGE_EXTENSION_FAMILIES) {
    if (family.lookup.has(ext)) return family.extensions;
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
export function resolveImportPath(db: ScipDatabase, importerPath: string, specifier: string): string | null {
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

  if (isClojureSourcePath(importerPath)) {
    return resolveClojureImportPath(db, specifier);
  }

  return resolveJavaScriptImportPath(db, importerPath, specifier);
}

// scip-query: ignore-extract — this is the JavaScript import-path decision
// table: path aliases, package names, relative candidates, indexed paths, and
// disk fallback are tried in priority order.
export function resolveJavaScriptImportPath(db: ScipDatabase, importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return resolveTsconfigPathAliasImport(db, importerPath, specifier) ?? resolveWorkspacePackageImport(db, specifier);
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

/**
 * Bare-specifier imports (`@/foo`, `~/bar`) aren't relative and aren't npm
 * package names either when a tsconfig `paths` alias maps them onto the
 * project's own source tree. Without this, every consumer that only reaches
 * a symbol through a path-aliased `import` (type-only or not) resolves to no
 * import edge at all, which starves the source-fallback reference-counting
 * layer (dead/isolated/new-dead/production-callables/stale-abstractions all
 * go through `sourceImportPathsByLocalName` -> `resolveImportPath`) of the
 * only evidence it has left when scip-typescript itself emits zero
 * occurrences for a whole-statement `import type { ... }` clause.
 */
function resolveTsconfigPathAliasImport(db: ScipDatabase, importerPath: string, specifier: string): string | null {
  const config = tsconfigAliasConfigForImporter(db, importerPath);
  if (!config) return null;

  const indexedPaths = getIndexedPaths(db);
  for (const target of matchTsconfigPathAlias(config, specifier)) {
    const absolute = resolve(config.baseUrl, target);
    for (const candidate of candidateImportPaths(absolute)) {
      const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
      if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
        return relativeCandidate;
      }
    }
  }

  return null;
}

function matchTsconfigPathAlias(config: TsconfigAliasConfig, specifier: string): string[] {
  const targets: string[] = [];
  for (const [pattern, patternTargets] of Object.entries(config.paths)) {
    const starIndex = pattern.indexOf('*');
    if (starIndex === -1) {
      if (specifier !== pattern) continue;
      targets.push(...patternTargets);
      continue;
    }

    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (specifier.length < prefix.length + suffix.length) continue;
    const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const patternTarget of patternTargets) {
      targets.push(patternTarget.includes('*') ? patternTarget.replace('*', wildcard) : patternTarget);
    }
  }
  return targets;
}

/**
 * `@scope/pkg` / `@scope/pkg/subpath` specifiers in a pnpm/npm/yarn
 * workspace resolve at runtime through `node_modules` symlinks into a
 * built `dist/` the package's own `package.json` `exports` map points at —
 * which not only isn't indexed (dist output is conventionally excluded)
 * but frequently doesn't exist yet in a freshly cloned, unbuilt repo. The
 * source-level answer this resolver needs is the *source* file the built
 * output was compiled from, so an `exports` target under `dist/` is
 * remapped onto the equivalent `src/` path (the universal 1:1 build-output
 * convention); when a package declares no matching `exports` entry at all,
 * `src/<subpath>` / `src/<subpath>/index` are tried directly as a
 * best-effort fallback.
 */
function resolveWorkspacePackageImport(db: ScipDatabase, specifier: string): string | null {
  const match = matchWorkspacePackage(workspacePackagesFor(db), specifier);
  if (!match) return null;

  const indexedPaths = getIndexedPaths(db);
  for (const target of workspacePackageImportCandidates(match)) {
    const absolute = resolve(db.config.projectRoot, match.pkg.relativeDir, target);
    for (const candidate of candidateImportPaths(absolute)) {
      const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
      if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
        return relativeCandidate;
      }
    }
  }

  return null;
}

function workspacePackagesFor(db: ScipDatabase): readonly WorkspacePackage[] {
  return WORKSPACE_PACKAGES_CACHE.get(db, () => discoverWorkspacePackages(db.config.projectRoot));
}

interface WorkspacePackageMatch {
  pkg: WorkspacePackage;
  /** Specifier text after `<package name>/`, or '' for the package root. */
  subpath: string;
}

function matchWorkspacePackage(packages: readonly WorkspacePackage[], specifier: string): WorkspacePackageMatch | null {
  let best: WorkspacePackageMatch | null = null;
  for (const pkg of packages) {
    let subpath: string | null = null;
    if (specifier === pkg.name) subpath = '';
    else if (specifier.startsWith(`${pkg.name}/`)) subpath = specifier.slice(pkg.name.length + 1);
    if (subpath === null) continue;
    if (!best || pkg.name.length > best.pkg.name.length) best = { pkg, subpath };
  }
  return best;
}

function workspacePackageImportCandidates(match: WorkspacePackageMatch): string[] {
  const candidates: string[] = [];
  const exportsTarget = exportsTargetForSubpath(match.pkg.exports, match.subpath);
  if (exportsTarget) {
    const srcCandidate = distTargetToSrcCandidate(exportsTarget);
    if (srcCandidate) candidates.push(srcCandidate);
  }
  candidates.push(match.subpath ? `src/${match.subpath}` : 'src/index');
  return candidates;
}

function exportsTargetForSubpath(exportsField: unknown, subpath: string): string | null {
  if (!exportsField || typeof exportsField !== 'object') return null;
  const key = subpath === '' ? '.' : `./${subpath}`;
  return firstStringConditionTarget((exportsField as Record<string, unknown>)[key]);
}

function firstStringConditionTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const condition of ['types', 'import', 'default', 'require', 'node']) {
    const target = firstStringConditionTarget(record[condition]);
    if (target) return target;
  }
  return null;
}

function distTargetToSrcCandidate(target: string): string | null {
  const normalized = target.replace(/^\.\//, '');
  return normalized.startsWith('dist/') ? `src/${normalized.slice('dist/'.length)}` : null;
}

// scip-query: ignore-wrapper — importer-directory cache key layer sits on
// top of the tsconfig-content cache so re-parsing the same tsconfig once per
// directory it governs doesn't repeat the upward filesystem walk.
function tsconfigAliasConfigForImporter(db: ScipDatabase, importerPath: string): TsconfigAliasConfig | null {
  const importerDir = normalizePath(dirname(importerPath));
  return TSCONFIG_ALIAS_DIR_CACHE.get(db, importerDir, () => findTsconfigAliasConfig(db, importerDir));
}

function findTsconfigAliasConfig(db: ScipDatabase, importerDir: string): TsconfigAliasConfig | null {
  const ts = loadTypeScriptForPathAliases();
  if (!ts) return null;

  const root = resolve(db.config.projectRoot);
  let current = resolve(root, importerDir);

  while (current === root || current.startsWith(root + sep)) {
    for (const name of TSCONFIG_ALIAS_CANDIDATE_NAMES) {
      const candidate = join(current, name);
      if (!existsSync(candidate)) continue;
      const config = TSCONFIG_ALIAS_CONFIG_CACHE.get(db, candidate, () => parseTsconfigAliasConfig(ts, candidate));
      // A tsconfig with no `paths` (e.g. a solution-style shell that only
      // `references` other configs) can't answer this alias — keep checking
      // the other candidate names at this same directory level before
      // walking up, so a shell `tsconfig.json` doesn't shadow the sibling
      // `tsconfig.app.json` that actually declares the alias.
      if (config) return config;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function parseTsconfigAliasConfig(ts: typeof TypeScriptModule, tsconfigPath: string): TsconfigAliasConfig | null {
  try {
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.error || !read.config) return null;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath));
    const paths = parsed.options.paths;
    if (!paths || Object.keys(paths).length === 0) return null;
    const baseUrl = parsed.options.baseUrl
      ? resolve(dirname(tsconfigPath), parsed.options.baseUrl)
      : dirname(tsconfigPath);
    return { baseUrl, paths };
  } catch {
    return null;
  }
}

// scip-query: ignore-extract — this is the Python import-path decision table:
// direct module candidates, package __init__ candidates, and indexed-path
// fallback are ordered from most to least specific.
export function resolvePythonImportPath(db: ScipDatabase, importerPath: string, specifier: string): string | null {
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

    basePath = remainder ? resolve(baseDir, remainder.replace(/\./g, '/')) : baseDir;
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

export function resolveRustImportPath(db: ScipDatabase, importerPath: string, specifier: string): string | null {
  if (!specifier) return null;
  const normalizedSpecifier = specifier.replace(/\s+as\s+.+$/, '').trim();
  if (
    !normalizedSpecifier.startsWith('crate::') &&
    !normalizedSpecifier.startsWith('self::') &&
    !normalizedSpecifier.startsWith('super::')
  ) {
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

export function resolveRubyImportPath(db: ScipDatabase, importerPath: string, specifier: string): string | null {
  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const absolute = resolve(importerDir, specifier);
  return firstIndexedOrExistingPath(db, rubyCandidateImportPaths(absolute));
}

export function resolveCLikeImportPath(db: ScipDatabase, importerPath: string, specifier: string): string | null {
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
  const normalized = specifier
    .replace(/\\/g, '.')
    .replace(/::/g, '.')
    .replace(/^global::/, '');
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
    .filter((relativePath) => relativePath.includes(`/${pathified}/`) || relativePath.includes(`/${basenameOnly}/`))
    .sort((left, right) => left.localeCompare(right));
  if (folderMatches.length === 1) {
    return folderMatches[0]!;
  }

  return null;
}

// scip-query: ignore-extract — this is the Dart import-path decision table:
// package, relative, and indexed-path candidates are intentionally tried in a
// single priority order.
export function resolveDartImportPath(db: ScipDatabase, importerPath: string, specifier: string): string | null {
  const indexedPaths = getIndexedPaths(db);
  if (specifier.startsWith('package:')) {
    const withoutScheme = specifier.slice('package:'.length);
    const slashIndex = withoutScheme.indexOf('/');
    if (slashIndex < 0) return null;
    const packageRelative = withoutScheme.slice(slashIndex + 1);
    const candidate = normalizePath(packageRelative.startsWith('lib/') ? packageRelative : `lib/${packageRelative}`);
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

export function resolveClojureImportPath(db: ScipDatabase, specifier: string): string | null {
  const normalized = specifier.replace(/-/g, '_').replace(/\./g, '/');
  const indexedPaths = getIndexedPaths(db);

  for (const ext of CLOJURE_EXTENSIONS) {
    const exactSuffix = `${normalized}${ext}`;
    const exact = [...indexedPaths].find((relativePath) => relativePath.endsWith(exactSuffix));
    if (exact) return exact;
  }

  for (const ext of CLOJURE_EXTENSIONS) {
    const basenameMatch = [...indexedPaths].find(
      (relativePath) => basename(relativePath) === `${normalized.split('/').pop()}${ext}`,
    );
    if (basenameMatch) return basenameMatch;
  }

  return null;
}

function pythonCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (PYTHON_EXTENSION_SET.has(ext)) {
    return [basePath];
  }

  return [`${basePath}.py`, `${basePath}.pyi`, join(basePath, '__init__.py'), join(basePath, '__init__.pyi')];
}

function firstIndexedOrExistingPath(db: ScipDatabase, candidates: readonly string[]): string | null {
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
  if (RUST_EXTENSION_SET.has(ext)) {
    return [basePath];
  }

  return [`${basePath}.rs`, join(basePath, 'mod.rs')];
}

function rubyCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (RUBY_EXTENSION_SET.has(ext)) {
    return [basePath];
  }

  return [`${basePath}.rb`, join(basePath, 'index.rb')];
}

function dartCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (DART_EXTENSION_SET.has(ext)) {
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
  return INDEXED_PATH_CACHE.get(
    db,
    () => new Set(indexedDocumentPaths(db, { includeIgnored: false }).map(normalizePath)),
  );
}

export function importResolutionFingerprint(db: ScipDatabase): string {
  return INDEXED_PATH_DIGEST_CACHE.get(db, () => sha256Hex([...getIndexedPaths(db)].sort().join('\n')));
}
