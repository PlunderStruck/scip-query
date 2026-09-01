import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { fileContentHash } from '../../storage/evidence-cache.js';
import { createFileEvidenceProduct, evidenceProductInvalidation } from '../../storage/evidence-products.js';
import { createPerDbSourceCache } from '../../storage/per-db-cache.js';
import { detectAstLanguage, isVueSfcPath, type AstLanguage } from '../ast/ast-language.js';
import { getAst, parseAstSourceText } from '../ast/ast-core.js';
import type { SyntaxNode, Tree } from '../ast/ast-types.js';
import { getSourceText } from '../primitives/source-text.js';
import { extractVueScriptBlock } from '../ast/vue-script.js';
import { branchContribution } from '../ast/branch-nodes.js';
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
import { buildClojureSourceFacts } from './clojure-facts.js';
import type { SourceFacts } from './source-fact-types.js';

export type { SourceFacts } from './source-fact-types.js';

export type SourceFactsUnavailableReason = 'parser-unavailable';

// scip-query: ignore-stale — reviewed S1 owned contract; this payload explains unavailable source evidence.
export interface SourceFactsUnavailable {
  language: AstLanguage;
  reason: SourceFactsUnavailableReason;
}

export interface SourceFactsResult {
  facts: SourceFacts | null;
  unavailable?: SourceFactsUnavailable;
}

export const SOURCE_FACTS_PAYLOAD_VERSION = 7;

// In-process layer keyed by (db, path, source) — previously a WeakMap on the
// parsed Tree, but a persistent-cache hit never parses a Tree at all.
const SOURCE_FACTS_CACHE = createPerDbSourceCache<SourceFactsResult>('source-facts', {
  clearGroups: ['whole-project', 'source-file'],
});
const SOURCE_FACTS_PRODUCT = createFileEvidenceProduct<SourceFacts>({
  kind: 'source-facts',
  invalidation: evidenceProductInvalidation('source-facts'),
  serialize: serializeSourceFacts,
  deserialize: deserializeSourceFacts,
});

export function getSourceFacts(db: ScipDatabase, relativePath: string): SourceFacts | null {
  return getSourceFactsResult(db, relativePath).facts;
}

export function getSourceFactsResult(db: ScipDatabase, relativePath: string): SourceFactsResult {
  const source = getSourceText(db, relativePath);
  if (!source) return { facts: null };
  const language = sourceFactsLanguage(db, relativePath, source);
  if (!language) return { facts: null };
  return SOURCE_FACTS_CACHE.get(db, relativePath, source, () =>
    loadOrBuildSourceFacts(db, relativePath, language, source),
  );
}

/**
 * Build the same source facts from fixed bytes rather than the live project
 * file. This is the comparison boundary used by change-relative analyzers:
 * a Git-base blob and the current repository snapshot can be parsed under one
 * fact contract without temporarily replacing either file.
 */
export function sourceFactsFromText(db: ScipDatabase, relativePath: string, source: string): SourceFactsResult {
  const language = detectAstLanguage(relativePath);
  if (!language && !isVueSfcPath(relativePath)) return { facts: null };
  if (language === 'clojure') return { facts: buildClojureSourceFacts(source) };
  const parsed = parseAstSourceText(db, relativePath, source);
  if (parsed) return { facts: buildSourceFacts(parsed.tree, parsed.language) };
  const unavailableLanguage = language ?? extractVueScriptBlock(db, relativePath, source)?.language;
  return unavailableLanguage
    ? { facts: null, unavailable: { language: unavailableLanguage, reason: 'parser-unavailable' } }
    : { facts: null };
}

function sourceFactsLanguage(db: ScipDatabase, relativePath: string, source: string): AstLanguage | null {
  if (isVueSfcPath(relativePath)) {
    return extractVueScriptBlock(db, relativePath, source)?.language ?? null;
  }
  return detectAstLanguage(relativePath);
}

function loadOrBuildSourceFacts(
  db: ScipDatabase,
  relativePath: string,
  language: AstLanguage,
  source: string,
): SourceFactsResult {
  const contentHash = fileContentHash(db, relativePath, source);
  const cached = SOURCE_FACTS_PRODUCT.read(db, relativePath, contentHash);
  if (cached && cached.language === language) return { facts: cached };

  if (language === 'clojure') {
    const facts = buildClojureSourceFacts(source);
    SOURCE_FACTS_PRODUCT.write(db, relativePath, contentHash, facts);
    return { facts };
  }

  const tree = getAst(db, relativePath);
  if (!tree) return { facts: null, unavailable: { language, reason: 'parser-unavailable' } };
  const facts = buildSourceFacts(tree, language);
  SOURCE_FACTS_PRODUCT.write(db, relativePath, contentHash, facts);
  return { facts };
}

/**
 * Persistent form. `identifiersByLine` and `fileIdentifiers` are derived from
 * `identifierLineMap`, so only the map is stored and both are rebuilt through
 * the same helpers — structurally identical to a fresh build.
 */
interface SerializedSourceFacts {
  version: number;
  language: AstLanguage;
  callables: SourceFacts['callables'];
  callSites: SourceFacts['callSites'];
  clojureMembers?: SourceFacts['clojureMembers'];
  typeContainerMap: Array<[string, string[]]>;
  identifierLineMap: Array<[string, number[]]>;
  rustAttrReferencedNames: string[];
  crossLanguageDispatchNames: string[];
}

function serializeSourceFacts(facts: SourceFacts): string {
  const serialized: SerializedSourceFacts = {
    version: SOURCE_FACTS_PAYLOAD_VERSION,
    language: facts.language,
    callables: facts.callables,
    callSites: facts.callSites,
    clojureMembers: facts.clojureMembers,
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
    if (raw.version !== SOURCE_FACTS_PAYLOAD_VERSION) return null;
    if (
      raw.language === 'clojure' &&
      (raw.clojureMembers === undefined || raw.callSites.some((site) => site.calleeText === undefined))
    ) {
      return null;
    }
    const identifierLineMap = new Map(raw.identifierLineMap);
    return {
      language: raw.language,
      callables: raw.callables,
      callSites: raw.callSites,
      clojureMembers: raw.clojureMembers ?? [],
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

export function isClojureMacroDefinition(
  db: ScipDatabase,
  definition: Pick<IndexedDefinition, 'relativePath' | 'startLine' | 'endLine'>,
): boolean {
  if (definition.relativePath.includes('.clj-kondo/hooks/')) return true;
  const callable = getSourceFacts(db, definition.relativePath)?.callables.find(
    (candidate) => candidate.startLine === definition.startLine && candidate.endLine === definition.endLine,
  );
  return callable?.clojureKind === 'macro';
}

function findCallableInFacts(
  facts: SourceFacts,
  startLine: number,
  endLine: number,
): SourceFacts['callables'][number] | null {
  return facts.callables.find((callable) => callable.startLine === startLine && callable.endLine === endLine) ?? null;
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

  // Every callable enclosing the current node; a branch node inside a nested
  // function counts toward each enclosing callable, as the complexity query's
  // own AST pass defines it.
  const openCallables: SourceFacts['callables'] = [];
  const walk = (node: SyntaxNode): void => {
    const callable = callableFactForNode(node, language);
    if (callable) {
      callable.branches = 0;
      callables.push(callable);
      openCallables.push(callable);
    }
    const contribution = branchContribution(node);
    if (contribution > 0) {
      for (const open of openCallables) open.branches = (open.branches ?? 0) + contribution;
    }

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
    if (callable) openCallables.pop();
  };
  walk(tree.rootNode);

  return {
    language,
    callables,
    callSites,
    clojureMembers: [],
    typeContainerMap: buildTypeContainerMap(tree, language),
    identifierLineMap,
    identifiersByLine: identifiersByLine(identifierLineMap),
    fileIdentifiers: new Set(identifierLineMap.keys()),
    rustAttrReferencedNames,
    crossLanguageDispatchNames,
  };
}
