import type { ScipDatabase } from '../../storage/db.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { joinRustPath } from '../../language-parsers/languages/rust.js';
import { getAst, type SyntaxNode } from '../../source/ast.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import type { SemanticImportUsage } from '../types.js';
import type { RustImportDefinitionPosition, RustImportDefinitionResolution } from './lsp-session.js';

export interface RustSourceImportUsageFacts {
  usage: SemanticImportUsage[];
  positions: RustImportDefinitionPosition[];
}

export interface RustSourceImportUsageResolver {
  importUsageFacts(file: string): RustSourceImportUsageFacts;
}

export interface RustImportDefinitionResolver {
  importDefinitionsForFile(
    file: string,
    positions: readonly RustImportDefinitionPosition[],
  ): RustImportDefinitionResolution;
}

export function rustImportUsageFromSource(db: ScipDatabase, file: string): SemanticImportUsage[] {
  return rustImportUsageFactsFromSource(db, file).usage;
}

export function rustImportUsageFactsFromSource(db: ScipDatabase, file: string): RustSourceImportUsageFacts {
  const sourceImports = getSourceImports(db, file);
  const usage = sourceImports.map((entry) => rustSourceImportToSemanticUsage(file, entry));
  return {
    usage,
    positions: rustImportDefinitionPositionsFromSource(db, file, usage),
  };
}

export function createRustSemanticImportUsageResolver(
  sourceResolver: RustSourceImportUsageResolver,
  definitionResolver: RustImportDefinitionResolver | null,
): { importUsage(file: string): SemanticImportUsage[] } {
  return {
    importUsage(file) {
      const facts = sourceResolver.importUsageFacts(file);
      if (!definitionResolver || facts.positions.length === 0) return facts.usage;
      const resolution = definitionResolver.importDefinitionsForFile(file, facts.positions);
      if (!resolution.available) return facts.usage;
      return rustImportUsageWithResolvedDefinitions(facts.usage, resolution.sourcePaths);
    },
  };
}

export function rustImportUsageWithResolvedDefinitions(
  usage: readonly SemanticImportUsage[],
  sourcePaths: ReadonlyMap<string, string | null>,
): SemanticImportUsage[] {
  return usage.map((entry, index) => {
    const resolvedSourcePath = sourcePaths.get(String(index));
    if (!resolvedSourcePath) return entry;
    return {
      ...entry,
      sourcePath: resolvedSourcePath,
    };
  });
}

function rustSourceImportToSemanticUsage(importer: string, entry: ParsedSourceImport): SemanticImportUsage {
  const isTypeOnly = entry.isTypeOnly === true;
  const isUsed = entry.kind === 'side-effect' || isTypeOnly || entry.used;
  return {
    importer,
    sourcePath: entry.sourcePath,
    importedName: entry.importedName,
    localName: entry.localName,
    kind: entry.kind,
    isTypeOnly,
    isUsed,
    isTypeUsed: isTypeOnly,
    isValueUsed: entry.kind === 'side-effect' || (!isTypeOnly && entry.used),
    references: [],
  };
}

function rustImportDefinitionPositionsFromSource(
  db: ScipDatabase,
  file: string,
  usage: readonly SemanticImportUsage[],
): RustImportDefinitionPosition[] {
  const tree = getAst(db, file);
  if (!tree) return [];
  const rawPositions = rustImportLeafPositions(tree.rootNode);
  const positionsByKey = new Map<string, RustImportDefinitionPosition[]>();
  for (const position of rawPositions) {
    const bucket = positionsByKey.get(importPositionKey(position.importedName, position.localName));
    if (bucket) bucket.push(position.position);
    else positionsByKey.set(importPositionKey(position.importedName, position.localName), [position.position]);
  }

  const out: RustImportDefinitionPosition[] = [];
  usage.forEach((entry, index) => {
    const position = positionsByKey
      .get(importPositionKey(entry.importedName, entry.localName ?? entry.importedName))
      ?.shift();
    if (!position) return;
    out.push({
      ...position,
      id: String(index),
      file,
    });
  });
  return out;
}

interface RustImportLeafPosition {
  importedName: string;
  localName: string;
  position: RustImportDefinitionPosition;
}

function rustImportLeafPositions(root: SyntaxNode): RustImportLeafPosition[] {
  const out: RustImportLeafPosition[] = [];
  for (const useDecl of root.descendantsOfType('use_declaration')) {
    const useRoot = useDecl.namedChildren.find((child) => child.type !== 'visibility_modifier');
    if (!useRoot) continue;
    out.push(...flattenRustUseTreePositions(useRoot, ''));
  }
  return out.filter((position) => position.importedName !== '*');
}

function flattenRustUseTreePositions(node: SyntaxNode, prefix: string): RustImportLeafPosition[] {
  switch (node.type) {
    case 'identifier':
    case 'super':
    case 'self':
    case 'crate':
      return [
        {
          importedName: node.text,
          localName: node.text,
          position: nodeImportPosition(node, node.text),
        },
      ];
    case 'scoped_identifier': {
      const importedName = node.text.split('::').pop() ?? node.text;
      return [
        {
          importedName,
          localName: importedName,
          position: nodeImportPosition(node, importedName),
        },
      ];
    }
    case 'scoped_use_list': {
      const pathNode = node.namedChild(0);
      const list = node.namedChild(1);
      if (!pathNode || !list) return [];
      const newPrefix = joinRustPath(prefix, pathNode.text);
      return list.namedChildren.flatMap((child) => flattenRustUseTreePositions(child, newPrefix));
    }
    case 'use_list':
      return node.namedChildren.flatMap((child) => flattenRustUseTreePositions(child, prefix));
    case 'use_as_clause': {
      const path = node.namedChild(0);
      const alias = node.namedChild(1);
      if (!path || !alias) return [];
      return flattenRustUseTreePositions(path, prefix).map((leaf) => ({
        ...leaf,
        localName: alias.text,
      }));
    }
    case 'use_wildcard': {
      const path = node.namedChild(0);
      const importedName = '*';
      return [
        {
          importedName,
          localName: importedName,
          position: nodeImportPosition(path ?? node, importedName),
        },
      ];
    }
    default:
      return [];
  }
}

function nodeImportPosition(node: SyntaxNode, importedName: string): RustImportDefinitionPosition {
  const offset = Math.max(0, node.text.lastIndexOf(importedName));
  return {
    id: '',
    file: '',
    line: node.startPosition.row,
    column: node.startPosition.column + offset + characterInsideImportName(importedName),
  };
}

function characterInsideImportName(importedName: string): number {
  return Math.max(0, Math.min(importedName.length - 1, 1));
}

function importPositionKey(importedName: string, localName: string): string {
  return `${importedName}\0${localName}`;
}
