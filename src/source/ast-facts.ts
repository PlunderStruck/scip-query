import type { ScipDatabase } from '../storage/db.js';
import { detectAstLanguage, type AstLanguage } from './ast-language.js';
import { getAst } from './ast-core.js';
import { compileQuery } from './ast-runtime.js';
import type { QueryInstance, SyntaxNode, Tree } from './ast-types.js';

// scip-query: ignore-stale — public return type of getCallableSites; the
// single-consumer count just reflects that the function exposing it is itself
// only called from one place today.
export interface CallableSite {
  name: string;
  startLine: number;
  endLine: number;
}

const CALLABLE_QUERY_BY_LANG: Readonly<Partial<Record<AstLanguage, string>>> = {
  rust: `
    (function_item name: (identifier) @name) @def
    (function_signature_item name: (identifier) @name) @def
  `,
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
  /** Leaf name of what is being called, for example "foo" for `obj.foo()`. */
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

const TYPE_CONTAINER_CACHE = new WeakMap<Tree, Map<string, Set<string>>>();

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
      for (const cls of tree.rootNode.descendantsOfType('class_definition')) {
        const name = cls.namedChildren.find((c) => c.type === 'identifier')?.text;
        if (!name) continue;
        const body = cls.namedChildren.find((c) => c.type === 'block');
        if (!body) continue;
        for (const typeNode of body.descendantsOfType('type')) {
          for (const id of typeNode.descendantsOfType('identifier')) {
            if (id.text !== name) link(id.text, name);
          }
        }
      }
    } else {
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
