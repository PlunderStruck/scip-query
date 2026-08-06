import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { decodeReindexMetadata } from '../../domain/reindex-metadata.js';
import { listProjectFiles } from '../../platform/project-files.js';
import type { ScipDatabase } from '../../storage/db.js';
import {
  InputTooLargeError,
  isMissingProjectFileError,
  normalizeSafeProjectRelativePath,
  readProjectFile,
} from './project-file-boundary.js';

export type SourceSemanticFreshnessState = 'aligned' | 'stale' | 'unavailable';

/**
 * Freshness of one source observation. Exact text is read from the current
 * worktree; semantic alignment compares those bytes with the indexed input
 * fingerprint when the file has compiler facts.
 */
export interface SourceObservationFreshness {
  exactText: {
    state: 'current';
    basis: 'working-tree-read';
    sha256: string;
  };
  semantic: {
    state: SourceSemanticFreshnessState;
    basis: 'indexed-input-fingerprint' | 'no-compiler-document' | 'fingerprint-unavailable';
  };
}

export interface RepositoryTextFile {
  relativePath: string;
  text: string;
  bytes: number;
  freshness: SourceObservationFreshness;
}

export interface RepositoryTextInventory {
  files: RepositoryTextFile[];
  candidateFiles: number;
  scannedBytes: number;
  skippedBinaryPaths: string[];
  skippedUnreadablePaths: string[];
  skippedOversizedPaths: string[];
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Enumerate the current project paths used by the lossless path sensor. */
export function repositoryProjectPaths(db: ScipDatabase): string[] {
  return listProjectFiles(db.config.projectRoot);
}

/** Read one exact, safe in-project UTF-8 text file without compiler lookup. */
export function readRepositoryTextFile(db: ScipDatabase, candidatePath: string): RepositoryTextFile | null {
  const relativePath = normalizeSafeProjectRelativePath(candidatePath);
  let bytes: Buffer;
  try {
    bytes = readProjectFile(db.config.projectRoot, relativePath, { inputKind: 'repository text file' });
  } catch (error) {
    if (isMissingProjectFileError(error) || error instanceof InputTooLargeError) return null;
    throw error;
  }
  const text = decodeText(bytes);
  if (text === null) return null;
  return repositoryTextFile(relativePath, bytes, text, indexedFingerprintMap(db), indexedDocumentSet(db));
}

/**
 * Read every current project text file exactly once. Binary, unreadable, and
 * oversized paths are disclosed separately rather than silently becoming an
 * absence claim.
 */
export function repositoryTextInventory(db: ScipDatabase, opts: { scope?: string } = {}): RepositoryTextInventory {
  const paths = repositoryProjectPaths(db).filter((relativePath) => !opts.scope || relativePath.includes(opts.scope));
  const fingerprints = indexedFingerprintMap(db);
  const indexedDocuments = indexedDocumentSet(db);
  const files: RepositoryTextFile[] = [];
  const skippedBinaryPaths: string[] = [];
  const skippedUnreadablePaths: string[] = [];
  const skippedOversizedPaths: string[] = [];
  let scannedBytes = 0;

  for (const relativePath of paths) {
    let bytes: Buffer;
    try {
      bytes = readProjectFile(db.config.projectRoot, relativePath, { inputKind: 'repository text file' });
    } catch (error) {
      if (error instanceof InputTooLargeError) {
        skippedOversizedPaths.push(relativePath);
        continue;
      }
      if (isMissingProjectFileError(error)) continue;
      skippedUnreadablePaths.push(relativePath);
      continue;
    }
    const text = decodeText(bytes);
    if (text === null) {
      skippedBinaryPaths.push(relativePath);
      continue;
    }
    scannedBytes += bytes.byteLength;
    files.push(repositoryTextFile(relativePath, bytes, text, fingerprints, indexedDocuments));
  }

  return {
    files,
    candidateFiles: paths.length,
    scannedBytes,
    skippedBinaryPaths,
    skippedUnreadablePaths,
    skippedOversizedPaths,
  };
}

function repositoryTextFile(
  relativePath: string,
  bytes: Buffer,
  text: string,
  fingerprints: ReadonlyMap<string, string>,
  indexedDocuments: ReadonlySet<string>,
): RepositoryTextFile {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    relativePath,
    text,
    bytes: bytes.byteLength,
    freshness: {
      exactText: { state: 'current', basis: 'working-tree-read', sha256 },
      semantic: semanticFreshness(relativePath, sha256, fingerprints, indexedDocuments),
    },
  };
}

function semanticFreshness(
  relativePath: string,
  sha256: string,
  fingerprints: ReadonlyMap<string, string>,
  indexedDocuments: ReadonlySet<string>,
): SourceObservationFreshness['semantic'] {
  if (!indexedDocuments.has(relativePath)) return { state: 'unavailable', basis: 'no-compiler-document' };
  const indexedHash = fingerprints.get(relativePath);
  if (!indexedHash) return { state: 'unavailable', basis: 'fingerprint-unavailable' };
  return {
    state: indexedHash === sha256 ? 'aligned' : 'stale',
    basis: 'indexed-input-fingerprint',
  };
}

function indexedDocumentSet(db: ScipDatabase): Set<string> {
  return new Set(
    db
      .all<{
        relative_path: string;
      }>(`SELECT documents.relative_path FROM documents WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`)
      .map((row) => row.relative_path),
  );
}

function indexedFingerprintMap(db: ScipDatabase): Map<string, string> {
  const result = new Map<string, string>();
  if (!db.generation.metadataRaw) return result;
  const decoded = decodeReindexMetadata(db.generation.metadataRaw);
  if (decoded.kind !== 'legacy' && decoded.kind !== 'supported') return result;
  const fingerprint = decoded.metadata.fingerprint;
  if (!isRecord(fingerprint) || !Array.isArray(fingerprint['files'])) return result;
  for (const value of fingerprint['files']) {
    if (!isRecord(value) || typeof value['path'] !== 'string' || typeof value['hash'] !== 'string') continue;
    result.set(value['path'], value['hash']);
  }
  return result;
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
