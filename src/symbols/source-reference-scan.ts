import type { ScipDatabase } from '../storage/db.js';
import { getCrossLanguageDispatchNames, getRustAttrReferencedNames } from '../analysis/framework-patterns.js';
import { detectAstLanguage, isVueSfcPath } from '../source/ast.js';
import { attributeIdentifier, attributeIdentifierPermissive } from './identifier-attribution.js';
import { getIdentifierLineMap } from './identifier-index.js';

type SourceReferenceKind = 'identifier' | 'cross-language-dispatch' | 'rust-attribute';
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
  const resolveIdentifier = opts.identifierResolution === 'strict'
    ? attributeIdentifier
    : attributeIdentifierPermissive;

  for (const sourceFile of opts.paths) {
    const astLanguage = detectAstLanguage(sourceFile);
    if (!astLanguage && !(opts.includeVueSfc && isVueSfcPath(sourceFile))) continue;
    if (db.isIgnored(sourceFile)) continue;
    if (opts.skipPath?.(sourceFile)) continue;

    try {
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

      if (opts.includeCrossLanguageDispatchNames) {
        for (const name of getCrossLanguageDispatchNames(db, sourceFile)) {
          visitName(name, 'cross-language-dispatch', 1, () => attributeIdentifier(db, sourceFile, name));
        }
      }

      if (opts.includeRustAttributeNames && astLanguage === 'rust') {
        for (const name of getRustAttrReferencedNames(db, sourceFile)) {
          visitName(name, 'rust-attribute', 1, () => resolveIdentifier(db, sourceFile, name));
        }
      }
    } finally {
      opts.afterPath?.(sourceFile);
    }
  }
}
