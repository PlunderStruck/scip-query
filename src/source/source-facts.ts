import type { ScipDatabase } from '../storage/db.js';
import {
  fileContentHash,
  readCachedFileEvidence,
  writeCachedFileEvidence,
} from '../storage/evidence-cache.js';
import { createPerDbSourceCache } from '../storage/per-db-cache.js';
import { detectAstLanguage, isVueSfcPath, type AstLanguage } from './ast/ast-language.js';
import { getAst } from './ast/ast-core.js';
import type { SyntaxNode, Tree } from './ast/ast-types.js';
import { getSourceText } from './source-text.js';
import { extractVueScriptBlock } from './vue/vue-script.js';
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

// In-process layer keyed by (db, path, source) — previously a WeakMap on the
// parsed Tree, but a persistent-cache hit never parses a Tree at all.
const SOURCE_FACTS_CACHE = createPerDbSourceCache<SourceFacts | null>('source-facts', {
  clearGroups: ['whole-project', 'source-file'],
});

export function getSourceFacts(db: ScipDatabase, relativePath: string): SourceFacts | null {
  const source = getSourceText(db, relativePath);
  if (!source) return null;
  const language = sourceFactsLanguage(relativePath, source);
  if (!language) return null;
  return SOURCE_FACTS_CACHE.get(db, relativePath, source, () =>
    loadOrBuildSourceFacts(db, relativePath, language, source));
}

function sourceFactsLanguage(relativePath: string, source: string): AstLanguage | null {
  if (isVueSfcPath(relativePath)) {
    return extractVueScriptBlock(source)?.language ?? null;
  }
  return detectAstLanguage(relativePath);
}

function loadOrBuildSourceFacts(
  db: ScipDatabase,
  relativePath: string,
  language: AstLanguage,
  source: string,
): SourceFacts | null {
  const contentHash = fileContentHash(db, relativePath, source);
  const cached = readCachedFileEvidence(db, 'source-facts', relativePath, contentHash);
  if (cached) {
    const facts = deserializeSourceFacts(cached);
    if (facts && facts.language === language) return facts;
  }

  const tree = getAst(db, relativePath);
  if (!tree) return null;
  const facts = buildSourceFacts(tree, language);
  writeCachedFileEvidence(db, 'source-facts', relativePath, contentHash, serializeSourceFacts(facts));
  return facts;
}

/**
 * Persistent form. `identifiersByLine` and `fileIdentifiers` are derived from
 * `identifierLineMap`, so only the map is stored and both are rebuilt through
 * the same helpers — structurally identical to a fresh build.
 */
interface SerializedSourceFacts {
  language: AstLanguage;
  callables: SourceFacts['callables'];
  callSites: SourceFacts['callSites'];
  typeContainerMap: Array<[string, string[]]>;
  identifierLineMap: Array<[string, number[]]>;
  rustAttrReferencedNames: string[];
  crossLanguageDispatchNames: string[];
}

function serializeSourceFacts(facts: SourceFacts): string {
  const serialized: SerializedSourceFacts = {
    language: facts.language,
    callables: facts.callables,
    callSites: facts.callSites,
    typeContainerMap: [...facts.typeContainerMap.entries()].map(([key, value]) => [key, [...value]]),
    identifierLineMap: [...facts.identifierLineMap.entries()],
    rustAttrReferencedNames: [...facts.rustAttrReferencedNames],
    crossLanguageDispatchNames: [...facts.crossLanguageDispatchNames],
  };
  return JSON.stringify(serialized);
}

function deserializeSourceFacts(payload: string): SourceFacts | null {
  try {
    const raw = JSON.parse(payload) as SerializedSourceFacts;
    const identifierLineMap = new Map(raw.identifierLineMap);
    return {
      language: raw.language,
      callables: raw.callables,
      callSites: raw.callSites,
      typeContainerMap: new Map(raw.typeContainerMap.map(([key, value]) => [key, new Set(value)])),
      identifierLineMap,
      identifiersByLine: identifiersByLine(identifierLineMap),
      fileIdentifiers: new Set(identifierLineMap.keys()),
      rustAttrReferencedNames: new Set(raw.rustAttrReferencedNames),
      crossLanguageDispatchNames: new Set(raw.crossLanguageDispatchNames),
    };
  } catch {
    return null; // corrupt payload — treat as a miss and rebuild
  }
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
