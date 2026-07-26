import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeWindowsSidecarProvenance, WINDOWS_SIDECAR_PROVENANCE_FILE } from './scip-windows-provenance.mjs';

const MAX_SIDECAR_UNPACKED_BYTES = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;

export interface NpmPackIdentity {
  name: string;
  version: string;
  filename: string;
  tarballPath: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  shasum: string;
  integrity: string;
}

export interface RegistryDistIdentity {
  shasum: string;
  integrity: string;
  tarball: string;
}

export interface VerifiedSidecarPackageIdentity {
  pack: NpmPackIdentity;
  provenance: ReturnType<typeof decodeWindowsSidecarProvenance>;
  provenanceBytes: Buffer;
}

export interface DecodedNpmPackTarball {
  pack: NpmPackIdentity;
  bytes: Buffer;
}

export function decodeNpmPackTarball(
  output: string,
  packDirectory: string,
  readFile: typeof readFileSync = readFileSync,
): DecodedNpmPackTarball {
  const report = parseNpmPackJson(output);
  if (!Array.isArray(report) || report.length !== 1) {
    throw new Error(`npm pack output must contain exactly one package report.`);
  }
  const record = requireRecord(report[0], 'npm pack report');
  const name = requireNonEmptyString(record.name, 'npm pack name');
  const version = requireNonEmptyString(record.version, 'npm pack version');
  const filename = requireSafeFilename(record.filename, 'npm pack filename');
  const tarballPath = join(packDirectory, filename);
  const bytes = readFile(tarballPath);
  const observed = hashTarball(bytes);

  requireEqual(record.size, observed.size, 'npm pack byte size');
  requireEqual(record.shasum, observed.shasum, 'npm pack shasum');
  requireEqual(record.integrity, observed.integrity, 'npm pack integrity');
  const unpackedSize = requireNonNegativeSafeInteger(record.unpackedSize, 'npm pack unpackedSize');
  const entryCount = requirePositiveSafeInteger(record.entryCount, 'npm pack entryCount');

  return {
    pack: {
      name,
      version,
      filename,
      tarballPath,
      size: observed.size,
      unpackedSize,
      entryCount,
      shasum: observed.shasum,
      integrity: observed.integrity,
    },
    bytes,
  };
}

export function decodeNpmPackIdentity(
  output: string,
  packDirectory: string,
  readFile: typeof readFileSync = readFileSync,
): VerifiedSidecarPackageIdentity {
  const decoded = decodeNpmPackTarball(output, packDirectory, readFile);
  const packedProvenance = decodePackedProvenance(decoded.bytes, decoded.pack);
  return {
    pack: decoded.pack,
    ...packedProvenance,
  };
}

function decodePackedProvenance(
  bytes: Buffer,
  pack: NpmPackIdentity,
): Pick<VerifiedSidecarPackageIdentity, 'provenance' | 'provenanceBytes'> {
  const provenanceBytes = readTarEntry(bytes, `package/${WINDOWS_SIDECAR_PROVENANCE_FILE}`);
  const provenance = decodeWindowsSidecarProvenance(
    parseJson(provenanceBytes.toString('utf8'), 'packed provenance manifest'),
  );
  requireEqual(provenance.package.name, pack.name, 'packed provenance package name');
  requireEqual(provenance.package.version, pack.version, 'packed provenance package version');
  return {
    provenance,
    provenanceBytes,
  };
}

function parseNpmPackJson(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // npm lifecycle stdout may precede the final --json report.
  }
  const starts = [...trimmed.matchAll(/(?:^|\n)(?=\[)/g)].map((match) =>
    match.index === 0 ? 0 : (match.index ?? 0) + 1,
  );
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      // Keep scanning for the root array rather than a nested JSON array.
    }
  }
  throw new Error(`npm pack output is not valid JSON.`);
}

export function decodeRegistryDistIdentity(output: string): RegistryDistIdentity {
  const record = requireRecord(parseJson(output, 'npm registry dist metadata'), 'registry dist');
  const shasum = requireNonEmptyString(record.shasum, 'registry dist.shasum');
  const integrity = requireNonEmptyString(record.integrity, 'registry dist.integrity');
  const tarball = requireNonEmptyString(record.tarball, 'registry dist.tarball');
  if (!/^[a-f0-9]{40}$/.test(shasum)) {
    throw new Error(`registry dist.shasum must be a lowercase SHA-1 digest.`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`registry dist.integrity must be one SHA-512 Subresource Integrity value.`);
  }
  try {
    const url = new URL(tarball);
    if (url.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new Error(`registry dist.tarball must be an HTTPS URL.`);
  }
  return { shasum, integrity, tarball };
}

export function verifyRegistryTarballIdentity({
  local,
  registryDist,
  registryPackOutput,
  registryPackDirectory,
  readFile = readFileSync,
}: {
  local: VerifiedSidecarPackageIdentity;
  registryDist: RegistryDistIdentity;
  registryPackOutput: string;
  registryPackDirectory: string;
  readFile?: typeof readFileSync;
}): VerifiedSidecarPackageIdentity {
  const downloaded = decodeNpmPackTarball(registryPackOutput, registryPackDirectory, readFile);
  requireEqual(downloaded.pack.name, local.pack.name, 'registry package name');
  requireEqual(downloaded.pack.version, local.pack.version, 'registry package version');
  requireEqual(downloaded.pack.shasum, registryDist.shasum, 'downloaded registry shasum');
  requireEqual(downloaded.pack.integrity, registryDist.integrity, 'downloaded registry integrity');

  let packedProvenance: Pick<VerifiedSidecarPackageIdentity, 'provenance' | 'provenanceBytes'>;
  try {
    packedProvenance = decodePackedProvenance(downloaded.bytes, downloaded.pack);
  } catch (error) {
    throw new Error(
      `${local.pack.name}@${local.pack.version} exists without the intended provenance; ` +
        `the sidecar content changed, so bump its version before publishing the main package.`,
      { cause: error },
    );
  }
  const registry: VerifiedSidecarPackageIdentity = {
    pack: downloaded.pack,
    ...packedProvenance,
  };

  if (
    local.pack.shasum !== registry.pack.shasum ||
    local.pack.integrity !== registry.pack.integrity ||
    !local.provenanceBytes.equals(registry.provenanceBytes)
  ) {
    throw new Error(
      `${local.pack.name}@${local.pack.version} exists with different content; ` +
        `the sidecar content changed, so bump its version before publishing the main package.`,
    );
  }
  return registry;
}

export function hashTarball(bytes: Buffer): { size: number; shasum: string; integrity: string } {
  return {
    size: bytes.length,
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

export function readTarEntry(
  compressedTar: Buffer,
  expectedPath: string,
  maxUnpackedBytes = MAX_SIDECAR_UNPACKED_BYTES,
): Buffer {
  let tar: Buffer;
  try {
    tar = gunzipSync(compressedTar, { maxOutputLength: maxUnpackedBytes });
  } catch {
    throw new Error(`Registry tarball is invalid gzip data or exceeds the ${maxUnpackedBytes}-byte unpacked limit.`);
  }

  let offset = 0;
  let match: Buffer | null = null;
  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    verifyTarHeaderChecksum(header);

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(header, 124, 12, `${path} size`);
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error(`Registry tarball entry ${path} extends beyond the archive.`);
    }
    if (path === expectedPath) {
      if (match) {
        throw new Error(`Registry tarball contains duplicate ${expectedPath} entries.`);
      }
      match = Buffer.from(tar.subarray(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }

  if (!match) {
    throw new Error(`Registry tarball is missing ${expectedPath}.`);
  }
  return match;
}

function verifyTarHeaderChecksum(header: Buffer): void {
  const expected = readTarOctal(header, 148, 8, 'header checksum');
  let observed = 0;
  for (let index = 0; index < header.length; index += 1) {
    observed += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (observed !== expected) {
    throw new Error(`Registry tarball has an invalid header checksum.`);
  }
}

function readTarString(header: Buffer, offset: number, length: number): string {
  const end = header.indexOf(0, offset);
  const boundedEnd = end === -1 || end > offset + length ? offset + length : end;
  return header.subarray(offset, boundedEnd).toString('utf8');
}

function readTarOctal(header: Buffer, offset: number, length: number, field: string): number {
  const raw = header
    .subarray(offset, offset + length)
    .toString('ascii')
    .replace(/\0.*$/s, '')
    .trim();
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Registry tarball ${field} is not valid octal.`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Registry tarball ${field} exceeds the safe integer range.`);
  }
  return value;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireSafeFilename(value: unknown, field: string): string {
  const filename = requireNonEmptyString(value, field);
  if (basename(filename) !== filename || filename === '.' || filename === '..') {
    throw new Error(`${field} must be a safe basename.`);
  }
  return filename;
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative safe integer.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  const parsed = requireNonNegativeSafeInteger(value, field);
  if (parsed === 0) throw new Error(`${field} must be positive.`);
  return parsed;
}

function requireEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(`${field} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}
