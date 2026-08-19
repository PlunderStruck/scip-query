import type { ScipDatabase } from '../storage/db.js';
import { detectAstLanguage } from '../source/ast.js';
import { getSourceImports } from '../language-parsers/index.js';
import { createPerDbValue } from '../storage/per-db-cache.js';
import { getSourceText } from '../source/primitives/source-text.js';
import { leafName, parentTypeName } from './symbol-parser.js';
import { pathsResolveSame } from '../domain/path-normalization.js';

export function sameLanguageCandidates<T extends { file: string }>(sourceFile: string, candidates: T[]): T[] {
  const sourceFamily = astLanguageFamily(sourceFile);
  if (!sourceFamily) return candidates;
  return candidates.filter((candidate) => astLanguageFamily(candidate.file) === sourceFamily);
}

export function pickAstCallCandidate<T extends { symbol: string; file: string }>(
  db: ScipDatabase,
  sourceFile: string,
  candidates: T[],
  memberAccess: boolean,
  calleeQualifier?: string,
): T | null {
  const sourceImports = getSourceImports(db, sourceFile);

  if (memberAccess) {
    const receiverRoot = calleeQualifier?.match(/^[A-Za-z_$][\w$]*/u)?.[0];
    if (!receiverRoot) return null;
    const importedSourcePaths = new Set(
      sourceImports
        .filter((entry) => entry.localName === receiverRoot || entry.importedName === receiverRoot)
        .map((entry) => entry.sourcePath)
        .filter((path): path is string => Boolean(path)),
    );
    for (const candidate of candidates) {
      for (const sourcePath of importedSourcePaths) {
        if (pathsResolveSame(sourcePath, candidate.file)) return candidate;
      }
    }

    if (receiverRoot === 'this' || receiverRoot === 'self' || receiverRoot === 'cls') {
      const implicitOwnerMatches = candidates.filter(
        (candidate) => candidate.file === sourceFile && parentTypeName(candidate.symbol) !== null,
      );
      if (implicitOwnerMatches.length === 1) return implicitOwnerMatches[0]!;
    }

    const ownerNames = localReceiverOwnerNames(getSourceText(db, sourceFile) ?? '', receiverRoot);
    if (ownerNames.size === 0) return null;
    const ownerSourcePaths = new Set(
      sourceImports
        .filter((entry) => ownerNames.has(entry.localName ?? entry.importedName))
        .map((entry) => entry.sourcePath)
        .filter((path): path is string => Boolean(path)),
    );
    const ownerMatches = candidates.filter(
      (candidate) =>
        ownerNames.has(parentTypeName(candidate.symbol) ?? '') &&
        (candidate.file === sourceFile ||
          [...ownerSourcePaths].some((sourcePath) => pathsResolveSame(sourcePath, candidate.file))),
    );
    if (ownerMatches.length === 1) return ownerMatches[0]!;
    return null;
  }

  const directCandidates = candidates.filter((candidate) => parentTypeName(candidate.symbol) === null);
  const sameFile = directCandidates.find((candidate) => candidate.file === sourceFile);
  if (sameFile) return sameFile;

  const calleeLeaf = leafName(candidates[0]!.symbol);
  const directImports = sourceImports.filter(
    (entry) =>
      entry.kind !== 'namespace' &&
      entry.kind !== 'side-effect' &&
      (entry.localName === calleeLeaf || (entry.localName === null && entry.importedName === calleeLeaf)),
  );
  if (directImports.length > 0) {
    const importedMatches = directCandidates.filter((candidate) =>
      directImports.some((entry) => entry.sourcePath !== null && pathsResolveSame(entry.sourcePath, candidate.file)),
    );
    return importedMatches.length === 1 ? importedMatches[0]! : null;
  }

  return directCandidates.length === 1 ? directCandidates[0]! : null;
}

/**
 * Recover the imported owner of a local member-call receiver from direct,
 * source-visible type evidence. A receiver is attributed only when every
 * recognized declaration names the same owner type. This covers typed
 * parameters (`store: Store`) and direct construction (`sim =
 * GardenSimulation()` or `const store = new Store()`) without treating an
 * arbitrary local variable as an imported namespace.
 */
function localReceiverOwnerNames(source: string, receiver: string): Set<string> {
  const escapedReceiver = receiver.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const owners = new Set<string>();
  const patterns = [
    new RegExp(`\\b${escapedReceiver}\\s*:\\s*([A-Za-z_$][\\w$]*)`, 'gu'),
    new RegExp(`\\b${escapedReceiver}\\s*=\\s*(?:new\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`, 'gu'),
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) owners.add(match[1]!);
  }
  return owners.size === 1 ? owners : new Set();
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

const GLOBAL_LEAF_INDEX_CACHE = createPerDbValue<Map<string, GlobalLeafCandidate[]>>('global-leaf-index', {
  clearGroups: ['whole-project'],
});
// scip-query: ignore-extract — this builds the global leaf-name candidate
// index; SQL loading, ignore filtering, noise filtering, and language tagging
// define one cache value.
export function getGlobalLeafIndex(db: ScipDatabase): Map<string, GlobalLeafCandidate[]> {
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
      if (!bucket) {
        bucket = [];
        index.set(leaf, bucket);
      }
      // Dedupe: same symbol can show up via both joins.
      if (!bucket.some((e) => e.symbolId === row.id)) {
        bucket.push({ symbol: row.symbol, symbolId: row.id, file: row.relative_path });
      }
    }
    return index;
  });
}
