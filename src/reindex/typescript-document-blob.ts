import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readFileWithinLimit, SOURCE_ARTIFACT_MAX_BYTES } from '../platform/bounded-file.js';
import { sha256Hex } from '../storage/evidence-cache.js';

/** Write a content-addressed SCIP document blob, or verify the existing hash. */
export function persistHashedScipDocumentBlob(input: {
  blobDir: string;
  blobHash: string;
  bytes: Uint8Array;
  relativePath: string;
  inputKind: string;
}): void {
  mkdirSync(input.blobDir, { recursive: true });
  const blobPath = join(input.blobDir, `${input.blobHash}.scipdoc`);
  if (existsSync(blobPath)) {
    const existing = readFileWithinLimit(blobPath, {
      maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
      inputKind: input.inputKind,
    });
    if (existing.byteLength !== input.bytes.byteLength || sha256Hex(existing) !== input.blobHash) {
      throw new Error(`existing ${input.inputKind} is corrupt: ${input.relativePath}`);
    }
    return;
  }
  const temporaryPath = `${blobPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, input.bytes);
  renameSync(temporaryPath, blobPath);
}

/** Owned serialized documents: no compiler objects or caller-owned buffers. */
export class TypeScriptFragmentCache {
  private readonly values = new Map<string, CachedDocumentBytes>();
  private readonly pending = new Map<string, CachedDocumentBytes>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxEntries = 20_000,
  ) {}

  get(path: string): Uint8Array | null | undefined {
    const value = this.values.get(path) ?? this.pending.get(path);
    if (value === undefined) return undefined;
    this.pending.delete(path);
    this.values.delete(path);
    this.values.set(path, value);
    return value.compressed
      ? inflateRawSync(value.bytes!, { maxOutputLength: value.length })
      : value.bytes === null
        ? null
        : Uint8Array.from(value.bytes);
  }

  /** Preserve each prior document until this generation has had a chance to read it. */
  protectForGeneration(): void {
    for (const [path, value] of this.values) this.pending.set(path, value);
    this.values.clear();
  }

  set(path: string, value: Uint8Array | null): void {
    this.delete(path);
    const length = value?.byteLength ?? 0;
    if (length > this.maxBytes) return;
    const encoded = encodeCachedDocument(value);
    const size = encoded.bytes?.byteLength ?? 0;
    while (this.bytes + size > this.maxBytes || this.values.size + this.pending.size >= this.maxEntries) {
      // Do not destroy unread prior documents during a sequential scan larger
      // than the cache. A skipped admission only causes later fresh emission.
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) return;
      this.delete(oldest);
    }
    this.values.set(path, encoded);
    this.bytes += size;
  }

  delete(path: string): void {
    const value = this.values.get(path) ?? this.pending.get(path);
    this.bytes -= value?.bytes?.byteLength ?? 0;
    this.values.delete(path);
    this.pending.delete(path);
  }
}

interface CachedDocumentBytes {
  bytes: Uint8Array | null;
  length: number;
  compressed: boolean;
}

function encodeCachedDocument(value: Uint8Array | null): CachedDocumentBytes {
  const length = value?.byteLength ?? 0;
  const compressed = value && length >= 1_024 ? deflateRawSync(value, { level: 1 }) : null;
  return compressed && compressed.byteLength < length
    ? { bytes: compressed, length, compressed: true }
    : { bytes: value === null ? null : Uint8Array.from(value), length, compressed: false };
}
