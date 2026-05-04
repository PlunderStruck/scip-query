/**
 * Ruby parser. Owns `.rb`. Recognizes `require`, `require_relative`, and
 * `load` calls. Only `require_relative` resolves to a project file path —
 * `require 'gem-name'` is a side-effect import we surface but don't
 * resolve.
 */
import { basename } from 'node:path';
import { getAst, type Tree } from '../ast.js';
import type { ScipDatabase } from '../db.js';
import { resolveRubyImportPath } from '../import-path-resolver.js';
import { buildUsageBody, hasIdentifierUsage } from '../source-stripper.js';
import type { ParsedSourceImport } from '../types.js';
import { collectIdentifiersOutside } from './utils.js';

export function parseRubyImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const tree = getAst(db, importerPath);
  if (tree) return parseRubyImportsAst(db, importerPath, tree);

  // Regex fallback (only when tree-sitter parse fails on the source).
  const statements: ParsedSourceImport[] = [];
  for (const match of source.matchAll(/^[ \t]*(require_relative|require)\s+["']([^"']+)["']\s*$/gm)) {
    const kind = match[1];
    const specifier = match[2];
    const full = match[0];
    if (!kind || !specifier || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    const sourcePath = kind === 'require_relative'
      ? resolveRubyImportPath(db, importerPath, specifier)
      : null;

    if (sourcePath) {
      const localName = rubyConstantName(specifier);
      statements.push({
        importedName: localName,
        localName,
        sourcePath,
        kind: 'named',
        used: hasIdentifierUsage(body, localName),
        usedMembers: [],
      });
      continue;
    }

    statements.push({
      importedName: specifier,
      localName: null,
      sourcePath,
      kind: 'side-effect',
      used: true,
      usedMembers: [],
    });
  }
  return statements;
}

function parseRubyImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set([]));
  const results: ParsedSourceImport[] = [];
  const REQUIRE_KINDS = new Set(['require', 'require_relative', 'load']);

  for (const call of tree.rootNode.descendantsOfType('call')) {
    const method = call.namedChild(0);
    if (!method || method.type !== 'identifier') continue;
    if (!REQUIRE_KINDS.has(method.text)) continue;

    const args = call.namedChildren.find((c) => c.type === 'argument_list');
    const firstArg = args?.namedChild(0);
    if (!firstArg || firstArg.type !== 'string') continue;
    const fragment = firstArg.namedChildren.find((c) => c.type === 'string_content');
    const specifier = fragment?.text;
    if (!specifier) continue;

    const sourcePath = method.text === 'require_relative'
      ? resolveRubyImportPath(db, importerPath, specifier)
      : null;

    if (sourcePath) {
      const localName = rubyConstantName(specifier);
      results.push({
        importedName: localName,
        localName,
        sourcePath,
        kind: 'named',
        used: usedNames.has(localName),
        usedMembers: [],
      });
    } else {
      results.push({
        importedName: specifier,
        localName: null,
        sourcePath,
        kind: 'side-effect',
        used: true,
        usedMembers: [],
      });
    }
  }
  return results;
}

function rubyConstantName(specifier: string): string {
  return basename(specifier)
    .replace(/\.[^.]+$/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
