/**
 * .NET parser. Owns C# (`.cs`) and Visual Basic (`.vb`). Handles `using`
 * directives (C#) and `Imports` statements (VB), including `using Alias =
 * Target` aliasing.
 */
import type { SyntaxNode, Tree } from '../../source/ast.js';
import type { ScipDatabase } from '../../storage/db.js';
import {
  DOTNET_EXTENSIONS,
  isVisualBasicSourcePath,
  resolveQualifiedImportPath,
} from '../../source/primitives/import-path-resolver.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import {
  buildNamedImport,
  buildSimpleImport,
  collectIdentifiersOutside,
  parseImportLineMatches,
  parseWithAstLanguageDispatch,
} from './utils.js';

export function parseDotNetImports(db: ScipDatabase, importerPath: string, source: string): ParsedSourceImport[] {
  return parseWithAstLanguageDispatch(
    db,
    importerPath,
    {
      csharp: (tree) => parseCSharpImportsAst(db, importerPath, tree),
      vb: (tree) => parseVbImportsAst(db, importerPath, tree),
    },
    () => {
      const lineRegex = isVisualBasicSourcePath(importerPath)
        ? /^[ \t]*Imports\s+(.+?)\s*$/gm
        : /^[ \t]*using\s+(.+?)\s*;$/gm;

      return parseImportLineMatches(source, lineRegex, (match, body) => {
        const clause = match[1]?.trim();
        if (!clause) return [];

        const [aliasPart, targetPart] = clause.split(/\s*=\s*/);
        const hasAlias = Boolean(targetPart);
        const qualified = (hasAlias ? targetPart : aliasPart)?.trim() ?? clause;
        const importedName = qualified.split('.').pop() ?? qualified;
        const localName = hasAlias ? (aliasPart?.trim() ?? importedName) : importedName;

        return [
          buildSimpleImport(
            db,
            importerPath,
            body,
            qualified,
            importedName,
            localName,
            resolveQualifiedImportPath(db, qualified, DOTNET_EXTENSIONS),
          ),
        ];
      });
    },
  );
}

// scip-query: ignore-similar — per-language AST walker; each language has a
// distinct AST node shape (imports_statement / using_directive / import_declaration)
// and distinct alias/wildcard semantics. Convergence would require a Strategy
// abstraction that's harder to read than the per-language version.
function parseVbImportsAst(db: ScipDatabase, importerPath: string, tree: Tree): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set(['imports_statement']));
  const results: ParsedSourceImport[] = [];

  for (const stmt of tree.rootNode.descendantsOfType('imports_statement')) {
    // `Imports System` and `Imports System.IO`:
    //   imports_statement → namespace_name (target)
    // `Imports vb = System.Linq` (alias) parses as:
    //   imports_statement → ERROR("vb =") namespace_name(vb) namespace_name(System.Linq)
    // We pick the LAST namespace_name as the target (after the alias if any).
    const namespaceNodes = stmt.namedChildren.filter((c) => c.type === 'namespace_name');
    if (namespaceNodes.length === 0) continue;
    const target = namespaceNodes[namespaceNodes.length - 1]!;
    const aliasNode = namespaceNodes.length > 1 ? namespaceNodes[0]! : null;

    const qualified = target.text;
    const importedName = qualified.split('.').pop() ?? qualified;
    const localName = aliasNode?.text ?? importedName;

    results.push(
      buildNamedImport(
        importedName,
        localName,
        resolveQualifiedImportPath(db, qualified, DOTNET_EXTENSIONS),
        usedNames,
        aliasNode ? 'namespace' : 'named',
      ),
    );
  }
  return results;
}

// scip-query: ignore-similar — handles C#-specific `using static`, alias
// (`using A = B`), and 3-shape AST patterns; not interchangeable with VB / JVM.
function parseCSharpImportsAst(db: ScipDatabase, importerPath: string, tree: Tree): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set(['using_directive']));
  const results: ParsedSourceImport[] = [];

  for (const directive of tree.rootNode.descendantsOfType('using_directive')) {
    // Three shapes:
    //   using System;                  → identifier OR qualified_name
    //   using static System.Math;      → same, with `static` keyword child
    //   using Alias = System.Linq;     → `identifier` (alias) + `qualified_name` target
    const namedChildren = directive.namedChildren;
    if (namedChildren.length === 0) continue;

    let aliasNode: SyntaxNode | null = null;
    let targetNode: SyntaxNode;

    if (
      namedChildren.length >= 2 &&
      namedChildren[0]!.type === 'identifier' &&
      (namedChildren[1]!.type === 'qualified_name' || namedChildren[1]!.type === 'identifier')
    ) {
      aliasNode = namedChildren[0]!;
      targetNode = namedChildren[1]!;
    } else {
      targetNode = namedChildren[namedChildren.length - 1]!;
    }

    const qualified = targetNode.text;
    const importedName = qualified.split('.').pop() ?? qualified;
    const localName = aliasNode?.text ?? importedName;

    results.push(
      buildNamedImport(
        importedName,
        localName,
        resolveQualifiedImportPath(db, qualified, DOTNET_EXTENSIONS),
        usedNames,
        aliasNode ? 'namespace' : 'named',
      ),
    );
  }
  return results;
}
