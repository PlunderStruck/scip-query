import { projectInputSnapshotOrNull } from '../../domain/project-input.js';
import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbValue } from '../../storage/per-db-cache.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';
import { isTypeScriptLike } from './source-kinds.js';
import {
  createTypeScriptSemanticIdentityBuilder,
  type TypeScriptSemanticIdentity,
  type TypeScriptSemanticIdentityBuilder,
} from './semantic-identity.js';
import { typeScriptSemanticEngineIdentity } from './ts-morph-runtime.js';

interface TypeScriptSemanticIdentityContext {
  builder: TypeScriptSemanticIdentityBuilder;
  identities: Map<string, TypeScriptSemanticIdentity>;
}

const IDENTITY_CONTEXT = createPerDbValue<TypeScriptSemanticIdentityContext | null>(
  'typescript-semantic-identity-context',
  { clearGroups: ['whole-project'] },
);

export function typeScriptSemanticIdentityForFile(
  db: ScipDatabase,
  relativePath: string,
  schemaVersion: string,
): TypeScriptSemanticIdentity | null {
  const context = IDENTITY_CONTEXT.get(db, () => readIdentityContext(db));
  if (!context) return null;
  const cacheKey = `${schemaVersion}\0${relativePath}`;
  const existing = context.identities.get(cacheKey);
  if (existing) return existing;
  const identity = context.builder.identityFor(relativePath, schemaVersion);
  context.identities.set(cacheKey, identity);
  return identity;
}

export function indexedTypeScriptFiles(db: ScipDatabase): string[] {
  return indexedDocumentPaths(db, { includeIgnored: false }).filter(isTypeScriptLike).sort();
}

function readIdentityContext(db: ScipDatabase): TypeScriptSemanticIdentityContext | null {
  try {
    if (!db.generation.metadataRaw) return null;
    const metadata = JSON.parse(db.generation.metadataRaw) as {
      fingerprint?: unknown;
    };
    const snapshot = projectInputSnapshotOrNull(metadata.fingerprint);
    if (!snapshot) return null;
    return {
      builder: createTypeScriptSemanticIdentityBuilder({
        projectFiles: indexedTypeScriptFiles(db),
        snapshot,
        graph: buildFileDepGraph(db),
        engineIdentity: typeScriptSemanticEngineIdentity(),
      }),
      identities: new Map(),
    };
  } catch {
    return null;
  }
}
