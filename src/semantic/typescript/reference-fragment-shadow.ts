import type { IndexedDefinition } from '../../domain/types.js';
import type { FileDependencyGraph, ProjectInputSnapshot } from '../../domain/project-input.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { createFileEvidenceProduct, evidenceProductInvalidation } from '../../storage/evidence-products.js';
import type { ScipDatabase } from '../../storage/db.js';
import type { SemanticProvider, SemanticReference, SemanticReferenceFragment } from '../types.js';
import { indexedTypeScriptFiles, typeScriptSemanticIdentityForFile } from './semantic-identity-context.js';
import { isTypeScriptLike } from './source-kinds.js';
import {
  assembleReferenceFragments,
  compareReferenceFragmentMaps,
  createReferenceFragmentAccumulator,
} from './reference-fragments.js';
import { createTypeScriptSemanticIdentityBuilder } from './semantic-identity.js';
import { typeScriptSemanticEngineIdentity } from './ts-morph-runtime.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';

export const TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA = 'typescript-reference-fragment-v2';
const TYPESCRIPT_REFERENCE_FRAGMENT_BATCH_SIZE = 128;

/**
 * Resolves the semantic provider for a file. Injected so this module stays
 * below the provider registry that constructs TypeScript providers.
 */
export type SemanticProviderResolver = (relativePath: string) => SemanticProvider;

export interface TypeScriptReferenceFragmentShadowResult {
  state: 'passing' | 'failing' | 'unavailable';
  files: number;
  keyedFiles: number;
  writtenFiles: number;
  expectedCount: number;
  actualCount: number;
  missing: string[];
  extra: string[];
  reason?: string;
}

export interface TypeScriptReferenceFragmentMaterialization {
  references: Map<number, SemanticReference[]>;
  files: number;
  cacheHits: number;
  cacheMisses: number;
  computedFiles: number;
}

export interface TypeScriptReferenceFragmentSeedResult {
  affectedFiles: number;
  carriedFiles: number;
  skippedAffectedFiles: number;
}

const REFERENCE_FRAGMENT_PRODUCT = createFileEvidenceProduct<SemanticReferenceFragment[]>({
  kind: 'typescript-reference-fragments',
  invalidation: evidenceProductInvalidation('typescript-reference-fragments'),
  serialize: (value) => JSON.stringify(value),
  deserialize: parseReferenceFragments,
});

export function seedTypeScriptReferenceFragments(
  identityDb: ScipDatabase,
  snapshot: ProjectInputSnapshot,
  fragmentsByFile: ReadonlyMap<string, readonly SemanticReferenceFragment[]>,
  evidenceDb: ScipDatabase = identityDb,
  dependencyGraph?: FileDependencyGraph,
  invalidatedFiles: ReadonlySet<string> = new Set(fragmentsByFile.keys()),
): TypeScriptReferenceFragmentSeedResult {
  const projectFiles = indexedTypeScriptFiles(identityDb);
  const builder = createTypeScriptSemanticIdentityBuilder({
    projectFiles,
    snapshot,
    graph: dependencyGraph ?? buildFileDepGraph(identityDb),
    engineIdentity: typeScriptSemanticEngineIdentity(),
  });
  const writes: Array<{ relativePath: string; contentHash: string; value: SemanticReferenceFragment[] }> = [];
  let skippedAffectedFiles = 0;
  for (const [relativePath, fragments] of fragmentsByFile) {
    const contentHash = builder.identityFor(relativePath, TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA).key;
    if (!contentHash) {
      skippedAffectedFiles += 1;
      continue;
    }
    writes.push({ relativePath, contentHash, value: [...fragments] });
  }
  // The affected-set closure contains every document whose semantic identity
  // can change. Rows outside that closure keep the same identity and therefore
  // remain valid in the shared evidence database without an O(project files)
  // rekey scan.
  const carriedFiles = projectFiles.filter(
    (relativePath) => !invalidatedFiles.has(relativePath) && !fragmentsByFile.has(relativePath),
  ).length;
  REFERENCE_FRAGMENT_PRODUCT.writeBatch(evidenceDb, writes);
  return { affectedFiles: writes.length, carriedFiles, skippedAffectedFiles };
}

// scip-query: ignore-similar — shadow recording compares results; materialization produces them.
export function recordTypeScriptReferenceFragmentShadow(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  expected: ReadonlyMap<number, readonly SemanticReference[]>,
  resolveProvider: SemanticProviderResolver,
): TypeScriptReferenceFragmentShadowResult {
  const typeScriptDefinitions = definitions.filter((definition) => isTypeScriptLike(definition.relativePath));
  if (typeScriptDefinitions.length === 0) return unavailable('no TypeScript definitions');

  let result = unavailable('shadow did not run');
  return profileSpan(
    'typescript.reference-fragments.shadow',
    () => {
      try {
        const provider = resolveProvider(typeScriptDefinitions[0]!.relativePath);
        if (!provider.availability().available || !provider.referenceFragmentsForFiles) {
          result = unavailable('TypeScript reference fragment provider is unavailable');
          return result;
        }
        const files = indexedTypeScriptFiles(db);
        const indexedFiles = new Set(files);
        const fragments = new Map<string, SemanticReferenceFragment[]>();
        for (const batch of typeScriptReferenceFragmentBatches(files)) {
          const computed = provider.referenceFragmentsForFiles(batch);
          if (batch.some((file) => !computed.has(file))) {
            result = unavailable('TypeScript reference fragment provider returned an incomplete batch');
            return result;
          }
          for (const file of batch) fragments.set(file, computed.get(file) ?? []);
        }
        const actual = assembleReferenceFragments(typeScriptDefinitions, fragments);
        const parity = compareReferenceFragmentMaps(
          typeScriptDefinitions,
          referencesWithinFiles(expected, indexedFiles),
          actual,
        );
        if (!parity.passed) {
          result = {
            state: 'failing',
            files: files.length,
            keyedFiles: 0,
            writtenFiles: 0,
            ...parity,
          };
          return result;
        }

        const writes: Array<{ relativePath: string; contentHash: string; value: SemanticReferenceFragment[] }> = [];
        for (const file of files) {
          const identity = typeScriptSemanticIdentityForFile(db, file, TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA);
          if (!identity?.key) continue;
          writes.push({
            relativePath: file,
            contentHash: identity.key,
            value: fragments.get(file) ?? [],
          });
        }
        REFERENCE_FRAGMENT_PRODUCT.writeBatch(db, writes);
        result = {
          state: 'passing',
          files: files.length,
          keyedFiles: writes.length,
          writtenFiles: writes.length,
          ...parity,
        };
        return result;
      } catch (error) {
        result = unavailable(error instanceof Error ? error.message : String(error));
        return result;
      }
    },
    () => ({ ...result }),
  );
}

function referencesWithinFiles(
  references: ReadonlyMap<number, readonly SemanticReference[]>,
  files: ReadonlySet<string>,
): Map<number, SemanticReference[]> {
  return new Map(
    [...references].map(([symbolId, locations]) => [
      symbolId,
      locations.filter((location) => files.has(location.file)),
    ]),
  );
}

// scip-query: ignore-passthrough — public read side of the TypeScript reference
// fragment product, paired with materialization and used by cache-contract tests.
export function readTypeScriptReferenceFragment(
  db: ScipDatabase,
  relativePath: string,
  semanticIdentity: string,
): SemanticReferenceFragment[] | null {
  return REFERENCE_FRAGMENT_PRODUCT.read(db, relativePath, semanticIdentity);
}

export function materializeTypeScriptReferenceFragments(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  resolveProvider: SemanticProviderResolver,
): TypeScriptReferenceFragmentMaterialization | null {
  if (definitions.length === 0) {
    return { references: new Map(), files: 0, cacheHits: 0, cacheMisses: 0, computedFiles: 0 };
  }
  let state = 'fallback';
  let files = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let computedFiles = 0;
  return profileSpan(
    'typescript.reference-fragments.materialize',
    () => {
      try {
        const projectFiles = indexedTypeScriptFiles(db);
        files = projectFiles.length;
        const accumulator = createReferenceFragmentAccumulator(definitions);
        const missingFiles: Array<{ file: string; contentHash: string }> = [];
        for (const file of projectFiles) {
          const identity = typeScriptSemanticIdentityForFile(db, file, TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA);
          if (!identity?.key) return null;
          const cached = REFERENCE_FRAGMENT_PRODUCT.read(db, file, identity.key);
          if (cached === null) {
            cacheMisses += 1;
            missingFiles.push({ file, contentHash: identity.key });
          } else {
            cacheHits += 1;
            accumulator.add(cached);
          }
        }
        if (cacheMisses === 0) {
          state = 'hit';
          return {
            references: accumulator.finish(),
            files,
            cacheHits,
            cacheMisses,
            computedFiles,
          };
        }

        const provider = resolveProvider(definitions[0]!.relativePath);
        if (!provider.availability().available || !provider.referenceFragmentsForFiles) return null;
        for (const batch of typeScriptReferenceFragmentBatches(missingFiles)) {
          const filesInBatch = batch.map(({ file }) => file);
          const computed = provider.referenceFragmentsForFiles(filesInBatch);
          if (filesInBatch.some((file) => !computed.has(file))) return null;
          REFERENCE_FRAGMENT_PRODUCT.writeBatch(
            db,
            batch.map(({ file, contentHash }) => ({
              relativePath: file,
              contentHash,
              value: computed.get(file) ?? [],
            })),
          );
          for (const file of filesInBatch) accumulator.add(computed.get(file) ?? []);
          computedFiles += batch.length;
        }
        state = 'computed';
        return {
          references: accumulator.finish(),
          files,
          cacheHits,
          cacheMisses,
          computedFiles,
        };
      } catch {
        return null;
      }
    },
    () => ({ state, files, cacheHits, cacheMisses, computedFiles }),
  );
}

export function typeScriptReferenceFragmentBatches<T>(files: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < files.length; offset += TYPESCRIPT_REFERENCE_FRAGMENT_BATCH_SIZE) {
    batches.push(files.slice(offset, offset + TYPESCRIPT_REFERENCE_FRAGMENT_BATCH_SIZE));
  }
  return batches;
}

function unavailable(reason: string): TypeScriptReferenceFragmentShadowResult {
  return {
    state: 'unavailable',
    files: 0,
    keyedFiles: 0,
    writtenFiles: 0,
    expectedCount: 0,
    actualCount: 0,
    missing: [],
    extra: [],
    reason,
  };
}

function parseReferenceFragments(payload: string): SemanticReferenceFragment[] | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(isReferenceFragment)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isReferenceFragment(value: unknown): value is SemanticReferenceFragment {
  if (!value || typeof value !== 'object') return false;
  const fragment = value as Partial<SemanticReferenceFragment>;
  const location = fragment.location as Partial<SemanticReference> | undefined;
  return (
    typeof fragment.targetSymbol === 'string' &&
    !!location &&
    typeof location.file === 'string' &&
    typeof location.line === 'number' &&
    typeof location.column === 'number'
  );
}
