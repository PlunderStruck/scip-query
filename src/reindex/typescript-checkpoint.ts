import { typeScriptFragmentGenerationIdentity } from './typescript-fragment-store.js';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  acceptedReindexMetadata,
  canonicalReindexMetadataIdentity,
  decodeReindexMetadata,
} from '../domain/reindex-metadata.js';
import {
  classifyProjectInputPath,
  projectInputSnapshotOrNull,
  type ProjectInputSnapshot,
} from '../domain/project-input.js';
import { buildProjectInputFingerprint, readProjectFile } from '../platform/project-files.js';
import { withProjectFileFingerprintCache } from '../platform/fingerprint-stat-cache.js';
import { discoverTypeScriptProjectRoots } from '../platform/typescript-projects.js';
import {
  acquireSqliteGenerationReader,
  readSqliteGenerationState,
  type SqliteGenerationHandle,
} from '../storage/sqlite-generation.js';
import { TypeScriptFragmentCache } from './typescript-document-blob.js';
import type { TypeScriptDocumentCheckpoint } from './typescript-document-emitter.js';
import type { TypeScriptIndexDocumentRequest } from './typescript-index-protocol.js';
import { readOverlayBlob, readTypeScriptOverlay } from './typescript-overlay-store.js';

interface CheckpointInput {
  projectRoot: string;
  dbPath: string;
  baseGeneration: string;
  request: TypeScriptIndexDocumentRequest;
}

/** Recover only source and documents owned by the currently accepted publication. */
export function readPublishedTypeScriptCheckpoint(input: CheckpointInput): TypeScriptDocumentCheckpoint | null {
  if (!input.request.modifiedFiles.length || input.request.removedFiles.length) return null;
  let reader: ReturnType<typeof acquireSqliteGenerationReader> | undefined;
  try {
    reader = acquireSqliteGenerationReader({
      projectRoot: input.projectRoot,
      dbPath: input.dbPath,
      indexPath: join(dirname(input.dbPath), 'index.scip'),
    });
    const accepted = checkpointPublication(input, reader.generation);
    if (!accepted || !matchingCheckpointInputs(input, accepted.snapshot)) return null;
    const sources = checkpointSources(reader.generation.databasePath, accepted.snapshot, input.request.modifiedFiles);
    if (!sources) return null;
    const documents = new TypeScriptFragmentCache();
    const prior = new Set(accepted.snapshot.files.map((file) => file.path));
    const cacheDir = dirname(input.dbPath);
    for (const record of accepted.overlay.overlays) {
      if (record.blobHash === null || !prior.has(record.relativePath)) continue;
      documents.setReference({ ...record, blobHash: record.blobHash }, () => readOverlayBlob(cacheDir, record));
    }
    return { sources, documents };
  } catch {
    // Missing or damaged recovery evidence only disables the optimization.
    return null;
  } finally {
    reader?.release();
  }
}

function checkpointPublication(input: CheckpointInput, generation: SqliteGenerationHandle) {
  const state = readSqliteGenerationState(input.dbPath);
  if (generation.source !== 'immutable' || state?.currentGeneration !== generation.identity) return null;
  const decoded = decodeReindexMetadata(generation.metadataRaw);
  const canonical = canonicalReindexMetadataIdentity(decoded);
  if (!canonical || digest(canonical) !== input.baseGeneration) return null;
  const snapshot = projectInputSnapshotOrNull(acceptedReindexMetadata(decoded)?.fingerprint);
  if (!snapshot || !matchingCheckpointProject(input, snapshot)) return null;
  const overlayGeneration =
    state.publication?.typescriptOverlayGeneration ??
    typeScriptFragmentGenerationIdentity(snapshot, input.request.producerIdentity);
  const overlay = readTypeScriptOverlay(dirname(input.dbPath), overlayGeneration);
  if (
    overlay?.producerIdentity !== input.request.producerIdentity ||
    overlay.projectIdentity !== input.request.projectIdentity
  )
    return null;
  return { snapshot, overlay };
}

function matchingCheckpointProject(input: CheckpointInput, snapshot: ProjectInputSnapshot): boolean {
  if (snapshot.typescriptProjectMode !== 'single' && snapshot.typescriptProjectMode !== 'workspace') return false;
  const roots =
    snapshot.typescriptProjectMode === 'workspace'
      ? discoverTypeScriptProjectRoots(input.projectRoot, snapshot.typescriptProjects)
      : ['.'];
  if (roots.length !== 1 || roots[0] !== input.request.projectArgument) return false;
  return input.request.tsconfigPath === (roots[0] === '.' ? 'tsconfig.json' : `${roots[0]}/tsconfig.json`);
}

function matchingCheckpointInputs(input: CheckpointInput, snapshot: ProjectInputSnapshot): boolean {
  const current = withProjectFileFingerprintCache(input.projectRoot, dirname(input.dbPath), () =>
    buildProjectInputFingerprint(input.projectRoot, snapshot.languages, {
      ...snapshot,
      typescriptProjectMode: snapshot.typescriptProjectMode as 'single' | 'workspace',
    }),
  );
  const prior = new Map(snapshot.files.map((file) => [file.path, file]));
  const modified = new Set(input.request.modifiedFiles);
  if (prior.size !== current.files.length || modified.size !== input.request.modifiedFiles.length) return false;
  for (const path of modified) {
    if (!prior.has(path) || classifyProjectInputPath(path, snapshot.languages) !== 'source') return false;
  }
  return current.files.every((file) => {
    const before = prior.get(file.path);
    return !!before && (modified.has(file.path) || (file.hash === before.hash && file.size === before.size));
  });
}

function checkpointSources(
  dbPath: string,
  snapshot: ProjectInputSnapshot,
  modified: readonly string[],
): Map<string, string> | null {
  const prior = new Map(snapshot.files.map((file) => [file.path, file]));
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const sources = new Map<string, string>();
    const query = db.prepare('SELECT text FROM documents WHERE relative_path = ?');
    for (const path of modified) {
      const row = query.get(path) as { text: string | null } | undefined;
      const before = prior.get(path)!;
      if (
        typeof row?.text !== 'string' ||
        Buffer.byteLength(row.text) !== before.size ||
        digest(row.text) !== before.hash
      )
        return null;
      sources.set(path, row.text);
    }
    return sources;
  } finally {
    db.close();
  }
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Retain the source revision belonging to an accepted document, using SCIP's
 * existing optional source field. A worker can then reconstruct its old program
 * after a restart. Bytes must match the publication fingerprint before writing.
 */
export function checkpointTypeScriptSources(input: {
  projectRoot: string;
  dbPath: string;
  fingerprint: unknown;
  changedFiles?: readonly string[];
}): number {
  const snapshot = projectInputSnapshotOrNull(input.fingerprint);
  if (!snapshot) return 0;
  const fingerprints = new Map(snapshot.files.map((file) => [file.path, file]));
  const db = new Database(input.dbPath);
  try {
    const missing = db.prepare('SELECT relative_path FROM documents WHERE text IS NULL').all() as {
      relative_path: string;
    }[];
    const paths = new Set([...missing.map((row) => row.relative_path), ...(input.changedFiles ?? [])]);
    const write = db.prepare('UPDATE documents SET text = ? WHERE relative_path = ? AND (text IS NULL OR text != ?)');
    return db.transaction(() => {
      let updated = 0;
      for (const path of paths) {
        const expected = fingerprints.get(path);
        if (!expected || !/\.[cm]?[jt]sx?$/.test(path)) continue;
        let bytes: Buffer;
        try {
          bytes = readProjectFile(input.projectRoot, path);
        } catch {
          continue;
        }
        const text = bytes.toString('utf8');
        if (
          !Buffer.from(text, 'utf8').equals(bytes) ||
          bytes.length !== expected.size ||
          createHash('sha256').update(bytes).digest('hex') !== expected.hash
        )
          continue;
        updated += write.run(text, path, text).changes;
      }
      return updated;
    })();
  } finally {
    db.close();
  }
}
