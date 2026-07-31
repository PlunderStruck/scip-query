/**
 * JVM-language parser. Owns Java (`.java`), Kotlin (`.kt`, `.kts`), and
 * Scala (`.scala`). Each language has a separate AST shape so the
 * dispatcher branches on `detectAstLanguage` to pick a per-language AST
 * walker. Regex fallback covers all three with a single shape (`import …;`).
 */
import type { Tree } from '../../source/ast.js';
import type { ScipDatabase } from '../../storage/db.js';
import { JVM_EXTENSIONS, resolveQualifiedImportPath } from '../../source/primitives/import-path-resolver.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import {
  buildNamedImport,
  buildNamespaceImport,
  buildSimpleImport,
  collectIdentifiersOutside,
  parseImportLineMatches,
  parseWithAstLanguageDispatch,
  splitTopLevel,
} from './utils.js';

// scip-query: ignore-extract — this is the JVM import parser dispatcher:
// Java, Scala, Kotlin, and regex fallback import shapes share one public
// parser boundary.
export function parseJvmImports(db: ScipDatabase, importerPath: string, source: string): ParsedSourceImport[] {
  return parseWithAstLanguageDispatch(
    db,
    importerPath,
    {
      java: (tree) => parseJavaImportsAst(db, importerPath, tree),
      kotlin: (tree) => parseKotlinImportsAst(db, importerPath, tree),
      scala: (tree) => parseScalaImportsAst(db, importerPath, tree),
    },
    () =>
      parseImportLineMatches(source, /^[ \t]*import\s+(?:static\s+)?(.+?)\s*;?$/gm, (match, body) => {
        const clause = match[1]?.trim();
        if (!clause) return [];
        return parseJvmImportClause(db, importerPath, clause, body);
      }),
    source,
  );
}

// scip-query: ignore-similar — Java-specific: scoped_identifier nodes, no
// aliases, asterisk wildcards. Per-language AST shapes intentionally split.
function parseJavaImportsAst(db: ScipDatabase, importerPath: string, tree: Tree): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set(['import_declaration']));
  const results: ParsedSourceImport[] = [];

  for (const decl of tree.rootNode.descendantsOfType('import_declaration')) {
    const isWildcard = decl.children.some((c) => c.type === 'asterisk');
    const scoped = decl.namedChildren.find((c) => c.type === 'scoped_identifier');
    const target = scoped ?? decl.namedChildren.find((c) => c.type === 'identifier');
    if (!target) continue;
    const qualified = target.text;

    if (isWildcard) {
      // `import foo.bar.*;` — namespace import, no specific imported name to track.
      results.push(buildNamespaceImport('*', resolveQualifiedImportPath(db, qualified, JVM_EXTENSIONS)));
      continue;
    }

    const importedName = qualified.split('.').pop() ?? qualified;
    results.push(
      buildNamedImport(
        importedName,
        importedName,
        resolveQualifiedImportPath(db, qualified, JVM_EXTENSIONS),
        usedNames,
      ),
    );
  }
  return results;
}

// scip-query: ignore-similar — Kotlin-specific: import_header + import_alias +
// wildcard_import nodes. Per-language AST shapes intentionally split.
function parseKotlinImportsAst(db: ScipDatabase, importerPath: string, tree: Tree): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set(['import_header', 'import_list']));
  const results: ParsedSourceImport[] = [];

  for (const header of tree.rootNode.descendantsOfType('import_header')) {
    const ident = header.namedChildren.find((c) => c.type === 'identifier');
    if (!ident) continue;
    const wildcard = header.namedChildren.some((c) => c.type === 'wildcard_import');
    const aliasNode = header.namedChildren.find((c) => c.type === 'import_alias');

    if (wildcard) {
      results.push(buildNamespaceImport('*', resolveQualifiedImportPath(db, ident.text, JVM_EXTENSIONS)));
      continue;
    }

    const qualified = ident.text;
    const importedName = qualified.split('.').pop() ?? qualified;
    const aliasName = aliasNode?.namedChild(0)?.text;
    const localName = aliasName ?? importedName;

    results.push(
      buildNamedImport(importedName, localName, resolveQualifiedImportPath(db, qualified, JVM_EXTENSIONS), usedNames),
    );
  }
  return results;
}

// scip-query: ignore-similar — Scala-specific: namespace_selectors with
// arrow_renamed_identifier (`{X => Y}`) syntax, three import-shape branches.
// Per-language AST shapes intentionally split.
function parseScalaImportsAst(db: ScipDatabase, importerPath: string, tree: Tree): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set(['import_declaration']));
  const results: ParsedSourceImport[] = [];

  for (const decl of tree.rootNode.descendantsOfType('import_declaration')) {
    // import_declaration has named children for the path segments (identifiers)
    // plus an optional namespace_selectors / namespace_wildcard at the tail.
    const tailSelector = decl.namedChildren.find(
      (c) => c.type === 'namespace_selectors' || c.type === 'namespace_wildcard',
    );
    const pathSegments = decl.namedChildren.filter(
      (c) => c !== tailSelector && (c.type === 'identifier' || c.type === 'stable_identifier'),
    );
    const prefix = pathSegments.map((s) => s.text).join('.');
    if (!prefix) continue;

    if (tailSelector?.type === 'namespace_wildcard') {
      results.push(buildNamespaceImport('*', resolveQualifiedImportPath(db, prefix, JVM_EXTENSIONS)));
      continue;
    }

    if (tailSelector?.type === 'namespace_selectors') {
      for (const sel of tailSelector.namedChildren) {
        if (sel.type === 'arrow_renamed_identifier') {
          const [orig, alias] = sel.namedChildren;
          if (!orig) continue;
          const importedName = orig.text;
          const localName = alias?.text ?? importedName;
          if (importedName === '_') continue;
          results.push(
            buildNamedImport(
              importedName,
              localName,
              resolveQualifiedImportPath(db, `${prefix}.${importedName}`, JVM_EXTENSIONS),
              usedNames,
            ),
          );
        } else if (sel.type === 'identifier') {
          const importedName = sel.text;
          results.push(
            buildNamedImport(
              importedName,
              importedName,
              resolveQualifiedImportPath(db, `${prefix}.${importedName}`, JVM_EXTENSIONS),
              usedNames,
            ),
          );
        }
      }
      continue;
    }

    // Bare `import x.Y` — last segment is the imported name.
    const importedName = pathSegments[pathSegments.length - 1]?.text ?? prefix;
    const qualifiedPrefix =
      pathSegments
        .slice(0, -1)
        .map((s) => s.text)
        .join('.') || prefix;
    results.push(
      buildNamedImport(
        importedName,
        importedName,
        resolveQualifiedImportPath(
          db,
          qualifiedPrefix && pathSegments.length > 1 ? `${qualifiedPrefix}.${importedName}` : prefix,
          JVM_EXTENSIONS,
        ),
        usedNames,
      ),
    );
  }
  return results;
}

function parseJvmImportClause(
  db: ScipDatabase,
  importerPath: string,
  clause: string,
  body: string,
): ParsedSourceImport[] {
  if (clause.includes('{') && clause.includes('}')) {
    const prefix = clause.slice(0, clause.indexOf('{')).replace(/\.$/, '').trim();
    const inner = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}')).trim();
    return splitTopLevel(inner).flatMap((entry) => {
      const cleaned = entry.trim();
      if (!cleaned) return [];
      const [importedPart, aliasPart] = cleaned.includes('=>') ? cleaned.split(/\s*=>\s*/) : cleaned.split(/\s+as\s+/);
      const importedName = importedPart?.trim();
      if (!importedName || importedName === '_') return [];
      const localName = (aliasPart ?? importedName.split('.').pop() ?? importedName).trim();
      const qualified = importedName === '_' ? prefix : `${prefix}.${importedName}`.replace(/\.\./g, '.');
      return [buildSimpleImport(db, importerPath, body, qualified, importedName, localName)];
    });
  }

  return [
    buildSimpleImport(
      db,
      importerPath,
      body,
      clause,
      clause.split('.').pop() ?? clause,
      clause.split('.').pop() ?? clause,
    ),
  ];
}
