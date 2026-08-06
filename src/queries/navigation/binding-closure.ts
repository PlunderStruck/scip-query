import { getSourceImports } from '../../language-parsers/index.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { resolveImportedDefinitions } from '../../symbols/imported-definitions.js';

const MAX_INLINE_BINDINGS = 12;
const MAX_INLINE_CHARACTERS = 280;

export interface BindingDefinitionEvidence {
  name: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  source: string;
}

/**
 * Literal project values needed to interpret a returned source range.
 *
 * This is a bounded evidence enhancement, not a lexical-completeness claim:
 * callable, dynamic, external-package, and non-foldable bindings stay silent
 * instead of becoming exploration obligations.
 */
export interface BindingClosure {
  coverage: 'indexed-project-literal-values';
  inline: BindingDefinitionEvidence[];
}

export interface CoveredSourceRange {
  relativePath: string;
  startLine: number;
  endLine: number;
}

interface LiteralDefinitionCandidate {
  name: string;
  relativePath: string;
  startLine: number;
  endLine: number;
}

/** Resolve literal-valued indexed project definitions referenced outside one displayed range. */
export function bindingClosureForRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): BindingClosure {
  const referenced = referencedIdentifiers(db, relativePath, startLine, endLine);
  if (referenced.size === 0) return emptyBindingClosure();

  const definitions: LiteralDefinitionCandidate[] = [];
  const seen = new Set<string>();
  const recordDefinition = (name: string, targetPath: string, targetStartLine: number, targetEndLine: number): void => {
    if (targetPath === relativePath && targetStartLine <= endLine && targetEndLine >= startLine) return;
    const key = `${targetPath}:${targetStartLine}:${targetEndLine}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    definitions.push({
      name,
      relativePath: targetPath,
      startLine: targetStartLine,
      endLine: targetEndLine,
    });
  };

  for (const definition of getDefinitionsForFile(db, relativePath)) {
    if (!referenced.has(definition.leaf)) continue;
    recordDefinition(definition.leaf, definition.relativePath, definition.startLine, definition.endLine);
  }

  for (const imported of getSourceImports(db, relativePath)) {
    const localName = imported.localName;
    if (!localName || !referenced.has(localName) || !imported.sourcePath || imported.kind === 'namespace') continue;
    const importedName = imported.importedName === 'default' ? localName : imported.importedName;
    for (const definition of resolveImportedDefinitions(db, imported.sourcePath, importedName, {
      maxReexportDepth: 3,
    })) {
      recordDefinition(localName, definition.relativePath, definition.startLine, definition.endLine);
    }
  }

  definitions.sort(compareBindingEvidence);
  const inline = definitions
    .map((definition): BindingDefinitionEvidence | null => {
      const source = inlineBindingSource(db, definition);
      return source ? { ...definition, source } : null;
    })
    .filter((definition): definition is BindingDefinitionEvidence => definition !== null)
    .slice(0, MAX_INLINE_BINDINGS);
  return closureResult(inline);
}

/** Merge unit literal values, removing definitions already covered by another returned unit. */
export function mergeBindingClosures(
  closures: readonly (BindingClosure | undefined)[],
  coveredRanges: readonly CoveredSourceRange[] = [],
): BindingClosure {
  return closureResult(
    mergeDefinitions(
      closures.flatMap((closure) => closure?.inline ?? []),
      coveredRanges,
    ),
  );
}

export function bindingClosureCharacters(closure: BindingClosure | undefined): number {
  if (!closure) return 0;
  return closure.inline.reduce((total, item) => total + item.name.length + item.source.length + 32, 0);
}

function referencedIdentifiers(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): Set<string> {
  const facts = getSourceFacts(db, relativePath);
  const referenced = new Set<string>();
  if (!facts) return referenced;
  for (let line = startLine; line <= endLine; line += 1) {
    for (const identifier of facts.identifiersByLine[line] ?? []) referenced.add(identifier);
  }
  return referenced;
}

function inlineBindingSource(db: ScipDatabase, definition: LiteralDefinitionCandidate): string | null {
  if (definition.startLine !== definition.endLine) return null;
  const source = (getSourceLines(db, definition.relativePath)[definition.startLine] ?? '').trim();
  if (!source || source.length > MAX_INLINE_CHARACTERS) return null;
  const equals = source.indexOf('=');
  if (equals < 0 || source[equals + 1] === '>') return null;
  const initializer = source
    .slice(equals + 1)
    .replace(/(?:\/\/|#).*$/u, '')
    .trim();
  if (
    !initializer ||
    initializer.includes('${') ||
    /\b(?:function|class|struct|interface|trait|enum|lambda)\b/u.test(initializer)
  ) {
    return null;
  }
  const withoutStrings = initializer.replace(/(['"`])(?:\\.|(?!\1).)*\1/gu, '');
  const withoutNumbers = withoutStrings.replace(
    /\b(?:0[xX][\dA-Fa-f_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?\b/gu,
    '',
  );
  const allowedLiteralWords = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False']);
  const remainingWords = withoutNumbers.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [];
  if (remainingWords.some((word) => !allowedLiteralWords.has(word))) return null;
  return source;
}

function mergeDefinitions(
  definitions: readonly BindingDefinitionEvidence[],
  coveredRanges: readonly CoveredSourceRange[],
): BindingDefinitionEvidence[] {
  const merged = new Map<string, BindingDefinitionEvidence>();
  for (const definition of definitions) {
    if (coveredBy(definition, coveredRanges)) continue;
    const key = `${definition.relativePath}:${definition.startLine}:${definition.endLine}:${definition.name}`;
    if (!merged.has(key)) merged.set(key, { ...definition });
  }
  return [...merged.values()].sort(compareBindingEvidence);
}

function coveredBy(definition: BindingDefinitionEvidence, coveredRanges: readonly CoveredSourceRange[]): boolean {
  return coveredRanges.some(
    (range) =>
      range.relativePath === definition.relativePath &&
      range.startLine <= definition.startLine &&
      range.endLine >= definition.endLine,
  );
}

function compareBindingEvidence(left: LiteralDefinitionCandidate, right: LiteralDefinitionCandidate): number {
  return (
    left.relativePath.localeCompare(right.relativePath) ||
    left.startLine - right.startLine ||
    left.name.localeCompare(right.name)
  );
}

function closureResult(inline: BindingDefinitionEvidence[]): BindingClosure {
  return { coverage: 'indexed-project-literal-values', inline };
}

function emptyBindingClosure(): BindingClosure {
  return closureResult([]);
}
