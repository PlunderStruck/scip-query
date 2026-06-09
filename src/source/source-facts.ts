import type { ScipDatabase } from '../storage/db.js';
import { detectAstLanguage, type AstLanguage } from './ast-language.js';
import { getAst } from './ast-core.js';
import type { SyntaxNode, Tree } from './ast-types.js';
import { callableFactForNode } from './source-callables.js';
import { callSiteForNode } from './source-calls.js';
import {
  identifiersByLine,
  recordInterpolatedIdentifiers,
  shouldRecordIdentifierNode,
  shouldRecordInterpolatedIdentifiers,
} from './source-identifiers.js';
import { collectCrossLanguageDispatchName, collectRustAttrHelperNames } from './source-reference-collectors.js';
import { buildTypeContainerMap } from './source-type-containers.js';

export interface SourceFacts {
  language: AstLanguage;
  callables: Array<{
    name: string;
    startLine: number;
    endLine: number;
    paramCount: number;
    params: Array<{ name: string; simple: boolean }>;
    paramsEndLine: number;
    isLiteralPassthrough: boolean;
  }>;
  callSites: Array<{
    calleeLeaf: string;
    memberAccess: boolean;
    line: number;
  }>;
  typeContainerMap: Map<string, Set<string>>;
  identifierLineMap: Map<string, number[]>;
  identifiersByLine: Array<Set<string>>;
  fileIdentifiers: Set<string>;
  rustAttrReferencedNames: Set<string>;
  crossLanguageDispatchNames: Set<string>;
}

const SOURCE_FACTS_CACHE = new WeakMap<Tree, SourceFacts>();

export function getSourceFacts(db: ScipDatabase, relativePath: string): SourceFacts | null {
  const language = detectAstLanguage(relativePath);
  if (!language) return null;
  const tree = getAst(db, relativePath);
  if (!tree) return null;

  const cached = SOURCE_FACTS_CACHE.get(tree);
  if (cached) return cached;

  const facts = buildSourceFacts(tree, language);
  SOURCE_FACTS_CACHE.set(tree, facts);
  return facts;
}

export function isLiteralPassthrough(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): boolean {
  const facts = getSourceFacts(db, relativePath);
  if (!facts) return true;
  return findCallableInFacts(facts, startLine, endLine)?.isLiteralPassthrough ?? true;
}

export function getRustAttrReferencedNames(db: ScipDatabase, relativePath: string): Set<string> {
  return getSourceFacts(db, relativePath)?.rustAttrReferencedNames ?? new Set();
}

export function getCrossLanguageDispatchNames(db: ScipDatabase, relativePath: string): Set<string> {
  return getSourceFacts(db, relativePath)?.crossLanguageDispatchNames ?? new Set();
}

function findCallableInFacts(
  facts: SourceFacts,
  startLine: number,
  endLine: number,
): SourceFacts['callables'][number] | null {
  return facts.callables.find((callable) =>
    callable.startLine === startLine && callable.endLine === endLine,
  ) ?? null;
}

function buildSourceFacts(tree: Tree, language: AstLanguage): SourceFacts {
  const callables: SourceFacts['callables'] = [];
  const callSites: SourceFacts['callSites'] = [];
  const rustAttrReferencedNames = new Set<string>();
  const crossLanguageDispatchNames = new Set<string>();
  const identifierLineMap = new Map<string, number[]>();

  const recordIdentifier = (name: string, line: number): void => {
    const arr = identifierLineMap.get(name);
    if (!arr) {
      identifierLineMap.set(name, [line]);
      return;
    }
    if (arr[arr.length - 1] !== line) arr.push(line);
  };

  const walk = (node: SyntaxNode): void => {
    const callable = callableFactForNode(node, language);
    if (callable) callables.push(callable);

    const callSite = callSiteForNode(node, language);
    if (callSite) callSites.push(callSite);
    collectCrossLanguageDispatchName(node, language, crossLanguageDispatchNames);

    if (language === 'rust' && (node.type === 'attribute_item' || node.type === 'inner_attribute_item')) {
      collectRustAttrHelperNames(node.text, rustAttrReferencedNames);
    }

    if (shouldRecordIdentifierNode(node, language)) {
      recordIdentifier(node.text, node.startPosition.row);
    }
    if (shouldRecordInterpolatedIdentifiers(node, language)) {
      recordInterpolatedIdentifiers(node, recordIdentifier);
    }

    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);

  return {
    language,
    callables,
    callSites,
    typeContainerMap: buildTypeContainerMap(tree, language),
    identifierLineMap,
    identifiersByLine: identifiersByLine(identifierLineMap),
    fileIdentifiers: new Set(identifierLineMap.keys()),
    rustAttrReferencedNames,
    crossLanguageDispatchNames,
  };
}
