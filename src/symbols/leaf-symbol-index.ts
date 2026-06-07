import type { ScipDatabase } from '../storage/db.js';
import { detectAstLanguage } from '../source/ast.js';
import { getSourceImports } from '../language-parsers/index.js';
import { createPerDbValue } from '../storage/per-db-cache.js';
import { leafName } from './symbol-parser.js';
import { pathsResolveSame } from '../resolution/path-normalization.js';

export function sameLanguageCandidates<T extends { file: string }>(
  sourceFile: string,
  candidates: T[],
): T[] {
  const sourceFamily = astLanguageFamily(sourceFile);
  if (!sourceFamily) return candidates;
  return candidates.filter((candidate) => astLanguageFamily(candidate.file) === sourceFamily);
}

export function pickAstCallCandidate<T extends { symbol: string; file: string }>(
  db: ScipDatabase,
  sourceFile: string,
  candidates: T[],
  memberAccess: boolean,
): T | null {
  const sameFile = candidates.find((candidate) => candidate.file === sourceFile);
  if (sameFile) return sameFile;

  if (memberAccess) {
    const importedSourcePaths = new Set(
      getSourceImports(db, sourceFile)
        .map((entry) => entry.sourcePath)
        .filter((path): path is string => Boolean(path)),
    );
    for (const candidate of candidates) {
      for (const sourcePath of importedSourcePaths) {
        if (pathsResolveSame(sourcePath, candidate.file)) return candidate;
      }
    }
    return null;
  }

  return candidates.length === 1 ? candidates[0]! : null;
}

function astLanguageFamily(relativePath: string): string | null {
  const language = detectAstLanguage(relativePath);
  if (!language) return null;
  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    return 'javascript-family';
  }
  return language;
}

export type GlobalLeafCandidate = { symbol: string; symbolId: number; file: string };

const GLOBAL_LEAF_INDEX_CACHE = createPerDbValue<Map<string, GlobalLeafCandidate[]>>('global-leaf-index');
// scip-query: ignore-extract — this builds the global leaf-name candidate
// index; SQL loading, ignore filtering, noise filtering, and language tagging
// define one cache value.
export function getGlobalLeafIndex(
  db: ScipDatabase,
): Map<string, GlobalLeafCandidate[]> {
  return GLOBAL_LEAF_INDEX_CACHE.get(db, () => {
    const rows = db.all<{ id: number; symbol: string; relative_path: string | null }>(
      `SELECT gs.id, gs.symbol,
              COALESCE(der_doc.relative_path, mention_doc.relative_path) AS relative_path
       FROM global_symbols gs
       LEFT JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
       LEFT JOIN documents der_doc ON der_doc.id = der.document_id
       LEFT JOIN (
         SELECT m.symbol_id, MIN(d.relative_path) AS relative_path
         FROM mentions m
         JOIN chunks c ON m.chunk_id = c.id
         JOIN documents d ON c.document_id = d.id
         WHERE m.role = 1
         GROUP BY m.symbol_id
       ) mention_doc ON mention_doc.symbol_id = gs.id
       WHERE 1 = 1
         ${db.symbolNoiseFor('gs')}`,
    );

    const index = new Map<string, GlobalLeafCandidate[]>();
    for (const row of rows) {
      if (!row.relative_path || db.isIgnored(row.relative_path)) continue;
      const leaf = leafName(row.symbol);
      if (!leaf) continue;
      let bucket = index.get(leaf);
      if (!bucket) { bucket = []; index.set(leaf, bucket); }
      // Dedupe: same symbol can show up via both joins.
      if (!bucket.some((e) => e.symbolId === row.id)) {
        bucket.push({ symbol: row.symbol, symbolId: row.id, file: row.relative_path });
      }
    }
    return index;
  });
}



// scip-query: ignore-passthrough — cache lifecycle facade used by
// symbol evidence cache reset without exposing global leaf-index internals.
export function clearGlobalLeafIndexCache(db: ScipDatabase): void {
  GLOBAL_LEAF_INDEX_CACHE.invalidate(db);
}
