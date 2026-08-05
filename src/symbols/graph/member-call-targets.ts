import { pathsResolveSame } from '../../domain/path-normalization.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { getCallableSites, getCallSites } from '../../source/ast.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getGlobalLeafIndex, pickAstCallCandidate, sameLanguageCandidates } from '../leaf-symbol-index.js';

export interface ImportedMemberCallTarget {
  calleeLeaf: string;
  line: number;
  sourceFile: string;
  targetFile: string;
}

export interface ImportedMemberCallTargetsResult {
  targets: ImportedMemberCallTarget[];
  unresolvedCallsites: number;
}

/**
 * Recover file-level targets for member calls whose callable is present in
 * source but absent from the compiler symbol table. A target is admitted only
 * when exactly one directly imported source file declares the callable leaf.
 */
export function importedMemberCallTargets(db: ScipDatabase, sourceFile: string): ImportedMemberCallTargetsResult {
  const callsites = getCallSites(db, sourceFile);
  if (!callsites) return { targets: [], unresolvedCallsites: 0 };

  const sourceImports = getSourceImports(db, sourceFile).filter(
    (entry): entry is ParsedSourceImport & { sourcePath: string } => Boolean(entry.sourcePath),
  );
  const sourceAliases = simpleIdentifierAliases(getSourceText(db, sourceFile) ?? '');
  const callableNamesByFile = new Map<string, Set<string>>();
  const leafIndex = getGlobalLeafIndex(db);
  const targets: ImportedMemberCallTarget[] = [];
  let unresolvedCallsites = 0;

  for (const site of callsites) {
    if (!site.memberAccess) continue;
    const indexedCandidates = sameLanguageCandidates(sourceFile, leafIndex.get(site.calleeLeaf) ?? []);
    if (pickAstCallCandidate(db, sourceFile, indexedCandidates, true)) continue;

    const receiver = site.calleeQualifier;
    const importedReceiver = receiver ? (sourceAliases.get(receiver) ?? receiver) : null;
    const receiverFiles = importedReceiver
      ? uniqueResolvedPaths(
          sourceImports
            .filter((entry) => (entry.localName ?? entry.importedName) === importedReceiver)
            .map((entry) => entry.sourcePath),
        )
      : [];
    const matchingFiles = receiverFiles.filter((file) => {
      let names = callableNamesByFile.get(file);
      if (!names) {
        names = new Set((getCallableSites(db, file) ?? []).map((callable) => callable.name));
        callableNamesByFile.set(file, names);
      }
      return names.has(site.calleeLeaf);
    });
    if (matchingFiles.length !== 1) {
      unresolvedCallsites += 1;
      continue;
    }
    targets.push({
      calleeLeaf: site.calleeLeaf,
      line: site.line,
      sourceFile,
      targetFile: matchingFiles[0]!,
    });
  }

  return { targets, unresolvedCallsites };
}

function simpleIdentifierAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/gu;
  for (const match of source.matchAll(pattern)) {
    const local = match[1];
    const target = match[2];
    if (local && target) aliases.set(local, target);
  }
  return aliases;
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  const unique: string[] = [];
  for (const path of paths) {
    if (!unique.some((candidate) => pathsResolveSame(candidate, path))) unique.push(path);
  }
  return unique;
}
