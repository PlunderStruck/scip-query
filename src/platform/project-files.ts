import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  classifyProjectInputPath,
  isLanguageRelevantProjectInputPath,
  type ProjectFileFingerprint,
} from '../domain/project-input.js';
import {
  isPathInsideProject,
  normalizeSafeProjectRelativePath,
  UnsafeProjectPathError,
} from '../domain/path-normalization.js';
import type { SupportedLanguage, TypeScriptProjectMode } from '../domain/types.js';
import { hashFileWithinLimit } from './bounded-file.js';
import {
  projectSnapshotFile,
  projectSnapshotFingerprint,
  projectSnapshotPaths,
  projectSnapshotPathState,
} from './project-snapshot-context.js';

export {
  normalizeSafeProjectRelativePath,
  UnsafeProjectPathError,
  type ProjectFileFailure,
} from '../domain/path-normalization.js';

export const DEFAULT_PROJECT_SOURCE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * A project-file proof identifies one existing regular file whose canonical
 * path is beneath the canonical project root. The canonical containment and
 * file identity make every later source read depend on a checked filesystem
 * referent rather than on repository-controlled path text alone.
 */
export interface ResolvedProjectFile {
  readonly projectRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly device: number;
  readonly inode: number;
}

export class InputTooLargeError extends Error {
  readonly code = 'SCIP_QUERY_INPUT_TOO_LARGE';

  // scip-query: ignore-similar — typed boundary errors intentionally share
  // Error initialization shape; their fields and callers enforce different contracts.
  constructor(
    readonly inputKind: string,
    readonly inputPath: string,
    readonly observedBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `${inputKind} ${JSON.stringify(inputPath)} is ${observedBytes} bytes; ` +
        `the safety limit is ${limitBytes} bytes`,
    );
    this.name = 'InputTooLargeError';
  }
}

export interface ProjectFileReadOptions {
  maxBytes?: number;
  inputKind?: string;
}

export interface ProjectInputFingerprint {
  version: 2;
  languages: SupportedLanguage[];
  pnpmWorkspaces: boolean;
  typescriptProjectMode: TypeScriptProjectMode;
  typescriptProjects: string[];
  clojureConfigPath?: string;
  files: ProjectFileFingerprint[];
}

// scip-query: ignore-stale — reviewed S1 owned contract; these options define project-input fingerprint policy.
export interface ProjectInputFingerprintOptions {
  pnpmWorkspaces?: boolean;
  typescriptProjectMode?: TypeScriptProjectMode;
  typescriptProjects?: readonly string[];
  clojureConfigPath?: string;
}

export type ProjectInputFingerprintConfiguration = Omit<ProjectInputFingerprint, 'files'>;

/**
 * Dedupe, trim, and sort a `typescript.projects` config list — shared by the
 * fingerprint builder and the freshness check so a re-ordered or
 * whitespace-padded config never registers as a fingerprint change.
 */
export function normalizeTypeScriptProjects(projects: readonly string[] | undefined): string[] {
  return [...new Set((projects ?? []).map((project) => project.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function resolveProjectFile(
  projectRoot: string,
  candidatePath: string,
  opts: ProjectFileReadOptions = {},
): ResolvedProjectFile {
  const relativePath = normalizeSafeProjectRelativePath(candidatePath);
  const canonicalProjectRoot = realpathSync(projectRoot);
  const joinedPath = resolve(canonicalProjectRoot, ...relativePath.split('/'));
  if (!isPathInsideProject(canonicalProjectRoot, joinedPath) || joinedPath === canonicalProjectRoot) {
    throw new UnsafeProjectPathError(candidatePath, 'outside-project');
  }

  const absolutePath = realpathSync(joinedPath);
  if (!isPathInsideProject(canonicalProjectRoot, absolutePath) || absolutePath === canonicalProjectRoot) {
    throw new UnsafeProjectPathError(candidatePath, 'outside-project');
  }

  const stat = lstatSync(absolutePath);
  if (!stat.isFile()) {
    throw new UnsafeProjectPathError(candidatePath, 'not-a-file');
  }
  const resolvedFile = {
    projectRoot: canonicalProjectRoot,
    relativePath,
    absolutePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    device: stat.dev,
    inode: stat.ino,
  };
  const maxBytes = opts.maxBytes ?? DEFAULT_PROJECT_SOURCE_LIMIT_BYTES;
  assertNonNegativeByteLimit(maxBytes);
  if (resolvedFile.size > maxBytes) {
    throw new InputTooLargeError(
      opts.inputKind ?? 'project file',
      resolvedFile.relativePath,
      resolvedFile.size,
      maxBytes,
    );
  }
  return resolvedFile;
}

export function readProjectFile(projectRoot: string, candidatePath: string, opts: ProjectFileReadOptions = {}): Buffer {
  const relativePath = normalizeSafeProjectRelativePath(candidatePath);
  const snapshotState = projectSnapshotPathState(projectRoot, relativePath);
  if (snapshotState) {
    if (snapshotState === 'missing') {
      throw Object.assign(new Error(`Snapshot project file ${JSON.stringify(relativePath)} does not exist.`), {
        code: 'ENOENT',
      });
    }
    const snapshotFile = projectSnapshotFile(projectRoot, relativePath);
    if (!snapshotFile) {
      throw new UnsafeProjectPathError(relativePath, 'changed-during-read');
    }
    const maxBytes = opts.maxBytes ?? DEFAULT_PROJECT_SOURCE_LIMIT_BYTES;
    assertNonNegativeByteLimit(maxBytes);
    if (snapshotFile.size > maxBytes) {
      throw new InputTooLargeError(opts.inputKind ?? 'project file', relativePath, snapshotFile.size, maxBytes);
    }
    return Buffer.from(snapshotFile.content);
  }
  const resolvedFile = resolveProjectFile(projectRoot, candidatePath, opts);
  const maxBytes = opts.maxBytes ?? DEFAULT_PROJECT_SOURCE_LIMIT_BYTES;

  const descriptor = openSync(resolvedFile.absolutePath, 'r');
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.dev !== resolvedFile.device ||
      before.ino !== resolvedFile.inode ||
      before.size !== resolvedFile.size
    ) {
      throw new UnsafeProjectPathError(candidatePath, 'changed-during-read');
    }
    if (before.size > maxBytes) {
      throw new InputTooLargeError(opts.inputKind ?? 'project file', resolvedFile.relativePath, before.size, maxBytes);
    }

    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      content.byteLength !== before.size
    ) {
      throw new UnsafeProjectPathError(candidatePath, 'changed-during-read');
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

export function readProjectFileText(
  projectRoot: string,
  candidatePath: string,
  opts: ProjectFileReadOptions = {},
): string {
  return readProjectFile(projectRoot, candidatePath, opts).toString('utf8');
}

export function isMissingProjectFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

export function projectFileExists(projectRoot: string, candidatePath: string): boolean {
  try {
    resolveProjectFile(projectRoot, candidatePath);
    return true;
  } catch (error) {
    if (isMissingProjectFileError(error)) return false;
    throw error;
  }
}

function assertNonNegativeByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative safe integer; received ${maxBytes}`);
  }
}

export function listProjectFiles(projectRoot: string): string[] {
  return (
    projectSnapshotPaths(projectRoot) ??
    listGitProjectFiles(projectRoot) ??
    listFilesystemProjectFiles(projectRoot)
  )
    .filter((file) => file && !isProjectArtifactPath(file))
    .sort();
}

export function fingerprintProjectFiles(
  projectRoot: string,
  opts: {
    language?: SupportedLanguage;
    markerFiles?: readonly string[];
    includePath?: (relativePath: string) => boolean;
    includePaths?: readonly string[];
  } = {},
): ProjectFileFingerprint[] {
  const explicitlyIncluded = (opts.includePaths ?? []).map(normalizeSafeProjectRelativePath);
  const files = [...new Set([...listProjectFiles(projectRoot), ...explicitlyIncluded])]
    .filter((path) => !isProjectArtifactPath(path))
    .filter((path) => !opts.language || isLanguageRelevantProjectInputPath(path, opts.language, opts.markerFiles))
    .filter((path) => !opts.includePath || opts.includePath(path))
    .sort();
  const canonicalProjectRoot = realpathSync(projectRoot);
  return files.map((relativePath) => {
    const snapshotFingerprint = projectSnapshotFingerprint(projectRoot, relativePath);
    if (snapshotFingerprint) {
      return {
        path: relativePath,
        size: snapshotFingerprint.fingerprintSize ?? snapshotFingerprint.size,
        hash: snapshotFingerprint.sha256,
      };
    }
    if (projectSnapshotPathState(projectRoot, relativePath) === 'present') {
      const snapshotFile = projectSnapshotFile(projectRoot, relativePath);
      if (snapshotFile) {
        return {
          path: relativePath,
          size: snapshotFile.fingerprintSize ?? snapshotFile.size,
          hash: snapshotFile.sha256,
        };
      }
    }
    const absPath = join(projectRoot, relativePath);
    try {
      if (lstatSync(absPath).isSymbolicLink()) {
        const targetPath = realpathSync(absPath);
        const relativeTarget = relative(canonicalProjectRoot, targetPath);
        if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
          throw new Error('external symlink');
        }
        const target = readlinkSync(absPath);
        return {
          path: relativePath,
          size: Buffer.byteLength(target),
          hash: createHash('sha256').update('symlink\0').update(target).digest('hex'),
        };
      }
      const hash = createHash('sha256');
      const size = hashFileWithinLimit(
        absPath,
        { inputKind: 'project fingerprint input', maxBytes: DEFAULT_PROJECT_SOURCE_LIMIT_BYTES },
        (chunk) => hash.update(chunk),
      );
      return {
        path: relativePath,
        size,
        hash: hash.digest('hex'),
      };
    } catch {
      return {
        path: relativePath,
        size: -1,
        hash: 'unreadable',
      };
    }
  });
}

export function buildProjectInputFingerprint(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  opts: ProjectInputFingerprintOptions,
): ProjectInputFingerprint {
  const configuration = normalizeProjectInputFingerprintConfiguration(languages, opts);
  const configuredMarkerFiles = [
    ...configuration.typescriptProjects,
    ...(configuration.clojureConfigPath ? [configuration.clojureConfigPath] : []),
  ];
  return {
    ...configuration,
    files: fingerprintProjectFiles(projectRoot, {
      includePath: (path) => classifyProjectInputPath(path, languages, configuredMarkerFiles) !== 'other',
      includePaths: configuredMarkerFiles,
    }),
  };
}

/**
 * The non-file part of a project fingerprint identifies the indexer contract
 * under which source bytes are interpreted. Shared-baseline lookup uses this
 * projection because a dirty worktree's bytes intentionally differ from its
 * committed baseline while its indexer contract must remain exact.
 */
export function normalizeProjectInputFingerprintConfiguration(
  languages: readonly SupportedLanguage[],
  opts: ProjectInputFingerprintOptions,
): ProjectInputFingerprintConfiguration {
  return {
    version: 2,
    languages: [...languages].sort(),
    pnpmWorkspaces: opts.typescriptProjectMode !== 'workspace' && opts.pnpmWorkspaces === true,
    typescriptProjectMode: opts.typescriptProjectMode ?? 'single',
    typescriptProjects: normalizeTypeScriptProjects(opts.typescriptProjects),
    clojureConfigPath: normalizeOptionalPath(opts.clojureConfigPath),
  };
}

function normalizeOptionalPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed || undefined;
}

function listGitProjectFiles(projectRoot: string): string[] | null {
  try {
    return execFileSync('git', ['-C', projectRoot, 'ls-files', '-co', '--exclude-standard', '--', '.'], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      killSignal: 'SIGKILL',
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function listFilesystemProjectFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir ? join(projectRoot, relDir) : projectRoot;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relativePath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isProjectArtifactPath(relativePath)) {
          stack.push(relativePath);
        }
        continue;
      }
      files.push(relativePath);
    }
  }
  return files;
}

function isProjectArtifactPath(relativePath: string): boolean {
  const parts = relativePath.split('/');
  return (
    relativePath === 'meta.json' ||
    (parts[0] === '.scipquery' &&
      (parts[1] === 'events' || parts[1] === 'ledger' || parts[1] === 'releases' || parts[1] === 'suppressions')) ||
    parts.some((part) => PROJECT_ARTIFACT_DIRS.has(part)) ||
    relativePath.endsWith('.db') ||
    relativePath.endsWith('.db-wal') ||
    relativePath.endsWith('.db-shm') ||
    relativePath.endsWith('.scip')
  );
}

const PROJECT_ARTIFACT_DIRS = new Set([
  '.git',
  'node_modules',
  '.scipquery-cache',
  '.scipquery-generations',
  '.stryker-tmp',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'target',
]);
