import type { ScipDatabase } from '../../storage/db.js';
import { getSourceFacts } from './source-facts.js';

export type FrameworkSourceReferenceKind = 'cross-language-dispatch' | 'rust-attribute';

export interface FrameworkSourceReference {
  name: string;
  kind: FrameworkSourceReferenceKind;
  occurrences: number;
}

interface FrameworkSourceReferenceOptions {
  includeCrossLanguageDispatchNames?: boolean;
  includeRustAttributeNames?: boolean;
}

export function frameworkSourceReferences(
  db: ScipDatabase,
  relativePath: string,
  opts: FrameworkSourceReferenceOptions = {},
): FrameworkSourceReference[] {
  const facts = getSourceFacts(db, relativePath);
  if (!facts) return [];

  const references: FrameworkSourceReference[] = [];
  if (opts.includeCrossLanguageDispatchNames) {
    for (const name of facts.crossLanguageDispatchNames) {
      references.push({ name, kind: 'cross-language-dispatch', occurrences: 1 });
    }
  }
  if (opts.includeRustAttributeNames && facts.language === 'rust') {
    for (const name of facts.rustAttrReferencedNames) {
      references.push({ name, kind: 'rust-attribute', occurrences: 1 });
    }
  }
  return references;
}
