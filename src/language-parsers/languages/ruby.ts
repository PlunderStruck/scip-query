/**
 * Ruby parser. Owns `.rb`. Recognizes `require`, `require_relative`, and
 * `load` calls. Only `require_relative` resolves to a project file path —
 * `require 'gem-name'` is a side-effect import we surface but don't
 * resolve.
 */
import { basename } from 'node:path';
import type { Tree } from '../../source/ast.js';
import type { ScipDatabase } from '../../storage/db.js';
import { resolveRubyImportPath } from '../../resolution/import-path-resolver.js';
import { pascalCaseSeparated } from '../../source/name-normalization.js';
import { hasIdentifierUsage } from '../../source/source-stripper.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import { buildNamedImport, buildSideEffectImport, buildUsedImport, collectIdentifiersOutside, parseImportLineMatches, parseWithAstFallback } from '../utils.js';

export function parseRubyImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  return parseWithAstFallback(
    db,
    importerPath,
    (tree) => parseRubyImportsAst(db, importerPath, tree),
    () => parseRubyImportsRegex(db, importerPath, source),
  );
}

function parseRubyImportsRegex(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  return parseImportLineMatches<ParsedSourceImport>(
    source,
    /^[ \t]*(require_relative|require)\s+["']([^"']+)["']\s*$/gm,
    (match, body) => {
      const kind = match[1];
      const specifier = match[2];
      if (!kind || !specifier) return [];
      const sourcePath = kind === 'require_relative'
        ? resolveRubyImportPath(db, importerPath, specifier)
        : null;

      if (sourcePath) {
        const localName = rubyConstantName(specifier);
        return [buildUsedImport(localName, localName, sourcePath, hasIdentifierUsage(body, localName))];
      }

      return [buildSideEffectImport(specifier, sourcePath)];
    },
  );
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
      results.push(buildNamedImport(localName, localName, sourcePath, usedNames));
    } else {
      results.push(buildSideEffectImport(specifier, sourcePath));
    }
  }
  return results;
}

function rubyConstantName(specifier: string): string {
  return pascalCaseSeparated(basename(specifier).replace(/\.[^.]+$/, ''), /_/);
}
