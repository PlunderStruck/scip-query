import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
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

export interface RepositoryTextScanResult extends Omit<RepositoryTextInventory, 'files'> {
  scannedTextFiles: number;
  semanticFiles: Record<SourceSemanticFreshnessState, number>;
}

export interface RepositoryTextScanOptions {
  scope?: string;
  includeBytes?: (relativePath: string, bytes: Buffer) => boolean;
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
  const files: RepositoryTextFile[] = [];
  const scan = scanRepositoryText(db, opts, (file) => files.push(file));
  return {
    files,
    candidateFiles: scan.candidateFiles,
    scannedBytes: scan.scannedBytes,
    skippedBinaryPaths: scan.skippedBinaryPaths,
    skippedUnreadablePaths: scan.skippedUnreadablePaths,
    skippedOversizedPaths: scan.skippedOversizedPaths,
  };
}

/** Visits current UTF-8 project files without retaining every file body in memory. */
export function scanRepositoryText(
  db: ScipDatabase,
  opts: RepositoryTextScanOptions,
  visit: (file: RepositoryTextFile) => void,
): RepositoryTextScanResult {
  const paths = repositoryProjectPaths(db).filter((relativePath) => !opts.scope || relativePath.includes(opts.scope));
  const fingerprints = indexedFingerprintMap(db);
  const indexedDocuments = indexedDocumentSet(db);
  const skippedBinaryPaths: string[] = [];
  const skippedUnreadablePaths: string[] = [];
  const skippedOversizedPaths: string[] = [];
  let scannedBytes = 0;
  let scannedTextFiles = 0;
  const semanticFiles: Record<SourceSemanticFreshnessState, number> = { aligned: 0, stale: 0, unavailable: 0 };

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
    if (!isTextBytes(bytes)) {
      skippedBinaryPaths.push(relativePath);
      continue;
    }
    scannedBytes += bytes.byteLength;
    scannedTextFiles += 1;
    const indexed = indexedDocuments.has(relativePath);
    const sha256 = indexed ? hashBytes(bytes) : undefined;
    const semantic = semanticFreshness(relativePath, sha256, fingerprints, indexedDocuments);
    semanticFiles[semantic.state] += 1;
    if (opts.includeBytes && !opts.includeBytes(relativePath, bytes)) continue;
    const text = UTF8_DECODER.decode(bytes);
    visit(repositoryTextFile(relativePath, bytes, text, fingerprints, indexedDocuments, sha256));
  }

  return {
    candidateFiles: paths.length,
    scannedTextFiles,
    semanticFiles,
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
  knownSha256?: string,
): RepositoryTextFile {
  const sha256 = knownSha256 ?? hashBytes(bytes);
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
  sha256: string | undefined,
  fingerprints: ReadonlyMap<string, string>,
  indexedDocuments: ReadonlySet<string>,
): SourceObservationFreshness['semantic'] {
  if (!indexedDocuments.has(relativePath)) return { state: 'unavailable', basis: 'no-compiler-document' };
  const indexedHash = fingerprints.get(relativePath);
  if (!indexedHash || !sha256) return { state: 'unavailable', basis: 'fingerprint-unavailable' };
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
  return isTextBytes(bytes) ? UTF8_DECODER.decode(bytes) : null;
}

function isTextBytes(bytes: Buffer): boolean {
  return !bytes.includes(0) && isUtf8(bytes);
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
