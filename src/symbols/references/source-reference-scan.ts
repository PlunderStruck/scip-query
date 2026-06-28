import type { ScipDatabase } from '../../storage/db.js';
import { detectAstLanguage, frameworkSourceReferences, isVueSfcPath } from '../../source/ast.js';
import type { FrameworkSourceReferenceKind } from '../../source/ast.js';
import { sourceMayContainCandidateName } from '../../source/source-identifier-prefilter.js';
import { getSourceText } from '../../source/source-text.js';
import { attributeIdentifier, attributeIdentifierPermissive } from '../identifier-attribution.js';
import { getIdentifierLineMap } from '../identifier-index.js';

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

  for (const sourceFile of opts.paths) {
    const astLanguage = detectAstLanguage(sourceFile);
    if (!astLanguage && !(opts.includeVueSfc && isVueSfcPath(sourceFile))) continue;
    if (db.isIgnored(sourceFile)) continue;
    if (opts.skipPath?.(sourceFile)) continue;

    try {
      if (opts.candidateNames && !sourceMayContainCandidateName(getSourceText(db, sourceFile), opts.candidateNames)) {
        continue;
      }

      const visitName = (
        name: string,
        kind: SourceReferenceKind,
        occurrences: number,
        defaultTargets: () => readonly DefaultSourceReferenceTarget[],
      ): void => {
        if (opts.candidateNames && !opts.candidateNames.has(name)) return;
        const targets = opts.resolveTargets
          ? opts.resolveTargets({ sourceFile, name, kind, defaultTargets })
          : defaultTargets();
        for (const target of targets) {
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
    }
  }
}
