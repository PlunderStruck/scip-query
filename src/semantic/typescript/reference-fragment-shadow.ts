import { getHeapStatistics } from 'node:v8';
import type { IndexedDefinition } from '../../domain/types.js';
import type { FileDependencyGraph, ProjectInputSnapshot } from '../../domain/project-input.js';
import { profileAsyncSpan, profileSpan } from '../../instrumentation/profile.js';
import { collectNativeGarbage } from '../../platform/native-gc.js';
import { clearRegisteredCaches } from '../../storage/cache-registry.js';
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

        const persisted = persistMissingReferenceFragments(db, missingFiles, resolveProvider, (batch) => {
          for (const { fragments } of batch) accumulator.add(fragments);
          computedFiles += batch.length;
        });
        if (!persisted) return null;
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

interface MissingReferenceFragmentFile {
  file: string;
  contentHash: string;
}

/**
 * Fraction of the isolated heap above which a persisted fragment batch relieves
 * memory before the next one. An in-process compiler session resolves the
 * hierarchy of every definition for each batch, so its live checker state can
 * approach the whole program; discarding it is the bounded alternative to the
 * heap-limit abort, and the next batch resolves a fresh session.
 */
const FRAGMENT_BATCH_RELEASE_HEAP_FRACTION = 0.75;

export interface FragmentHeapPressureProbe {
  /** Fraction of the V8 old-space limit currently used. */
  heapUsedFraction(): number;
  /** Force a collection so garbage is not mistaken for live pressure; true when a collector ran. */
  collect(): boolean;
  /** Discard the semantic provider session. */
  release(): void;
}

function defaultFragmentHeapPressureProbe(db: ScipDatabase): FragmentHeapPressureProbe {
  return {
    heapUsedFraction: () => {
      const stats = getHeapStatistics();
      return stats.heap_size_limit > 0 ? stats.used_heap_size / stats.heap_size_limit : 0;
    },
    collect: collectNativeGarbage,
    release: () => clearRegisteredCaches(db, { groups: ['semantic-provider'] }),
  };
}

/**
 * Measure the isolated heap after a forced collection and discard the compiler
 * session only when live state still exceeds the threshold. Returns whether
 * the session was released.
 */
export function relieveFragmentHeapPressure(
  probe: FragmentHeapPressureProbe,
  threshold: number = FRAGMENT_BATCH_RELEASE_HEAP_FRACTION,
): boolean {
  if (probe.heapUsedFraction() < threshold) return false;
  if (probe.collect() && probe.heapUsedFraction() < threshold) return false;
  probe.release();
  return true;
}

interface PersistedReferenceFragmentFile {
  file: string;
  fragments: SemanticReferenceFragment[];
}

/**
 * Compute and persist reference fragments for files whose current identity has
 * no cached row. Every provider batch is written before the next one starts,
 * so a mid-pass crash or timeout keeps completed batches and the next run
 * resumes from the cache. The provider is resolved again for every batch so
 * `onBatch` may discard the compiler session between batches: an in-process
 * checker's state grows with every file it resolves, and a fresh session for
 * the next batch is the bounded alternative to exhausting the heap. Returns
 * false when the provider is unavailable or returned an incomplete batch.
 */
function persistMissingReferenceFragments(
  db: ScipDatabase,
  missingFiles: readonly MissingReferenceFragmentFile[],
  resolveProvider: SemanticProviderResolver,
  onBatch: (batch: readonly PersistedReferenceFragmentFile[]) => void,
  probe: FragmentHeapPressureProbe = defaultFragmentHeapPressureProbe(db),
): boolean {
  for (const batch of typeScriptReferenceFragmentBatches(missingFiles)) {
    const persisted = persistReferenceFragmentBatch(db, batch, resolveProvider);
    if (!persisted) return false;
    onBatch(persisted);
    relieveFragmentHeapPressure(probe);
  }
  return true;
}

/** One provider batch: compute, persist, and report the fragments; null when the provider cannot serve it. */
function persistReferenceFragmentBatch(
  db: ScipDatabase,
  batch: readonly MissingReferenceFragmentFile[],
  resolveProvider: SemanticProviderResolver,
): PersistedReferenceFragmentFile[] | null {
  const filesInBatch = batch.map(({ file }) => file);
  const provider = resolveProvider(filesInBatch[0]!);
  if (!provider.availability().available || !provider.referenceFragmentsForFiles) return null;
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
  return filesInBatch.map((file) => ({ file, fragments: computed.get(file) ?? [] }));
}

export interface TypeScriptReferenceFragmentCoverage {
  files: number;
  missing: number;
}

/**
 * How many indexed TypeScript files lack a persisted reference fragment for
 * their current identity; null when identities are unavailable. Existence is
 * checked without reading payloads, so this is cheap enough to gate a
 * command before it commits to whole-project compiler work.
 */
export function countMissingTypeScriptReferenceFragments(db: ScipDatabase): TypeScriptReferenceFragmentCoverage | null {
  const projectFiles = indexedTypeScriptFiles(db);
  let missing = 0;
  for (const file of projectFiles) {
    const identity = typeScriptSemanticIdentityForFile(db, file, TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA);
    if (!identity?.key) return null;
    if (!REFERENCE_FRAGMENT_PRODUCT.has(db, file, identity.key)) missing += 1;
  }
  return { files: projectFiles.length, missing };
}

export interface TypeScriptReferenceFragmentWarmResult {
  files: number;
  cacheHits: number;
  cacheMisses: number;
  computedFiles: number;
}

export interface TypeScriptReferenceFragmentWarmProgress {
  computedFiles: number;
  missingFiles: number;
}

export interface TypeScriptReferenceFragmentWarmOptions {
  /** Restrict the pass to these indexed files (a shard of a parallel prewarm); default: every indexed TypeScript file. */
  files?: readonly string[];
  /** Runs after each persisted provider batch; may release the semantic provider. */
  onBatch?: (progress: TypeScriptReferenceFragmentWarmProgress) => void;
  /** Yields one event-loop turn between batches; defaults to `setImmediate`. */
  yieldToEventLoop?: () => Promise<void>;
  /** Heap-pressure probe used between batches; defaults to the live V8 heap and the provider cache. */
  probe?: FragmentHeapPressureProbe;
}

const yieldOneEventLoopTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Ensure every indexed TypeScript file has a persisted reference fragment for
 * its current semantic identity without assembling the project-wide reference
 * map. Health prewarm uses this instead of materializing references for every
 * definition: the phases read fragments per file, so the persisted rows are
 * the warm state, and the assembled map would only be held to be discarded —
 * on a large repository that map alone is several gigabytes. Existence is
 * checked without transferring payloads, computed batches are persisted one at
 * a time, and after each persisted batch the heap is relieved (a forced
 * collection, then discarding the compiler session when live state stays
 * high; the next batch resolves a fresh provider), `onBatch` runs, and one
 * event-loop turn is yielded so finalizer-owned native memory from the batch
 * can be reclaimed before the next one starts. Returns null when the
 * semantic identity or the fragment provider is unavailable.
 */
export async function warmTypeScriptReferenceFragments(
  db: ScipDatabase,
  resolveProvider: SemanticProviderResolver,
  options: TypeScriptReferenceFragmentWarmOptions = {},
): Promise<TypeScriptReferenceFragmentWarmResult | null> {
  const yieldToEventLoop = options.yieldToEventLoop ?? yieldOneEventLoopTurn;
  const probe = options.probe ?? defaultFragmentHeapPressureProbe(db);
  let state = 'fallback';
  let files = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let computedFiles = 0;
  return profileAsyncSpan(
    'typescript.reference-fragments.warm',
    async () => {
      try {
        const allFiles = indexedTypeScriptFiles(db);
        const shard = options.files ? new Set(options.files) : null;
        const projectFiles = shard ? allFiles.filter((file) => shard.has(file)) : allFiles;
        files = projectFiles.length;
        const missingFiles: MissingReferenceFragmentFile[] = [];
        for (const file of projectFiles) {
          const identity = typeScriptSemanticIdentityForFile(db, file, TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA);
          if (!identity?.key) return null;
          if (REFERENCE_FRAGMENT_PRODUCT.has(db, file, identity.key)) {
            cacheHits += 1;
          } else {
            cacheMisses += 1;
            missingFiles.push({ file, contentHash: identity.key });
          }
        }
        if (missingFiles.length === 0) {
          state = 'hit';
          return { files, cacheHits, cacheMisses, computedFiles };
        }

        for (const batch of typeScriptReferenceFragmentBatches(missingFiles)) {
          const persisted = persistReferenceFragmentBatch(db, batch, resolveProvider);
          if (!persisted) return null;
          computedFiles += persisted.length;
          relieveFragmentHeapPressure(probe);
          options.onBatch?.({ computedFiles, missingFiles: missingFiles.length });
          await yieldToEventLoop();
        }
        state = 'computed';
        return { files, cacheHits, cacheMisses, computedFiles };
      } catch {
        return null;
      }
    },
    () => ({ state, files, cacheHits, cacheMisses, computedFiles }),
  );
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
