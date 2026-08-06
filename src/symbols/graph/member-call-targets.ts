import { pathsResolveSame } from '../../domain/path-normalization.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { getAst, getCallableSites, getCallSites, type SyntaxNode } from '../../source/ast.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../definition-catalog.js';
import { resolveImportedDefinitions } from '../imported-definitions.js';
import { getGlobalLeafIndex, pickAstCallCandidate, sameLanguageCandidates } from '../leaf-symbol-index.js';
import { parentTypeName } from '../symbol-parser.js';

export interface ImportedMemberCallTarget {
  calleeLeaf: string;
  line: number;
  sourceFile: string;
  targetFile: string;
  targetStartLine: number;
  targetEndLine: number;
  targetSymbol?: string;
  resolution?: 'direct-import-receiver' | 'constructed-member-receiver';
  strength?: 'exact' | 'candidate';
}

export interface ImportedMemberCallTargetsResult {
  targets: ImportedMemberCallTarget[];
  unresolvedCallsites: number;
}

/**
 * Recover file-level targets for member calls whose callable is present in
 * source but absent from the compiler symbol table. A target is admitted only
 * when exactly one directly imported source file declares the callable leaf.
 */
export function importedMemberCallTargets(
  db: ScipDatabase,
  sourceFile: string,
  options: {
    ranges?: readonly { startLine: number; endLine: number }[];
    excludeIndexedTargets?: boolean;
  } = {},
): ImportedMemberCallTargetsResult {
  const allCallsites = getCallSites(db, sourceFile);
  const callsites = allCallsites?.filter(
    (site) =>
      !options.ranges || options.ranges.some((range) => site.line >= range.startLine && site.line <= range.endLine),
  );
  if (!callsites) return { targets: [], unresolvedCallsites: 0 };

  const sourceImports = getSourceImports(db, sourceFile).filter(
    (entry): entry is ParsedSourceImport & { sourcePath: string } => Boolean(entry.sourcePath),
  );
  const sourceAliases = simpleIdentifierAliases(getSourceText(db, sourceFile) ?? '');
  const callablesByFile = new Map<string, Array<{ name: string; startLine: number; endLine: number }>>();
  const leafIndex = getGlobalLeafIndex(db);
  const targets: ImportedMemberCallTarget[] = [];
  let unresolvedCallsites = 0;

  for (const site of callsites) {
    if (!site.memberAccess) continue;
    const indexedCandidates = sameLanguageCandidates(sourceFile, leafIndex.get(site.calleeLeaf) ?? []);
    if (options.excludeIndexedTargets !== false && pickAstCallCandidate(db, sourceFile, indexedCandidates, true)) {
      continue;
    }

    const receiver = site.calleeQualifier;
    const constructedTarget = constructedMemberCallTarget(db, sourceFile, site, sourceImports);
    if (constructedTarget) {
      targets.push(constructedTarget);
      continue;
    }
    const importedReceiver = receiver ? (sourceAliases.get(receiver) ?? receiver) : null;
    const receiverFiles = importedReceiver
      ? uniqueResolvedPaths(
          sourceImports
            .filter((entry) => (entry.localName ?? entry.importedName) === importedReceiver)
            .map((entry) => entry.sourcePath),
        )
      : [];
    const matchingCallables = receiverFiles.flatMap((file) => {
      let callables = callablesByFile.get(file);
      if (!callables) {
        callables = getCallableSites(db, file) ?? [];
        callablesByFile.set(file, callables);
      }
      return callables.filter((callable) => callable.name === site.calleeLeaf).map((callable) => ({ file, callable }));
    });
    if (matchingCallables.length !== 1) {
      unresolvedCallsites += 1;
      continue;
    }
    const match = matchingCallables[0]!;
    targets.push({
      calleeLeaf: site.calleeLeaf,
      line: site.line,
      sourceFile,
      targetFile: match.file,
      targetStartLine: match.callable.startLine,
      targetEndLine: match.callable.endLine,
      resolution: 'direct-import-receiver',
      strength: 'candidate',
    });
  }

  return { targets, unresolvedCallsites };
}

function constructedMemberCallTarget(
  db: ScipDatabase,
  sourceFile: string,
  site: NonNullable<ReturnType<typeof getCallSites>>[number],
  sourceImports: ReadonlyArray<ParsedSourceImport & { sourcePath: string }>,
): ImportedMemberCallTarget | null {
  const member = /^this\.([A-Za-z_$][\w$]*)$/u.exec(site.calleeQualifier ?? '');
  if (!member) return null;
  const root = getAst(db, sourceFile)?.rootNode;
  if (!root) return null;
  const classScope = smallestEnclosingClass(root, site.line);
  if (!classScope) return null;

  const constructorNames = new Set<string>();
  walk(classScope, (node) => {
    if (node.type !== 'assignment_expression') return;
    const left = node.childForFieldName('left') ?? node.namedChild(0);
    const right = node.childForFieldName('right') ?? node.namedChild(node.namedChildCount - 1);
    if (left?.text.replace(/\s+/gu, '') !== `this.${member[1]}` || !right) return;
    const constructed = unwrap(right);
    if (constructed.type !== 'new_expression') return;
    const constructor = constructed.childForFieldName('constructor') ?? constructed.namedChild(0);
    const name = constructor?.text.match(/[A-Za-z_$][\w$]*$/u)?.[0];
    if (name) constructorNames.add(name);
  });
  if (constructorNames.size !== 1) return null;
  const constructorName = [...constructorNames][0]!;
  const imported = sourceImports.filter((entry) => entry.localName === constructorName);
  if (imported.length !== 1) return null;
  const importedName = imported[0]!.importedName === 'default' ? constructorName : imported[0]!.importedName;
  const resolvedOwnerTypes =
    imported[0]!.importedName === 'default'
      ? resolveImportedDefinitions(db, imported[0]!.sourcePath, constructorName)
      : [];
  const ownerTypeName = resolvedOwnerTypes.length === 1 ? resolvedOwnerTypes[0]!.leaf : importedName;
  const methods = getDefinitionsForFile(db, imported[0]!.sourcePath).filter(
    (definition) =>
      definition.isFunctionLike &&
      definition.leaf === site.calleeLeaf &&
      parentTypeName(definition.symbol) === ownerTypeName,
  );
  if (methods.length !== 1) return null;
  const method = methods[0]!;
  return {
    calleeLeaf: site.calleeLeaf,
    line: site.line,
    sourceFile,
    targetFile: method.relativePath,
    targetStartLine: method.startLine,
    targetEndLine: method.endLine,
    targetSymbol: method.symbol,
    resolution: 'constructed-member-receiver',
    strength: 'exact',
  };
}

function smallestEnclosingClass(root: SyntaxNode, line: number): SyntaxNode | null {
  const candidates: SyntaxNode[] = [];
  walk(root, (node) => {
    if (
      ['class', 'class_declaration', 'class_definition'].includes(node.type) &&
      node.startPosition.row <= line &&
      node.endPosition.row >= line
    ) {
      candidates.push(node);
    }
  });
  return (
    candidates.sort(
      (left, right) =>
        left.endPosition.row - left.startPosition.row - (right.endPosition.row - right.startPosition.row),
    )[0] ?? null
  );
}

function unwrap(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (
    ['parenthesized_expression', 'as_expression', 'type_assertion', 'satisfies_expression'].includes(current.type) &&
    current.namedChildCount === 1
  ) {
    current = current.namedChild(0)!;
  }
  return current;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

function simpleIdentifierAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/gu;
  for (const match of source.matchAll(pattern)) {
    const local = match[1];
    const target = match[2];
    if (local && target) aliases.set(local, target);
  }
  return aliases;
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  const unique: string[] = [];
  for (const path of paths) {
    if (!unique.some((candidate) => pathsResolveSame(candidate, path))) unique.push(path);
  }
  return unique;
}
