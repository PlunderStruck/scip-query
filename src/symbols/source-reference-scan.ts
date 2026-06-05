import type { ScipDatabase } from '../storage/db.js';
import { getCrossLanguageDispatchNames, getRustAttrReferencedNames } from '../analysis/framework-patterns.js';
import { detectAstLanguage, isVueSfcPath } from '../source/ast.js';
import { attributeIdentifier, attributeIdentifierPermissive } from './identifier-attribution.js';
import { getIdentifierLineMap } from './identifier-index.js';

type SourceReferenceKind = 'identifier' | 'cross-language-dispatch' | 'rust-attribute';
type SourceReferenceTarget = ReturnType<typeof attributeIdentifier>[number];

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
  skipPath?: (relativePath: string) => boolean;
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

    const lineMap = getIdentifierLineMap(db, sourceFile);
    for (const [name, lines] of lineMap) {
      for (const target of resolveIdentifier(db, sourceFile, name)) {
        visit({
          sourceFile,
          name,
          target,
          occurrences: lines.length,
          kind: 'identifier',
        });
      }
    }

    if (opts.includeCrossLanguageDispatchNames) {
      for (const name of getCrossLanguageDispatchNames(db, sourceFile)) {
        for (const target of attributeIdentifier(db, sourceFile, name)) {
          visit({
            sourceFile,
            name,
            target,
            occurrences: 1,
            kind: 'cross-language-dispatch',
          });
        }
      }
    }

    if (opts.includeRustAttributeNames && astLanguage === 'rust') {
      for (const name of getRustAttrReferencedNames(db, sourceFile)) {
        for (const target of resolveIdentifier(db, sourceFile, name)) {
          visit({
            sourceFile,
            name,
            target,
            occurrences: 1,
            kind: 'rust-attribute',
          });
        }
      }
    }
  }
}
