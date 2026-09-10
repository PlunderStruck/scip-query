import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { sha256Hex as sha256 } from '../storage/evidence-cache.js';
import {
  readFileWithinLimit,
  readTextFileWithinLimit,
  SMALL_ARTIFACT_MAX_BYTES,
  SOURCE_ARTIFACT_MAX_BYTES,
} from '../platform/bounded-file.js';
import { persistHashedScipDocumentBlob, type TypeScriptDocumentBlobReference } from './typescript-document-blob.js';
import type { TypeScriptDocumentFragment } from './typescript-document-emitter.js';
import { assembleTypeScriptIndex } from './typescript-fragment-store.js';

export const TYPESCRIPT_OVERLAY_STORE_VERSION = 1;
export const TYPESCRIPT_OVERLAY_STORE_DIRECTORY = 'typescript-scip-overlays';
const CURRENT_TYPESCRIPT_PROJECT_IDENTITY_PREFIX = 'typescript-project-v3:';

export interface TypeScriptOverlayRecord {
  relativePath: string;
  blobHash: string | null;
  byteLength: number;
}

export interface TypeScriptOverlayManifest {
  version: typeof TYPESCRIPT_OVERLAY_STORE_VERSION;
  producerIdentity: string;
  projectIdentity: string;
  baseGenerationIdentity: string;
  generationIdentity: string;
  createdAt: string;
  overlays: TypeScriptOverlayRecord[];
}

export interface CommitTypeScriptOverlayInput {
  cacheDir: string;
  previousGenerationIdentity: string;
  nextGenerationIdentity: string;
  producerIdentity: string;
  projectIdentity: string;
  baseShardCurrent: boolean;
  fragments: readonly TypeScriptDocumentFragment[];
  retainedDocuments?: readonly TypeScriptDocumentBlobReference[];
  /** Permit a complete project refresh to carry the prior overlay onto a new compiler-project identity. */
  allowProjectIdentityChange?: boolean;
  /** Permit a one-time migration from the pre-v2 source-membership identity after validating the accepted snapshot. */
  allowLegacyProjectIdentityMigration?: boolean;
  now?: () => Date;
}

export interface MaterializeTypeScriptOverlayInput {
  cacheDir: string;
  generationIdentity: string;
  baseIndexBytes: Uint8Array;
  packageVersion: string;
}

export function commitTypeScriptOverlay(input: CommitTypeScriptOverlayInput): TypeScriptOverlayManifest {
  const previous = readTypeScriptOverlay(input.cacheDir, input.previousGenerationIdentity);
  validatePreviousOverlay(input, previous);
  const overlays = new Map((previous?.overlays ?? []).map((record) => [record.relativePath, record]));
  const replaced = new Set<string>();
  for (const fragment of input.fragments) {
    const relativePath = validateRelativePath(fragment.relativePath);
    if (replaced.has(relativePath)) throw new Error(`duplicate TypeScript overlay: ${relativePath}`);
    replaced.add(relativePath);
    overlays.set(relativePath, persistOverlayFragment(input.cacheDir, fragment));
  }
  validateRetainedOverlays(input, overlays, replaced);
  if (replaced.size === 0) throw new Error('TypeScript overlay generation requires affected documents');
  const manifest: TypeScriptOverlayManifest = {
    version: TYPESCRIPT_OVERLAY_STORE_VERSION,
    producerIdentity: input.producerIdentity,
    projectIdentity: input.projectIdentity,
    baseGenerationIdentity: previous?.baseGenerationIdentity ?? input.previousGenerationIdentity,
    generationIdentity: input.nextGenerationIdentity,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    overlays: [...overlays.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
  persistOverlayManifest(input.cacheDir, manifest);
  return manifest;
}

function validateRetainedOverlays(
  input: CommitTypeScriptOverlayInput,
  overlays: ReadonlyMap<string, TypeScriptOverlayRecord>,
  replaced: Set<string>,
): void {
  for (const retained of input.retainedDocuments ?? []) {
    validateOverlayRecord(retained);
    const path = validateRelativePath(retained.relativePath);
    if (replaced.has(path)) throw new Error(`duplicate TypeScript overlay: ${path}`);
    const prior = overlays.get(path);
    if (
      !retained.blobHash ||
      !prior ||
      prior.blobHash !== retained.blobHash ||
      prior.byteLength !== retained.byteLength
    ) {
      throw new Error(`retained TypeScript overlay does not match its accepted blob: ${path}`);
    }
    readOverlayBlob(input.cacheDir, retained);
    replaced.add(path);
  }
}

function validatePreviousOverlay(
  input: CommitTypeScriptOverlayInput,
  previous: TypeScriptOverlayManifest | null,
): void {
  if (!previous && !input.baseShardCurrent) {
    throw new Error('deferred TypeScript SCIP base has no matching overlay generation');
  }
  if (previous?.producerIdentity !== undefined && previous.producerIdentity !== input.producerIdentity) {
    throw new Error('TypeScript overlay producer identity changed');
  }
  const legacyIdentityMigration = isLegacyOverlayIdentityMigration(input, previous);
  if (
    previous &&
    previous.projectIdentity !== input.projectIdentity &&
    !input.allowProjectIdentityChange &&
    !legacyIdentityMigration
  ) {
    throw new Error('TypeScript overlay project identity changed');
  }
}

function isLegacyOverlayIdentityMigration(
  input: CommitTypeScriptOverlayInput,
  previous: TypeScriptOverlayManifest | null,
): boolean {
  return (
    input.allowLegacyProjectIdentityMigration === true &&
    previous !== null &&
    !previous.projectIdentity.startsWith(CURRENT_TYPESCRIPT_PROJECT_IDENTITY_PREFIX) &&
    input.projectIdentity.startsWith(CURRENT_TYPESCRIPT_PROJECT_IDENTITY_PREFIX)
  );
}

export function materializeTypeScriptOverlay(input: MaterializeTypeScriptOverlayInput): Uint8Array {
  const manifest = readTypeScriptOverlay(input.cacheDir, input.generationIdentity);
  if (!manifest) throw new Error('TypeScript overlay generation is unavailable');
  const fragments = manifest.overlays.map((record): TypeScriptDocumentFragment => {
    if (record.blobHash === null) {
      return { relativePath: record.relativePath, bytes: null, occurrences: 0, symbols: 0, referenceFragments: [] };
    }
    const bytes = readOverlayBlob(input.cacheDir, record);
    return { relativePath: record.relativePath, bytes, occurrences: 0, symbols: 0, referenceFragments: [] };
  });
  return assembleTypeScriptIndex({
    packageVersion: input.packageVersion,
    baseIndexBytes: input.baseIndexBytes,
    fragments,
  });
}

function readOverlayBlob(cacheDir: string, record: TypeScriptOverlayRecord): Uint8Array {
  const bytes = readFileWithinLimit(join(overlayRoot(cacheDir), 'blobs', `${record.blobHash}.scipdoc`), {
    maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
    inputKind: 'TypeScript overlay blob',
  });
  if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.blobHash) {
    throw new Error(`TypeScript overlay blob is corrupt: ${record.relativePath}`);
  }
  return bytes;
}

export function pruneTypeScriptOverlays(cacheDir: string, keepGenerationIdentities: readonly string[]): void {
  const root = overlayRoot(cacheDir);
  const generationDir = join(root, 'generations');
  if (!existsSync(generationDir)) return;
  const keep = new Set(keepGenerationIdentities.map(generationFile));
  const referenced = new Set<string>();
  for (const file of readdirSync(generationDir).filter((entry) => keep.has(entry))) {
    const manifest = parseOverlayManifest(
      readTextFileWithinLimit(join(generationDir, file), {
        maxBytes: SMALL_ARTIFACT_MAX_BYTES,
        inputKind: 'TypeScript overlay manifest',
      }),
    );
    for (const overlay of manifest.overlays) {
      if (overlay.blobHash) referenced.add(`${overlay.blobHash}.scipdoc`);
    }
  }
  for (const file of readdirSync(generationDir)) {
    if (!keep.has(file)) rmSync(join(generationDir, file), { force: true });
  }
  const blobDir = join(root, 'blobs');
  if (!existsSync(blobDir)) return;
  for (const file of readdirSync(blobDir)) {
    if (!referenced.has(file)) rmSync(join(blobDir, file), { force: true });
  }
}

export function readTypeScriptOverlay(cacheDir: string, generationIdentity: string): TypeScriptOverlayManifest | null {
  const path = join(overlayRoot(cacheDir), 'generations', generationFile(generationIdentity));
  if (!existsSync(path)) return null;
  const manifest = parseOverlayManifest(
    readTextFileWithinLimit(path, {
      maxBytes: SMALL_ARTIFACT_MAX_BYTES,
      inputKind: 'TypeScript overlay manifest',
    }),
  );
  if (manifest.generationIdentity !== generationIdentity) {
    throw new Error('TypeScript overlay generation identity does not match its path');
  }
  return manifest;
}

function persistOverlayFragment(cacheDir: string, fragment: TypeScriptDocumentFragment): TypeScriptOverlayRecord {
  const relativePath = validateRelativePath(fragment.relativePath);
  if (fragment.bytes === null) return { relativePath, blobHash: null, byteLength: 0 };
  const bytes = Buffer.from(fragment.bytes);
  const blobHash = sha256(bytes);
  persistHashedScipDocumentBlob({
    blobDir: join(overlayRoot(cacheDir), 'blobs'),
    blobHash,
    bytes,
    relativePath,
    inputKind: 'TypeScript overlay blob',
  });
  return { relativePath, blobHash, byteLength: bytes.byteLength };
}

function persistOverlayManifest(cacheDir: string, manifest: TypeScriptOverlayManifest): void {
  const path = join(overlayRoot(cacheDir), 'generations', generationFile(manifest.generationIdentity));
  if (existsSync(path)) {
    const existing = parseOverlayManifest(
      readTextFileWithinLimit(path, {
        maxBytes: SMALL_ARTIFACT_MAX_BYTES,
        inputKind: 'TypeScript overlay manifest',
      }),
    );
    if (manifestIdentity(existing) !== manifestIdentity(manifest)) {
      throw new Error(`TypeScript overlay generation is immutable: ${manifest.generationIdentity}`);
    }
    return;
  }
  writeJsonAtomic(path, manifest, { spacing: 2, trailingNewline: true });
}

type TypeScriptOverlayManifestHeader = Omit<TypeScriptOverlayManifest, 'overlays'> & { overlays: unknown[] };

function parseOverlayManifest(raw: string): TypeScriptOverlayManifest {
  const value = JSON.parse(raw) as Partial<TypeScriptOverlayManifestHeader>;
  validateOverlayManifestHeader(value);
  const seen = new Set<string>();
  for (const overlay of value.overlays) {
    validateOverlayRecord(overlay);
    validateRelativePath(overlay.relativePath);
    if (seen.has(overlay.relativePath)) throw new Error('duplicate TypeScript overlay record');
    seen.add(overlay.relativePath);
  }
  return value as TypeScriptOverlayManifest;
}

function validateOverlayManifestHeader(
  value: Partial<TypeScriptOverlayManifestHeader>,
): asserts value is TypeScriptOverlayManifestHeader {
  if (
    value.version !== TYPESCRIPT_OVERLAY_STORE_VERSION ||
    !isOverlayIdentity(value.producerIdentity) ||
    !isOverlayIdentity(value.projectIdentity) ||
    !isOverlayIdentity(value.baseGenerationIdentity) ||
    !isOverlayIdentity(value.generationIdentity) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.overlays)
  ) {
    throw new Error('invalid TypeScript overlay manifest');
  }
}

function isOverlayIdentity(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function validateOverlayRecord(overlay: unknown): asserts overlay is TypeScriptOverlayRecord {
  const record = overlay as Partial<TypeScriptOverlayRecord> | null | undefined;
  if (
    !record ||
    typeof record.relativePath !== 'string' ||
    (record.blobHash !== null && (typeof record.blobHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.blobHash))) ||
    !Number.isInteger(record.byteLength) ||
    record.byteLength! < 0 ||
    (record.blobHash === null && record.byteLength !== 0)
  ) {
    throw new Error('invalid TypeScript overlay record');
  }
}

function overlayRoot(cacheDir: string): string {
  return join(cacheDir, TYPESCRIPT_OVERLAY_STORE_DIRECTORY);
}

function generationFile(generationIdentity: string): string {
  if (!generationIdentity) throw new Error('TypeScript overlay generation identity must be non-empty');
  return `${sha256(generationIdentity)}.json`;
}

function manifestIdentity(manifest: TypeScriptOverlayManifest): string {
  return sha256(
    JSON.stringify({
      version: manifest.version,
      producerIdentity: manifest.producerIdentity,
      projectIdentity: manifest.projectIdentity,
      baseGenerationIdentity: manifest.baseGenerationIdentity,
      generationIdentity: manifest.generationIdentity,
      overlays: manifest.overlays,
    }),
  );
}

function validateRelativePath(value: string): string {
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.')
  ) {
    throw new Error(`invalid TypeScript overlay path: ${value}`);
  }
  if (value.split('/').includes('..')) throw new Error(`invalid TypeScript overlay path: ${value}`);
  return value;
}
