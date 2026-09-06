import { ts } from '@ts-morph/common';
import type * as TypeScript from 'typescript';
import type { FunctionAnalysis, SourceFunction } from './function-metrics.js';
import type { SourceImport } from './maintenance-imports.js';

/** Names introduced by either compiler provider's binding pattern, excluding keys, defaults and array holes. */
export function bindingNames(name: TypeScript.BindingName | ts.BindingName): string[] {
  if (!('elements' in name)) return [name.text];
  return name.elements.flatMap((element) => ('name' in element ? bindingNames(element.name) : []));
}

export interface MaintenanceFunctionBindings {
  fn: SourceFunction;
  declaration: number;
  exports: string[];
  /** Exact same-file declarations referenced by the function, including shared state and helpers. */
  bindings: number[];
  dependencies: string[];
}

export interface MaintenanceBindingFacts {
  functions: MaintenanceFunctionBindings[];
  consumers: { file: string; line: number; target: string; name: string }[];
}

const IMPORT_BINDING_KINDS = new Set([
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
]);

/** A deliberately narrow provider: top-level functions and named ES imports, resolved by lexical binding identity. */
export function maintenanceBindings(
  analysis: FunctionAnalysis,
  imports: readonly SourceImport[],
): MaintenanceBindingFacts {
  const { sourceFile: source, checker } = analysis;
  const nodes = topLevelFunctions(source);
  const { importedBindings, consumers } = importedMaintenanceBindings(source, checker, imports);
  const exported = exportedBindings(source, checker);
  const functions = nodes.flatMap((node) => {
    const fn = analysis.functions.find((item) => item.startOffset === node.getStart(source));
    if (!fn) return [];
    const bindings = new Set<number>(),
      dependencies = new Set<string>();
    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child)) {
        const symbol = checker.getSymbolAtLocation(child);
        const imported = symbol && importedBindings.get(symbol);
        if (imported) dependencies.add(imported);
        for (const declaration of symbol?.declarations ?? []) {
          if (declaration.getSourceFile() !== source || (declaration.pos >= node.pos && declaration.end <= node.end))
            continue;
          if (!IMPORT_BINDING_KINDS.has(declaration.kind)) bindings.add(declaration.getStart(source));
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    const identity = functionIdentifier(node);
    const symbol = identity && checker.getSymbolAtLocation(identity);
    const declaration = (ts.isVariableDeclaration(node.parent) ? node.parent : node).getStart(source);
    return [
      {
        fn,
        declaration,
        exports: symbol ? (exported.get(symbol) ?? []) : [],
        bindings: [...bindings].sort((a, b) => a - b),
        dependencies: [...dependencies].sort(),
      },
    ];
  });
  return { functions, consumers };
}

function importedMaintenanceBindings(source: ts.SourceFile, checker: ts.TypeChecker, imports: readonly SourceImport[]) {
  const importedBindings = new Map<ts.Symbol, string>();
  const consumers: MaintenanceBindingFacts['consumers'] = [];
  for (const statement of source.statements.filter(ts.isImportDeclaration)) {
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const line = source.getLineAndCharacterOfPosition(statement.moduleSpecifier.getStart(source)).line + 1;
    const edge = imports.find(
      (item) => item.specifier === specifier && item.line === line && item.syntax === 'import' && item.kind === 'value',
    );
    if (!edge || edge.role === 'test') continue;
    for (const binding of importBindings(statement)) {
      const symbol = checker.getSymbolAtLocation(binding.local);
      if (symbol) importedBindings.set(symbol, edge.target ?? `specifier:${edge.specifier}`);
      if (edge.target && edge.resolution === 'internal')
        consumers.push({ file: source.fileName, line: edge.line, target: edge.target, name: binding.imported });
    }
  }
  return { importedBindings, consumers };
}

function topLevelFunctions(source: ts.SourceFile): ts.FunctionLikeDeclaration[] {
  return source.statements.flatMap<ts.FunctionLikeDeclaration>((statement) => {
    if (ts.isFunctionDeclaration(statement) && statement.body) return [statement];
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap((declaration) =>
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
        ? [declaration.initializer]
        : [],
    );
  });
}

function functionIdentifier(node: ts.FunctionLikeDeclaration): ts.Node | undefined {
  return ts.isVariableDeclaration(node.parent) ? node.parent.name : node.name;
}

function importBindings(node: ts.ImportDeclaration): { local: ts.Identifier; imported: string }[] {
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) return [];
  const result = clause.name ? [{ local: clause.name, imported: 'default' }] : [];
  const named = clause.namedBindings;
  if (!named) return result;
  // Namespace imports join dependency groups conservatively; consumers cannot be attributed to one export.
  if (ts.isNamespaceImport(named)) {
    result.push({ local: named.name, imported: '*' });
    return result;
  }
  for (const binding of named.elements) {
    if (!binding.isTypeOnly)
      result.push({ local: binding.name, imported: (binding.propertyName ?? binding.name).text });
  }
  return result;
}

function exportedBindings(source: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Symbol, string[]> {
  const module = checker.getSymbolAtLocation(source);
  const result = new Map<ts.Symbol, string[]>();
  if (!module) return result;
  for (const exported of checker.getExportsOfModule(module)) {
    const local = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    result.set(local, [...(result.get(local) ?? []), exported.name]);
  }
  return result;
}
