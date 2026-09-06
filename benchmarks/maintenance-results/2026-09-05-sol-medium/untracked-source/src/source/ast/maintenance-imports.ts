import path from 'node:path';
import { ts } from '@ts-morph/common';

export interface SourceImport {
  file: string;
  line: number;
  specifier: string;
  target?: string;
  kind: 'value' | 'type';
}

/** Static relative imports and re-exports, resolved against the same immutable source snapshot. */
export function maintenanceImports(source: ts.SourceFile, files: ReadonlyMap<string, string>): SourceImport[] {
  const imports: SourceImport[] = [];
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => files.has(path.posix.normalize(file).replace(/^\//, '')),
    readFile: (file) => files.get(path.posix.normalize(file).replace(/^\//, '')),
  };
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    const literal = node.moduleSpecifier;
    if (!literal || !ts.isStringLiteral(literal)) continue;
    const specifier = literal.text;
    const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
    const resolved = specifier.startsWith('.')
      ? ts.resolveModuleName(
          specifier,
          '/' + source.fileName,
          { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Node10 },
          host,
        ).resolvedModule
      : undefined;
    imports.push({
      file: source.fileName,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      specifier,
      kind: typeOnly ? 'type' : 'value',
      ...(resolved ? { target: resolved.resolvedFileName.replace(/^\//, '') } : {}),
    });
  }
  return imports;
}
