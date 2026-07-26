import { closeSync, fstatSync, openSync, readFileSync, readSync, type PathLike } from 'node:fs';
import { createHash } from 'node:crypto';

export const SMALL_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const SOURCE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const SCIP_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export const PROFILE_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;

export class BoundedFileReadError extends Error {
  readonly code = 'SCIP_QUERY_BOUNDED_FILE_READ';

  constructor(
    readonly inputKind: string,
    readonly inputPath: string,
    readonly reason: 'not-regular' | 'too-large' | 'changed-during-read',
    readonly observedBytes: number,
    readonly limitBytes: number,
  ) {
    const detail =
      reason === 'too-large'
        ? `is ${observedBytes} bytes; the safety limit is ${limitBytes} bytes`
        : reason === 'not-regular'
          ? 'is not a regular file'
          : 'changed while it was being read';
    super(`${inputKind} ${JSON.stringify(inputPath)} ${detail}`);
    this.name = 'BoundedFileReadError';
  }
}

export interface BoundedFileReadOptions {
  maxBytes: number;
  inputKind: string;
}

/**
 * Materialize one regular file only after checking its size through the same
 * open descriptor used for the read. The post-read identity check prevents a
 * concurrent replacement or growth from bypassing the pre-allocation bound.
 */
export function readFileWithinLimit(path: PathLike, options: BoundedFileReadOptions): Buffer {
  validateLimit(options.maxBytes);
  const displayPath = String(path);
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor);
    assertReadableIdentity(before, options, displayPath);
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      content.byteLength !== before.size
    ) {
      throw new BoundedFileReadError(
        options.inputKind,
        displayPath,
        'changed-during-read',
        after.size,
        options.maxBytes,
      );
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

export function readTextFileWithinLimit(
  path: PathLike,
  options: BoundedFileReadOptions,
  encoding: BufferEncoding = 'utf8',
): string {
  return readFileWithinLimit(path, options).toString(encoding);
}

export function readSmallArtifactText(path: PathLike, inputKind: string): string {
  return readTextFileWithinLimit(path, { maxBytes: SMALL_ARTIFACT_MAX_BYTES, inputKind });
}

export function readSourceArtifactText(path: PathLike, inputKind: string): string {
  return readTextFileWithinLimit(path, { maxBytes: SOURCE_ARTIFACT_MAX_BYTES, inputKind });
}

export function readProfileArtifactText(path: PathLike, inputKind: string): string {
  return readTextFileWithinLimit(path, { maxBytes: PROFILE_ARTIFACT_MAX_BYTES, inputKind });
}

/**
 * Read a stream or already-open descriptor without ever retaining more than
 * the declared byte budget. Ownership of the descriptor stays with the caller.
 */
export function readFileDescriptorWithinLimit(descriptor: number, options: BoundedFileReadOptions): Buffer {
  validateLimit(options.maxBytes);
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let totalBytes = 0;
  for (;;) {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > options.maxBytes) {
      throw new BoundedFileReadError(
        options.inputKind,
        `file descriptor ${descriptor}`,
        'too-large',
        totalBytes,
        options.maxBytes,
      );
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, totalBytes);
}

export function readTextFileDescriptorWithinLimit(
  descriptor: number,
  options: BoundedFileReadOptions,
  encoding: BufferEncoding = 'utf8',
): string {
  return readFileDescriptorWithinLimit(descriptor, options).toString(encoding);
}

/**
 * Read a bounded pseudo-file such as Linux procfs. Pseudo-files commonly
 * report a metadata size of zero, so regular-file preallocation checks cannot
 * describe their real stream length.
 */
export function readStreamPathWithinLimit(path: PathLike, options: BoundedFileReadOptions): Buffer {
  const descriptor = openSync(path, 'r');
  try {
    return readFileDescriptorWithinLimit(descriptor, options);
  } finally {
    closeSync(descriptor);
  }
}

export function readTextStreamPathWithinLimit(
  path: PathLike,
  options: BoundedFileReadOptions,
  encoding: BufferEncoding = 'utf8',
): string {
  return readStreamPathWithinLimit(path, options).toString(encoding);
}

/**
 * Hash a regular file in fixed-size chunks so freshness checks do not
 * materialize a complete repository artifact in process memory.
 */
export function hashFileWithinLimit(
  path: PathLike,
  options: BoundedFileReadOptions,
  update: (chunk: Buffer) => void,
): number {
  validateLimit(options.maxBytes);
  const displayPath = String(path);
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor);
    assertReadableIdentity(before, options, displayPath);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) break;
      update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || offset !== before.size) {
      throw new BoundedFileReadError(
        options.inputKind,
        displayPath,
        'changed-during-read',
        after.size,
        options.maxBytes,
      );
    }
    return offset;
  } finally {
    closeSync(descriptor);
  }
}

export function sha256FileWithinLimit(path: PathLike, options: BoundedFileReadOptions): string {
  const hash = createHash('sha256');
  hashFileWithinLimit(path, options, (chunk) => hash.update(chunk));
  return hash.digest('hex');
}

function assertReadableIdentity(
  stat: ReturnType<typeof fstatSync>,
  options: BoundedFileReadOptions,
  displayPath: string,
): void {
  if (!stat.isFile()) {
    throw new BoundedFileReadError(options.inputKind, displayPath, 'not-regular', Number(stat.size), options.maxBytes);
  }
  if (stat.size > options.maxBytes) {
    throw new BoundedFileReadError(options.inputKind, displayPath, 'too-large', Number(stat.size), options.maxBytes);
  }
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative safe integer; received ${maxBytes}`);
  }
}
