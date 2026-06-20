/**
 * PHP parser. Owns `.php`. Recognizes `use` statements (including grouped
 * `use Ns\{Foo, Bar};` and `use Ns\Foo as Alias;`).
 */
import type { SyntaxNode, Tree } from '../../source/ast.js';
import type { ScipDatabase } from '../../storage/db.js';
import { PHP_EXTENSIONS, resolveQualifiedImportPath } from '../../resolution/import-path-resolver.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import { buildNamedImport, buildSimpleImport, collectIdentifiersOutside, parseImportLineMatches, parseWithAstFallback, splitTopLevel } from '../utils.js';

export function parsePhpImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  return parseWithAstFallback(
    db,
    importerPath,
    (tree) => parsePhpImportsAst(db, importerPath, tree),
    () => parseImportLineMatches(source, /^[ \t]*use\s+(.+?)\s*;$/gm, (match, body) => {
      const clause = match[1]?.trim();
      if (!clause) return [];
      return splitTopLevel(clause).flatMap((entry) => {
        const cleaned = entry.trim();
        if (!cleaned) return [];
        const [qualifiedPart, aliasPart] = cleaned.split(/\s+as\s+/i);
        const qualified = qualifiedPart?.trim() ?? cleaned;
        const importedName = qualified.split('\\').pop() ?? qualified;
        const localName = (aliasPart ?? importedName).trim();
        return [buildSimpleImport(
          db,
          importerPath,
          body,
          qualified,
          importedName,
          localName,
          resolveQualifiedImportPath(db, qualified.replace(/\\/g, '.'), PHP_EXTENSIONS),
        )];
      });
    }),
  );
}

// scip-query: ignore-similar — PHP-specific: `use Foo\Bar;`, `use function`,
// `use const`, group `use Foo\{A, B}`. Per-language AST shapes intentionally split.
function parsePhpImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set(['namespace_use_declaration']));
  const results: ParsedSourceImport[] = [];

  const emit = (qualified: string, importedName: string, localName: string): void => {
    results.push(buildNamedImport(
      importedName,
      localName,
      resolveQualifiedImportPath(db, qualified.replace(/\\/g, '.'), PHP_EXTENSIONS),
      usedNames,
    ));
  };

  for (const decl of tree.rootNode.descendantsOfType('namespace_use_declaration')) {
    const group = decl.namedChildren.find((c) => c.type === 'namespace_use_group');
    if (group) {
      // `use Ns\{Foo, Bar as Baz};` — group import with shared prefix.
      const prefix = decl.namedChildren.find((c) => c.type === 'namespace_name')?.text ?? '';
      for (const clause of group.namedChildren) {
        if (clause.type !== 'namespace_use_clause') continue;
        const { importedName, localName, qualified } = phpUseClauseTarget(clause, prefix);
        if (!importedName) continue;
        emit(qualified, importedName, localName);
      }
      continue;
    }

    // `use App\Foo;` or `use App\Foo as Bar;` — single clause(s) at the top level.
    for (const clause of decl.namedChildren) {
      if (clause.type !== 'namespace_use_clause') continue;
      const { importedName, localName, qualified } = phpUseClauseTarget(clause, '');
      if (!importedName) continue;
      emit(qualified, importedName, localName);
    }
  }
  return results;
}

function phpUseClauseTarget(
  clause: SyntaxNode,
  prefix: string,
): { importedName: string; localName: string; qualified: string } {
  const qualifiedNode = clause.namedChildren.find((c) => c.type === 'qualified_name');
  const nameNodes = clause.namedChildren.filter((c) => c.type === 'name');

  let basePath = '';
  if (qualifiedNode) {
    basePath = qualifiedNode.text;
  } else if (nameNodes.length >= 1) {
    basePath = nameNodes[0]!.text;
  }
  const aliasNode = qualifiedNode && nameNodes.length > 0 ? nameNodes[nameNodes.length - 1] : null;
  const importedName = basePath.split('\\').pop() ?? basePath;
  const localName = aliasNode?.text ?? importedName;
  const qualified = prefix ? `${prefix}\\${basePath}` : basePath;
  return { importedName, localName, qualified };
}
