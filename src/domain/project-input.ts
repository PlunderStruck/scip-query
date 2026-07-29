import type { SupportedLanguage } from './types.js';

export interface ProjectFileFingerprint {
  path: string;
  size: number;
  hash: string;
}

export interface ProjectInputSnapshot {
  version: number;
  languages: readonly SupportedLanguage[];
  pnpmWorkspaces: boolean;
  typescriptProjectMode: string;
  typescriptProjects: readonly string[];
  clojureConfigPath?: string;
  files: readonly ProjectFileFingerprint[];
}

export type ProjectInputPathKind = 'source' | 'ambient' | 'config' | 'other';

interface ProjectFileChangeBase {
  path: string;
  inputKind: ProjectInputPathKind;
}

export interface AddedProjectFileChange extends ProjectFileChangeBase {
  kind: 'added';
  after: ProjectFileFingerprint;
}

export interface ModifiedProjectFileChange extends ProjectFileChangeBase {
  kind: 'modified';
  before: ProjectFileFingerprint;
  after: ProjectFileFingerprint;
}

export interface DeletedProjectFileChange extends ProjectFileChangeBase {
  kind: 'deleted';
  before: ProjectFileFingerprint;
}

export type ProjectFileChange = AddedProjectFileChange | ModifiedProjectFileChange | DeletedProjectFileChange;

export type ProjectChangeUncertainty =
  | 'prior-snapshot-unavailable'
  | 'snapshot-version-changed'
  | 'duplicate-input-path'
  | 'unreadable-input';

export interface ProjectChangeManifest {
  version: 1;
  changes: ProjectFileChange[];
  projectIdentityChanged: boolean;
  uncertainty: ProjectChangeUncertainty[];
}

export type FileDependencyGraph = ReadonlyMap<string, ReadonlySet<string>>;

export function classifyProjectInputPath(
  relativePath: string,
  languages: readonly SupportedLanguage[],
  configuredMarkerFiles: readonly string[] = [],
): ProjectInputPathKind {
  const normalizedPath = normalizeProjectInputPath(relativePath);
  if (
    SHARED_INDEX_INPUTS.has(normalizedPath) ||
    configuredMarkerFiles.some((marker) => matchesProjectInputMarker(normalizedPath, marker)) ||
    languages.some((language) => isLanguageConfigurationInputPath(normalizedPath, language))
  ) {
    return 'config';
  }
  if (languages.some(isTypeScriptFamilyLanguage) && /\.d\.(?:ts|mts|cts)$/.test(normalizedPath.toLowerCase())) {
    return 'ambient';
  }
  const extension = projectInputExtension(normalizedPath);
  if (languages.some((language) => (LANGUAGE_SOURCE_EXTENSIONS[language] ?? []).includes(extension))) return 'source';
  return 'other';
}

export function isLanguageRelevantProjectInputPath(
  relativePath: string,
  language: SupportedLanguage,
  markerFiles: readonly string[] | undefined,
): boolean {
  const normalizedPath = normalizeProjectInputPath(relativePath);
  if (SHARED_INDEX_INPUTS.has(normalizedPath)) return true;
  if (markerFiles?.some((marker) => matchesProjectInputMarker(normalizedPath, marker))) return true;
  if (isLanguageConfigurationInputPath(normalizedPath, language)) return true;
  if (isTypeScriptFamilyLanguage(language) && /\.d\.(?:ts|mts|cts)$/.test(normalizedPath.toLowerCase())) return true;
  const extension = projectInputExtension(normalizedPath);
  return (LANGUAGE_SOURCE_EXTENSIONS[language] ?? []).includes(extension);
}

export function projectInputSnapshotOrNull(value: unknown): ProjectInputSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot['version'] !== 'number') return null;
  if (!isStringArray(snapshot['languages'])) return null;
  if (typeof snapshot['pnpmWorkspaces'] !== 'boolean') return null;
  if (typeof snapshot['typescriptProjectMode'] !== 'string') return null;
  if (!isStringArray(snapshot['typescriptProjects'])) return null;
  if (snapshot['clojureConfigPath'] !== undefined && typeof snapshot['clojureConfigPath'] !== 'string') return null;
  if (!Array.isArray(snapshot['files']) || !snapshot['files'].every(isProjectFileFingerprint)) return null;

  return snapshot as unknown as ProjectInputSnapshot;
}

export function buildProjectChangeManifest(
  previous: ProjectInputSnapshot | null,
  current: ProjectInputSnapshot,
): ProjectChangeManifest {
  const previousFiles = new Map((previous?.files ?? []).map((file) => [file.path, file]));
  const currentFiles = new Map(current.files.map((file) => [file.path, file]));
  const paths = new Set([...previousFiles.keys(), ...currentFiles.keys()]);
  const changes: ProjectFileChange[] = [];

  for (const path of [...paths].sort()) {
    const before = previousFiles.get(path);
    const after = currentFiles.get(path);
    const inputKind = classifyProjectInputPath(path, current.languages);
    if (!before && after) {
      changes.push({ kind: 'added', path, inputKind, after });
    } else if (before && !after) {
      changes.push({ kind: 'deleted', path, inputKind, before });
    } else if (before && after && (before.hash !== after.hash || before.size !== after.size)) {
      changes.push({ kind: 'modified', path, inputKind, before, after });
    }
  }

  const uncertainty = new Set<ProjectChangeUncertainty>();
  if (!previous) uncertainty.add('prior-snapshot-unavailable');
  if (previous && previous.version !== current.version) uncertainty.add('snapshot-version-changed');
  if (hasDuplicatePaths(previous?.files ?? []) || hasDuplicatePaths(current.files)) {
    uncertainty.add('duplicate-input-path');
  }
  if ([...(previous?.files ?? []), ...current.files].some(isUnreadableFingerprint)) {
    uncertainty.add('unreadable-input');
  }

  return {
    version: 1,
    changes,
    projectIdentityChanged: previous ? !sameProjectIdentity(previous, current) : true,
    uncertainty: [...uncertainty].sort(),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function hasDuplicatePaths(files: readonly ProjectFileFingerprint[]): boolean {
  return new Set(files.map((file) => file.path)).size !== files.length;
}

export function isProjectFileFingerprint(value: unknown): value is ProjectFileFingerprint {
  if (typeof value !== 'object' || value === null) return false;
  const fingerprint = value as Record<string, unknown>;
  return (
    typeof fingerprint['path'] === 'string' &&
    typeof fingerprint['size'] === 'number' &&
    Number.isFinite(fingerprint['size']) &&
    typeof fingerprint['hash'] === 'string'
  );
}

function isUnreadableFingerprint(file: ProjectFileFingerprint): boolean {
  return file.hash === 'unreadable' || file.size < 0;
}

function sameProjectIdentity(left: ProjectInputSnapshot, right: ProjectInputSnapshot): boolean {
  return (
    sameStrings(left.languages, right.languages) &&
    left.pnpmWorkspaces === right.pnpmWorkspaces &&
    left.typescriptProjectMode === right.typescriptProjectMode &&
    sameStrings(left.typescriptProjects, right.typescriptProjects) &&
    left.clojureConfigPath === right.clojureConfigPath
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

const SHARED_INDEX_INPUTS = new Set(['.scipquery.json']);

/**
 * Files whose presence identifies a language to its indexer. Indexer
 * descriptors reuse this table so language detection and cache invalidation
 * cannot silently assign different meanings to the same marker.
 */
export const LANGUAGE_INDEX_MARKERS = {
  typescript: ['tsconfig.json'],
  javascript: ['package.json'],
  java: ['pom.xml', 'build.gradle'],
  scala: ['build.sbt'],
  kotlin: ['build.gradle.kts'],
  rust: ['Cargo.toml'],
  python: ['pyproject.toml', 'setup.py'],
  ruby: ['Gemfile'],
  go: ['go.mod'],
  cpp: ['CMakeLists.txt', 'Makefile'],
  c: ['CMakeLists.txt', 'Makefile'],
  csharp: ['*.csproj', '*.sln'],
  vb: ['*.vbproj', '*.sln'],
  dart: ['pubspec.yaml'],
  php: ['composer.json'],
  clojure: ['deps.edn', 'project.clj', 'bb.edn', 'shadow-cljs.edn'],
} satisfies Record<SupportedLanguage, readonly string[]>;

const LANGUAGE_ADDITIONAL_INDEX_INPUTS = {
  typescript: [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'tsconfig.*.json',
    'jsconfig.json',
    'jsconfig.*.json',
  ],
  javascript: [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'tsconfig.json',
    'tsconfig.*.json',
    'jsconfig.json',
    'jsconfig.*.json',
  ],
  java: [
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle.properties',
    'gradle.lockfile',
    'gradle-wrapper.properties',
  ],
  scala: ['plugins.sbt', 'build.properties'],
  kotlin: [
    'pom.xml',
    'build.gradle',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle.properties',
    'gradle.lockfile',
    'gradle-wrapper.properties',
  ],
  rust: ['Cargo.lock', 'rust-project.json', 'rust-toolchain', 'rust-toolchain.toml'],
  python: ['setup.cfg', 'requirements*.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'uv.lock'],
  ruby: ['Gemfile.lock', 'gems.locked'],
  go: ['go.sum', 'go.work', 'go.work.sum'],
  cpp: ['compile_commands.json'],
  c: ['compile_commands.json'],
  csharp: [
    'Directory.Build.props',
    'Directory.Build.targets',
    'Directory.Packages.props',
    'packages.lock.json',
    'NuGet.Config',
    'global.json',
  ],
  vb: [
    'Directory.Build.props',
    'Directory.Build.targets',
    'Directory.Packages.props',
    'packages.lock.json',
    'NuGet.Config',
    'global.json',
  ],
  dart: ['pubspec.lock', 'analysis_options.yaml'],
  php: ['composer.lock'],
  clojure: [],
} satisfies Record<SupportedLanguage, readonly string[]>;

const markerPatternCache = new Map<string, RegExp>();

function isLanguageConfigurationInputPath(relativePath: string, language: SupportedLanguage): boolean {
  return (
    LANGUAGE_INDEX_MARKERS[language].some((marker) => matchesProjectInputMarker(relativePath, marker)) ||
    LANGUAGE_ADDITIONAL_INDEX_INPUTS[language].some((marker) => matchesProjectInputMarker(relativePath, marker))
  );
}

function matchesProjectInputMarker(relativePath: string, marker: string): boolean {
  const normalizedMarker = normalizeProjectInputPath(marker).replace(/^\.\//, '');
  if (!normalizedMarker) return false;
  const basename = relativePath.split('/').at(-1) ?? relativePath;
  const candidate = normalizedMarker.includes('/') ? relativePath : basename;
  if (!normalizedMarker.includes('*') && !normalizedMarker.includes('?')) return candidate === normalizedMarker;

  let matcher = markerPatternCache.get(normalizedMarker);
  if (!matcher) {
    const pattern = normalizedMarker
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    matcher = new RegExp(`^${pattern}$`);
    markerPatternCache.set(normalizedMarker, matcher);
  }
  return matcher.test(candidate);
}

function normalizeProjectInputPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function projectInputExtension(relativePath: string): string {
  return relativePath.includes('.') ? `.${relativePath.split('.').at(-1)!.toLowerCase()}` : '';
}

function isTypeScriptFamilyLanguage(language: SupportedLanguage): boolean {
  return language === 'typescript' || language === 'javascript';
}

const LANGUAGE_SOURCE_EXTENSIONS: Record<SupportedLanguage, readonly string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '.vue'],
  java: ['.java'],
  scala: ['.scala'],
  kotlin: ['.kt', '.kts'],
  rust: ['.rs'],
  python: ['.py', '.pyi'],
  ruby: ['.rb'],
  go: ['.go'],
  cpp: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
  c: ['.c', '.h'],
  csharp: ['.cs'],
  vb: ['.vb'],
  dart: ['.dart'],
  php: ['.php'],
  clojure: ['.clj', '.cljs', '.cljc'],
};
