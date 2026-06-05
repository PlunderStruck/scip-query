/**
 * Shared helpers used by 2+ per-language parsers.
 *
 * - `splitTopLevel`: comma-split at depth-0, used by every parser that has
 *   to handle braced grouping (`{ X, Y as Z }` clauses).
 * - `firstChildOfType`: first named child of a tree-sitter node by type.
 *   Common across the AST-using parsers.
 * - `buildSimpleImport`: emit a `ParsedSourceImport` for the "qualified-name
 *   to single binding" shape used by JVM, .NET, and PHP.
 * - `collectIdentifiersOutside`: walk the AST and collect every identifier
 *   reference NOT inside the given exclusion node-types. Powers the
 *   "is this imported binding referenced elsewhere in the file?" check
 *   that every per-language parser performs.
 */
import type { ScipDatabase } from '../storage/db.js';
import { extensionFamilyFor, resolveQualifiedImportPath } from '../resolution/import-path-resolver.js';
import { buildUsageBody, hasIdentifierUsage } from '../source/source-stripper.js';
import type { SyntaxNode, Tree } from '../source/ast.js';
import type { ParsedSourceImport } from '../domain/types.js';

/**
 * Comma-split that respects bracket depth — `splitTopLevel('a, {b, c}, d')`
 * returns `['a', ' {b, c}', ' d']`. Used by the regex-fallback parsers
 * when they need to split a clause body without splitting nested groups.
 */
export function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === '{' || char === '[' || char === '(') depth++;
    if (char === '}' || char === ']' || char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

/** First named-child of `node` whose `type` matches, or null. */
export function firstChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return null;
}

/**
 * Walk the AST collecting the text of every identifier-shaped node that is
 * not a descendant of any node whose type is in `excludeTypes`. Used to
 * figure out whether an imported symbol is actually referenced elsewhere
 * in the file (excluding the import statement itself).
 *
 * Tracked node types: `identifier` plus the type-position equivalents
 * (`type_identifier`, `property_identifier`, `field_identifier`,
 * `shorthand_property_identifier`). Without the type-position handling,
 * `import type { Foo }` used only in `function f(x: Foo)` would look
 * unused because `Foo` is a `type_identifier`, not an `identifier`.
 */
export function collectIdentifiersOutside(tree: Tree, excludeTypes: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const refTypes = new Set([
    'identifier',
    'type_identifier',
    'property_identifier',
    'shorthand_property_identifier',
    'field_identifier',
  ]);
  const walk = (node: SyntaxNode, inside: boolean): void => {
    const skip = inside || excludeTypes.has(node.type);
    if (!skip && refTypes.has(node.type)) {
      out.add(node.text);
    }
    for (const child of node.children) walk(child, skip);
  };
  walk(tree.rootNode, false);
  return out;
}

/**
 * Emit a `ParsedSourceImport` for the simple "qualified path → single name"
 * shape used by JVM, .NET, and PHP imports. The `body` is the stripped
 * source with the import statement masked out, so `hasIdentifierUsage`
 * doesn't false-positive on the import statement itself.
 */
export function buildSimpleImport(
  db: ScipDatabase,
  importerPath: string,
  body: string,
  qualifiedName: string,
  importedName: string,
  localName: string,
  sourcePath?: string | null,
): ParsedSourceImport {
  return {
    importedName,
    localName,
    sourcePath: sourcePath ?? resolveQualifiedImportPath(db, qualifiedName, extensionFamilyFor(importerPath)),
    kind: 'named',
    used: hasIdentifierUsage(body, localName),
    usedMembers: [],
  };
}

export function parseImportLineMatches<T>(
  source: string,
  pattern: RegExp,
  parse: (match: RegExpMatchArray, body: string) => T[],
): T[] {
  const results: T[] = [];
  for (const match of source.matchAll(pattern)) {
    const full = match[0];
    if (!full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    results.push(...parse(match, body));
  }
  return results;
}
