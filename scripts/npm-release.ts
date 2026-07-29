import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryAcquireProcessFileLock } from '../src/platform/process-file-lock.js';
import { replaceFileAtomic, type AtomicFileWriteResult } from '../src/storage/atomic-file.js';
import {
  advanceNpmReleaseState,
  assertNpmReleaseStateMatches,
  createNpmReleaseState,
  npmReleaseLockPath,
  npmReleaseStatePath,
  parseNpmReleaseStateJson,
  releasePackageIdentity,
  serializeNpmReleaseState,
  type NpmReleaseStage,
  type NpmReleaseState,
} from './npm-release-state.js';
import {
  decodeNpmPackTarball,
  readTarEntry,
  type DecodedNpmPackTarball,
  type RegistryDistIdentity,
  verifyRegistryNpmPackIdentity,
} from './scip-windows-package-identity.js';
import {
  DEFAULT_SCIP_REPOSITORY,
  DEFAULT_SCIP_TAG,
  PINNED_GO_VERSION,
  verifyWindowsSidecarProvenance,
  WINDOWS_SIDECAR_PROVENANCE_FILE,
} from './scip-windows-provenance.mjs';
import {
  createWindowsSidecarReleaseRuntime,
  lookupRegistryDist,
  packLocalSidecar,
  type WindowsSidecarReleaseRuntime,
  verifyExistingRegistryPackage,
} from './scip-windows-release.js';

const PREFLIGHT_TIMEOUT_MS = 10 * 60_000;
const GIT_INSPECTION_TIMEOUT_MS = 30_000;
const PACK_TIMEOUT_MS = 120_000;
const REGISTRY_VISIBILITY_DELAYS_MS = [0, 500, 1_000, 2_000] as const;
const PUBLISH_TIMEOUT_MS = 180_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

interface PackageRecord {
  name: string;
  version: string;
  optionalDependencies?: Record<string, string>;
}

export interface NpmReleaseLock {
  release(): boolean;
}

export interface NpmReleaseRuntime extends WindowsSidecarReleaseRuntime {
  acquireReleaseLock(path: string, detail: Record<string, unknown>): NpmReleaseLock;
  now(): string;
  readOptionalFile(path: string): Buffer | null;
  wait(milliseconds: number): void;
  writeReleaseState(path: string, bytes: string): AtomicFileWriteResult;
}

export interface RunNpmReleaseOptions {
  mode?: 'publish' | 'dry-run';
}

export interface NpmReleaseResult {
  mode: 'publish' | 'dry-run';
  statePath: string;
  state: NpmReleaseState;
}

export function formatNpmReleaseError(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors.map((nested) => formatNpmReleaseError(nested));
    return [error.message, ...details.map((detail) => `  - ${detail.replaceAll('\n', '\n    ')}`)].join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

interface RegistryObservation {
  kind: 'absent' | 'verified';
}

export function runNpmRelease(runtime: NpmReleaseRuntime, options: RunNpmReleaseOptions = {}): NpmReleaseResult {
  const mode = options.mode ?? 'publish';
  const root = runtime.cwd();
  const sidecarDir = join(root, 'packages', 'scip-windows');
  const mainPackage = parsePackage(runtime.readFile(join(root, 'package.json')), 'main package');
  const sidecarPackage = parsePackage(runtime.readFile(join(sidecarDir, 'package.json')), 'Windows sidecar');
  requireExactSidecarPin(mainPackage, sidecarPackage);

  const lock = runtime.acquireReleaseLock(npmReleaseLockPath(root), {
    main: `${mainPackage.name}@${mainPackage.version}`,
    sidecar: `${sidecarPackage.name}@${sidecarPackage.version}`,
  });
  let releaseDirectory: string | null = null;
  let result: NpmReleaseResult | undefined;
  let operationError: unknown;
  let lastReleaseStateWrite: AtomicFileWriteResult | undefined;
  const recordReleaseStateWrite = (write: AtomicFileWriteResult): void => {
    lastReleaseStateWrite = write;
  };
  try {
    releaseDirectory = runtime.makeTempDirectory(join(runtime.tempDirectory(), 'scip-query-npm-release-'));
    const gitRevision = requireCleanGitRevision(root, runtime);
    const registry = resolveNpmRegistry(root, runtime);
    runLocalPreflight(root, runtime);
    const localSidecar = prepareLocalSidecar(sidecarDir, sidecarPackage, releaseDirectory, runtime);
    const localMain = packLocalMain(root, mainPackage, sidecarPackage, releaseDirectory, runtime);
    requireCleanGitRevision(root, runtime, gitRevision);
    const expectedState = createNpmReleaseState({
      main: releasePackageIdentity(localMain.pack),
      sidecar: releasePackageIdentity(localSidecar.pack),
      gitRevision,
      registry,
      now: runtime.now(),
    });
    const statePath = npmReleaseStatePath(root, expectedState.packages.main, expectedState.packages.sidecar);
    let state = loadOrCreateReleaseState(statePath, expectedState, runtime, recordReleaseStateWrite);

    const sidecarObservation = observeSidecarRegistry(
      localSidecar,
      registry,
      releaseDirectory,
      'initial-sidecar',
      runtime,
    );
    const mainObservation = observeMainRegistry(localMain, registry, releaseDirectory, 'initial-main', runtime);
    const observedStages: NpmReleaseStage[] = [];
    if (sidecarObservation.kind === 'verified') observedStages.push('sidecar-registry-verified');
    if (mainObservation.kind === 'verified') observedStages.push('main-registry-verified');
    state = persistReleaseStages(statePath, state, observedStages, runtime, recordReleaseStateWrite);

    if (mode === 'dry-run') {
      logDryRunPlan(mainPackage, sidecarPackage, sidecarObservation, mainObservation, statePath, runtime);
      result = { mode, statePath, state };
    } else {
      if (sidecarObservation.kind === 'absent') {
        publishAndVerify({
          local: localSidecar,
          packageRole: 'Windows sidecar',
          publishCwd: sidecarDir,
          registry,
          verify: (attempt) =>
            observeSidecarRegistry(localSidecar, registry, releaseDirectory, `published-sidecar-${attempt}`, runtime),
          runtime,
        });
        state = persistReleaseStages(statePath, state, ['sidecar-registry-verified'], runtime, recordReleaseStateWrite);
      }

      if (mainObservation.kind === 'absent') {
        publishAndVerify({
          local: localMain,
          packageRole: 'main package',
          publishCwd: root,
          registry,
          verify: (attempt) =>
            observeMainRegistry(localMain, registry, releaseDirectory, `published-main-${attempt}`, runtime),
          runtime,
        });
        state = persistReleaseStages(statePath, state, ['main-registry-verified'], runtime, recordReleaseStateWrite);
      }

      runtime.log(
        `Release complete: ${mainPackage.name}@${mainPackage.version} and ` +
          `${sidecarPackage.name}@${sidecarPackage.version} have verified registry identities.`,
      );
      runtime.log(
        lastReleaseStateWrite
          ? `Release state (${formatAchievedDurability(lastReleaseStateWrite)}): ${statePath}`
          : `Existing release state reconciled from disk: ${statePath}`,
      );
      result = { mode, statePath, state };
    }
  } catch (error) {
    operationError = error;
  }

  const finalizationErrors: Error[] = [];
  try {
    if (releaseDirectory) runtime.removeTree(releaseDirectory);
  } catch (error) {
    finalizationErrors.push(asError(error, 'Temporary release-directory cleanup failed.'));
  }
  try {
    if (!lock.release()) {
      finalizationErrors.push(
        new Error(`npm release lock ownership changed before release; a later run must reconcile it.`),
      );
    }
  } catch (error) {
    finalizationErrors.push(asError(error, 'npm release lock release failed.'));
  }

  if (operationError !== undefined) {
    if (finalizationErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...finalizationErrors],
        `npm release failed and resource finalization also failed.`,
      );
    }
    throw operationError;
  }
  if (finalizationErrors.length === 1) throw finalizationErrors[0];
  if (finalizationErrors.length > 1) {
    throw new AggregateError(finalizationErrors, `npm release resource finalization failed.`);
  }
  if (!result) throw new Error(`npm release completed without an outcome.`);
  return result;
}

export function createNpmReleaseRuntime(): NpmReleaseRuntime {
  const base = createWindowsSidecarReleaseRuntime();
  return {
    ...base,
    acquireReleaseLock(path, detail) {
      const result = tryAcquireProcessFileLock(path, {
        kind: 'npm-release',
        detail,
      });
      if (result.kind === 'contended') {
        const owner = result.observation.owner;
        throw new Error(
          `Another npm release owns ${path}` +
            (owner ? ` (pid ${owner.pid})` : ` (${result.observation.state} lock)`) +
            `. Wait for it to finish; a dead attributable owner is reclaimed automatically.`,
        );
      }
      return result.lock;
    },
    now: () => new Date().toISOString(),
    readOptionalFile(path) {
      try {
        return readFileSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    wait(milliseconds) {
      if (milliseconds <= 0) return;
      const signal = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(signal, 0, 0, milliseconds);
    },
    writeReleaseState(path, bytes) {
      return replaceFileAtomic(path, bytes, { durability: 'durable' });
    },
  };
}

function runLocalPreflight(root: string, runtime: NpmReleaseRuntime): void {
  const commands: Array<{ label: string; args: string[] }> = [
    { label: 'typecheck', args: ['run', 'typecheck'] },
    { label: 'production dependency audit', args: ['run', 'audit:prod'] },
    { label: 'complete test suite', args: ['test'] },
    { label: 'lint, build, API compatibility, and skill links', args: ['run', 'lint'] },
  ];
  for (const command of commands) {
    runtime.log(`Preflight: ${command.label}...`);
    runtime.run('npm', command.args, {
      cwd: root,
      stdio: 'inherit',
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
      maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    });
  }
}

function resolveNpmRegistry(root: string, runtime: NpmReleaseRuntime): string {
  const observed = runtime
    .run('npm', ['config', 'get', 'registry'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: GIT_INSPECTION_TIMEOUT_MS,
      maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    })
    .trim();
  let parsed: URL;
  try {
    parsed = new URL(observed);
  } catch {
    throw new Error('npm registry must be an absolute HTTPS URL; received an invalid registry value.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      `npm registry must be a credential-free HTTPS URL; received ${formatRegistryForDiagnostic(parsed)}.`,
    );
  }
  const registry = parsed.toString();
  runtime.log(`Release registry: ${registry}`);
  return registry;
}

function formatRegistryForDiagnostic(registry: URL): string {
  const safe = new URL(registry);
  if (safe.username) safe.username = 'redacted';
  if (safe.password) safe.password = 'redacted';
  if (safe.search) safe.search = '?redacted';
  if (safe.hash) safe.hash = '#redacted';
  return JSON.stringify(safe.toString());
}

function requireCleanGitRevision(root: string, runtime: NpmReleaseRuntime, expected?: string): string {
  const revision = runtime
    .run('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: GIT_INSPECTION_TIMEOUT_MS,
      maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    })
    .trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) {
    throw new Error(`Git returned an invalid release revision: ${JSON.stringify(revision)}.`);
  }
  if (expected && revision !== expected) {
    throw new Error(
      `Git HEAD changed during release preflight (${expected} -> ${revision}); refusing registry mutation.`,
    );
  }
  const workingTreeChanges = runtime.run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: GIT_INSPECTION_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
  });
  if (workingTreeChanges.trim().length > 0) {
    throw new Error(
      `The working tree is dirty at release preflight; commit, remove, or ignore every listed path before publishing:\n${workingTreeChanges.trim()}`,
    );
  }
  return revision;
}

function prepareLocalSidecar(
  sidecarDir: string,
  expected: PackageRecord,
  releaseDirectory: string,
  runtime: NpmReleaseRuntime,
) {
  const manifest = verifyWindowsSidecarProvenance({
    sidecarDir,
    expectedSourceRepository: runtime.env.SCIP_REPO_URL ?? DEFAULT_SCIP_REPOSITORY,
    expectedSourceTag: runtime.env.SCIP_VERSION ?? DEFAULT_SCIP_TAG,
    expectedGoVersion: runtime.env.SCIP_GO_VERSION ?? PINNED_GO_VERSION,
    readFile: runtime.readFile,
  });
  const local = packLocalSidecar(sidecarDir, releaseDirectory, runtime);
  const packedPackage = parsePackage(
    readTarEntry(runtime.readFile(local.pack.tarballPath), 'package/package.json'),
    'packed Windows sidecar',
  );
  requireEqual(packedPackage.name, expected.name, 'packed Windows sidecar package name');
  requireEqual(packedPackage.version, expected.version, 'packed Windows sidecar package version');
  const localManifestBytes = runtime.readFile(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE));
  if (!local.provenanceBytes.equals(localManifestBytes)) {
    throw new Error(`Packed sidecar provenance does not equal the reviewed local provenance.json bytes.`);
  }
  runtime.log(
    `Preflight packed ${local.pack.name}@${local.pack.version}: ${local.pack.integrity}; ` +
      `${manifest.source.tag} (${manifest.source.commit.slice(0, 12)}).`,
  );
  return local;
}

function packLocalMain(
  root: string,
  expected: PackageRecord,
  sidecar: PackageRecord,
  releaseDirectory: string,
  runtime: NpmReleaseRuntime,
): DecodedNpmPackTarball {
  const packDirectory = join(releaseDirectory, 'main');
  runtime.mkdir(packDirectory);
  const output = runtime.run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: PACK_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
  });
  const local = decodeNpmPackTarball(output, packDirectory, runtime.readFile);
  requireEqual(local.pack.name, expected.name, 'packed main package name');
  requireEqual(local.pack.version, expected.version, 'packed main package version');
  const packedPackage = parsePackage(readTarEntry(local.bytes, 'package/package.json'), 'packed main package');
  requireEqual(packedPackage.name, expected.name, 'packed main package.json name');
  requireEqual(packedPackage.version, expected.version, 'packed main package.json version');
  requireExactSidecarPin(packedPackage, sidecar);
  runtime.log(
    `Preflight packed ${local.pack.name}@${local.pack.version}: ${local.pack.integrity}, ` +
      `${local.pack.entryCount} entries.`,
  );
  return local;
}

function loadOrCreateReleaseState(
  path: string,
  expected: NpmReleaseState,
  runtime: NpmReleaseRuntime,
  onWrite: (write: AtomicFileWriteResult) => void,
): NpmReleaseState {
  const existing = runtime.readOptionalFile(path);
  if (existing) {
    const state = parseNpmReleaseStateJson(existing);
    assertNpmReleaseStateMatches(state, expected);
    return state;
  }
  const write = runtime.writeReleaseState(path, serializeNpmReleaseState(expected));
  onWrite(write);
  runtime.log(`Recorded local preflight state (${formatAchievedDurability(write)}) at ${path}.`);
  return expected;
}

function persistReleaseStages(
  path: string,
  state: NpmReleaseState,
  stages: readonly NpmReleaseStage[],
  runtime: NpmReleaseRuntime,
  onWrite: (write: AtomicFileWriteResult) => void,
): NpmReleaseState {
  if (stages.every((stage) => state.completedStages.includes(stage))) return state;
  const next = advanceNpmReleaseState(state, stages, runtime.now());
  const write = runtime.writeReleaseState(path, serializeNpmReleaseState(next));
  onWrite(write);
  runtime.log(`Recorded release stages ${next.completedStages.join(', ')} (${formatAchievedDurability(write)}).`);
  return next;
}

function formatAchievedDurability(write: AtomicFileWriteResult): string {
  return write.achievedDurability === 'file-flushed'
    ? 'file-flushed; directory sync unsupported'
    : write.achievedDurability;
}

function observeSidecarRegistry(
  local: ReturnType<typeof packLocalSidecar>,
  registry: string,
  releaseDirectory: string,
  observationName: string,
  runtime: NpmReleaseRuntime,
): RegistryObservation {
  const dist = lookupRegistryDist(local.pack.name, local.pack.version, runtime, registry);
  if (!dist) return { kind: 'absent' };
  verifyExistingRegistryPackage(local, dist, join(releaseDirectory, observationName), runtime, registry);
  return { kind: 'verified' };
}

function observeMainRegistry(
  local: DecodedNpmPackTarball,
  registry: string,
  releaseDirectory: string,
  observationName: string,
  runtime: NpmReleaseRuntime,
): RegistryObservation {
  const dist = lookupRegistryDist(local.pack.name, local.pack.version, runtime, registry);
  if (!dist) return { kind: 'absent' };
  verifyExistingMainRegistryPackage(local, dist, join(releaseDirectory, observationName), runtime, registry);
  return { kind: 'verified' };
}

function verifyExistingMainRegistryPackage(
  local: DecodedNpmPackTarball,
  registryDist: RegistryDistIdentity,
  observationDirectory: string,
  runtime: NpmReleaseRuntime,
  registry: string,
): DecodedNpmPackTarball {
  const registryDirectory = join(observationDirectory, 'registry');
  runtime.mkdir(registryDirectory);
  const output = runtime.run(
    'npm',
    [
      'pack',
      `${local.pack.name}@${local.pack.version}`,
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      registryDirectory,
      '--registry',
      registry,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: PACK_TIMEOUT_MS,
      maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    },
  );
  return verifyRegistryNpmPackIdentity({
    local,
    registryDist,
    registryPackOutput: output,
    registryPackDirectory: registryDirectory,
    readFile: runtime.readFile,
    contentLabel: 'main package',
  });
}

function publishAndVerify({
  local,
  packageRole,
  publishCwd,
  registry,
  verify,
  runtime,
}: {
  local: { pack: DecodedNpmPackTarball['pack'] };
  packageRole: string;
  publishCwd: string;
  registry: string;
  verify(attempt: number): RegistryObservation;
  runtime: NpmReleaseRuntime;
}): void {
  runtime.log(`Publishing ${packageRole} ${local.pack.name}@${local.pack.version} from its verified tarball...`);
  let publishError: unknown;
  try {
    runtime.run('npm', ['publish', local.pack.tarballPath, '--ignore-scripts', '--registry', registry], {
      cwd: publishCwd,
      stdio: 'inherit',
      timeoutMs: PUBLISH_TIMEOUT_MS,
      maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    });
  } catch (error) {
    publishError = error;
  }

  for (let attempt = 0; attempt < REGISTRY_VISIBILITY_DELAYS_MS.length; attempt += 1) {
    runtime.wait(REGISTRY_VISIBILITY_DELAYS_MS[attempt]);
    let observation: RegistryObservation;
    try {
      observation = verify(attempt + 1);
    } catch (verificationError) {
      if (publishError !== undefined) {
        throw new AggregateError(
          [publishError, verificationError],
          `${packageRole} publication failed and registry reconciliation also failed: ` +
            formatNpmReleaseError(verificationError),
          { cause: verificationError },
        );
      }
      throw verificationError;
    }
    if (observation.kind === 'verified') {
      runtime.log(
        publishError
          ? `${packageRole} publish raced or returned ambiguously; the winning registry identity is exact.`
          : `${packageRole} registry identity verified after publication.`,
      );
      return;
    }
  }

  if (publishError) throw publishError;
  throw new Error(
    `${packageRole} ${local.pack.name}@${local.pack.version} was not visible with the intended identity ` +
      `after bounded post-publish verification. Retry the release coordinator; do not republish blindly.`,
  );
}

function logDryRunPlan(
  main: PackageRecord,
  sidecar: PackageRecord,
  sidecarObservation: RegistryObservation,
  mainObservation: RegistryObservation,
  statePath: string,
  runtime: NpmReleaseRuntime,
): void {
  runtime.log(
    `[dry-run] preflight complete; registry sidecar=${sidecarObservation.kind}, main=${mainObservation.kind}.`,
  );
  if (sidecarObservation.kind === 'absent') {
    runtime.log(`[dry-run] would publish and verify ${sidecar.name}@${sidecar.version} first.`);
  }
  if (mainObservation.kind === 'absent') {
    runtime.log(`[dry-run] would publish and verify ${main.name}@${main.version} last.`);
  }
  runtime.log(`[dry-run] no registry mutation performed. Durable local state: ${statePath}`);
}

function parsePackage(bytes: Buffer, label: string): PackageRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} package.json is malformed.`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as Partial<PackageRecord>).name !== 'string' ||
    typeof (parsed as Partial<PackageRecord>).version !== 'string'
  ) {
    throw new Error(`${label} package.json is missing its name or version.`);
  }
  return parsed as PackageRecord;
}

function requireExactSidecarPin(main: PackageRecord, sidecar: PackageRecord): void {
  const pin = main.optionalDependencies?.[sidecar.name];
  if (!pin) {
    throw new Error(`package.json has no optionalDependencies entry for ${sidecar.name}.`);
  }
  if (pin !== sidecar.version) {
    throw new Error(`optionalDependencies pin (${pin}) != packages/scip-windows version (${sidecar.version}).`);
  }
}

function requireEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(`${field} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(`${fallback} ${String(error)}`);
}
