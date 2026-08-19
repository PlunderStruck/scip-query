import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  classifyProjectInputPath,
  isLanguageRelevantProjectInputPath,
  type ProjectFileFingerprint,
  type ProjectInputSnapshot,
} from '../domain/project-input.js';
import type { ProjectInputChangeJournal } from '../domain/project-input-change-journal.js';
import {
  isPathInsideProject,
  normalizeSafeProjectRelativePath,
  UnsafeProjectPathError,
} from '../domain/path-normalization.js';
import type { SupportedLanguage, TypeScriptProjectMode } from '../domain/types.js';
import { assertNonNegativeByteLimit, hashFileWithinLimit } from '../filesystem/bounded-file.js';
import {
  projectSnapshotFile,
  projectSnapshotFingerprint,
  projectSnapshotPaths,
  projectSnapshotPathState,
} from './project-snapshot-context.js';
import { typeScriptProjectInputPaths } from './typescript-projects.js';
import {
  lookupProjectFileFingerprint,
  persistProjectFileFingerprintCache,
  rememberProjectFileFingerprint,
} from './fingerprint-stat-cache.js';
import { cachedProjectFileListing } from './project-file-inventory-context.js';

export {
  normalizeSafeProjectRelativePath,
  UnsafeProjectPathError,
  type ProjectFileFailure,
} from '../domain/path-normalization.js';

export const DEFAULT_PROJECT_SOURCE_LIMIT_BYTES = 64 * 1024 * 1024;
const PROJECT_FILE_PROBE_BUFFER_BYTES = 1024 * 1024;

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

export interface ProjectFileByteProbeOptions extends ProjectFileReadOptions {
  computeSha256?: boolean;
  scratchBuffer?: Buffer;
}

export interface ProjectFileByteProbe {
  byteLength: number;
  isUtf8Text: boolean;
  includesLiteral: boolean;
  bytes: Buffer | null;
  sha256?: string;
}

export interface ProjectFileByteProbeBatch extends Omit<ProjectFileByteProbe, 'includesLiteral'> {
  matchedLiteralIndexes: number[];
}

export interface ProjectInputFingerprint {
  version: 3;
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

export type ProjectInputFingerprintBuild =
  | { mode: 'delta'; fingerprint: ProjectInputFingerprint; changedPaths: string[] }
  | { mode: 'full'; fingerprint: ProjectInputFingerprint; reason: string };

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
    assertResolvedProjectFileIdentity(before, resolvedFile, candidatePath);
    if (before.size > maxBytes) {
      throw new InputTooLargeError(opts.inputKind ?? 'project file', resolvedFile.relativePath, before.size, maxBytes);
    }

    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    assertResolvedProjectFileIdentity(after, resolvedFile, candidatePath);
    if (content.byteLength !== before.size) {
      throw new UnsafeProjectPathError(candidatePath, 'changed-during-read');
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Inspect one project file through the authority boundary while keeping only a
 * fixed-size read buffer. Full bytes are materialized only when the file is
 * UTF-8 text containing the requested literal.
 */
export function probeProjectFileBytes(
  projectRoot: string,
  candidatePath: string,
  literal: Buffer,
  opts: ProjectFileByteProbeOptions = {},
): ProjectFileByteProbe {
  if (literal.byteLength === 0) throw new Error('Project file probe literal must not be empty.');
  const { matchedLiteralIndexes, ...probe } = probeProjectFileBytesForLiterals(
    projectRoot,
    candidatePath,
    [literal],
    opts,
  );
  return { ...probe, includesLiteral: matchedLiteralIndexes.length > 0 };
}

export function probeProjectFileBytesForLiterals(
  projectRoot: string,
  candidatePath: string,
  literals: readonly Buffer[],
  opts: ProjectFileByteProbeOptions = {},
): ProjectFileByteProbeBatch {
  if (literals.length === 0 || literals.some((literal) => literal.byteLength === 0)) {
    throw new Error('Project file probe literals must not be empty.');
  }
  const relativePath = normalizeSafeProjectRelativePath(candidatePath);
  const snapshotState = projectSnapshotPathState(projectRoot, relativePath);
  if (snapshotState) {
    if (snapshotState === 'missing') {
      throw Object.assign(new Error(`Snapshot project file ${JSON.stringify(relativePath)} does not exist.`), {
        code: 'ENOENT',
      });
    }
    const snapshotFile = projectSnapshotFile(projectRoot, relativePath);
    if (!snapshotFile) throw new UnsafeProjectPathError(relativePath, 'changed-during-read');
    const maxBytes = opts.maxBytes ?? DEFAULT_PROJECT_SOURCE_LIMIT_BYTES;
    assertNonNegativeByteLimit(maxBytes);
    if (snapshotFile.size > maxBytes) {
      throw new InputTooLargeError(opts.inputKind ?? 'project file', relativePath, snapshotFile.size, maxBytes);
    }
    const isUtf8Text = !snapshotFile.content.includes(0) && isUtf8(snapshotFile.content);
    const matchedLiteralIndexes = isUtf8Text ? matchingLiteralIndexes(snapshotFile.content, literals) : [];
    return {
      byteLength: snapshotFile.size,
      isUtf8Text,
      matchedLiteralIndexes,
      bytes: matchedLiteralIndexes.length > 0 ? Buffer.from(snapshotFile.content) : null,
      ...(opts.computeSha256 ? { sha256: snapshotFile.sha256 } : {}),
    };
  }

  const resolvedFile = resolveProjectFile(projectRoot, candidatePath, opts);
  const descriptor = openSync(resolvedFile.absolutePath, 'r');
  try {
    const before = fstatSync(descriptor);
    assertResolvedProjectFileIdentity(before, resolvedFile, candidatePath);
    const hash = opts.computeSha256 ? createHash('sha256') : null;
    const scratch = opts.scratchBuffer ?? Buffer.allocUnsafe(PROJECT_FILE_PROBE_BUFFER_BYTES);
    if (scratch.byteLength === 0) throw new Error('Project file probe scratch buffer must not be empty.');
    let offset = 0;
    const includesLiterals = literals.map(() => false);
    let containsNul = false;
    let validUtf8 = true;
    let utf8Carry: Buffer = Buffer.alloc(0);
    const literalTails: Buffer[] = literals.map(() => Buffer.alloc(0));

    while (offset < before.size) {
      const bytesRead = readSync(descriptor, scratch, 0, Math.min(scratch.byteLength, before.size - offset), offset);
      if (bytesRead <= 0) throw new UnsafeProjectPathError(candidatePath, 'changed-during-read');
      const chunk = scratch.subarray(0, bytesRead);
      hash?.update(chunk);
      containsNul ||= chunk.includes(0);
      if (validUtf8) {
        const validationBytes = utf8Carry.byteLength > 0 ? Buffer.concat([utf8Carry, chunk]) : chunk;
        const completePrefixLength = completeUtf8PrefixLength(validationBytes);
        validUtf8 = isUtf8(validationBytes.subarray(0, completePrefixLength));
        utf8Carry = Buffer.from(validationBytes.subarray(completePrefixLength));
      }
      for (let index = 0; index < literals.length; index += 1) {
        if (includesLiterals[index]) continue;
        const literal = literals[index]!;
        const literalTail = literalTails[index]!;
        includesLiterals[index] = chunkIncludesLiteral(chunk, literal, literalTail);
        literalTails[index] = nextLiteralTail(chunk, literal, literalTail);
      }
      offset += bytesRead;
    }

    validUtf8 &&= utf8Carry.byteLength === 0;
    assertResolvedProjectFileIdentity(fstatSync(descriptor), resolvedFile, candidatePath);
    const isUtf8Text = !containsNul && validUtf8;
    const matchedLiteralIndexes = isUtf8Text
      ? includesLiterals.flatMap((matched, index) => (matched ? [index] : []))
      : [];
    let bytes: Buffer | null = null;
    if (matchedLiteralIndexes.length > 0) {
      bytes = Buffer.allocUnsafe(before.size);
      let materialized = 0;
      while (materialized < bytes.byteLength) {
        const bytesRead = readSync(descriptor, bytes, materialized, bytes.byteLength - materialized, materialized);
        if (bytesRead <= 0) throw new UnsafeProjectPathError(candidatePath, 'changed-during-read');
        materialized += bytesRead;
      }
      assertResolvedProjectFileIdentity(fstatSync(descriptor), resolvedFile, candidatePath);
    }
    return {
      byteLength: before.size,
      isUtf8Text,
      matchedLiteralIndexes,
      bytes,
      ...(hash ? { sha256: hash.digest('hex') } : {}),
    };
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

function assertResolvedProjectFileIdentity(
  stat: Stats,
  resolvedFile: ResolvedProjectFile,
  candidatePath: string,
): void {
  if (
    !stat.isFile() ||
    stat.dev !== resolvedFile.device ||
    stat.ino !== resolvedFile.inode ||
    stat.size !== resolvedFile.size
  ) {
    throw new UnsafeProjectPathError(candidatePath, 'changed-during-read');
  }
}

function completeUtf8PrefixLength(bytes: Buffer): number {
  if (bytes.byteLength === 0) return 0;
  let leadIndex = bytes.byteLength - 1;
  let continuationBytes = 0;
  while (leadIndex >= 0 && continuationBytes < 3 && (bytes[leadIndex]! & 0xc0) === 0x80) {
    continuationBytes += 1;
    leadIndex -= 1;
  }
  if (leadIndex < 0) return bytes.byteLength;
  const lead = bytes[leadIndex]!;
  const expectedBytes =
    (lead & 0x80) === 0 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 0;
  return expectedBytes > bytes.byteLength - leadIndex ? leadIndex : bytes.byteLength;
}

function matchingLiteralIndexes(bytes: Buffer, literals: readonly Buffer[]): number[] {
  return literals.flatMap((literal, index) => (bytes.includes(literal) ? [index] : []));
}

function chunkIncludesLiteral(chunk: Buffer, literal: Buffer, previousTail: Buffer): boolean {
  if (chunk.includes(literal)) return true;
  if (previousTail.byteLength === 0 || literal.byteLength === 1) return false;
  const prefix = chunk.subarray(0, Math.min(chunk.byteLength, literal.byteLength - 1));
  return Buffer.concat([previousTail, prefix]).includes(literal);
}

function nextLiteralTail(chunk: Buffer, literal: Buffer, previousTail: Buffer): Buffer {
  const tailBytes = literal.byteLength - 1;
  if (tailBytes === 0) return Buffer.alloc(0);
  if (chunk.byteLength >= tailBytes) return Buffer.from(chunk.subarray(chunk.byteLength - tailBytes));
  const combined = Buffer.concat([previousTail, chunk]);
  return Buffer.from(combined.subarray(Math.max(0, combined.byteLength - tailBytes)));
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

export function listProjectFiles(projectRoot: string): string[] {
  const snapshotPaths = projectSnapshotPaths(projectRoot);
  if (snapshotPaths) return snapshotPaths.filter((file) => file && !isProjectArtifactPath(file)).sort();
  return (listGitProjectFiles(projectRoot) ?? listFilesystemProjectFiles(projectRoot))
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
  const fingerprints = files.flatMap((relativePath) =>
    fingerprintProjectFile(projectRoot, canonicalProjectRoot, relativePath),
  );
  persistProjectFileFingerprintCache(canonicalProjectRoot);
  return fingerprints;
}

function fingerprintProjectFile(
  projectRoot: string,
  canonicalProjectRoot: string,
  relativePath: string,
): ProjectFileFingerprint[] {
  const snapshotFingerprint = projectSnapshotFingerprint(projectRoot, relativePath);
  if (snapshotFingerprint) {
    return [
      {
        path: relativePath,
        size: snapshotFingerprint.fingerprintSize ?? snapshotFingerprint.size,
        hash: snapshotFingerprint.sha256,
      },
    ];
  }
  if (projectSnapshotPathState(projectRoot, relativePath) === 'present') {
    const snapshotFile = projectSnapshotFile(projectRoot, relativePath);
    if (snapshotFile) {
      return [
        {
          path: relativePath,
          size: snapshotFile.fingerprintSize ?? snapshotFile.size,
          hash: snapshotFile.sha256,
        },
      ];
    }
  }
  const absPath = join(projectRoot, relativePath);
  try {
    const stats = lstatSync(absPath);
    if (stats.isSymbolicLink()) {
      const cached = lookupProjectFileFingerprint(
        canonicalProjectRoot,
        relativePath,
        'symlink',
        fileStatIdentity(stats),
      );
      if (cached) return [{ path: relativePath, size: cached.size, hash: cached.hash }];
      const targetPath = realpathSync(absPath);
      const relativeTarget = relative(canonicalProjectRoot, targetPath);
      if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
        throw new Error('external symlink');
      }
      const target = readlinkSync(absPath);
      const hash = createHash('sha256').update('symlink\0').update(target).digest('hex');
      const size = Buffer.byteLength(target);
      rememberProjectFileFingerprint(canonicalProjectRoot, relativePath, 'symlink', fileStatIdentity(stats), {
        hash,
        size,
      });
      return [{ path: relativePath, size, hash }];
    }
    const cached = lookupProjectFileFingerprint(canonicalProjectRoot, relativePath, 'file', fileStatIdentity(stats));
    if (cached) return [{ path: relativePath, size: cached.size, hash: cached.hash }];
    const hash = createHash('sha256');
    const size = hashFileWithinLimit(
      absPath,
      { inputKind: 'project fingerprint input', maxBytes: DEFAULT_PROJECT_SOURCE_LIMIT_BYTES },
      (chunk) => hash.update(chunk),
    );
    const digest = hash.digest('hex');
    rememberProjectFileFingerprint(canonicalProjectRoot, relativePath, 'file', fileStatIdentity(stats), {
      hash: digest,
      size,
    });
    return [{ path: relativePath, size, hash: digest }];
  } catch (error) {
    // `git ls-files` includes tracked paths deleted in the working tree. Their
    // absence is a proved deletion; other I/O failures remain conservative.
    if (isMissingProjectFileError(error)) return [];
    return [{ path: relativePath, size: -1, hash: 'unreadable' }];
  }
}

function fileStatIdentity(stats: Stats): {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
} {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    size: stats.size,
  };
}

export function buildProjectInputFingerprint(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  opts: ProjectInputFingerprintOptions,
): ProjectInputFingerprint {
  const configuration = normalizeProjectInputFingerprintConfiguration(languages, opts);
  const configuredMarkerFiles = [
    ...configuration.typescriptProjects.filter((candidate) => isConfiguredProjectFile(projectRoot, candidate)),
    ...(configuration.clojureConfigPath ? [configuration.clojureConfigPath] : []),
  ];
  const typeScriptInputs = configuration.languages.includes('typescript')
    ? typeScriptProjectInputPaths(projectRoot, configuration.typescriptProjectMode, configuration.typescriptProjects)
    : null;
  return {
    ...configuration,
    files: fingerprintProjectFiles(projectRoot, {
      includePath: (path) => {
        const kind = classifyProjectInputPath(path, languages, configuredMarkerFiles);
        if (kind === 'other') return false;
        if (kind !== 'source' || !isTypeScriptSourcePath(path) || !typeScriptInputs) return true;
        return typeScriptInputs.has(path);
      },
      includePaths: configuredMarkerFiles,
    }),
  };
}

/**
 * A delta fingerprint is the next project-input identity derived from an
 * accepted snapshot by applying only watcher-proved source-file mutations.
 * Configuration and ambient mutations return the ordinary full fingerprint
 * together with the reason that made enumeration necessary.
 */
export function buildProjectInputFingerprintFromJournal(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  opts: ProjectInputFingerprintOptions,
  previous: ProjectInputSnapshot | null,
  journal: ProjectInputChangeJournal | undefined,
  acceptedGeneration: string | null,
): ProjectInputFingerprintBuild {
  const full = (reason: string): ProjectInputFingerprintBuild => ({
    mode: 'full',
    fingerprint: buildProjectInputFingerprint(projectRoot, languages, opts),
    reason,
  });
  if (!journal) return full('change-journal-unavailable');
  if (!journal.complete) return full(`change-journal-incomplete:${journal.incompleteReason ?? 'unknown'}`);
  if (!acceptedGeneration) return full('accepted-generation-unavailable');
  if (journal.baseGeneration !== acceptedGeneration) return full('change-journal-base-mismatch');
  if (!previous) return full('prior-project-input-snapshot-unavailable');

  const configuration = normalizeProjectInputFingerprintConfiguration(languages, opts);
  if (!sameProjectInputConfiguration(previous, configuration)) return full('project-input-configuration-changed');
  if (new Set(previous.files.map((file) => file.path)).size !== previous.files.length) {
    return full('prior-project-input-snapshot-has-duplicate-paths');
  }
  if (journal.entries.length === 0) {
    return {
      mode: 'delta',
      fingerprint: { ...configuration, files: [...previous.files].sort((a, b) => a.path.localeCompare(b.path)) },
      changedPaths: [],
    };
  }

  const configuredMarkerFiles = [
    // Keep configured paths as classification markers even after deletion.
    // Directory-valued project entries cannot collide with a source file below them
    // because marker matching is exact rather than prefix-based.
    ...configuration.typescriptProjects,
    ...(configuration.clojureConfigPath ? [configuration.clojureConfigPath] : []),
  ];
  const previousFiles = new Map(previous.files.map((file) => [file.path, file]));
  for (const entry of journal.entries) {
    const prior = previousFiles.get(entry.path);
    if (classifyProjectInputPath(entry.path, languages, configuredMarkerFiles) !== 'source') {
      return full('non-source-project-input-changed');
    }
    if (entry.kind === 'add' && prior) return full('added-path-already-in-prior-project-input-snapshot');
    if (entry.kind === 'delete' && !prior) return full('deleted-path-not-in-prior-project-input-snapshot');
    if (entry.kind === 'change' && !prior) return full('changed-path-not-in-prior-project-input-snapshot');
    if (prior && (prior.hash === 'unreadable' || prior.size < 0)) return full('changed-path-was-unreadable');
  }

  const canonicalProjectRoot = realpathSync(projectRoot);
  for (const entry of journal.entries) {
    const current = fingerprintProjectFile(projectRoot, canonicalProjectRoot, entry.path);
    if (entry.kind === 'delete') {
      if (current.length !== 0) return full('deleted-source-is-still-readable');
      previousFiles.delete(entry.path);
      continue;
    }
    if (current.length !== 1 || current[0]!.hash === 'unreadable' || current[0]!.size < 0) {
      return full(entry.kind === 'add' ? 'added-source-is-not-readable' : 'changed-source-no-longer-readable');
    }
    previousFiles.set(entry.path, current[0]!);
  }
  persistProjectFileFingerprintCache(canonicalProjectRoot);
  return {
    mode: 'delta',
    fingerprint: { ...configuration, files: [...previousFiles.values()].sort((a, b) => a.path.localeCompare(b.path)) },
    changedPaths: journal.entries.map((entry) => entry.path).sort(),
  };
}

function sameProjectInputConfiguration(
  previous: ProjectInputSnapshot,
  current: ProjectInputFingerprintConfiguration,
): boolean {
  return (
    previous.version === current.version &&
    JSON.stringify([...previous.languages].sort()) === JSON.stringify(current.languages) &&
    previous.pnpmWorkspaces === current.pnpmWorkspaces &&
    previous.typescriptProjectMode === current.typescriptProjectMode &&
    JSON.stringify([...previous.typescriptProjects].sort()) === JSON.stringify(current.typescriptProjects) &&
    previous.clojureConfigPath === current.clojureConfigPath
  );
}

function isTypeScriptSourcePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|vue)$/iu.test(path);
}

function isConfiguredProjectFile(projectRoot: string, candidatePath: string): boolean {
  let relativePath: string;
  try {
    relativePath = normalizeSafeProjectRelativePath(candidatePath);
  } catch {
    return false;
  }
  const snapshotState = projectSnapshotPathState(projectRoot, relativePath);
  if (snapshotState) return snapshotState === 'present';
  try {
    return lstatSync(join(projectRoot, relativePath)).isFile();
  } catch (error) {
    if (isMissingProjectFileError(error)) return false;
    throw error;
  }
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
    version: 3,
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
    return cachedProjectFileListing(projectRoot, 50 * 1024 * 1024, () =>
      execFileSync('git', ['-C', projectRoot, 'ls-files', '-co', '--exclude-standard', '--', '.'], {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }),
    )
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
