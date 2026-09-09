import { ts } from '@ts-morph/common';

export interface ModuleReference {
  specifier: string;
  literal: boolean;
  line: number;
  kind: 'value' | 'type';
  syntax: 'import' | 'reexport' | 'require' | 'dynamic-import' | 'type-import';
}

/** Enumerate source module references, retaining dynamic expressions and type-only edges. */
export function sourceModuleReferences(source: ts.SourceFile, checker: ts.TypeChecker): ModuleReference[] {
  const references: ModuleReference[] = [];
  const add = (node: ts.Node | undefined, kind: ModuleReference['kind'], syntax: ModuleReference['syntax']): void => {
    if (!node) return;
    const literal = ts.isStringLiteralLike(node);
    references.push({
      specifier: literal ? node.text : node.getText(source),
      literal,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
      syntax,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, importKind(node), 'import');
    else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, exportKind(node), 'reexport');
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node.moduleReference.expression, node.isTypeOnly ? 'type' : 'value', 'require');
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal, 'type', 'type-import');
    else if (ts.isCallExpression(node)) {
      const syntax = callImportSyntax(node, checker);
      if (syntax) add(node.arguments[0], 'value', syntax);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function callImportSyntax(node: ts.CallExpression, checker: ts.TypeChecker): 'dynamic-import' | 'require' | undefined {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return 'dynamic-import';
  if (
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    !checker.getSymbolAtLocation(node.expression)
  )
    return 'require';
  return undefined;
}

function importKind(node: ts.ImportDeclaration): ModuleReference['kind'] {
  const clause = node.importClause;
  if (clause?.isTypeOnly) return 'type';
  const named = clause?.namedBindings;
  return !clause?.name &&
    named &&
    ts.isNamedImports(named) &&
    named.elements.length > 0 &&
    named.elements.every((item) => item.isTypeOnly)
    ? 'type'
    : 'value';
}

function exportKind(node: ts.ExportDeclaration): ModuleReference['kind'] {
  const clause = node.exportClause;
  return node.isTypeOnly ||
    (clause &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((item) => item.isTypeOnly))
    ? 'type'
    : 'value';
}
