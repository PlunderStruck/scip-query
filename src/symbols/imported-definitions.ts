import { getReExports } from '../language-parsers/index.js';
import type { ScipDatabase } from '../storage/db.js';
import { getDefinitionsForFile } from './definition-catalog.js';

const DEFAULT_MAX_REEXPORT_DEPTH = 4;

/**
 * Resolve one imported binding to the definitions that supply it.
 *
 * A direct import can name a barrel rather than the file that owns the
 * callable. Follow only re-export statements that can carry the requested
 * name, preserving file-and-name identity instead of falling back to a
 * repository-wide leaf-name match.
 */
export function resolveImportedDefinitions(
  db: ScipDatabase,
  relativePath: string,
  importedName: string,
  options: { maxReexportDepth?: number } = {},
): ReturnType<typeof getDefinitionsForFile> {
  return resolveImportedDefinitionsAtDepth(
    db,
    relativePath,
    importedName,
    options.maxReexportDepth ?? DEFAULT_MAX_REEXPORT_DEPTH,
    0,
    new Set(),
  );
}

function resolveImportedDefinitionsAtDepth(
  db: ScipDatabase,
  relativePath: string,
  importedName: string,
  maxReexportDepth: number,
  depth: number,
  seen: Set<string>,
): ReturnType<typeof getDefinitionsForFile> {
  const identity = `${relativePath}\0${importedName}`;
  if (seen.has(identity) || depth > maxReexportDepth) return [];
  seen.add(identity);

  const direct = getDefinitionsForFile(db, relativePath).filter((definition) => definition.leaf === importedName);
  if (direct.length > 0) return direct;

  return getReExports(db, relativePath).flatMap((reexport) => {
    if (!reexport.sourcePath) return [];
    if (reexport.kind === 'named' && !reexport.names.includes(importedName)) return [];
    return resolveImportedDefinitionsAtDepth(
      db,
      reexport.sourcePath,
      importedName,
      maxReexportDepth,
      depth + 1,
      new Set(seen),
    );
  });
}
