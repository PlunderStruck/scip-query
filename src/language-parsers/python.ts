/**
 * Python parser. Owns `.py` and `.pyi`. AST path uses tree-sitter-python
 * (the dispatcher in `ast.ts` picks the grammar). Regex fallback handles
 * cases where the AST is unavailable or where multi-line `from … import (…)`
 * statements need backstop coverage.
 */
import { getAst, type SyntaxNode, type Tree } from '../source/ast.js';
import type { ScipDatabase } from '../storage/db.js';
import { resolvePythonImportPath } from '../resolution/import-path-resolver.js';
import { buildUsageBody, collectNamespaceMembers, hasIdentifierUsage } from '../source/source-stripper.js';
import type { ParsedSourceImport } from '../domain/types.js';
import { collectIdentifiersOutside, firstChildOfType, splitTopLevel } from './utils.js';

export function parsePythonImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const tree = getAst(db, importerPath);
  if (tree) {
    return parsePythonImportsAst(db, importerPath, tree);
  }
  return collectPythonImportStatements(source).flatMap((statement) =>
    parsePythonImportStatement(db, importerPath, statement, source),
  );
}

function parsePythonImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(
    tree,
    new Set(['import_statement', 'import_from_statement']),
  );
  const results: ParsedSourceImport[] = [];

  // Plain `import X` and `import X as Y`, possibly comma-separated.
  for (const node of tree.rootNode.descendantsOfType('import_statement')) {
    for (const child of node.namedChildren) {
      const item = parsePythonImportItem(child);
      if (!item) continue;
      const sourcePath = resolvePythonImportPath(db, importerPath, item.qualifiedName);
      results.push({
        importedName: item.qualifiedName,
        localName: item.localName,
        sourcePath,
        kind: 'namespace',
        used: usedNames.has(item.localName),
        usedMembers: [], // member-access tracking via AST is possible but skipped here for parity
      });
    }
  }

  // `from X import a, b as c, *`
  for (const node of tree.rootNode.descendantsOfType('import_from_statement')) {
    const moduleNode = node.namedChild(0);
    if (!moduleNode) continue;
    const moduleSpec = pythonModuleSpec(moduleNode);
    if (moduleSpec === null) continue;
    const sourcePath = resolvePythonImportPath(db, importerPath, moduleSpec);

    // First named child is the module; remaining children are the imported names.
    for (let i = 1; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i)!;
      if (child.type === 'wildcard_import') {
        results.push({
          importedName: '*',
          localName: null,
          sourcePath,
          kind: 'side-effect',
          used: true,
          usedMembers: [],
        });
        continue;
      }
      const item = parsePythonImportItem(child);
      if (!item) continue;
      results.push({
        importedName: item.qualifiedName,
        localName: item.localName,
        sourcePath,
        kind: 'named',
        used: usedNames.has(item.localName),
        usedMembers: [],
      });
    }
  }

  return results;
}

function parsePythonImportItem(node: SyntaxNode): { qualifiedName: string; localName: string } | null {
  if (node.type === 'aliased_import') {
    const inner = node.namedChild(0);
    const alias = node.namedChild(1);
    if (!inner || !alias) return null;
    const qualifiedName = inner.text;
    return { qualifiedName, localName: alias.text };
  }
  if (node.type === 'dotted_name') {
    const text = node.text;
    return { qualifiedName: text, localName: text.split('.')[0] ?? text };
  }
  if (node.type === 'identifier') {
    return { qualifiedName: node.text, localName: node.text };
  }
  return null;
}

function pythonModuleSpec(moduleNode: SyntaxNode): string | null {
  if (moduleNode.type === 'dotted_name') {
    return moduleNode.text;
  }
  if (moduleNode.type === 'relative_import') {
    // `.`, `..`, `..pkg.sub`, etc. — concatenate `import_prefix` (the dots)
    // and any trailing `dotted_name`.
    const prefix = firstChildOfType(moduleNode, 'import_prefix')?.text ?? '';
    const dotted = firstChildOfType(moduleNode, 'dotted_name')?.text ?? '';
    return `${prefix}${dotted}`;
  }
  return null;
}

function collectPythonImportStatements(source: string): Array<{
  kind: 'import' | 'from';
  module: string | null;
  clause: string;
  start: number;
  end: number;
}> {
  const lines = source.split('\n');
  const statements: Array<{
    kind: 'import' | 'from';
    module: string | null;
    clause: string;
    start: number;
    end: number;
  }> = [];

  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const trimmed = line.trimStart();
    const lineStart = offset;
    offset += line.length + 1;

    if (!trimmed.startsWith('import ') && !trimmed.startsWith('from ')) {
      continue;
    }

    let statement = line;
    let statementEnd = lineStart + line.length;
    let balance = pythonParenBalance(line);

    while (
      lineIndex + 1 < lines.length
      && (balance > 0 || statement.trimEnd().endsWith('\\'))
    ) {
      lineIndex++;
      const nextLine = lines[lineIndex]!;
      statement += `\n${nextLine}`;
      statementEnd += 1 + nextLine.length;
      balance += pythonParenBalance(nextLine);
      offset += nextLine.length + 1;
    }

    const parsed = parsePythonStatementHeader(statement);
    if (parsed) {
      statements.push({
        ...parsed,
        start: lineStart,
        end: statementEnd,
      });
    }
  }

  return statements;
}

function parsePythonStatementHeader(statement: string): {
  kind: 'import' | 'from';
  module: string | null;
  clause: string;
} | null {
  const normalized = statement
    .replace(/\\\s*\n/g, ' ')
    .trim();

  if (normalized.startsWith('import ')) {
    return {
      kind: 'import',
      module: null,
      clause: normalized.slice('import '.length).trim(),
    };
  }

  const fromMatch = normalized.match(/^from\s+([.\w]+)\s+import\s+([\s\S]+)$/);
  if (!fromMatch) {
    return null;
  }

  let clause = fromMatch[2]!.trim();
  if (clause.startsWith('(') && clause.endsWith(')')) {
    clause = clause.slice(1, -1).trim();
  }

  return {
    kind: 'from',
    module: fromMatch[1]!,
    clause,
  };
}

function parsePythonImportStatement(
  db: ScipDatabase,
  importerPath: string,
  statement: {
    kind: 'import' | 'from';
    module: string | null;
    clause: string;
    start: number;
    end: number;
  },
  source: string,
): ParsedSourceImport[] {
  const body = buildUsageBody(source, statement.start, statement.end);
  const normalizedClause = statement.clause.replace(/\n/g, ' ').trim();

  if (statement.kind === 'import') {
    return splitTopLevel(normalizedClause).flatMap((entry) => {
      const cleaned = entry.trim().replace(/,$/, '');
      if (!cleaned) return [];

      const [moduleName, alias] = cleaned.split(/\s+as\s+/);
      const importedName = moduleName!.trim();
      const localName = (alias ?? importedName.split('.')[0] ?? importedName).trim();
      const sourcePath = resolvePythonImportPath(db, importerPath, importedName);
      const usedMembers = collectNamespaceMembers(body, localName);

      return [{
        importedName,
        localName,
        sourcePath,
        kind: 'namespace' as const,
        used: hasIdentifierUsage(body, localName) || usedMembers.length > 0,
        usedMembers,
      }];
    });
  }

  const sourcePath = statement.module
    ? resolvePythonImportPath(db, importerPath, statement.module)
    : null;
  const results: ParsedSourceImport[] = [];
  for (const entry of splitTopLevel(normalizedClause)) {
    const cleaned = entry.trim().replace(/,$/, '');
    if (!cleaned) continue;

    if (cleaned === '*') {
      results.push({
        importedName: '*',
        localName: null,
        sourcePath,
        kind: 'side-effect' as const,
        used: true,
        usedMembers: [],
      });
      continue;
    }

    const [importedName, alias] = cleaned.split(/\s+as\s+/);
    const localName = (alias ?? importedName)!.trim();
    results.push({
      importedName: importedName!.trim(),
      localName,
      sourcePath,
      kind: 'named' as const,
      used: hasIdentifierUsage(body, localName),
      usedMembers: [],
    });
  }

  return results;
}

function pythonParenBalance(value: string): number {
  let balance = 0;
  for (const char of value) {
    if (char === '(') balance++;
    if (char === ')') balance--;
  }
  return balance;
}
