import { writeSync } from 'node:fs';

/** Write a complete byte range, including partial writes, or fail on stalled output. */
export function writeAllBytes(descriptor: number, bytes: Uint8Array, label = 'File'): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error(`${label} write made no forward progress.`);
    offset += written;
  }
}
