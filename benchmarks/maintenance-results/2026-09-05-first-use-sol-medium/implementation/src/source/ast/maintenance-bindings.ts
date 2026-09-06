import { ts } from '@ts-morph/common';
import type { FunctionAnalysis, SourceFunction } from './function-metrics.js';
import type { SourceImport } from './maintenance-imports.js';

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

/** A deliberately narrow provider: top-level functions and named ES imports, resolved by lexical binding identity. */
export function maintenanceBindings(
  analysis: FunctionAnalysis,
  imports: readonly SourceImport[],
): MaintenanceBindingFacts {
  const { sourceFile: source, checker } = analysis;
  const nodes = topLevelFunctions(source);
  const importedBindings = new Map<ts.Symbol, string>();
  const consumers: MaintenanceBindingFacts['consumers'] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const edge = imports.find(
      (item) => item.specifier === statement.moduleSpecifier.getText(source).slice(1, -1) && item.kind === 'value',
    );
    if (!edge || edge.role === 'test') continue;
    for (const binding of importBindings(statement)) {
      const symbol = checker.getSymbolAtLocation(binding.local);
      if (symbol) importedBindings.set(symbol, edge.target ?? `specifier:${edge.specifier}`);
      if (edge.target && edge.resolution === 'internal')
        consumers.push({ file: source.fileName, line: edge.line, target: edge.target, name: binding.imported });
    }
  }
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
          if (
            !ts.isImportSpecifier(declaration) &&
            !ts.isImportClause(declaration) &&
            !ts.isNamespaceImport(declaration)
          )
            bindings.add(declaration.getStart(source));
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
  if (named && ts.isNamedImports(named))
    for (const binding of named.elements)
      if (!binding.isTypeOnly)
        result.push({ local: binding.name, imported: (binding.propertyName ?? binding.name).text });
  // Namespace imports join dependency groups conservatively; consumers cannot be attributed to one export.
  if (named && ts.isNamespaceImport(named)) result.push({ local: named.name, imported: '*' });
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
