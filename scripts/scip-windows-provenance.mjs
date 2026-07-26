import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const WINDOWS_SIDECAR_PROVENANCE_KIND = 'scip-query-windows-sidecar-provenance';
export const WINDOWS_SIDECAR_PROVENANCE_VERSION = 1;
export const WINDOWS_SIDECAR_PROVENANCE_FILE = 'provenance.json';
export const DEFAULT_SCIP_REPOSITORY = 'https://github.com/scip-code/scip.git';
export const DEFAULT_SCIP_TAG = 'v0.8.1';
export const PINNED_GO_VERSION = 'go1.26.4';

export const WINDOWS_SIDECAR_BUILD = Object.freeze({
  command: 'go build',
  package: './cmd/scip',
  flags: Object.freeze(['-trimpath', '-ldflags=-s -w']),
  environment: Object.freeze({
    CGO_ENABLED: '0',
    GOOS: 'windows',
  }),
});

export const WINDOWS_SIDECAR_TARGETS = Object.freeze([
  Object.freeze({
    goarch: 'amd64',
    packageArch: 'x64',
    filename: 'scip-win32-x64.exe',
    peMachine: 'AMD64',
    peMachineCode: 0x8664,
  }),
  Object.freeze({
    goarch: 'arm64',
    packageArch: 'arm64',
    filename: 'scip-win32-arm64.exe',
    peMachine: 'ARM64',
    peMachineCode: 0xaa64,
  }),
]);

export class WindowsSidecarProvenanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WindowsSidecarProvenanceError';
    this.code = code;
  }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function inspectPortableExecutable(bytes, filename = '<binary>') {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x40) {
    throw provenanceError('malformed-binary', `${filename} is too short to be a PE executable.`);
  }
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw provenanceError('malformed-binary', `${filename} is missing the DOS MZ signature.`);
  }

  const peOffset = bytes.readUInt32LE(0x3c);
  if (!Number.isSafeInteger(peOffset) || peOffset < 0x40 || peOffset + 26 > bytes.length) {
    throw provenanceError('malformed-binary', `${filename} has an invalid PE header offset.`);
  }
  if (
    bytes[peOffset] !== 0x50 ||
    bytes[peOffset + 1] !== 0x45 ||
    bytes[peOffset + 2] !== 0 ||
    bytes[peOffset + 3] !== 0
  ) {
    throw provenanceError('malformed-binary', `${filename} is missing the PE signature.`);
  }

  const machineCode = bytes.readUInt16LE(peOffset + 4);
  const target = WINDOWS_SIDECAR_TARGETS.find((candidate) => candidate.peMachineCode === machineCode);
  if (!target) {
    throw provenanceError(
      'wrong-architecture',
      `${filename} has unsupported PE machine 0x${machineCode.toString(16).padStart(4, '0')}.`,
    );
  }

  const optionalHeaderMagic = bytes.readUInt16LE(peOffset + 24);
  if (optionalHeaderMagic !== 0x20b) {
    throw provenanceError(
      'malformed-binary',
      `${filename} is not a PE32+ executable (optional-header magic 0x${optionalHeaderMagic
        .toString(16)
        .padStart(4, '0')}).`,
    );
  }

  return {
    peMachine: target.peMachine,
    peMachineCode: `0x${machineCode.toString(16).padStart(4, '0')}`,
  };
}

export function inspectWindowsSidecarBinary(file, readFile = readFileSync) {
  const bytes = readFile(file);
  const pe = inspectPortableExecutable(bytes, file);
  return {
    size: bytes.length,
    sha256: sha256(bytes),
    ...pe,
  };
}

export function createWindowsSidecarProvenance({
  sidecarDir,
  packageName,
  packageVersion,
  sourceRepository = DEFAULT_SCIP_REPOSITORY,
  sourceTag = DEFAULT_SCIP_TAG,
  sourceCommit,
  goVersion = PINNED_GO_VERSION,
  readFile = readFileSync,
}) {
  if (!isCommit(sourceCommit)) {
    throw provenanceError('invalid-build-input', `Source commit must be a full 40-character Git commit.`);
  }

  return {
    kind: WINDOWS_SIDECAR_PROVENANCE_KIND,
    schemaVersion: WINDOWS_SIDECAR_PROVENANCE_VERSION,
    package: {
      name: packageName,
      version: packageVersion,
    },
    source: {
      repository: sourceRepository,
      tag: sourceTag,
      commit: sourceCommit,
    },
    toolchain: {
      goVersion,
    },
    build: {
      command: WINDOWS_SIDECAR_BUILD.command,
      package: WINDOWS_SIDECAR_BUILD.package,
      flags: [...WINDOWS_SIDECAR_BUILD.flags],
      environment: {
        ...WINDOWS_SIDECAR_BUILD.environment,
      },
    },
    binaries: WINDOWS_SIDECAR_TARGETS.map((target) => {
      const inspected = inspectWindowsSidecarBinary(join(sidecarDir, target.filename), readFile);
      if (inspected.peMachine !== target.peMachine) {
        throw provenanceError(
          'wrong-architecture',
          `${target.filename} declares ${target.packageArch} but contains ${inspected.peMachine}.`,
        );
      }
      return {
        filename: target.filename,
        target: {
          goos: 'windows',
          goarch: target.goarch,
          packageArch: target.packageArch,
        },
        size: inspected.size,
        sha256: inspected.sha256,
        peMachine: inspected.peMachine,
        peMachineCode: inspected.peMachineCode,
      };
    }),
  };
}

export function verifyWindowsSidecarProvenance({
  sidecarDir,
  expectedSourceRepository = DEFAULT_SCIP_REPOSITORY,
  expectedSourceTag = DEFAULT_SCIP_TAG,
  expectedGoVersion = PINNED_GO_VERSION,
  readFile = readFileSync,
}) {
  const packageRecord = parseJsonFile(join(sidecarDir, 'package.json'), 'sidecar package', readFile);
  const manifest = parseJsonFile(
    join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE),
    'sidecar provenance manifest',
    readFile,
  );
  const decoded = decodeWindowsSidecarProvenance(manifest);

  requireEqual(decoded.package.name, packageRecord.name, 'package name');
  requireEqual(decoded.package.version, packageRecord.version, 'package version');
  requireEqual(decoded.source.repository, expectedSourceRepository, 'SCIP source repository');
  requireEqual(decoded.source.tag, expectedSourceTag, 'SCIP source tag');
  requireEqual(decoded.toolchain.goVersion, expectedGoVersion, 'pinned Go version');
  requireBuildContract(decoded.build);

  const entries = new Map(decoded.binaries.map((binary) => [binary.filename, binary]));
  for (const target of WINDOWS_SIDECAR_TARGETS) {
    const expected = entries.get(target.filename);
    if (!expected) {
      throw provenanceError('malformed-manifest', `Manifest is missing ${target.filename}.`);
    }

    requireEqual(expected.target.goos, 'windows', `${target.filename} GOOS`);
    requireEqual(expected.target.goarch, target.goarch, `${target.filename} GOARCH`);
    requireEqual(expected.target.packageArch, target.packageArch, `${target.filename} package arch`);
    requireEqual(expected.peMachine, target.peMachine, `${target.filename} PE machine`);
    requireEqual(
      expected.peMachineCode,
      `0x${target.peMachineCode.toString(16).padStart(4, '0')}`,
      `${target.filename} PE machine code`,
    );

    let actual;
    try {
      actual = inspectWindowsSidecarBinary(join(sidecarDir, target.filename), readFile);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw provenanceError('missing-binary', `${target.filename} is missing.`);
      }
      throw error;
    }
    requireEqual(actual.peMachine, target.peMachine, `${target.filename} actual PE machine`);
    requireEqual(actual.size, expected.size, `${target.filename} byte size`);
    requireEqual(actual.sha256, expected.sha256, `${target.filename} SHA-256`);
  }

  return decoded;
}

export function decodeWindowsSidecarProvenance(value) {
  const record = requireRecord(value, 'manifest');
  requireEqual(record.kind, WINDOWS_SIDECAR_PROVENANCE_KIND, 'manifest kind');
  if (record.schemaVersion !== WINDOWS_SIDECAR_PROVENANCE_VERSION) {
    throw provenanceError(
      'unsupported-manifest',
      `Unsupported Windows sidecar provenance schema ${String(record.schemaVersion)}; expected ${WINDOWS_SIDECAR_PROVENANCE_VERSION}.`,
    );
  }

  const packageRecord = requireRecord(record.package, 'package');
  const source = requireRecord(record.source, 'source');
  const toolchain = requireRecord(record.toolchain, 'toolchain');
  const build = requireRecord(record.build, 'build');
  if (!Array.isArray(record.binaries) || record.binaries.length !== WINDOWS_SIDECAR_TARGETS.length) {
    throw provenanceError(
      'malformed-manifest',
      `binaries must contain exactly ${WINDOWS_SIDECAR_TARGETS.length} entries.`,
    );
  }

  const binaries = record.binaries.map((value, index) => {
    const binary = requireRecord(value, `binaries[${index}]`);
    const target = requireRecord(binary.target, `binaries[${index}].target`);
    requireNonEmptyString(binary.filename, `binaries[${index}].filename`);
    requireNonEmptyString(target.goos, `binaries[${index}].target.goos`);
    requireNonEmptyString(target.goarch, `binaries[${index}].target.goarch`);
    requireNonEmptyString(target.packageArch, `binaries[${index}].target.packageArch`);
    requirePositiveSafeInteger(binary.size, `binaries[${index}].size`);
    if (typeof binary.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binary.sha256)) {
      throw provenanceError('malformed-manifest', `binaries[${index}].sha256 must be lowercase SHA-256.`);
    }
    requireNonEmptyString(binary.peMachine, `binaries[${index}].peMachine`);
    if (typeof binary.peMachineCode !== 'string' || !/^0x[a-f0-9]{4}$/.test(binary.peMachineCode)) {
      throw provenanceError(
        'malformed-manifest',
        `binaries[${index}].peMachineCode must be a four-digit hexadecimal code.`,
      );
    }
    return binary;
  });

  requireNonEmptyString(packageRecord.name, 'package.name');
  requireNonEmptyString(packageRecord.version, 'package.version');
  requireNonEmptyString(source.repository, 'source.repository');
  requireNonEmptyString(source.tag, 'source.tag');
  if (!isCommit(source.commit)) {
    throw provenanceError('malformed-manifest', `source.commit must be a full 40-character Git commit.`);
  }
  requireNonEmptyString(toolchain.goVersion, 'toolchain.goVersion');
  requireNonEmptyString(build.command, 'build.command');
  requireNonEmptyString(build.package, 'build.package');
  if (!Array.isArray(build.flags) || !build.flags.every((flag) => typeof flag === 'string')) {
    throw provenanceError('malformed-manifest', `build.flags must be an array of strings.`);
  }
  requireRecord(build.environment, 'build.environment');

  const filenames = binaries.map((binary) => binary.filename);
  if (new Set(filenames).size !== filenames.length) {
    throw provenanceError('malformed-manifest', `binaries contains duplicate filenames.`);
  }

  return {
    ...record,
    package: packageRecord,
    source,
    toolchain,
    build,
    binaries,
  };
}

function requireBuildContract(build) {
  requireEqual(build.command, WINDOWS_SIDECAR_BUILD.command, 'build command');
  requireEqual(build.package, WINDOWS_SIDECAR_BUILD.package, 'build package');
  if (JSON.stringify(build.flags) !== JSON.stringify(WINDOWS_SIDECAR_BUILD.flags)) {
    throw provenanceError(
      'build-input-mismatch',
      `Build flags do not match the pinned contract (${WINDOWS_SIDECAR_BUILD.flags.join(' ')}).`,
    );
  }
  const environment = requireRecord(build.environment, 'build.environment');
  requireEqual(environment.CGO_ENABLED, WINDOWS_SIDECAR_BUILD.environment.CGO_ENABLED, 'CGO_ENABLED');
  requireEqual(environment.GOOS, WINDOWS_SIDECAR_BUILD.environment.GOOS, 'GOOS');
}

function parseJsonFile(file, label, readFile) {
  let bytes;
  try {
    bytes = readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw provenanceError(
        label === 'sidecar provenance manifest' ? 'missing-manifest' : 'missing-package',
        `${label} is missing at ${file}.`,
      );
    }
    throw error;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw provenanceError('malformed-manifest', `${label} is not valid JSON at ${file}.`);
  }
}

function requireRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw provenanceError('malformed-manifest', `${field} must be an object.`);
  }
  return value;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw provenanceError('malformed-manifest', `${field} must be a non-empty string.`);
  }
}

function requirePositiveSafeInteger(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw provenanceError('malformed-manifest', `${field} must be a positive safe integer.`);
  }
}

function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    throw provenanceError(
      'build-input-mismatch',
      `${field} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function isCommit(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function provenanceError(code, message) {
  return new WindowsSidecarProvenanceError(code, message);
}
