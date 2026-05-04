/**
 * Dart parser. Owns `.dart`. Currently only the regex path is implemented —
 * tree-sitter-dart isn't bundled. Handles `import 'pkg' as ns;` and
 * `export 'pkg';` shapes.
 */
import type { ScipDatabase } from '../db.js';
import { resolveDartImportPath } from '../import-path-resolver.js';
import {
  buildUsageBody,
  collectNamespaceMembers,
  hasIdentifierUsage,
} from '../source-stripper.js';
import type { ParsedSourceExport, ParsedSourceImport } from '../types.js';

export function parseDartImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const statements: ParsedSourceImport[] = [];
  for (const match of source.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"](?:\s+as\s+([A-Za-z_]\w*))?[\s\S]*?;$/gm)) {
    const specifier = match[1]?.trim();
    const alias = match[2]?.trim() ?? null;
    const full = match[0];
    if (!specifier || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    statements.push({
      importedName: specifier,
      localName: alias,
      sourcePath: resolveDartImportPath(db, importerPath, specifier),
      kind: alias ? 'namespace' : 'side-effect',
      used: alias ? hasIdentifierUsage(body, alias) : true,
      usedMembers: alias ? collectNamespaceMembers(body, alias) : [],
    });
  }
  return statements;
}

export function parseDartExports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceExport[] {
  const statements: ParsedSourceExport[] = [];
  for (const match of source.matchAll(/^[ \t]*export\s+['"]([^'"]+)['"][\s\S]*?;$/gm)) {
    const specifier = match[1]?.trim();
    if (!specifier) continue;
    statements.push({
      specifier,
      sourcePath: resolveDartImportPath(db, importerPath, specifier),
    });
  }
  return statements;
}
