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
): ProjectInputPathKind {
  const basename = relativePath.split('/').at(-1) ?? relativePath;
  if (
    COMMON_INDEX_INPUTS.has(basename) ||
    basename === '.scipquery.json' ||
    /^tsconfig(?:\..+)?\.json$/.test(basename)
  ) {
    return 'config';
  }
  if (/\.d\.(?:ts|mts|cts)$/.test(relativePath.toLowerCase())) return 'ambient';
  const extension = relativePath.includes('.') ? `.${relativePath.split('.').at(-1)!.toLowerCase()}` : '';
  if (languages.some((language) => (LANGUAGE_SOURCE_EXTENSIONS[language] ?? []).includes(extension))) return 'source';
  return 'other';
}

export function isLanguageRelevantProjectInputPath(
  relativePath: string,
  language: SupportedLanguage,
  markerFiles: readonly string[] | undefined,
): boolean {
  const basename = relativePath.split('/').at(-1) ?? relativePath;
  if (markerFiles?.includes(relativePath) || markerFiles?.includes(basename)) return true;
  if (
    COMMON_INDEX_INPUTS.has(basename) ||
    basename === '.scipquery.json' ||
    /^tsconfig(?:\..+)?\.json$/.test(basename)
  ) {
    return true;
  }
  const extension = relativePath.includes('.') ? `.${relativePath.split('.').at(-1)!.toLowerCase()}` : '';
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

const COMMON_INDEX_INPUTS = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  'tsconfig.base.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'build.sbt',
  'compile_commands.json',
  'CMakeLists.txt',
  'Makefile',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
  'pubspec.yaml',
  'pubspec.lock',
  'deps.edn',
  'project.clj',
  'bb.edn',
  'shadow-cljs.edn',
]);

const LANGUAGE_SOURCE_EXTENSIONS: Record<SupportedLanguage, readonly string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
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
