import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
