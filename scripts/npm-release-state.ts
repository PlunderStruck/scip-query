import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { NpmPackIdentity } from './scip-windows-package-identity.js';

export const NPM_RELEASE_STATE_KIND = 'scip-query-npm-release-state';
export const NPM_RELEASE_STATE_VERSION = 1;
export const NPM_RELEASE_STAGES = [
  'local-preflight-complete',
  'sidecar-registry-verified',
  'main-registry-verified',
] as const;

export type NpmReleaseStage = (typeof NPM_RELEASE_STAGES)[number];

export interface ReleasePackageIdentity {
  name: string;
  version: string;
  size: number;
  shasum: string;
  integrity: string;
}

export interface NpmReleaseState {
  kind: typeof NPM_RELEASE_STATE_KIND;
  schemaVersion: typeof NPM_RELEASE_STATE_VERSION;
  releaseId: string;
  source: {
    gitRevision: string;
    registry: string;
  };
  packages: {
    main: ReleasePackageIdentity;
    sidecar: ReleasePackageIdentity;
  };
  completedStages: NpmReleaseStage[];
  createdAt: string;
  updatedAt: string;
  writer: {
    name: 'scip-query';
    version: string;
  };
}

export function releasePackageIdentity(pack: NpmPackIdentity): ReleasePackageIdentity {
  return {
    name: pack.name,
    version: pack.version,
    size: pack.size,
    shasum: pack.shasum,
    integrity: pack.integrity,
  };
}

export function createNpmReleaseState({
  main,
  sidecar,
  gitRevision,
  registry,
  now,
}: {
  main: ReleasePackageIdentity;
  sidecar: ReleasePackageIdentity;
  gitRevision: string;
  registry: string;
  now: string;
}): NpmReleaseState {
  requireIsoTimestamp(now, 'release state timestamp');
  const packages = { main, sidecar };
  const source = {
    gitRevision: requireGitRevision(gitRevision, 'release source git revision'),
    registry: requireHttpsRegistry(registry, 'release source registry'),
  };
  return {
    kind: NPM_RELEASE_STATE_KIND,
    schemaVersion: NPM_RELEASE_STATE_VERSION,
    releaseId: releaseIdFor(packages, source),
    source,
    packages,
    completedStages: ['local-preflight-complete'],
    createdAt: now,
    updatedAt: now,
    writer: {
      name: 'scip-query',
      version: main.version,
    },
  };
}

export function decodeNpmReleaseState(value: unknown): NpmReleaseState {
  const record = requireRecord(value, 'npm release state');
  if (record.kind !== NPM_RELEASE_STATE_KIND) {
    throw new Error(`npm release state kind mismatch.`);
  }
  if (record.schemaVersion !== NPM_RELEASE_STATE_VERSION) {
    throw new Error(
      `Unsupported npm release state schema ${String(record.schemaVersion)}; ` +
        `this release tool supports schema ${NPM_RELEASE_STATE_VERSION}.`,
    );
  }
  const sourceRecord = requireRecord(record.source, 'npm release state source');
  const source = {
    gitRevision: requireGitRevision(sourceRecord.gitRevision, 'npm release state source gitRevision'),
    registry: requireHttpsRegistry(sourceRecord.registry, 'npm release state source registry'),
  };
  const packagesRecord = requireRecord(record.packages, 'npm release state packages');
  const packages = {
    main: decodeReleasePackageIdentity(packagesRecord.main, 'main package identity'),
    sidecar: decodeReleasePackageIdentity(packagesRecord.sidecar, 'sidecar package identity'),
  };
  const releaseId = requireSha256(record.releaseId, 'npm release state releaseId');
  const expectedReleaseId = releaseIdFor(packages, source);
  if (releaseId !== expectedReleaseId) {
    throw new Error(`npm release state releaseId does not match its package identities.`);
  }
  const completedStages = decodeCompletedStages(record.completedStages);
  const createdAt = requireIsoTimestamp(record.createdAt, 'npm release state createdAt');
  const updatedAt = requireIsoTimestamp(record.updatedAt, 'npm release state updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error(`npm release state updatedAt precedes createdAt.`);
  }
  const writerRecord = requireRecord(record.writer, 'npm release state writer');
  if (writerRecord.name !== 'scip-query') {
    throw new Error(`npm release state writer name mismatch.`);
  }
  const writerVersion = requireNonEmptyString(writerRecord.version, 'npm release state writer version');
  if (writerVersion !== packages.main.version) {
    throw new Error(`npm release state writer version does not match the main package version.`);
  }

  return {
    kind: NPM_RELEASE_STATE_KIND,
    schemaVersion: NPM_RELEASE_STATE_VERSION,
    releaseId,
    source,
    packages,
    completedStages,
    createdAt,
    updatedAt,
    writer: {
      name: 'scip-query',
      version: writerVersion,
    },
  };
}

export function parseNpmReleaseStateJson(bytes: Buffer | string): NpmReleaseState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString());
  } catch {
    throw new Error(`npm release state is not valid JSON.`);
  }
  return decodeNpmReleaseState(parsed);
}

export function assertNpmReleaseStateMatches(
  state: NpmReleaseState,
  expected: Pick<NpmReleaseState, 'releaseId' | 'source' | 'packages'>,
): void {
  if (
    state.releaseId !== expected.releaseId ||
    JSON.stringify(state.source) !== JSON.stringify(expected.source) ||
    !samePackages(state.packages, expected.packages)
  ) {
    throw new Error(
      `Release state for ${expected.packages.main.name}@${expected.packages.main.version} ` +
        `records different source or package bytes. npm versions are immutable; ` +
        `resume from the recorded revision or bump the changed package version.`,
    );
  }
}

export function advanceNpmReleaseState(
  state: NpmReleaseState,
  stages: readonly NpmReleaseStage[],
  now: string,
): NpmReleaseState {
  const candidateUpdatedAt = requireIsoTimestamp(now, 'release state timestamp');
  const completed = new Set<NpmReleaseStage>(state.completedStages);
  for (const stage of stages) completed.add(stage);
  return {
    ...state,
    completedStages: NPM_RELEASE_STAGES.filter((stage) => completed.has(stage)),
    updatedAt: Date.parse(candidateUpdatedAt) >= Date.parse(state.updatedAt) ? candidateUpdatedAt : state.updatedAt,
  };
}

export function serializeNpmReleaseState(state: NpmReleaseState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function npmReleaseStatePath(
  root: string,
  main: Pick<ReleasePackageIdentity, 'name' | 'version'>,
  sidecar: Pick<ReleasePackageIdentity, 'name' | 'version'>,
): string {
  const coordinateId = createHash('sha256')
    .update(
      JSON.stringify({
        main: { name: main.name, version: main.version },
        sidecar: { name: sidecar.name, version: sidecar.version },
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return join(root, '.scipquery', 'releases', `npm-${coordinateId}.json`);
}

export function npmReleaseLockPath(root: string): string {
  return join(root, '.scipquery', 'releases', 'npm-release.lock');
}

function releaseIdFor(packages: NpmReleaseState['packages'], source: NpmReleaseState['source']): string {
  return createHash('sha256').update(JSON.stringify({ source, packages })).digest('hex');
}

function decodeReleasePackageIdentity(value: unknown, label: string): ReleasePackageIdentity {
  const record = requireRecord(value, label);
  return {
    name: requireNonEmptyString(record.name, `${label} name`),
    version: requireNonEmptyString(record.version, `${label} version`),
    size: requireNonNegativeSafeInteger(record.size, `${label} size`),
    shasum: requireSha1(record.shasum, `${label} shasum`),
    integrity: requireSha512Integrity(record.integrity, `${label} integrity`),
  };
}

function decodeCompletedStages(value: unknown): NpmReleaseStage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`npm release state completedStages must be a non-empty array.`);
  }
  const observed = value.map((stage) => {
    if (typeof stage !== 'string' || !NPM_RELEASE_STAGES.includes(stage as NpmReleaseStage)) {
      throw new Error(`npm release state contains an unsupported completed stage.`);
    }
    return stage as NpmReleaseStage;
  });
  if (new Set(observed).size !== observed.length) {
    throw new Error(`npm release state completedStages must not contain duplicates.`);
  }
  const canonical = NPM_RELEASE_STAGES.filter((stage) => observed.includes(stage));
  if (JSON.stringify(canonical) !== JSON.stringify(observed)) {
    throw new Error(`npm release state completedStages are not in canonical order.`);
  }
  if (observed[0] !== 'local-preflight-complete') {
    throw new Error(`npm release state must begin with local-preflight-complete.`);
  }
  return observed;
}

function samePackages(left: NpmReleaseState['packages'], right: NpmReleaseState['packages']): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative safe integer.`);
  }
  return value;
}

function requireSha1(value: unknown, field: string): string {
  const digest = requireNonEmptyString(value, field);
  if (!/^[a-f0-9]{40}$/.test(digest)) {
    throw new Error(`${field} must be a lowercase SHA-1 digest.`);
  }
  return digest;
}

function requireSha256(value: unknown, field: string): string {
  const digest = requireNonEmptyString(value, field);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  }
  return digest;
}

function requireGitRevision(value: unknown, field: string): string {
  const revision = requireNonEmptyString(value, field);
  if (!/^[a-f0-9]{40,64}$/.test(revision)) {
    throw new Error(`${field} must be a lowercase 40-64 character Git object ID.`);
  }
  return revision;
}

function requireHttpsRegistry(value: unknown, field: string): string {
  const registry = requireNonEmptyString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(registry);
  } catch {
    throw new Error(`${field} must be an absolute HTTPS URL.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.toString() !== registry
  ) {
    throw new Error(`${field} must be one canonical credential-free HTTPS URL.`);
  }
  return registry;
}

function requireSha512Integrity(value: unknown, field: string): string {
  const integrity = requireNonEmptyString(value, field);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`${field} must be one SHA-512 Subresource Integrity value.`);
  }
  return integrity;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requireNonEmptyString(value, field);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`${field} must be a canonical UTC ISO timestamp.`);
  }
  return timestamp;
}
