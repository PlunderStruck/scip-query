import type { SyntaxNode } from './ast-types.js';
import { parseAstSource } from './ast-runtime.js';
import { callableFactForNode } from './source-callables.js';
import { callSiteForNode } from './source-calls.js';
import type { VueSfcScriptBlock, VueSfcUnit } from './vue-sfc.js';
import { vueBlockLineCount } from './vue-sfc.js';

export type VueScriptCallCategory =
  | 'call'
  | 'composable'
  | 'store'
  | 'reactivity'
  | 'lifecycle'
  | 'request'
  | 'macro';

export interface VueScriptImportFact {
  local: string;
  source: string;
  sourcePath: string;
  line: number;
  setup: boolean;
}

export interface VueScriptFunctionFact {
  name: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  setup: boolean;
}

export interface VueScriptCallFact {
  name: string;
  sourcePath: string;
  line: number;
  categories: VueScriptCallCategory[];
  setup: boolean;
}

// scip-query: ignore-stale — public Vue behavior envelope consumed by profiles
// and the AST facade; fields are intentionally read by category.
export interface VueScriptFacts {
  imports: VueScriptImportFact[];
  functions: VueScriptFunctionFact[];
  calls: VueScriptCallFact[];
  composables: string[];
  stores: string[];
  reactivity: string[];
  lifecycle: string[];
  requests: string[];
  macros: string[];
  lineCount: number;
  externalLineCount: number;
  externalScriptPaths: string[];
  unresolvedScripts: Array<{ sourcePath: string; reason: string }>;
}

const REACTIVITY_CALLS = new Set([
  'ref',
  'shallowRef',
  'reactive',
  'computed',
  'watch',
  'watchEffect',
]);

const LIFECYCLE_CALLS = new Set([
  'onBeforeMount',
  'onMounted',
  'onBeforeUpdate',
  'onUpdated',
  'onBeforeUnmount',
  'onUnmounted',
  'onActivated',
  'onDeactivated',
  'onErrorCaptured',
]);

const REQUEST_CALLS = new Set([
  'axios',
  'fetch',
  'runRequest',
  'useAsyncData',
  'useFetch',
  'useResource',
]);

const MACRO_CALLS = new Set([
  'defineEmits',
  'defineExpose',
  'defineModel',
  'defineOptions',
  'defineProps',
  'withDefaults',
]);

const CALL_FALLBACK_STOP_WORDS = new Set([
  'catch',
  'for',
  'function',
  'if',
  'return',
  'switch',
  'while',
]);

export function buildVueScriptFacts(unit: VueSfcUnit): VueScriptFacts {
  const facts: VueScriptFacts = {
    imports: [],
    functions: [],
    calls: [],
    composables: [],
    stores: [],
    reactivity: [],
    lifecycle: [],
    requests: [],
    macros: [],
    lineCount: 0,
    externalLineCount: 0,
    externalScriptPaths: [],
    unresolvedScripts: [],
  };

  for (const block of unit.scripts) {
    facts.lineCount += vueBlockLineCount(block);
    if (block.external) {
      facts.externalLineCount += vueBlockLineCount(block);
      facts.externalScriptPaths.push(block.sourcePath);
    }
    for (const error of block.errors) {
      facts.unresolvedScripts.push({ sourcePath: block.sourcePath, reason: error });
    }
    if (!block.body || !block.astLanguage) {
      if (!block.astLanguage) {
        facts.unresolvedScripts.push({
          sourcePath: block.sourcePath,
          reason: `Unsupported Vue script language: ${block.lang ?? 'unknown'}`,
        });
      }
      continue;
    }

    facts.imports.push(...extractImportFacts(block));
    const tree = parseAstSource(block.astLanguage, block.body);
    if (tree) {
      collectAstScriptFacts(block, tree.rootNode, facts);
    } else {
      collectFallbackScriptFacts(block, facts);
    }
  }

  facts.composables = uniqueSorted(facts.calls
    .filter((call) => call.categories.includes('composable'))
    .map((call) => call.name));
  facts.stores = uniqueSorted(facts.calls
    .filter((call) => call.categories.includes('store'))
    .map((call) => call.name));
  facts.reactivity = uniqueSorted(facts.calls
    .filter((call) => call.categories.includes('reactivity'))
    .map((call) => call.name));
  facts.lifecycle = uniqueSorted(facts.calls
    .filter((call) => call.categories.includes('lifecycle'))
    .map((call) => call.name));
  facts.requests = uniqueSorted(facts.calls
    .filter((call) => call.categories.includes('request'))
    .map((call) => call.name));
  facts.macros = uniqueSorted(facts.calls
    .filter((call) => call.categories.includes('macro'))
    .map((call) => call.name));
  facts.externalScriptPaths = uniqueSorted(facts.externalScriptPaths);
  return facts;
}

function collectAstScriptFacts(
  block: VueSfcScriptBlock,
  root: SyntaxNode,
  facts: VueScriptFacts,
): void {
  const seenCalls = new Set<string>();
  const seenFunctions = new Set<string>();

  const walk = (node: SyntaxNode): void => {
    const callable = callableFactForNode(node, block.astLanguage!);
    if (callable) {
      const key = `${callable.name}:${callable.startLine}:${callable.endLine}`;
      if (!seenFunctions.has(key)) {
        seenFunctions.add(key);
        facts.functions.push({
          name: callable.name,
          sourcePath: block.sourcePath,
          startLine: block.startLine + callable.startLine,
          endLine: block.startLine + callable.endLine,
          setup: block.setup,
        });
      }
    }

    const call = callSiteForNode(node, block.astLanguage!);
    if (call) {
      const key = `${call.calleeLeaf}:${call.line}`;
      if (!seenCalls.has(key)) {
        seenCalls.add(key);
        facts.calls.push({
          name: call.calleeLeaf,
          sourcePath: block.sourcePath,
          line: block.startLine + call.line,
          categories: categoriesForCall(call.calleeLeaf),
          setup: block.setup,
        });
      }
    }

    for (const child of node.children) walk(child);
  };
  walk(root);
}

function collectFallbackScriptFacts(block: VueSfcScriptBlock, facts: VueScriptFacts): void {
  for (const match of block.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (!name || CALL_FALLBACK_STOP_WORDS.has(name)) continue;
    facts.calls.push({
      name,
      sourcePath: block.sourcePath,
      line: block.startLine + lineAtOffset(block.body, match.index ?? 0),
      categories: categoriesForCall(name),
      setup: block.setup,
    });
  }

  for (const match of block.body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\b/g)) {
    const name = match[1];
    if (!name) continue;
    const line = block.startLine + lineAtOffset(block.body, match.index ?? 0);
    facts.functions.push({
      name,
      sourcePath: block.sourcePath,
      startLine: line,
      endLine: line,
      setup: block.setup,
    });
  }

  for (const match of block.body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) {
    const name = match[1];
    if (!name) continue;
    const line = block.startLine + lineAtOffset(block.body, match.index ?? 0);
    facts.functions.push({
      name,
      sourcePath: block.sourcePath,
      startLine: line,
      endLine: line,
      setup: block.setup,
    });
  }
}

function extractImportFacts(block: VueSfcScriptBlock): VueScriptImportFact[] {
  const facts: VueScriptImportFact[] = [];
  for (const match of block.body.matchAll(/\bimport\s+(?:type\s+)?([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = match[1]?.trim();
    const source = match[2];
    if (!clause || !source) continue;
    const line = block.startLine + lineAtOffset(block.body, match.index ?? 0);
    for (const local of localNamesFromImportClause(clause)) {
      facts.push({ local, source, sourcePath: block.sourcePath, line, setup: block.setup });
    }
  }
  return facts;
}

function localNamesFromImportClause(clause: string): string[] {
  const names: string[] = [];
  const parts = clause.split(',').map((part) => part.trim()).filter(Boolean);
  const first = parts[0];
  if (first && !first.startsWith('{') && !first.startsWith('*')) {
    names.push(first);
  }
  const named = /\{([^}]*)\}/.exec(clause)?.[1];
  if (named) {
    for (const raw of named.split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(part)?.[1];
      names.push(alias ?? part.replace(/^type\s+/, '').trim());
    }
  }
  const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
  if (namespace) names.push(namespace);
  return names.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

function categoriesForCall(name: string): VueScriptCallCategory[] {
  const categories: VueScriptCallCategory[] = ['call'];
  if (/^use[A-Z0-9_]/.test(name)) categories.push('composable');
  if (/^use[A-Z0-9_].*Store$/.test(name)) categories.push('store');
  if (REACTIVITY_CALLS.has(name)) categories.push('reactivity');
  if (LIFECYCLE_CALLS.has(name)) categories.push('lifecycle');
  if (REQUEST_CALLS.has(name)) categories.push('request');
  if (MACRO_CALLS.has(name)) categories.push('macro');
  return categories;
}

function lineAtOffset(source: string, offset: number): number {
  let count = 0;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
