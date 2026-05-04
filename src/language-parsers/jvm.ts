/**
 * JVM-language parser. Owns Java (`.java`), Kotlin (`.kt`, `.kts`), and
 * Scala (`.scala`). Each language has a separate AST shape so the
 * dispatcher branches on `detectAstLanguage` to pick a per-language AST
 * walker. Regex fallback covers all three with a single shape (`import …;`).
 */
import { detectAstLanguage, getAst, type Tree } from '../ast.js';
import type { ScipDatabase } from '../db.js';
import { JVM_EXTENSIONS, resolveQualifiedImportPath } from '../import-path-resolver.js';
import { buildUsageBody } from '../source-stripper.js';
import type { ParsedSourceImport } from '../types.js';
import { buildSimpleImport, collectIdentifiersOutside, splitTopLevel } from './utils.js';

export function parseJvmImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const tree = getAst(db, importerPath);
  const lang = detectAstLanguage(importerPath);
  if (tree && lang === 'java') return parseJavaImportsAst(db, importerPath, tree);
  if (tree && lang === 'kotlin') return parseKotlinImportsAst(db, importerPath, tree);
  if (tree && lang === 'scala') return parseScalaImportsAst(db, importerPath, tree);

  // Regex fallback (used only when tree-sitter parse fails on the source).
  const statements: ParsedSourceImport[] = [];
  for (const match of source.matchAll(/^[ \t]*import\s+(?:static\s+)?(.+?)\s*;?$/gm)) {
    const clause = match[1]?.trim();
    const full = match[0];
    if (!clause || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    statements.push(...parseJvmImportClause(db, importerPath, clause, body));
  }
  return statements;
}

function parseJavaImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
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
      results.push({
        importedName: '*',
        localName: null,
        sourcePath: resolveQualifiedImportPath(db, qualified, JVM_EXTENSIONS),
        kind: 'namespace',
        used: true,
        usedMembers: [],
      });
      continue;
    }

    const importedName = qualified.split('.').pop() ?? qualified;
    results.push({
      importedName,
      localName: importedName,
      sourcePath: resolveQualifiedImportPath(db, qualified, JVM_EXTENSIONS),
      kind: 'named',
      used: usedNames.has(importedName),
      usedMembers: [],
    });
  }
  return results;
}

function parseKotlinImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set(['import_header', 'import_list']));
  const results: ParsedSourceImport[] = [];

  for (const header of tree.rootNode.descendantsOfType('import_header')) {
    const ident = header.namedChildren.find((c) => c.type === 'identifier');
    if (!ident) continue;
    const wildcard = header.namedChildren.some((c) => c.type === 'wildcard_import');
    const aliasNode = header.namedChildren.find((c) => c.type === 'import_alias');

    if (wildcard) {
      results.push({
        importedName: '*',
        localName: null,
        sourcePath: resolveQualifiedImportPath(db, ident.text, JVM_EXTENSIONS),
        kind: 'namespace',
        used: true,
        usedMembers: [],
      });
      continue;
    }

    const qualified = ident.text;
    const importedName = qualified.split('.').pop() ?? qualified;
    const aliasName = aliasNode?.namedChild(0)?.text;
    const localName = aliasName ?? importedName;

    results.push({
      importedName,
      localName,
      sourcePath: resolveQualifiedImportPath(db, qualified, JVM_EXTENSIONS),
      kind: 'named',
      used: usedNames.has(localName),
      usedMembers: [],
    });
  }
  return results;
}

function parseScalaImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
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
      results.push({
        importedName: '*',
        localName: null,
        sourcePath: resolveQualifiedImportPath(db, prefix, JVM_EXTENSIONS),
        kind: 'namespace',
        used: true,
        usedMembers: [],
      });
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
          results.push({
            importedName,
            localName,
            sourcePath: resolveQualifiedImportPath(db, `${prefix}.${importedName}`, JVM_EXTENSIONS),
            kind: 'named',
            used: usedNames.has(localName),
            usedMembers: [],
          });
        } else if (sel.type === 'identifier') {
          const importedName = sel.text;
          results.push({
            importedName,
            localName: importedName,
            sourcePath: resolveQualifiedImportPath(db, `${prefix}.${importedName}`, JVM_EXTENSIONS),
            kind: 'named',
            used: usedNames.has(importedName),
            usedMembers: [],
          });
        }
      }
      continue;
    }

    // Bare `import x.Y` — last segment is the imported name.
    const importedName = pathSegments[pathSegments.length - 1]?.text ?? prefix;
    const qualifiedPrefix = pathSegments.slice(0, -1).map((s) => s.text).join('.') || prefix;
    results.push({
      importedName,
      localName: importedName,
      sourcePath: resolveQualifiedImportPath(
        db,
        qualifiedPrefix && pathSegments.length > 1 ? `${qualifiedPrefix}.${importedName}` : prefix,
        JVM_EXTENSIONS,
      ),
      kind: 'named',
      used: usedNames.has(importedName),
      usedMembers: [],
    });
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
      const [importedPart, aliasPart] = cleaned.includes('=>')
        ? cleaned.split(/\s*=>\s*/)
        : cleaned.split(/\s+as\s+/);
      const importedName = importedPart?.trim();
      if (!importedName || importedName === '_') return [];
      const localName = (aliasPart ?? importedName.split('.').pop() ?? importedName).trim();
      const qualified = importedName === '_'
        ? prefix
        : `${prefix}.${importedName}`.replace(/\.\./g, '.');
      return [buildSimpleImport(db, importerPath, body, qualified, importedName, localName)];
    });
  }

  return [buildSimpleImport(
    db,
    importerPath,
    body,
    clause,
    clause.split('.').pop() ?? clause,
    clause.split('.').pop() ?? clause,
  )];
}
