import path from 'node:path';
import { isBuiltin } from 'node:module';
import { ts } from '@ts-morph/common';
import { classifyFile, isManagedOutputPath } from '../primitives/file-kind.js';
import {
  isInternalSpecifier,
  maintenanceFileConfigs,
  packageName,
  type MaintenanceProject,
} from '../primitives/maintenance-project.js';

export type ImportResolution = 'internal' | 'external' | 'builtin' | 'excluded' | 'missing' | 'ambiguous' | 'dynamic';

export interface SourceImport {
  file: string;
  line: number;
  specifier: string;
  target?: string;
  kind: 'value' | 'type';
  role: 'production' | 'test';
  syntax: 'import' | 'reexport' | 'require' | 'dynamic-import' | 'type-import';
  resolution: ImportResolution;
  configs: string[];
  alternatives?: string[];
  excludedReason?: string;
}

/** Syntactic imports with compiler resolution against the same captured source and configuration. */
export function maintenanceImports(
  source: ts.SourceFile,
  files: ReadonlyMap<string, string>,
  project: MaintenanceProject,
  checker: ts.TypeChecker,
): SourceImport[] {
  const imports: SourceImport[] = [];
  const configs = maintenanceFileConfigs(project, source.fileName);
  const add = (literal: ts.Node | undefined, kind: SourceImport['kind'], syntax: SourceImport['syntax']): void => {
    if (!literal) return;
    const specifier = ts.isStringLiteralLike(literal) ? literal.text : literal.getText(source);
    const resolved = ts.isStringLiteralLike(literal)
      ? resolveSourceImport(project, files, source.fileName, specifier, configs)
      : { resolution: 'dynamic' as const };
    imports.push({
      file: source.fileName,
      line: source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1,
      specifier,
      kind,
      role: classifyFile(source.fileName) === 'test' ? 'test' : 'production',
      syntax,
      configs: configs.map((config) => config.file).filter(Boolean),
      ...resolved,
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
  return imports;
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

function importKind(node: ts.ImportDeclaration): SourceImport['kind'] {
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

function exportKind(node: ts.ExportDeclaration): SourceImport['kind'] {
  const clause = node.exportClause;
  return node.isTypeOnly ||
    (clause &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((item) => item.isTypeOnly))
    ? 'type'
    : 'value';
}

function resolveSourceImport(
  project: MaintenanceProject,
  files: ReadonlyMap<string, string>,
  file: string,
  specifier: string,
  configs: ReturnType<typeof maintenanceFileConfigs>,
): Pick<SourceImport, 'resolution' | 'target' | 'alternatives' | 'excludedReason'> {
  if (isBuiltin(specifier)) return { resolution: 'builtin' };
  const asset = relativeAssetTarget(project, file, specifier);
  if (asset) return { resolution: 'excluded', target: asset };
  if (project.ambiguousPackages.has(packageName(specifier))) return { resolution: 'ambiguous', alternatives: [] };
  const results = configs.map((config) => {
    let cache = project.resolutionCaches.get(config.file);
    if (!cache) {
      cache = ts.createModuleResolutionCache('/', (name) => name, { allowJs: true, ...config.options });
      project.resolutionCaches.set(config.file, cache);
    }
    return ts.resolveModuleName(specifier, '/' + file, { allowJs: true, ...config.options }, project.host, cache)
      .resolvedModule?.resolvedFileName;
  });
  const targets = [
    ...new Set(
      results
        .filter((target): target is string => target !== undefined)
        .map((target) => path.posix.normalize(project.host.realpath?.(target) ?? target).replace(/^\//, '')),
    ),
  ];
  if (targets.length > 1 || (targets.length === 1 && results.some((result) => !result)))
    return { resolution: 'ambiguous', alternatives: targets };
  const target = targets[0];
  if (target) return { resolution: files.has(target) ? 'internal' : 'excluded', target };
  return unresolvedSourceImport(project, file, specifier);
}

/** Assets are inventory facts, not executable TypeScript module edges. */
function relativeAssetTarget(project: MaintenanceProject, file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const asset = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return project.inventory.has(asset) && !/\.[cm]?[jt]sx?$/.test(asset) ? asset : undefined;
}

function unresolvedSourceImport(
  project: MaintenanceProject,
  file: string,
  specifier: string,
): Pick<SourceImport, 'resolution' | 'excludedReason'> {
  const requested = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (specifier.startsWith('.') && isManagedOutputPath(requested))
    return {
      resolution: 'excluded',
      excludedReason: `Requested managed output ${requested}; build/install existence is not established by the source inventory.`,
    };
  return { resolution: isInternalSpecifier(project, file, specifier) ? 'missing' : 'external' };
}
