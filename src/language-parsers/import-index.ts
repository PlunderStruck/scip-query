import type { ScipDatabase } from '../storage/db.js';
import { normalizeRelativePath } from '../domain/path-normalization.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import { getSourceImports } from './index.js';

const SOURCE_IMPORT_PATHS_BY_LOCAL_NAME_CACHE = createPerDbCache<string, Map<string, Set<string>>>(
  'source-import-paths-by-local-name',
  { clearGroups: ['whole-project', 'source-file'] },
);

/**
 * Per-file imports indexed by local identifier to the source paths that
 * identifier can resolve to. Namespace members are included because a member
 * access can carry the same attribution signal as a direct named import.
 */
export function sourceImportPathsByLocalName(db: ScipDatabase, file: string): Map<string, Set<string>> {
  const normalized = normalizeRelativePath(file);
  return SOURCE_IMPORT_PATHS_BY_LOCAL_NAME_CACHE.get(db, normalized, () =>
    buildSourceImportPathsByLocalName(db, normalized),
  );
}

function buildSourceImportPathsByLocalName(db: ScipDatabase, file: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of getSourceImports(db, file)) {
    if (!entry.sourcePath) continue;
    const localName = entry.localName ?? entry.importedName;
    if (localName) addImportSourcePath(map, localName, entry.sourcePath);
    if (entry.kind === 'namespace') {
      for (const member of entry.usedMembers) {
        addImportSourcePath(map, member, entry.sourcePath);
      }
    }
  }
  return map;
}

function addImportSourcePath(map: Map<string, Set<string>>, name: string, sourcePath: string): void {
  let bucket = map.get(name);
  if (!bucket) {
    bucket = new Set();
    map.set(name, bucket);
  }
  bucket.add(sourcePath);
}
