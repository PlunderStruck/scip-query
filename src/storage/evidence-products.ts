import type { ScipDatabase } from './db.js';
import { profileEnabled, profileSpan, profileWorkIdentity } from '../instrumentation/profile.js';
import {
  FILE_EVIDENCE_KINDS,
  PROJECT_EVIDENCE_KINDS,
  hasCachedFileEvidence,
  readCachedFileEvidence,
  readCachedProjectEvidence,
  projectEvidenceFingerprint,
  writeCachedFileEvidenceBatch,
  writeCachedFileEvidence,
  writeCachedProjectEvidence,
  type FileEvidenceKind,
  type ProjectEvidenceKind,
} from './evidence-cache.js';

export type EvidenceProductScope = 'file' | 'project';

export type EvidenceProductDependency =
  | 'content-hash'
  | 'direct-deps-digest'
  | 'transitive-deps-digest'
  | 'project-fingerprint'
  | 'import-resolution-fingerprint'
  | 'git-head'
  | 'git-history'
  | 'config'
  | 'tool-version'
  | 'indexed-language-set';

export interface EvidenceProductInvalidation {
  scope: EvidenceProductScope;
  dependsOn: readonly EvidenceProductDependency[];
  keyParts: readonly string[];
  stalenessTest: string;
  owner: string;
}

export type EvidenceProductManifestEntry =
  | {
      scope: 'file';
      kind: FileEvidenceKind;
      invalidation: EvidenceProductInvalidation;
    }
  | {
      scope: 'project';
      kind: ProjectEvidenceKind;
      invalidation: EvidenceProductInvalidation;
    };

export interface EvidenceProductManifestValidation {
  missing: string[];
  duplicate: string[];
  unknown: string[];
}

export interface FileEvidenceProduct<T> {
  kind: FileEvidenceKind;
  read(db: ScipDatabase, relativePath: string, contentHash: string): T | null;
  /** Whether a row exists for this identity, without transferring or parsing its payload. */
  has(db: ScipDatabase, relativePath: string, contentHash: string): boolean;
  write(db: ScipDatabase, relativePath: string, contentHash: string, value: T): void;
  writeBatch(db: ScipDatabase, entries: ReadonlyArray<{ relativePath: string; contentHash: string; value: T }>): void;
}

export interface FileEvidenceProductOptions<T> {
  kind: FileEvidenceKind;
  invalidation: EvidenceProductInvalidation;
  serialize(value: T): string;
  deserialize(payload: string): T | null;
}

export interface ProjectEvidenceProduct<T> {
  kind: ProjectEvidenceKind;
  read(db: ScipDatabase, cacheKey: string, projectFingerprint: string): T | null;
  write(db: ScipDatabase, cacheKey: string, projectFingerprint: string, value: T): void;
}

export interface ProjectEvidenceProductOptions<T> {
  kind: ProjectEvidenceKind;
  invalidation: EvidenceProductInvalidation;
  serialize(value: T): string;
  deserialize(payload: string): T | null;
}

export const EVIDENCE_PRODUCT_MANIFEST: readonly EvidenceProductManifestEntry[] = [
  fileManifest('source-facts', {
    dependsOn: ['content-hash', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-cache.test.ts',
    owner: 'src/source/source-facts.ts',
  }),
  fileManifest('file-definitions', {
    dependsOn: ['content-hash', 'project-fingerprint', 'indexed-language-set', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'projectFingerprint', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-cache.test.ts',
    owner: 'src/symbols/definition-catalog.ts',
  }),
  fileManifest('definition-exclusions', {
    dependsOn: ['content-hash', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-cache.test.ts',
    owner: 'src/analysis/framework-patterns.ts',
  }),
  fileManifest('doc-path-tokens', {
    dependsOn: ['content-hash', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-products.test.ts',
    owner: 'tests/storage/evidence-cache.test.ts',
  }),
  fileManifest('doc-path-evidence', {
    dependsOn: ['content-hash', 'git-history', 'git-head', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'trackedFiles', 'historyWindow', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-cache.test.ts',
    owner: 'src/queries/cleanup/doc-drift.ts',
  }),
  fileManifest('source-imports', {
    dependsOn: ['content-hash', 'import-resolution-fingerprint', 'config', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'importResolutionFingerprint', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-cache.test.ts',
    owner: 'src/language-parsers/index.ts',
  }),
  fileManifest('source-reexports', {
    dependsOn: ['content-hash', 'import-resolution-fingerprint', 'config', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'importResolutionFingerprint', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-cache.test.ts',
    owner: 'src/language-parsers/index.ts',
  }),
  fileManifest('source-fingerprints', {
    dependsOn: ['content-hash', 'project-fingerprint', 'indexed-language-set', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'projectFingerprint', 'payloadVersion'],
    stalenessTest: 'tests/symbols/definition-catalog.test.ts',
    owner: 'src/queries/cleanup/similar.ts',
  }),
  fileManifest('consumer-file-usage', {
    dependsOn: ['content-hash', 'project-fingerprint', 'indexed-language-set', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'projectFingerprint', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-cache.test.ts',
    owner: 'src/queries/internal/consumer-evidence.ts',
  }),
  fileManifest('react-component-behavior-profiles', {
    dependsOn: ['content-hash', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-cache.test.ts',
    owner: 'src/source/react-profile.ts',
  }),
  fileManifest('git-file-adds', {
    dependsOn: ['git-head', 'git-history', 'tool-version'],
    keyParts: ['kind', 'cacheKey', 'head', 'historyWindow', 'payloadVersion'],
    stalenessTest: 'tests/storage/evidence-cache.test.ts',
    owner: 'src/analysis/git-history.ts',
  }),
  fileManifest('typescript-reference-fragments', {
    dependsOn: ['content-hash', 'transitive-deps-digest', 'config', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'semanticIdentity', 'payloadVersion'],
    stalenessTest: 'tests/semantic/typescript/typescript-reference-fragments.test.ts',
    owner: 'src/semantic/typescript/reference-fragment-shadow.ts',
  }),
  fileManifest('typescript-import-usage', {
    dependsOn: ['content-hash', 'transitive-deps-digest', 'config', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'semanticIdentity', 'payloadVersion'],
    stalenessTest: 'tests/semantic/typescript/typescript-semantic-provider.test.ts',
    owner: 'src/semantic/shared-primitives.ts',
  }),
  fileManifest('typescript-signatures', {
    dependsOn: ['content-hash', 'transitive-deps-digest', 'config', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'semanticIdentity', 'payloadVersion'],
    stalenessTest: 'tests/semantic/typescript/typescript-semantic-provider.test.ts',
    owner: 'src/semantic/shared-primitives.ts',
  }),
  fileManifest('runtime-boundary-http-roles', {
    dependsOn: ['content-hash', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'payloadVersion'],
    stalenessTest: 'tests/analysis/runtime-boundaries.test.ts',
    owner: 'src/analysis/runtime-boundaries/http-summaries.ts',
  }),
  fileManifest('runtime-boundary-source-hashes', {
    dependsOn: ['content-hash', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'payloadVersion'],
    stalenessTest: 'tests/analysis/runtime-boundaries.test.ts',
    owner: 'src/analysis/runtime-boundaries/graph.ts',
  }),
  fileManifest('runtime-boundary-direct-extraction', {
    // direct-deps-digest: the payload names every consulted file with its
    // content hash (recorded at the shared read chokepoints), and the read
    // path revalidates each one before serving the cached extraction.
    dependsOn: ['content-hash', 'direct-deps-digest', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'contentHash', 'payloadVersion'],
    stalenessTest: 'tests/analysis/runtime-boundaries.test.ts',
    owner: 'src/analysis/runtime-boundaries/graph.ts',
  }),
  projectManifest('file-dependency-graph', {
    dependsOn: ['project-fingerprint', 'indexed-language-set', 'import-resolution-fingerprint', 'tool-version'],
    keyParts: ['kind', 'scope', 'projectFingerprint', 'payloadVersion'],
    stalenessTest: 'tests/symbols/file-dep-graph.test.ts',
    owner: 'src/symbols/graph/file-dep-graph.ts',
  }),
  projectManifest('semantic-import-usage', {
    dependsOn: ['project-fingerprint', 'indexed-language-set', 'import-resolution-fingerprint', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'projectFingerprint', 'language', 'semanticEngine', 'payloadVersion'],
    stalenessTest: 'tests/semantic/rust/rust-semantic-cache-gate.test.ts',
    owner: 'src/semantic/shared-primitives.ts',
  }),
  projectManifest('semantic-signatures', {
    dependsOn: ['project-fingerprint', 'indexed-language-set', 'tool-version'],
    keyParts: ['kind', 'relativePath', 'symbol', 'projectFingerprint', 'language', 'semanticEngine', 'payloadVersion'],
    stalenessTest: 'tests/semantic/rust/rust-semantic-cache-gate.test.ts',
    owner: 'src/semantic/shared-primitives.ts',
  }),
  projectManifest('health-semantic-prewarm', {
    dependsOn: ['project-fingerprint', 'indexed-language-set', 'tool-version'],
    keyParts: ['kind', 'scope', 'cliVersion', 'projectFingerprint', 'payloadVersion'],
    stalenessTest: 'tests/runtime/cli-support.test.ts',
    owner: 'src/runtime/cli-support.ts',
  }),
  projectManifest('typescript-hierarchy-targets', {
    dependsOn: ['project-fingerprint', 'indexed-language-set', 'tool-version'],
    keyParts: ['kind', 'definitionSet', 'projectFingerprint', 'payloadVersion'],
    stalenessTest: 'tests/semantic/typescript/typescript-semantic-provider.test.ts',
    owner: 'src/semantic/typescript/ts-morph-provider.ts',
  }),
];

export function createFileEvidenceProduct<T>(opts: FileEvidenceProductOptions<T>): FileEvidenceProduct<T> {
  const profileIdentities = new Map<string, string>();
  return {
    kind: opts.kind,
    read(db, relativePath, contentHash) {
      let hit = false;
      let payloadBytes = 0;
      let workIdentity: string | undefined;
      if (profileEnabled()) {
        const projectFingerprint = projectEvidenceFingerprint(db);
        if (projectFingerprint) {
          const identityKey = `${projectFingerprint}\0${relativePath}\0${contentHash}`;
          workIdentity = profileIdentities.get(identityKey);
          if (!workIdentity) {
            workIdentity = profileWorkIdentity([
              'evidence-product-file-read-v1',
              opts.kind,
              projectFingerprint,
              relativePath,
              contentHash,
            ]);
            profileIdentities.set(identityKey, workIdentity);
          }
        }
      }
      return profileSpan(
        'evidence-product.file.read',
        () => {
          const payload = readCachedFileEvidence(db, opts.kind, relativePath, contentHash);
          if (payload === null) return null;
          payloadBytes = payload.length;
          try {
            const value = opts.deserialize(payload);
            hit = value !== null;
            return value;
          } catch {
            return null;
          }
        },
        () => ({
          ...(workIdentity ? { workIdentity, workOutcome: 'computed' } : {}),
          scope: 'file',
          kind: opts.kind,
          available: true,
          hit,
          payloadBytes,
        }),
      );
    },
    has(db, relativePath, contentHash) {
      return hasCachedFileEvidence(db, opts.kind, relativePath, contentHash);
    },
    write(db, relativePath, contentHash, value) {
      writeCachedFileEvidence(db, opts.kind, relativePath, contentHash, opts.serialize(value));
    },
    writeBatch(db, entries) {
      writeCachedFileEvidenceBatch(
        db,
        entries.map((entry) => ({
          kind: opts.kind,
          relativePath: entry.relativePath,
          contentHash: entry.contentHash,
          payload: opts.serialize(entry.value),
        })),
      );
    },
  };
}

export function createProjectEvidenceProduct<T>(opts: ProjectEvidenceProductOptions<T>): ProjectEvidenceProduct<T> {
  const profileIdentities = new Map<string, string>();
  return {
    kind: opts.kind,
    read(db, cacheKey, projectFingerprint) {
      let hit = false;
      let payloadBytes = 0;
      let workIdentity: string | undefined;
      if (profileEnabled()) {
        const identityKey = `${projectFingerprint}\0${cacheKey}`;
        workIdentity = profileIdentities.get(identityKey);
        if (!workIdentity) {
          workIdentity = profileWorkIdentity([
            'evidence-product-project-read-v1',
            opts.kind,
            projectFingerprint,
            cacheKey,
          ]);
          profileIdentities.set(identityKey, workIdentity);
        }
      }
      return profileSpan(
        'evidence-product.project.read',
        () => {
          const payload = readCachedProjectEvidence(db, opts.kind, cacheKey, projectFingerprint);
          if (payload === null) return null;
          payloadBytes = payload.length;
          try {
            const value = opts.deserialize(payload);
            hit = value !== null;
            return value;
          } catch {
            return null;
          }
        },
        () => ({
          ...(workIdentity ? { workIdentity, workOutcome: 'computed' } : {}),
          scope: 'project',
          kind: opts.kind,
          available: true,
          hit,
          payloadBytes,
        }),
      );
    },
    write(db, cacheKey, projectFingerprint, value) {
      writeCachedProjectEvidence(db, opts.kind, cacheKey, projectFingerprint, opts.serialize(value));
    },
  };
}

export function validateEvidenceProductManifest(
  manifest: readonly EvidenceProductManifestEntry[] = EVIDENCE_PRODUCT_MANIFEST,
): EvidenceProductManifestValidation {
  const expected = new Set([
    ...FILE_EVIDENCE_KINDS.map((kind) => `file:${kind}`),
    ...PROJECT_EVIDENCE_KINDS.map((kind) => `project:${kind}`),
  ]);
  const seen = new Map<string, number>();
  for (const entry of manifest) {
    const key = `${entry.scope}:${entry.kind}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return {
    missing: [...expected].filter((key) => !seen.has(key)).sort(),
    duplicate: [...seen]
      .filter(([, count]) => count > 1)
      .map(([key]) => key)
      .sort(),
    unknown: [...seen]
      .filter(([key]) => !expected.has(key))
      .map(([key]) => key)
      .sort(),
  };
}

export function evidenceProductInvalidation(kind: FileEvidenceKind | ProjectEvidenceKind): EvidenceProductInvalidation {
  const entry = EVIDENCE_PRODUCT_MANIFEST.find((candidate) => candidate.kind === kind);
  if (!entry) throw new Error(`missing evidence product manifest entry for ${kind}`);
  return entry.invalidation;
}

function fileManifest(
  kind: FileEvidenceKind,
  invalidation: Omit<EvidenceProductInvalidation, 'scope'>,
): EvidenceProductManifestEntry {
  return { scope: 'file', kind, invalidation: { scope: 'file', ...invalidation } };
}

function projectManifest(
  kind: ProjectEvidenceKind,
  invalidation: Omit<EvidenceProductInvalidation, 'scope'>,
): EvidenceProductManifestEntry {
  return { scope: 'project', kind, invalidation: { scope: 'project', ...invalidation } };
}
