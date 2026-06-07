/**
 * C/C++ parser. Owns `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`,
 * `.hxx`. Recognizes `#include` directives. AST path uses tree-sitter-c
 * (the dispatcher in `ast.ts` picks the grammar). Regex fallback covers
 * source files where tree-sitter fails.
 */
import { basename } from 'node:path';
import type { Tree } from '../source/ast.js';
import type { ScipDatabase } from '../storage/db.js';
import { resolveCLikeImportPath } from '../resolution/import-path-resolver.js';
import { hasIdentifierUsage } from '../source/source-stripper.js';
import type { ParsedSourceImport } from '../domain/types.js';
import { collectIdentifiersOutside, parseImportLineMatches, parseWithAstFallback } from './utils.js';

export function parseCLikeImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  return parseWithAstFallback(
    db,
    importerPath,
    (tree) => parseCLikeImportsAst(db, importerPath, tree),
    () => parseCLikeImportsRegex(db, importerPath, source),
  );
}

function parseCLikeImportsRegex(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  return parseImportLineMatches(
    source,
    /^[ \t]*#include\s+[<"]([^">]+)[">]\s*$/gm,
    (match, body) => {
      const specifier = match[1]?.trim();
      if (!specifier) return [];
      const localName = basename(specifier).replace(/\.[^.]+$/, '');
      return [{
        importedName: specifier,
        localName,
        sourcePath: resolveCLikeImportPath(db, importerPath, specifier),
        kind: 'named',
        used: hasIdentifierUsage(body, localName),
        usedMembers: [],
      }];
    },
  );
}

function parseCLikeImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set(['preproc_include']));
  const results: ParsedSourceImport[] = [];

  for (const inc of tree.rootNode.descendantsOfType('preproc_include')) {
    // System headers: `#include <stdio.h>` → `system_lib_string` child whose
    // text includes the angle brackets. Local headers: `#include "foo.h"` →
    // `string_literal` with a `string_content` child holding the filename.
    let specifier: string | null = null;
    for (const child of inc.namedChildren) {
      if (child.type === 'system_lib_string') {
        specifier = child.text.replace(/^<|>$/g, '');
        break;
      }
      if (child.type === 'string_literal') {
        const frag = child.namedChildren.find((c) => c.type === 'string_content');
        specifier = frag?.text ?? child.text.replace(/^"|"$/g, '');
        break;
      }
    }
    if (!specifier) continue;

    const localName = basename(specifier).replace(/\.[^.]+$/, '');
    results.push({
      importedName: specifier,
      localName,
      sourcePath: resolveCLikeImportPath(db, importerPath, specifier),
      kind: 'named',
      used: usedNames.has(localName),
      usedMembers: [],
    });
  }
  return results;
}
