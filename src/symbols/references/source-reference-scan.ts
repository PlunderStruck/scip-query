import type { ScipDatabase } from '../../storage/db.js';
import { detectAstLanguage, frameworkSourceReferences, isVueSfcPath } from '../../source/ast.js';
import type { FrameworkSourceReferenceKind } from '../../source/ast.js';
import { createCandidateNameMatcher, sourceMayContainCandidateName } from '../../source/primitives/source-identifier-prefilter.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { attributeIdentifier, attributeIdentifierPermissive } from '../identifier-attribution.js';
import { getIdentifierLineMap } from '../identifier-index.js';
import { profileSpan } from '../../instrumentation/profile.js';

type SourceReferenceKind = 'identifier' | FrameworkSourceReferenceKind;
type DefaultSourceReferenceTarget = ReturnType<typeof attributeIdentifier>[number];

export interface SourceReferenceTarget {
  symbolId: number;
  relativePath: string;
}

interface SourceReferenceHit {
  sourceFile: string;
  name: string;
  target: SourceReferenceTarget;
  occurrences: number;
  kind: SourceReferenceKind;
}

interface ScanSourceReferencesOptions {
  paths: Iterable<string>;
  includeVueSfc?: boolean;
  includeCrossLanguageDispatchNames?: boolean;
  includeRustAttributeNames?: boolean;
  identifierResolution?: 'strict' | 'permissive';
  candidateNames?: ReadonlySet<string>;
  skipPath?: (relativePath: string) => boolean;
  resolveTargets?: (ctx: SourceReferenceResolveContext) => Iterable<SourceReferenceTarget>;
  afterPath?: (relativePath: string) => void;
}

interface SourceReferenceResolveContext {
  sourceFile: string;
  name: string;
  kind: SourceReferenceKind;
  defaultTargets: () => readonly DefaultSourceReferenceTarget[];
}

export function scanSourceReferences(
  db: ScipDatabase,
  opts: ScanSourceReferencesOptions,
  visit: (hit: SourceReferenceHit) => void,
): void {
  const resolveIdentifier =
    opts.identifierResolution === 'strict' ? attributeIdentifier : attributeIdentifierPermissive;
  const candidateNameMatcher = opts.candidateNames ? createCandidateNameMatcher(opts.candidateNames) : null;
  let scannedPaths = 0;
  let candidateMatchedPaths = 0;
  let visitedNames = 0;
  let visitedHits = 0;
  let currentPath = '';

  for (const sourceFile of opts.paths) {
    scannedPaths += 1;
    currentPath = sourceFile;
    const astLanguage = detectAstLanguage(sourceFile);
    if (!astLanguage && !(opts.includeVueSfc && isVueSfcPath(sourceFile))) continue;
    if (db.isIgnored(sourceFile)) continue;
    if (opts.skipPath?.(sourceFile)) continue;

    try {
      if (candidateNameMatcher && !sourceMayContainCandidateName(getSourceText(db, sourceFile), candidateNameMatcher)) {
        continue;
      }
      candidateMatchedPaths += 1;

      const visitName = (
        name: string,
        kind: SourceReferenceKind,
        occurrences: number,
        defaultTargets: () => readonly DefaultSourceReferenceTarget[],
      ): void => {
        if (opts.candidateNames && !opts.candidateNames.has(name)) return;
        visitedNames += 1;
        const targets = opts.resolveTargets
          ? opts.resolveTargets({ sourceFile, name, kind, defaultTargets })
          : defaultTargets();
        for (const target of targets) {
          visitedHits += 1;
          visit({ sourceFile, name, target, occurrences, kind });
        }
      };

      const lineMap = getIdentifierLineMap(db, sourceFile);
      for (const [name, lines] of lineMap) {
        visitName(name, 'identifier', lines.length, () => resolveIdentifier(db, sourceFile, name));
      }

      for (const reference of frameworkSourceReferences(db, sourceFile, {
        includeCrossLanguageDispatchNames: opts.includeCrossLanguageDispatchNames,
        includeRustAttributeNames: opts.includeRustAttributeNames,
      })) {
        const resolveDefaultTargets =
          reference.kind === 'cross-language-dispatch'
            ? () => attributeIdentifier(db, sourceFile, reference.name)
            : () => resolveIdentifier(db, sourceFile, reference.name);
        visitName(reference.name, reference.kind, reference.occurrences, resolveDefaultTargets);
      }
    } finally {
      opts.afterPath?.(sourceFile);
      if (scannedPaths % 10 === 0) {
        profileSpan(
          'source-reference-scan.progress',
          () => undefined,
          () => ({
            scannedPaths,
            currentPath,
            candidateMatchedPaths,
            visitedNames,
            visitedHits,
          }),
        );
      }
    }
  }
}
