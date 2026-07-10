import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbValue } from '../../storage/per-db-cache.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';
import { projectInputSnapshotOrNull, type ProjectInputSnapshot } from '../../reindex/affected-set.js';
import { isTypeScriptLike } from './source-kinds.js';
import { buildTypeScriptSemanticIdentity, type TypeScriptSemanticIdentity } from './semantic-identity.js';
import { typeScriptSemanticEngineIdentity } from './ts-morph-runtime.js';

interface TypeScriptSemanticIdentityContext {
  snapshot: ProjectInputSnapshot;
  projectFiles: string[];
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
  return buildTypeScriptSemanticIdentity({
    targetFile: relativePath,
    projectFiles: context.projectFiles,
    snapshot: context.snapshot,
    graph: buildFileDepGraph(db),
    engineIdentity: typeScriptSemanticEngineIdentity(),
    schemaVersion,
  });
}

export function indexedTypeScriptFiles(db: ScipDatabase): string[] {
  return indexedDocumentPaths(db, { includeIgnored: false }).filter(isTypeScriptLike).sort();
}

function readIdentityContext(db: ScipDatabase): TypeScriptSemanticIdentityContext | null {
  try {
    const metadata = JSON.parse(readFileSync(join(dirname(db.config.dbPath), 'meta.json'), 'utf8')) as {
      fingerprint?: unknown;
    };
    const snapshot = projectInputSnapshotOrNull(metadata.fingerprint);
    if (!snapshot) return null;
    return { snapshot, projectFiles: indexedTypeScriptFiles(db) };
  } catch {
    return null;
  }
}
