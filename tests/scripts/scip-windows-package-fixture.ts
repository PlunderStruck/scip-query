import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { hashTarball } from '../../scripts/scip-windows-package-identity.js';

export function writeNpmPackFixture({
  directory,
  name = 'scip-query-scip-windows',
  version = '0.13.1',
  provenanceBytes,
  payload = 'same-package-content',
}: {
  directory: string;
  name?: string;
  version?: string;
  provenanceBytes: Buffer;
  payload?: string;
}): { output: string; tarball: Buffer; tarballPath: string } {
  mkdirSync(directory, { recursive: true });
  const tarball = createTarGzip([
    { path: 'package/provenance.json', bytes: provenanceBytes },
    { path: 'package/payload.txt', bytes: Buffer.from(payload) },
  ]);
  const filename = `${name}-${version}.tgz`;
  const tarballPath = join(directory, filename);
  writeFileSync(tarballPath, tarball);
  const identity = hashTarball(tarball);
  return {
    output: JSON.stringify([
      {
        name,
        version,
        filename,
        size: identity.size,
        unpackedSize: provenanceBytes.length + Buffer.byteLength(payload),
        shasum: identity.shasum,
        integrity: identity.integrity,
        entryCount: 2,
      },
    ]),
    tarball,
    tarballPath,
  };
}

export function createTarGzip(entries: Array<{ path: string; bytes: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (Buffer.byteLength(entry.path) > 100) {
      throw new Error(`test tar path is too long: ${entry.path}`);
    }
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'binary');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'binary');
    blocks.push(header, entry.bytes);
    const padding = entry.bytes.length % 512;
    if (padding !== 0) blocks.push(Buffer.alloc(512 - padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  buffer.write(encoded, offset, length, 'ascii');
}
