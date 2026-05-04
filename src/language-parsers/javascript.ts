/**
 * JavaScript / TypeScript / Vue parser. Owns the import + re-export shapes
 * for `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.vue`.
 *
 * AST path uses tree-sitter-typescript (or tree-sitter-javascript via the
 * shared dispatcher in `ast.ts`). Regex fallback handles cases where
 * tree-sitter can't parse the source.
 */
import { getAst, isVueSfcPath, type SyntaxNode, type Tree } from '../ast.js';
import type { ScipDatabase } from '../db.js';
import { resolveImportPath } from '../import-path-resolver.js';
import { getSourceText } from '../source-text.js';
import {
  buildUsageBody,
  collectNamespaceMembers,
  hasIdentifierUsage,
} from '../source-stripper.js';
import type { ParsedReExport, ParsedSourceImport } from '../types.js';
import { collectIdentifiersOutside, firstChildOfType, splitTopLevel } from './utils.js';
import { createPerDbCache } from '../per-db-cache.js';

export function parseJavaScriptImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const tree = getAst(db, importerPath);
  if (tree) {
    return parseJavaScriptImportsAst(db, importerPath, tree);
  }
  // Fallback: regex parser when AST is unavailable.
  return parseJavaScriptImportStatements(source)
    .flatMap((statement) => parseJavaScriptImportStatement(
      db,
      importerPath,
      statement.clause,
      statement.specifier,
      statement.start,
      statement.end,
      source,
    ));
}

function parseJavaScriptImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
  // Only IMPORT contexts are exclusions — value exports like
  // `export function f()` are also `export_statement` nodes, so excluding
  // them here would make every identifier used inside an exported function
  // body look "unused", and unused-imports would flag every import.
  const usedNames = collectIdentifiersOutside(
    tree,
    new Set(['import_statement']),
  );

  // Vue SFC: the script-block AST doesn't see <template> or <style> usages,
  // so a component imported into <script setup> and only referenced as
  // `<Header />` in the template would look unused. Augment usedNames with
  // identifier-like tokens found in the SFC outside the script block.
  if (isVueSfcPath(importerPath)) {
    for (const name of collectVueNonScriptIdentifiers(db, importerPath)) {
      usedNames.add(name);
    }
  }

  const results: ParsedSourceImport[] = [];

  for (const node of tree.rootNode.descendantsOfType('import_statement')) {
    const specifier = jsImportSpecifier(node);
    if (!specifier) continue;
    const sourcePath = resolveImportPath(db, importerPath, specifier);

    const importClause = firstChildOfType(node, 'import_clause');
    if (!importClause) {
      // Side-effect import: `import 'x';`
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

    for (const child of importClause.namedChildren) {
      switch (child.type) {
        case 'identifier': {
          // Default import: `import Foo from 'x'`
          const localName = child.text;
          results.push({
            importedName: 'default',
            localName,
            sourcePath,
            kind: 'default',
            used: usedNames.has(localName),
            usedMembers: [],
          });
          break;
        }
        case 'namespace_import': {
          const idNode = firstChildOfType(child, 'identifier');
          const localName = idNode?.text ?? '';
          if (!localName) break;
          // `import * as ns from 'x'` — surface members the file actually accesses
          // via `ns.member` so downstream queries (drift, redundant-reexports)
          // can tell which sub-symbols are live.
          const usedMembers = collectMemberAccesses(tree, localName);
          results.push({
            importedName: '*',
            localName,
            sourcePath,
            kind: 'namespace',
            used: usedMembers.length > 0 || usedNames.has(localName),
            usedMembers,
          });
          break;
        }
        case 'named_imports': {
          for (const spec of child.namedChildren) {
            if (spec.type !== 'import_specifier') continue;
            const importedNode = spec.namedChild(0);
            const aliasNode = spec.namedChild(1);
            if (!importedNode) continue;
            const importedName = importedNode.text;
            const localName = aliasNode?.text ?? importedName;
            results.push({
              importedName,
              localName,
              sourcePath,
              kind: 'named',
              used: usedNames.has(localName),
              usedMembers: [],
            });
          }
          break;
        }
      }
    }
  }

  return results;
}

function jsImportSpecifier(node: SyntaxNode): string | null {
  const str = firstChildOfType(node, 'string');
  if (!str) return null;
  const frag = firstChildOfType(str, 'string_fragment');
  return frag ? frag.text : null;
}

/**
 * Collect names accessed as `<receiver>.<name>` anywhere in the tree.
 * Used to enumerate which members of a namespace import are actually touched.
 */
function collectMemberAccesses(tree: Tree, receiver: string): string[] {
  const names = new Set<string>();
  for (const expr of tree.rootNode.descendantsOfType('member_expression')) {
    const obj = expr.namedChild(0);
    const prop = expr.namedChild(1);
    if (!obj || !prop) continue;
    if (obj.type !== 'identifier' || obj.text !== receiver) continue;
    if (prop.type === 'property_identifier' || prop.type === 'identifier') {
      names.add(prop.text);
    }
  }
  return [...names];
}

function parseJavaScriptImportStatements(source: string): Array<{
  clause: string | null;
  specifier: string;
  start: number;
  end: number;
}> {
  const statements: Array<{
    clause: string | null;
    specifier: string;
    start: number;
    end: number;
  }> = [];

  const importFromRegex = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(importFromRegex)) {
    const full = match[0];
    const clause = match[1];
    const specifier = match[2];
    if (!full || !specifier || typeof match.index !== 'number') continue;
    statements.push({
      clause,
      specifier,
      start: match.index,
      end: match.index + full.length,
    });
  }

  const sideEffectRegex = /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(sideEffectRegex)) {
    const full = match[0];
    const specifier = match[1];
    if (!full || !specifier || typeof match.index !== 'number') continue;
    statements.push({
      clause: null,
      specifier,
      start: match.index,
      end: match.index + full.length,
    });
  }

  return statements.sort((a, b) => a.start - b.start);
}

function parseJavaScriptImportStatement(
  db: ScipDatabase,
  importerPath: string,
  clause: string | null,
  specifier: string,
  start: number,
  end: number,
  source: string,
): ParsedSourceImport[] {
  const resolvedSource = resolveImportPath(db, importerPath, specifier);
  const body = buildUsageBody(source, start, end);

  if (!clause) {
    return [{
      importedName: '*',
      localName: null,
      sourcePath: resolvedSource,
      kind: 'side-effect',
      used: true,
      usedMembers: [],
    }];
  }

  const bindings = parseImportClause(clause).map((binding) => ({
    ...binding,
    sourcePath: resolvedSource,
  }));

  return bindings.map((binding) => {
    if (binding.kind === 'namespace') {
      const usedMembers = collectNamespaceMembers(body, binding.localName!);
      return {
        ...binding,
        used: usedMembers.length > 0 || hasIdentifierUsage(body, binding.localName!),
        usedMembers,
      };
    }

    if (binding.kind === 'side-effect') {
      return { ...binding, used: true, usedMembers: [] };
    }

    return {
      ...binding,
      used: binding.localName ? hasIdentifierUsage(body, binding.localName) : false,
      usedMembers: [],
    };
  });
}

function parseImportClause(clause: string): Array<{
  importedName: string;
  localName: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
}> {
  const trimmed = clause.trim().replace(/^type\s+/, '');
  const [first, second] = splitImportClause(trimmed);
  const entries: Array<{
    importedName: string;
    localName: string | null;
    kind: 'named' | 'default' | 'namespace' | 'side-effect';
  }> = [];

  if (first) {
    entries.push(...parseImportBinding(first));
  }

  if (second) {
    entries.push(...parseImportBinding(second));
  }

  return entries;
}

function parseImportBinding(
  binding: string,
): Array<{
  importedName: string;
  localName: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
}> {
  const trimmed = binding.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];

    return splitTopLevel(inner).map((entry) => {
      const cleaned = entry.trim().replace(/^type\s+/, '');
      const [importedName, alias] = cleaned.split(/\s+as\s+/);
      return {
        importedName: importedName!.trim(),
        localName: (alias ?? importedName)!.trim(),
        kind: 'named' as const,
      };
    });
  }

  if (trimmed.startsWith('* as ')) {
    return [{
      importedName: '*',
      localName: trimmed.slice(5).trim(),
      kind: 'namespace',
    }];
  }

  return [{
    importedName: 'default',
    localName: trimmed,
    kind: 'default',
  }];
}

function splitImportClause(clause: string): [string, string | null] {
  let depth = 0;
  for (let i = 0; i < clause.length; i++) {
    const char = clause[i]!;
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (char === ',' && depth === 0) {
      return [clause.slice(0, i).trim(), clause.slice(i + 1).trim()];
    }
  }

  return [clause.trim(), null];
}

// ── Re-exports (export … from '…') ──────────────────────────────────

/**
 * Parse all re-export statements (`export ... from '...'`) in a JS/TS source.
 * Returns each statement's kind, resolved source path, re-exported local
 * names (for named re-exports), and line range.
 *
 * The public entry point lives in `./index.ts` (`getReExports`) so callers
 * import via the language-parsers barrel like every other parser surface.
 */
export function parseReExports(
  db: ScipDatabase,
  relativePath: string,
): ParsedReExport[] {
  const tree = getAst(db, relativePath);
  if (tree) return getReExportsAst(db, relativePath, tree);

  const source = getSourceText(db, relativePath);
  if (!source) return [];

  const results: ParsedReExport[] = [];

  const namedRegex = /^[ \t]*export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(namedRegex)) {
    if (typeof match.index !== 'number') continue;
    const inner = match[1] ?? '';
    const specifier = match[2] ?? '';
    const names = splitTopLevel(inner)
      .map((binding) => parseReExportBinding(binding.trim()))
      .filter((name): name is string => Boolean(name));
    const start = lineOf(source, match.index);
    const end = lineOf(source, match.index + match[0].length - 1);
    results.push({
      kind: 'named',
      sourcePath: resolveImportPath(db, relativePath, specifier),
      names,
      startLine: start,
      endLine: end,
    });
  }

  const starAsRegex = /^[ \t]*export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(starAsRegex)) {
    if (typeof match.index !== 'number') continue;
    const specifier = match[2] ?? '';
    const start = lineOf(source, match.index);
    const end = lineOf(source, match.index + match[0].length - 1);
    results.push({
      kind: 'star-as',
      sourcePath: resolveImportPath(db, relativePath, specifier),
      names: [],
      startLine: start,
      endLine: end,
    });
  }

  const starRegex = /^[ \t]*export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(starRegex)) {
    if (typeof match.index !== 'number') continue;
    const specifier = match[1] ?? '';
    const start = lineOf(source, match.index);
    const end = lineOf(source, match.index + match[0].length - 1);
    results.push({
      kind: 'star',
      sourcePath: resolveImportPath(db, relativePath, specifier),
      names: [],
      startLine: start,
      endLine: end,
    });
  }

  return results;
}

function parseReExportBinding(entry: string): string | null {
  if (!entry) return null;
  // Strip trailing comment fragments that survived splitTopLevel
  const cleaned = entry.replace(/^type\s+/, '').trim();
  if (!cleaned) return null;
  // `X` or `X as Y` — we want the LOCAL (post-alias) name, since that's what
  // external consumers see and what mentions in this file carry.
  const asMatch = cleaned.match(/^(\w+)\s+as\s+(\w+)$/);
  if (asMatch) return asMatch[2] ?? null;
  const plainMatch = cleaned.match(/^(\w+)$/);
  return plainMatch ? plainMatch[1] ?? null : null;
}

function lineOf(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function getReExportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedReExport[] {
  const results: ParsedReExport[] = [];

  for (const node of tree.rootNode.descendantsOfType('export_statement')) {
    const sourcePath = resolveExportSpecifierSource(db, importerPath, node);
    if (sourcePath === undefined) continue; // Not a re-export

    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;
    const result = parseReExportClause(node, sourcePath, startLine, endLine);
    results.push(result);
  }

  return results;
}

function resolveExportSpecifierSource(
  db: ScipDatabase,
  importerPath: string,
  node: SyntaxNode,
): string | null | undefined {
  const str = firstChildOfType(node, 'string');
  if (!str) return undefined;
  const frag = firstChildOfType(str, 'string_fragment');
  if (!frag) return undefined;
  return resolveImportPath(db, importerPath, frag.text);
}

function parseReExportClause(
  node: SyntaxNode,
  sourcePath: string | null,
  startLine: number,
  endLine: number,
): ParsedReExport {
  const exportClause = firstChildOfType(node, 'export_clause');
  if (exportClause) {
    const names: string[] = [];
    for (const spec of exportClause.namedChildren) {
      if (spec.type !== 'export_specifier') continue;
      const importedNode = spec.namedChild(0);
      const aliasNode = spec.namedChild(1);
      if (!importedNode) continue;
      names.push((aliasNode ?? importedNode).text);
    }
    return { kind: 'named', sourcePath, names, startLine, endLine };
  }

  const namespaceExport = firstChildOfType(node, 'namespace_export');
  if (namespaceExport) {
    return { kind: 'star-as', sourcePath, names: [], startLine, endLine };
  }

  return { kind: 'star', sourcePath, names: [], startLine, endLine };
}

// ── Vue SFC non-script identifier scan ─────────────────────────────

const VUE_NON_SCRIPT_IDENTIFIERS_CACHE = createPerDbCache<string, Set<string>>('vue-non-script-identifiers');

/**
 * Collect identifier-shaped tokens from the parts of a Vue SFC that aren't
 * inside `<script>` blocks — i.e. `<template>` and `<style>`. Used to mark
 * imports as "used" when they're only referenced from a template (e.g. a
 * component imported into `<script setup>` and rendered as `<Header />`).
 *
 * This is a textual scan — it doesn't understand template directives in
 * detail — but it's correct for the unused-imports decision: any identifier
 * whose name appears anywhere in the template/style is treated as used.
 */
function collectVueNonScriptIdentifiers(
  db: ScipDatabase,
  relativePath: string,
): Set<string> {
  return VUE_NON_SCRIPT_IDENTIFIERS_CACHE.get(db, relativePath, () => {
    const out = new Set<string>();
    const source = getSourceText(db, relativePath);
    if (!source) return out;
    // Replace all <script>...</script> bodies with whitespace so we only scan
    // template/style/etc. for identifiers. Comments inside template are
    // unlikely to contain real identifiers, but we still strip HTML and JS
    // comments to keep things clean.
    const withoutScripts = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (m) =>
      m.replace(/[^\r\n]/g, ' '),
    );
    const stripped = withoutScripts
      .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\r\n]/g, ' '))
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '));
    for (const match of stripped.matchAll(/[A-Za-z_$][\w$]*/g)) {
      out.add(match[0]);
    }
    return out;
  });
}
