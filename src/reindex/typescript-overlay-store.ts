import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import {
  readFileWithinLimit,
  readTextFileWithinLimit,
  SMALL_ARTIFACT_MAX_BYTES,
  SOURCE_ARTIFACT_MAX_BYTES,
} from '../platform/bounded-file.js';
import type { TypeScriptDocumentFragment } from './typescript-document-emitter.js';
import { assembleTypeScriptIndex } from './typescript-fragment-store.js';

export const TYPESCRIPT_OVERLAY_STORE_VERSION = 1;
export const TYPESCRIPT_DEFERRED_SCIP_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const TYPESCRIPT_OVERLAY_STORE_DIRECTORY = 'typescript-scip-overlays';

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
  if (!previous && !input.baseShardCurrent) {
    throw new Error('deferred TypeScript SCIP base has no matching overlay generation');
  }
  if (
    previous &&
    (previous.producerIdentity !== input.producerIdentity || previous.projectIdentity !== input.projectIdentity)
  ) {
    throw new Error('TypeScript overlay producer or project identity changed');
  }
  const overlays = new Map((previous?.overlays ?? []).map((record) => [record.relativePath, record]));
  const replaced = new Set<string>();
  for (const fragment of input.fragments) {
    const relativePath = validateRelativePath(fragment.relativePath);
    if (replaced.has(relativePath)) throw new Error(`duplicate TypeScript overlay: ${relativePath}`);
    replaced.add(relativePath);
    overlays.set(relativePath, persistOverlayFragment(input.cacheDir, fragment));
  }
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

export function materializeTypeScriptOverlay(input: MaterializeTypeScriptOverlayInput): Uint8Array {
  const manifest = readTypeScriptOverlay(input.cacheDir, input.generationIdentity);
  if (!manifest) throw new Error('TypeScript overlay generation is unavailable');
  const fragments = manifest.overlays.map((record): TypeScriptDocumentFragment => {
    if (record.blobHash === null) {
      return { relativePath: record.relativePath, bytes: null, occurrences: 0, symbols: 0, referenceFragments: [] };
    }
    const bytes = readFileWithinLimit(join(overlayRoot(input.cacheDir), 'blobs', `${record.blobHash}.scipdoc`), {
      maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
      inputKind: 'TypeScript overlay blob',
    });
    if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.blobHash) {
      throw new Error(`TypeScript overlay blob is corrupt: ${record.relativePath}`);
    }
    return { relativePath: record.relativePath, bytes, occurrences: 0, symbols: 0, referenceFragments: [] };
  });
  return assembleTypeScriptIndex({
    packageVersion: input.packageVersion,
    baseIndexBytes: input.baseIndexBytes,
    fragments,
  });
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
  const blobDir = join(overlayRoot(cacheDir), 'blobs');
  mkdirSync(blobDir, { recursive: true });
  const path = join(blobDir, `${blobHash}.scipdoc`);
  if (existsSync(path)) {
    const existing = readFileWithinLimit(path, {
      maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
      inputKind: 'TypeScript overlay blob',
    });
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== blobHash) {
      throw new Error(`existing TypeScript overlay blob is corrupt: ${relativePath}`);
    }
  } else {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  }
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

function parseOverlayManifest(raw: string): TypeScriptOverlayManifest {
  const value = JSON.parse(raw) as Partial<TypeScriptOverlayManifest>;
  if (
    value.version !== TYPESCRIPT_OVERLAY_STORE_VERSION ||
    typeof value.producerIdentity !== 'string' ||
    !value.producerIdentity ||
    typeof value.projectIdentity !== 'string' ||
    !value.projectIdentity ||
    typeof value.baseGenerationIdentity !== 'string' ||
    !value.baseGenerationIdentity ||
    typeof value.generationIdentity !== 'string' ||
    !value.generationIdentity ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.overlays)
  ) {
    throw new Error('invalid TypeScript overlay manifest');
  }
  const seen = new Set<string>();
  for (const overlay of value.overlays) {
    if (
      !overlay ||
      typeof overlay.relativePath !== 'string' ||
      (overlay.blobHash !== null &&
        (typeof overlay.blobHash !== 'string' || !/^[a-f0-9]{64}$/.test(overlay.blobHash))) ||
      !Number.isInteger(overlay.byteLength) ||
      overlay.byteLength < 0 ||
      (overlay.blobHash === null && overlay.byteLength !== 0)
    ) {
      throw new Error('invalid TypeScript overlay record');
    }
    validateRelativePath(overlay.relativePath);
    if (seen.has(overlay.relativePath)) throw new Error('duplicate TypeScript overlay record');
    seen.add(overlay.relativePath);
  }
  return value as TypeScriptOverlayManifest;
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

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
