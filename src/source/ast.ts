/**
 * Tree-sitter AST cache for fast, accurate source parsing.
 *
 * Each per-language parser in `src/language-parsers/*.ts` calls `getAst`
 * to walk a source file's syntax tree; the regex-fallback paths in those
 * adapters only run when the AST is unavailable.
 *
 * Caching strategy:
 *   - Parser instances are created once per language at first use.
 *   - Parsed trees are cached per (db, relativePath). Cache is keyed off
 *     the source string identity so callers that pre-load source via
 *     getSourceText share the cache hit.
 */
import type { ScipDatabase } from '../storage/db.js';
import { getSourceText } from './source-text.js';
import { createPerDbSourceCache } from '../storage/per-db-cache.js';
import { detectAstLanguage, isVueSfcPath, type AstLanguage } from './ast-language.js';
import { compileQuery, parseAstSource } from './ast-runtime.js';
import type { QueryInstance, SyntaxNode, Tree } from './ast-types.js';

export { detectAstLanguage, isVueSfcPath };
export { compileQuery };
export type { AstLanguage, QueryInstance, SyntaxNode, Tree };

const TREE_CACHE = createPerDbSourceCache<Tree | null>('ast-trees');
// scip-query: ignore-passthrough — cache lifecycle hook used by composite
// health runs; keeping it here avoids exposing TREE_CACHE outside this module.
export function clearAstCache(db: ScipDatabase): void {
  TREE_CACHE.invalidateAll(db);
}

// scip-query: ignore-passthrough — per-file cache lifecycle hook used by
// composite invalidation without exposing TREE_CACHE outside this module.
export function clearAstCacheForFile(db: ScipDatabase, relativePath: string): void {
  TREE_CACHE.invalidate(db, relativePath);
}

/**
 * Parse a file with tree-sitter and cache the result. Returns null when the
 * language has no AST parser configured (caller should fall back to regex).
 *
 * Vue SFCs are special-cased: there's no working tree-sitter-vue binding
 * compatible with our tree-sitter runtime, so we extract the `<script>` (or
 * `<script setup>`) block and parse it with TypeScript/JavaScript. The
 * extracted script is left-padded with newlines so node line numbers match
 * the original SFC file. Template and style blocks fall back to regex.
 */
// scip-query: ignore-extract — this is the AST entrypoint: language detection,
// Vue SFC handling, parser selection, and source parsing are one parse policy.
export function getAst(db: ScipDatabase, relativePath: string): Tree | null {
  if (isVueSfcPath(relativePath)) {
    return getVueScriptAst(db, relativePath);
  }
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;

  const source = getSourceText(db, relativePath);
  if (!source) return null;

  return TREE_CACHE.get(db, relativePath, source, () => {
    return parseAstSource(lang, source);
  });
}

/**
 * Extract the `<script>` block from a Vue SFC and parse it with the AST
 * grammar implied by `lang=`. The returned Tree's node positions are
 * SFC-relative (achieved by padding the extracted script with newlines so
 * the script content sits on its original line numbers).
 *
 * Returns null when there's no `<script>` block, the source is unreadable,
 * or the inferred grammar isn't loadable.
 */
// scip-query: ignore-extract — this parses the script-bearing part of a Vue
// SFC; block extraction, language selection, and parser dispatch are one rule.
function getVueScriptAst(db: ScipDatabase, relativePath: string): Tree | null {
  const source = getSourceText(db, relativePath);
  if (!source) return null;

  return TREE_CACHE.get(db, relativePath, source, () => {
    const block = extractVueScriptBlock(source);
    if (!block) return null;
    // Pad with newlines so the script content sits on its original lines.
    const padded = '\n'.repeat(block.startLine) + block.body;
    return parseAstSource(block.language, padded);
  });
}

interface VueScriptBlock {
  body: string;
  startLine: number;
  language: AstLanguage;
}

/**
 * Find the first `<script>` (or `<script setup>`) block in a Vue SFC.
 * Vue's grammar disallows nested `<script>` tags so a regex on the SFC
 * is safe — we don't need a full HTML parser. Picks the language from
 * the `lang=` attribute (`ts`/`tsx` → typescript/tsx, otherwise javascript).
 */
function extractVueScriptBlock(source: string): VueScriptBlock | null {
  // Vue allows up to two script blocks: a regular `<script>` and a `<script setup>`.
  // Tooling typically treats their imports as the same source-of-truth, so for
  // our import-tracking purpose grabbing the setup block (when present)
  // covers the modern path, and we fall back to the plain `<script>` otherwise.
  const scripts: { tagOpen: string; body: string; openIdx: number }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  for (const match of source.matchAll(re)) {
    if (typeof match.index !== 'number') continue;
    scripts.push({
      tagOpen: match[1] ?? '',
      body: match[2] ?? '',
      openIdx: match.index + (match[0].length - (match[2]?.length ?? 0) - '</script>'.length),
    });
  }
  if (scripts.length === 0) return null;

  const preferred = scripts.find((s) => /\bsetup\b/.test(s.tagOpen)) ?? scripts[0]!;
  const langMatch = preferred.tagOpen.match(/\blang\s*=\s*["']?([\w-]+)/);
  const langAttr = langMatch?.[1]?.toLowerCase();
  const language: AstLanguage = langAttr === 'ts' || langAttr === 'typescript'
    ? 'typescript'
    : langAttr === 'tsx'
      ? 'tsx'
      : 'javascript';

  // The script body's start line is the count of newlines before openIdx.
  const startLine = countNewlinesBefore(source, preferred.openIdx);
  return { body: preferred.body, startLine, language };
}

function countNewlinesBefore(source: string, offset: number): number {
  let count = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) count++;
  }
  return count;
}

// scip-query: ignore-stale — public return type of getCallableSites; the
// single-consumer count just reflects that the function exposing it is itself
// only called from one place today.
export interface CallableSite {
  name: string;
  startLine: number;
  endLine: number;
}

const CALLABLE_QUERY_BY_LANG: Readonly<Partial<Record<AstLanguage, string>>> = {
  // Rust: free fns + methods. impl-block methods are still `function_item`.
  rust: `
    (function_item name: (identifier) @name) @def
    (function_signature_item name: (identifier) @name) @def
  `,
  // TypeScript / TSX share the same AST shape for these constructs.
  typescript: `
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (method_signature name: (property_identifier) @name) @def
    (function_signature name: (identifier) @name) @def
    (variable_declarator name: (identifier) @name value: (arrow_function)) @def
    (variable_declarator name: (identifier) @name value: (function_expression)) @def
    (public_field_definition name: (property_identifier) @name value: (arrow_function)) @def
  `,
  tsx: `
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (method_signature name: (property_identifier) @name) @def
    (function_signature name: (identifier) @name) @def
    (variable_declarator name: (identifier) @name value: (arrow_function)) @def
    (variable_declarator name: (identifier) @name value: (function_expression)) @def
    (public_field_definition name: (property_identifier) @name value: (arrow_function)) @def
  `,
  javascript: `
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (variable_declarator name: (identifier) @name value: (arrow_function)) @def
    (variable_declarator name: (identifier) @name value: (function_expression)) @def
  `,
  python: `
    (function_definition name: (identifier) @name) @def
  `,
};

const CALLABLE_CACHE = new WeakMap<Tree, CallableSite[]>();

/**
 * Return every callable declaration (function, method, arrow assigned to a
 * binding) in the file with its precise start/end lines. Cached per Tree.
 *
 * Used by correctDefinitionRangesFromSource to look up declaration ranges
 * by name in O(1) instead of regex-scanning the file. For non-AST languages,
 * the tree-sitter path is unavailable and callers fall back to regex.
 */
// scip-query: ignore-wrapper — callable-site index primitive consumed by the
// definition catalog; it hides tree-sitter query execution and cache policy.
export function getCallableSites(db: ScipDatabase, relativePath: string): CallableSite[] | null {
  return runCachedAstQuery(db, relativePath, CALLABLE_CACHE, CALLABLE_QUERY_BY_LANG, (matches) => {
    const sites: CallableSite[] = [];
    for (const match of matches) {
      let name: string | null = null;
      let def: { startLine: number; endLine: number } | null = null;
      for (const cap of match.captures) {
        if (cap.name === 'name') name = cap.node.text;
        else if (cap.name === 'def') {
          def = { startLine: cap.node.startPosition.row, endLine: cap.node.endPosition.row };
        }
      }
      if (name && def) sites.push({ name, startLine: def.startLine, endLine: def.endLine });
    }
    return sites;
  });
}

export interface CallSite {
  /** Leaf name of what is being called — "foo" for `foo()`, `obj.foo()`, `Type::foo()`. */
  calleeLeaf: string;
  /** True for member/dotted calls like `obj.foo()` where the receiver type is unknown. */
  memberAccess: boolean;
  line: number;
}

const CALL_QUERY_BY_LANG: Readonly<Partial<Record<AstLanguage, string>>> = {
  rust: `
    (call_expression function: (_) @target) @call
    (macro_invocation macro: (_) @target) @call
  `,
  typescript: `
    (call_expression function: (_) @target) @call
    (new_expression constructor: (_) @target) @call
  `,
  tsx: `
    (call_expression function: (_) @target) @call
    (new_expression constructor: (_) @target) @call
  `,
  javascript: `
    (call_expression function: (_) @target) @call
    (new_expression constructor: (_) @target) @call
  `,
  python: `
    (call function: (_) @target) @call
  `,
};

const CALLSITE_CACHE = new WeakMap<Tree, CallSite[]>();

/**
 * Return every call expression in the file with its target's leaf name and
 * line. Tree-sitter sees every callsite directly — no chunk-level mention
 * attribution, no lexical fallback, no false positives from identifier
 * references that aren't calls.
 *
 * The "leaf name" is the rightmost dotted/scoped component:
 *   foo()             → "foo"
 *   obj.method()      → "method"
 *   Type::method()    → "method"
 *   pkg.mod.func()    → "func"
 *
 * Cached per parsed Tree.
 */
export function getCallSites(db: ScipDatabase, relativePath: string): CallSite[] | null {
  return runCachedAstQuery(db, relativePath, CALLSITE_CACHE, CALL_QUERY_BY_LANG, (matches) => {
    const sites: CallSite[] = [];
    for (const match of matches) {
      let target: SyntaxNode | null = null;
      let call: SyntaxNode | null = null;
      for (const cap of match.captures) {
        if (cap.name === 'target') target = cap.node;
        else if (cap.name === 'call') call = cap.node;
      }
      if (!target || !call) continue;
      const leaf = extractCallLeaf(target);
      if (!leaf) continue;
      sites.push({ calleeLeaf: leaf, memberAccess: isMemberAccessTarget(target), line: call.startPosition.row });
    }
    return sites;
  });
}

function isMemberAccessTarget(node: SyntaxNode): boolean {
  switch (node.type) {
    case 'field_expression':
    case 'member_expression':
    case 'attribute':
      return true;
    default:
      return false;
  }
}


/**
 * Per-file map: child type name → set of container type names that reference
 * it inside their field/variant type annotations. Powers transitive type
 * usage detection in stale-abstractions: if `Foo` is referenced only by
 * fields of `Bar` and `Bar` has cross-file consumers, `Foo` isn't really
 * stale — it's reachable through `Bar`.
 *
 * Walks structs/enums/interfaces/type aliases. For each, collects every
 * type_identifier inside its body (including those nested in generic_type,
 * array_type, union_type, tuple, etc.) and records "child → container".
 */
export function getTypeContainerMap(
  db: ScipDatabase,
  relativePath: string,
): Map<string, Set<string>> {
  return runCachedAstWalk(db, relativePath, TYPE_CONTAINER_CACHE, () => new Map<string, Set<string>>(), (tree, lang, result) => {
    const link = (child: string, container: string): void => {
      if (child === container) return;
      let bucket = result.get(child);
      if (!bucket) { bucket = new Set(); result.set(child, bucket); }
      bucket.add(container);
    };

    // Different languages name type references with different node types.
    const refTypes = lang === 'python'
      ? new Set(['identifier'])
      : new Set(['type_identifier']);
    const collectChildren = (root: SyntaxNode, container: string): void => {
      const walk = (node: SyntaxNode): void => {
        if (refTypes.has(node.type) && node.text !== container) {
          link(node.text, container);
        }
        for (const child of node.children) walk(child);
      };
      for (const child of root.children) walk(child);
    };

    if (lang === 'rust') {
      for (const s of tree.rootNode.descendantsOfType(['struct_item', 'enum_item', 'union_item', 'type_item'])) {
        const name = s.namedChildren.find((c) => c.type === 'type_identifier')?.text;
        if (!name) continue;
        const body = s.namedChildren.find((c) => c.type === 'field_declaration_list'
          || c.type === 'enum_variant_list'
          || c.type === 'ordered_field_declaration_list');
        if (body) collectChildren(body, name);
        if (s.type === 'type_item') collectChildren(s, name);
      }
    } else if (lang === 'python') {
      // Python class fields are annotated assignments inside the class body.
      // Walk only the `type` annotation nodes (not the assignment values) so
      // we only pick up types, not arbitrary identifiers used as defaults.
      for (const cls of tree.rootNode.descendantsOfType('class_definition')) {
        const name = cls.namedChildren.find((c) => c.type === 'identifier')?.text;
        if (!name) continue;
        const body = cls.namedChildren.find((c) => c.type === 'block');
        if (!body) continue;
        for (const typeNode of body.descendantsOfType('type')) {
          // Inside `type` node, every identifier is a referenced type name.
          for (const id of typeNode.descendantsOfType('identifier')) {
            if (id.text !== name) link(id.text, name);
          }
        }
      }
    } else {
      // TS/JS interfaces, type aliases, classes (field types).
      for (const s of tree.rootNode.descendantsOfType(['interface_declaration', 'type_alias_declaration', 'class_declaration'])) {
        const name = s.namedChildren.find((c) => c.type === 'type_identifier')?.text;
        if (!name) continue;
        collectChildren(s, name);
      }
    }
  }) ?? new Map();
}

// scip-query: ignore-wrapper — cached AST-walk primitive; callers supply the
// accumulator and visitor while this owns language/tree/cache lifecycle.
export function runCachedAstWalk<T>(
  db: ScipDatabase,
  relativePath: string,
  cache: WeakMap<Tree, T>,
  init: () => T,
  walk: (tree: Tree, lang: AstLanguage, acc: T) => void,
): T | null {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;
  const tree = getAst(db, relativePath);
  if (!tree) return null;
  const cached = cache.get(tree);
  if (cached) return cached;
  const acc = init();
  walk(tree, lang, acc);
  cache.set(tree, acc);
  return acc;
}

/**
 * Run a per-language tree-sitter query against `relativePath`, build a result
 * via `build`, and cache it per-Tree. Returns `null` when the language has no
 * query string registered, the source is unparseable, or the query fails to
 * compile. Used by getCallableSites / getCallSites which share this exact
 * shape.
 */
// scip-query: ignore-extract — this is the shared cached AST-query executor:
// language detection, query compilation, AST loading, and projection are one
// cache contract.
export function runCachedAstQuery<T>(
  db: ScipDatabase,
  relativePath: string,
  cache: WeakMap<Tree, T>,
  queryByLang: Readonly<Partial<Record<AstLanguage, string>>>,
  build: (matches: ReturnType<QueryInstance['matches']>) => T,
): T | null {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;
  const queryString = queryByLang[lang];
  if (!queryString) return null;
  const tree = getAst(db, relativePath);
  if (!tree) return null;

  const cached = cache.get(tree);
  if (cached) return cached;

  const query = compileQuery(lang, queryString);
  if (!query) return null;
  const result = build(query.matches(tree.rootNode));
  cache.set(tree, result);
  return result;
}

const TYPE_CONTAINER_CACHE = new WeakMap<Tree, Map<string, Set<string>>>();

/**
 * Pull the rightmost name out of a call target node. Handles plain
 * identifiers, dotted/member access (TS/JS, Python), Rust scoped paths and
 * field expressions, macro names with trailing `!`. Returns null when the
 * call target is something we can't statically attribute (e.g. a function
 * literal invoked inline).
 */
export function extractCallLeaf(node: SyntaxNode): string | null {
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'property_identifier':
    case 'shorthand_property_identifier':
      return node.text;
    case 'field_expression':
    case 'member_expression':
    case 'attribute': {
      // Last named child is the property/field/attribute name.
      const last = node.namedChild(node.namedChildCount - 1);
      return last ? extractCallLeaf(last) : null;
    }
    case 'scoped_identifier': {
      const name = node.childForFieldName('name') ?? node.namedChild(node.namedChildCount - 1);
      return name ? extractCallLeaf(name) : null;
    }
    case 'super':
    case 'self':
    case 'this':
      return null;
    default:
      return null;
  }
}
