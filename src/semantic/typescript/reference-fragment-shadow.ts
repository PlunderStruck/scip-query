import type { IndexedDefinition } from '../../domain/types.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { createFileEvidenceProduct, evidenceProductInvalidation } from '../../storage/evidence-products.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getSemanticProvider } from '../provider-cache.js';
import type { SemanticReference, SemanticReferenceFragment } from '../types.js';
import { indexedTypeScriptFiles, typeScriptSemanticIdentityForFile } from './semantic-identity-context.js';
import { isTypeScriptLike } from './source-kinds.js';
import { assembleReferenceFragments, compareReferenceFragmentMaps } from './reference-fragments.js';

export const TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA = 'typescript-reference-fragment-v1';

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

const REFERENCE_FRAGMENT_PRODUCT = createFileEvidenceProduct<SemanticReferenceFragment[]>({
  kind: 'typescript-reference-fragments',
  invalidation: evidenceProductInvalidation('typescript-reference-fragments'),
  serialize: (value) => JSON.stringify(value),
  deserialize: parseReferenceFragments,
});

export function recordTypeScriptReferenceFragmentShadow(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  expected: ReadonlyMap<number, readonly SemanticReference[]>,
): TypeScriptReferenceFragmentShadowResult {
  const typeScriptDefinitions = definitions.filter((definition) => isTypeScriptLike(definition.relativePath));
  if (typeScriptDefinitions.length === 0) return unavailable('no TypeScript definitions');

  let result = unavailable('shadow did not run');
  return profileSpan(
    'typescript.reference-fragments.shadow',
    () => {
      try {
        const provider = getSemanticProvider(db, typeScriptDefinitions[0]!.relativePath);
        if (!provider.availability().available || !provider.referenceFragmentsForFiles) {
          result = unavailable('TypeScript reference fragment provider is unavailable');
          return result;
        }
        const files = indexedTypeScriptFiles(db);
        const fragments = provider.referenceFragmentsForFiles(files);
        const actual = assembleReferenceFragments(typeScriptDefinitions, fragments);
        const parity = compareReferenceFragmentMaps(typeScriptDefinitions, expected, actual);
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
        const identities = new Map<string, string>();
        const cachedFragments = new Map<string, SemanticReferenceFragment[]>();
        const missingFiles: string[] = [];
        for (const file of projectFiles) {
          const identity = typeScriptSemanticIdentityForFile(db, file, TYPESCRIPT_REFERENCE_FRAGMENT_SCHEMA);
          if (!identity?.key) return null;
          identities.set(file, identity.key);
          const cached = REFERENCE_FRAGMENT_PRODUCT.read(db, file, identity.key);
          if (cached === null) {
            cacheMisses += 1;
            missingFiles.push(file);
          } else {
            cacheHits += 1;
            cachedFragments.set(file, cached);
          }
        }
        if (cacheMisses === 0) {
          state = 'hit';
          return {
            references: assembleReferenceFragments(definitions, cachedFragments),
            files,
            cacheHits,
            cacheMisses,
            computedFiles,
          };
        }

        const provider = getSemanticProvider(db, definitions[0]!.relativePath);
        if (!provider.availability().available || !provider.referenceFragmentsForFiles) return null;
        const computed = provider.referenceFragmentsForFiles(missingFiles);
        if (missingFiles.some((file) => !computed.has(file))) return null;
        computedFiles = computed.size;
        REFERENCE_FRAGMENT_PRODUCT.writeBatch(
          db,
          missingFiles.map((file) => ({
            relativePath: file,
            contentHash: identities.get(file)!,
            value: computed.get(file) ?? [],
          })),
        );
        for (const [file, fragments] of computed) cachedFragments.set(file, fragments);
        state = 'computed';
        return {
          references: assembleReferenceFragments(definitions, cachedFragments),
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
