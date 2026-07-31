import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { matchesPathGlob } from '../domain/path-glob.js';
import { classifyProjectInputPath, type ProjectInputSnapshot } from '../domain/project-input.js';
import { stableJson } from '../domain/stable-json.js';
import type { ProjectConfig, SupportedLanguage } from '../domain/types.js';
import { readFileWithinLimit, SOURCE_ARTIFACT_MAX_BYTES } from '../filesystem/bounded-file.js';
import type { GitWorktreeContext } from './git-worktree.js';
import { buildProjectInputFingerprint } from './project-files.js';
import { type ProjectSnapshotFile, withProjectSnapshot } from './project-snapshot-context.js';

export const REPOSITORY_CONTENT_SNAPSHOT_VERSION = 1;
export const REPOSITORY_SNAPSHOT_TOTAL_LIMIT_BYTES = 512 * 1024 * 1024;

export interface RepositoryContentSnapshotEntry {
  path: string;
  kind: 'file' | 'symlink' | 'deleted';
  executable?: boolean;
  size?: number;
  sha256?: string;
}

export interface RepositoryContentSnapshot {
  version: typeof REPOSITORY_CONTENT_SNAPSHOT_VERSION;
  base?: {
    kind: 'git-tree';
    objectFormat: 'sha1' | 'sha256';
    treeOid: string;
  };
  files: readonly RepositoryContentSnapshotEntry[];
}

export interface ProjectObservationSnapshot {
  projectRoot: string;
  capturedAt: string;
  repositoryContent: RepositoryContentSnapshot;
  indexInputs: ProjectInputSnapshot;
  paths: readonly string[];
  files: Map<string, ProjectSnapshotFile>;
  missing: ReadonlySet<string>;
  fingerprints: Map<string, Pick<ProjectSnapshotFile, 'size' | 'sha256' | 'fingerprintSize'>>;
  readBaseFile?(relativePath: string): ProjectSnapshotFile | undefined;
  gitContext?: GitWorktreeContext;
  dispose(): void;
}

interface SourceIdentity {
  path: string;
  device: number;
  inode: number;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
  oid: string;
}

interface ProjectObservationSnapshotHooks {
  beforeValidation?(): void;
}

export function captureProjectObservationSnapshot(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  config: ProjectConfig,
  gitContext?: GitWorktreeContext,
  knownIndexInputs?: ProjectInputSnapshot,
  hooks?: ProjectObservationSnapshotHooks,
): ProjectObservationSnapshot {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const declaredInputPaths = configuredInputPaths(config);
  const captured =
    gitContext?.headCommit && gitContext.treeOid
      ? captureGitOverlaySnapshot(
          canonicalProjectRoot,
          gitContext.headCommit,
          gitContext.treeOid,
          gitContext.clean,
          config.docs?.snapshotPaths ?? [],
          declaredInputPaths,
          hooks,
        )
      : captureWholeFilesystemSnapshot(
          canonicalProjectRoot,
          config.docs?.snapshotPaths ?? [],
          declaredInputPaths,
          hooks,
        );
  const indexInputs =
    knownIndexInputs ?? buildIndexInputsFromActiveSnapshot(canonicalProjectRoot, languages, config, captured);
  verifyKnownIndexInputs(indexInputs, captured, languages, config);
  for (const file of indexInputs.files) {
    captured.fingerprints.set(file.path, {
      size: file.size,
      sha256: file.hash,
    });
  }

  let disposed = false;
  return {
    projectRoot: canonicalProjectRoot,
    capturedAt: new Date().toISOString(),
    repositoryContent: captured.repositoryContent,
    indexInputs,
    paths: captured.paths,
    files: captured.files,
    missing: captured.missing,
    fingerprints: captured.fingerprints,
    ...(captured.readBaseFile ? { readBaseFile: captured.readBaseFile } : {}),
    ...(gitContext ? { gitContext } : {}),
    dispose() {
      if (disposed) return;
      disposed = true;
      captured.files.clear();
    },
  };
}

export function canonicalRepositoryContentSnapshot(snapshot: RepositoryContentSnapshot): string {
  return stableJson({
    version: snapshot.version,
    ...(snapshot.base ? { base: snapshot.base } : {}),
    files: [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path)),
  });
}

export function canonicalProjectInputSnapshot(snapshot: ProjectInputSnapshot): string {
  return JSON.stringify({
    ...(snapshot.clojureConfigPath ? { clojureConfigPath: snapshot.clojureConfigPath } : {}),
    files: [...snapshot.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ hash: file.hash, path: file.path, size: file.size })),
    languages: [...snapshot.languages].sort(),
    pnpmWorkspaces: snapshot.pnpmWorkspaces,
    typescriptProjectMode: snapshot.typescriptProjectMode,
    typescriptProjects: [...snapshot.typescriptProjects].sort(),
    version: snapshot.version,
  });
}

function captureGitOverlaySnapshot(
  projectRoot: string,
  headCommit: string,
  treeOid: string,
  initiallyClean: boolean,
  snapshotPaths: readonly string[],
  declaredInputPaths: readonly string[],
  hooks?: ProjectObservationSnapshotHooks,
): Omit<ProjectObservationSnapshot, 'projectRoot' | 'capturedAt' | 'indexInputs' | 'gitContext' | 'dispose'> {
  const baseEntries = gitTreeEntries(projectRoot, headCommit).filter(
    (entry) =>
      !isExcludedObservationArtifact(entry.path) &&
      !snapshotPaths.some((pattern) => matchesPathGlob(pattern, entry.path)),
  );
  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const firstChangedPaths = [
    ...(initiallyClean ? [] : gitChangedAndUntrackedPaths(projectRoot)),
    ...declaredInputPaths.filter((path) => !baseByPath.has(path)),
  ].filter(
    (path) => !isExcludedObservationArtifact(path) && !snapshotPaths.some((pattern) => matchesPathGlob(pattern, path)),
  );
  const changedPaths = [...new Set(firstChangedPaths)].sort();
  const files = new Map<string, ProjectSnapshotFile>();
  const missing = new Set<string>();
  const fingerprints = new Map<string, Pick<ProjectSnapshotFile, 'size' | 'sha256' | 'fingerprintSize'>>();
  const contentEntries: RepositoryContentSnapshotEntry[] = [];
  const sourceIdentities: SourceIdentity[] = [];
  let totalBytes = 0;

  for (const relativePath of changedPaths) {
    const sourcePath = join(projectRoot, relativePath);
    let before: Stats;
    try {
      before = lstatSync(sourcePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        missing.add(relativePath);
        contentEntries.push({ path: relativePath, kind: 'deleted' });
        continue;
      }
      throw error;
    }
    const identity = sourceIdentity(relativePath, before);
    sourceIdentities.push(identity);
    const captured = captureSourceFile(projectRoot, relativePath, before);
    totalBytes = addSnapshotBytes(totalBytes, captured.file.content.byteLength);
    files.set(relativePath, captured.file);
    fingerprints.set(relativePath, captured.file);
    contentEntries.push(captured.entry);
    assertSourceIdentity(sourcePath, identity);
  }

  hooks?.beforeValidation?.();
  const finalChangedPaths = [
    ...gitChangedAndUntrackedPaths(projectRoot),
    ...declaredInputPaths.filter((path) => !baseByPath.has(path)),
  ]
    .filter(
      (path) =>
        !isExcludedObservationArtifact(path) && !snapshotPaths.some((pattern) => matchesPathGlob(pattern, path)),
    )
    .sort();
  if (!samePaths(changedPaths, [...new Set(finalChangedPaths)].sort())) {
    throw new Error('Repository change set moved while the fixed observation snapshot was captured.');
  }
  for (const identity of sourceIdentities) {
    assertSourceIdentity(join(projectRoot, identity.path), identity);
  }
  const [finalHead, finalTree] = gitLines(projectRoot, ['rev-parse', 'HEAD', 'HEAD^{tree}']);
  if (finalHead !== headCommit || finalTree !== treeOid) {
    throw new Error('Repository HEAD moved while the fixed observation snapshot was captured.');
  }

  const paths = [
    ...new Set([...baseEntries.map((entry) => entry.path).filter((path) => !missing.has(path)), ...files.keys()]),
  ].sort();
  const readBaseFile = fixedGitFileReader(projectRoot, baseByPath, paths, files, missing);
  return {
    repositoryContent: {
      version: REPOSITORY_CONTENT_SNAPSHOT_VERSION,
      base: {
        kind: 'git-tree',
        objectFormat: treeOid.length === 64 ? 'sha256' : 'sha1',
        treeOid,
      },
      files: contentEntries,
    },
    paths,
    files,
    missing,
    fingerprints,
    readBaseFile,
  };
}

function captureWholeFilesystemSnapshot(
  projectRoot: string,
  snapshotPaths: readonly string[],
  declaredInputPaths: readonly string[],
  hooks?: ProjectObservationSnapshotHooks,
): Omit<ProjectObservationSnapshot, 'projectRoot' | 'capturedAt' | 'indexInputs' | 'gitContext' | 'dispose'> {
  const sourceFiles = [...new Set([...listFilesystemRepositoryContentFiles(projectRoot), ...declaredInputPaths])]
    .filter((path) => !isExcludedObservationArtifact(path))
    .filter((path) => !snapshotPaths.some((pattern) => matchesPathGlob(pattern, path)))
    .sort();
  const sourceIdentities: SourceIdentity[] = [];
  const files = new Map<string, ProjectSnapshotFile>();
  const missing = new Set<string>();
  const fingerprints = new Map<string, Pick<ProjectSnapshotFile, 'size' | 'sha256' | 'fingerprintSize'>>();
  const contentEntries: RepositoryContentSnapshotEntry[] = [];
  let totalBytes = 0;
  for (const relativePath of sourceFiles) {
    const sourcePath = join(projectRoot, relativePath);
    let before: Stats;
    try {
      before = lstatSync(sourcePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        missing.add(relativePath);
        contentEntries.push({ path: relativePath, kind: 'deleted' });
        continue;
      }
      throw error;
    }
    const identity = sourceIdentity(relativePath, before);
    sourceIdentities.push(identity);
    const captured = captureSourceFile(projectRoot, relativePath, before);
    totalBytes = addSnapshotBytes(totalBytes, captured.file.content.byteLength);
    files.set(relativePath, captured.file);
    fingerprints.set(relativePath, captured.file);
    contentEntries.push(captured.entry);
    assertSourceIdentity(sourcePath, identity);
  }
  hooks?.beforeValidation?.();
  const finalFiles = [...new Set([...listFilesystemRepositoryContentFiles(projectRoot), ...declaredInputPaths])]
    .filter((path) => !isExcludedObservationArtifact(path))
    .filter((path) => !snapshotPaths.some((pattern) => matchesPathGlob(pattern, path)))
    .sort();
  if (!samePaths(sourceFiles, finalFiles)) {
    throw new Error('Repository file set changed while the fixed observation snapshot was captured.');
  }
  for (const identity of sourceIdentities) assertSourceIdentity(join(projectRoot, identity.path), identity);
  return {
    repositoryContent: {
      version: REPOSITORY_CONTENT_SNAPSHOT_VERSION,
      files: contentEntries,
    },
    paths: sourceFiles.filter((path) => !missing.has(path)),
    files,
    missing,
    fingerprints,
  };
}

function captureSourceFile(
  projectRoot: string,
  relativePath: string,
  stat: Stats,
): { file: ProjectSnapshotFile; entry: RepositoryContentSnapshotEntry } {
  const sourcePath = join(projectRoot, relativePath);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(sourcePath);
    if (!safeSnapshotSymlink(projectRoot, sourcePath, target)) {
      throw new Error(`Repository snapshot cannot follow external symlink ${JSON.stringify(relativePath)}.`);
    }
    const content = readFileWithinLimit(realpathSync(sourcePath), {
      inputKind: 'fixed repository snapshot symlink target',
      maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
    });
    const sha256 = createHash('sha256').update('symlink\0').update(target).digest('hex');
    return {
      file: {
        relativePath,
        content,
        size: content.byteLength,
        fingerprintSize: Buffer.byteLength(target),
        sha256,
      },
      entry: {
        path: relativePath,
        kind: 'symlink',
        executable: false,
        size: Buffer.byteLength(target),
        sha256,
      },
    };
  }
  if (!stat.isFile()) {
    throw new Error(`Repository snapshot does not support non-file input ${JSON.stringify(relativePath)}.`);
  }
  const content = readFileWithinLimit(sourcePath, {
    inputKind: 'fixed repository snapshot file',
    maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
  });
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    file: { relativePath, content, size: content.byteLength, sha256 },
    entry: {
      path: relativePath,
      kind: 'file',
      executable: (stat.mode & 0o111) !== 0,
      size: content.byteLength,
      sha256,
    },
  };
}

function buildIndexInputsFromActiveSnapshot(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  config: ProjectConfig,
  snapshot: Omit<ProjectObservationSnapshot, 'projectRoot' | 'capturedAt' | 'indexInputs' | 'gitContext' | 'dispose'>,
): ProjectInputSnapshot {
  return withProjectSnapshot({ projectRoot, ...snapshot }, () =>
    buildProjectInputFingerprint(projectRoot, languages, {
      pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces,
      typescriptProjectMode: config.indexer?.typescript?.projectMode,
      typescriptProjects: config.indexer?.typescript?.projects,
      clojureConfigPath: config.indexer?.clojure?.configPath,
    }),
  );
}

function verifyKnownIndexInputs(
  snapshot: ProjectInputSnapshot,
  captured: Omit<ProjectObservationSnapshot, 'projectRoot' | 'capturedAt' | 'indexInputs' | 'gitContext' | 'dispose'>,
  languages: readonly SupportedLanguage[],
  config: ProjectConfig,
): void {
  const expectedByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const configuredMarkerFiles = [
    ...(config.indexer?.typescript?.projects ?? []),
    ...(config.indexer?.clojure?.configPath ? [config.indexer.clojure.configPath] : []),
  ];
  for (const path of new Set([...captured.files.keys(), ...captured.missing])) {
    if (classifyProjectInputPath(path, languages, configuredMarkerFiles) === 'other') continue;
    const expected = expectedByPath.get(path);
    const observed = captured.fingerprints.get(path) ?? captured.files.get(path);
    if (
      captured.missing.has(path)
        ? expected !== undefined
        : !expected ||
          !observed ||
          expected.size !== (observed.fingerprintSize ?? observed.size) ||
          expected.hash !== observed.sha256
    ) {
      throw new Error(`Index-input fingerprint changed before fixed snapshot capture at ${JSON.stringify(path)}.`);
    }
  }
}

function fixedGitFileReader(
  projectRoot: string,
  baseEntries: ReadonlyMap<string, GitTreeEntry>,
  paths: readonly string[],
  files: Map<string, ProjectSnapshotFile>,
  missing: ReadonlySet<string>,
): (relativePath: string) => ProjectSnapshotFile | undefined {
  const pathSet = new Set(paths);
  const read = (relativePath: string, seen: Set<string>): ProjectSnapshotFile | undefined => {
    if (!pathSet.has(relativePath) || missing.has(relativePath)) return undefined;
    const overlay = files.get(relativePath);
    if (overlay) return overlay;
    if (seen.has(relativePath)) return undefined;
    seen.add(relativePath);
    const entry = baseEntries.get(relativePath);
    if (!entry || entry.type !== 'blob') return undefined;
    const blob = gitBuffer(projectRoot, ['cat-file', 'blob', entry.oid]);
    if (entry.mode === '120000') {
      const target = blob.toString('utf8');
      const targetPath = posix.normalize(posix.join(posix.dirname(relativePath), target));
      if (targetPath === '..' || targetPath.startsWith('../') || isAbsolute(targetPath)) return undefined;
      const targetFile = read(targetPath, seen);
      if (!targetFile) return undefined;
      return {
        relativePath,
        content: Buffer.from(targetFile.content),
        size: targetFile.content.byteLength,
        fingerprintSize: Buffer.byteLength(target),
        sha256: createHash('sha256').update('symlink\0').update(target).digest('hex'),
      };
    }
    if (blob.byteLength > SOURCE_ARTIFACT_MAX_BYTES) return undefined;
    return {
      relativePath,
      content: blob,
      size: blob.byteLength,
      sha256: createHash('sha256').update(blob).digest('hex'),
    };
  };
  return (relativePath) => read(relativePath, new Set());
}

function gitTreeEntries(projectRoot: string, commit: string): GitTreeEntry[] {
  const output = gitBuffer(projectRoot, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8');
  return output
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf('\t');
      const header = row.slice(0, tab).split(' ');
      if (tab < 0 || header.length !== 3) throw new Error('Git returned malformed fixed-snapshot tree data.');
      return { mode: header[0]!, type: header[1]!, oid: header[2]!, path: row.slice(tab + 1) };
    });
}

function gitChangedAndUntrackedPaths(projectRoot: string): string[] {
  return gitBuffer(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      if (record.length < 4 || record[2] !== ' ') {
        throw new Error('Git returned malformed fixed-snapshot status data.');
      }
      return record.slice(3);
    });
}

function gitLines(projectRoot: string, args: readonly string[]): string[] {
  return gitBuffer(projectRoot, args).toString('utf8').trim().split('\n');
}

function gitBuffer(projectRoot: string, args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', projectRoot, ...args], {
    maxBuffer: SOURCE_ARTIFACT_MAX_BYTES + 1,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
}

function listFilesystemRepositoryContentFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const stack = [''];
  while (stack.length > 0) {
    const relativeDirectory = stack.pop()!;
    const absoluteDirectory = relativeDirectory ? join(projectRoot, relativeDirectory) : projectRoot;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(absoluteDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (isExcludedObservationArtifact(relativePath)) continue;
      if (entry.isDirectory()) stack.push(relativePath);
      else files.push(relativePath);
    }
  }
  return files;
}

function isExcludedObservationArtifact(relativePath: string): boolean {
  const parts = relativePath.split('/');
  if (
    parts[0] === '.git' ||
    parts[0] === 'node_modules' ||
    parts[0] === '.scipquery-cache' ||
    parts[0] === '.scipquery-generations' ||
    parts[0] === 'dist' ||
    parts[0] === 'build' ||
    parts[0] === 'coverage' ||
    parts[0] === 'target'
  ) {
    return true;
  }
  if (parts[0] === '.scipquery' && (parts[1] === 'events' || parts[1] === 'ledger' || parts[1] === 'releases')) {
    return true;
  }
  return (
    relativePath === 'meta.json' ||
    relativePath.endsWith('.db') ||
    relativePath.endsWith('.db-wal') ||
    relativePath.endsWith('.db-shm') ||
    relativePath.endsWith('.scip')
  );
}

function safeSnapshotSymlink(projectRoot: string, sourcePath: string, target: string): boolean {
  try {
    const absoluteTarget = isAbsolute(target) ? target : resolve(dirname(sourcePath), target);
    const canonicalTarget = realpathSync(absoluteTarget);
    const relativeTarget = relative(projectRoot, canonicalTarget);
    return relativeTarget !== '..' && !relativeTarget.startsWith(`..${sep}`) && !isAbsolute(relativeTarget);
  } catch {
    return false;
  }
}

function sourceIdentity(path: string, stat: Stats): SourceIdentity {
  return {
    path,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function assertSourceIdentity(path: string, expected: SourceIdentity): void {
  const observed = lstatSync(path);
  if (
    observed.dev !== expected.device ||
    observed.ino !== expected.inode ||
    observed.size !== expected.size ||
    observed.mode !== expected.mode ||
    observed.mtimeMs !== expected.mtimeMs ||
    observed.ctimeMs !== expected.ctimeMs
  ) {
    throw new Error(`Repository input ${JSON.stringify(expected.path)} changed during snapshot capture.`);
  }
}

function addSnapshotBytes(current: number, added: number): number {
  const total = current + added;
  if (!Number.isSafeInteger(total) || total > REPOSITORY_SNAPSHOT_TOTAL_LIMIT_BYTES) {
    throw new Error(
      `Fixed repository snapshot exceeds its ${REPOSITORY_SNAPSHOT_TOTAL_LIMIT_BYTES}-byte memory limit.`,
    );
  }
  return total;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function configuredInputPaths(config: ProjectConfig): string[] {
  const candidates = [
    ...(config.indexer?.typescript?.projects ?? []),
    ...(config.indexer?.clojure?.configPath ? [config.indexer.clojure.configPath] : []),
  ];
  return [...new Set(candidates.map((path) => normalizeConfiguredInputPath(path)).filter(Boolean))].sort();
}

function normalizeConfiguredInputPath(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/');
  if (normalized.length === 0 || normalized.includes('*') || normalized.endsWith('/') || normalized.startsWith('/')) {
    return '';
  }
  const parts = normalized.split('/');
  return parts.some((part) => part === '' || part === '.' || part === '..') ? '' : normalized;
}
