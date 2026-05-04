/**
 * Tree-sitter AST cache for fast, accurate source parsing.
 *
 * Replaces the regex-based parsers in source-analysis.ts for the four
 * languages we care about most (Rust, TypeScript/TSX, JavaScript, Python).
 * Other languages keep their existing regex parsers.
 *
 * Caching strategy:
 *   - Parser instances are created once per language at first use.
 *   - Parsed trees are cached per (db, relativePath). Cache is keyed off
 *     the source string identity so callers that pre-load source via
 *     getSourceText share the cache hit.
 */
import { extname } from 'node:path';
import { createRequire } from 'node:module';
import type { ScipDatabase } from './db.js';
import { getSourceText } from './source-text.js';

const require = createRequire(import.meta.url);

// All grammars are CommonJS native bindings.
type ParserCtor = new () => ParserInstance;
interface ParserInstance {
  setLanguage(lang: unknown): void;
  parse(source: string): Tree;
}
export interface Tree {
  rootNode: SyntaxNode;
}
export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  childCount: number;
  namedChildCount: number;
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  parent: SyntaxNode | null;
  child(index: number): SyntaxNode | null;
  namedChild(index: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  descendantsOfType(type: string | string[]): SyntaxNode[];
}
interface QueryConstructor {
  new (lang: unknown, queryString: string): QueryInstance;
}
export interface QueryInstance {
  captures(node: SyntaxNode): Array<{ name: string; node: SyntaxNode }>;
  matches(node: SyntaxNode): Array<{ pattern: number; captures: Array<{ name: string; node: SyntaxNode }> }>;
}

let _Parser: (ParserCtor & { Query: QueryConstructor }) | null = null;
function getParserCtor(): ParserCtor & { Query: QueryConstructor } {
  if (!_Parser) {
    _Parser = require('tree-sitter') as ParserCtor & { Query: QueryConstructor };
  }
  return _Parser;
}

export type AstLanguage = 'rust' | 'typescript' | 'tsx' | 'javascript' | 'python';

const LANGUAGE_BY_EXT: Readonly<Record<string, AstLanguage>> = {
  '.rs': 'rust',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
};

const grammarCache = new Map<AstLanguage, unknown>();
function loadGrammar(lang: AstLanguage): unknown {
  const cached = grammarCache.get(lang);
  if (cached) return cached;
  let g: unknown;
  switch (lang) {
    case 'rust':       g = require('tree-sitter-rust'); break;
    case 'typescript': g = (require('tree-sitter-typescript') as { typescript: unknown }).typescript; break;
    case 'tsx':        g = (require('tree-sitter-typescript') as { tsx: unknown }).tsx; break;
    case 'javascript': g = require('tree-sitter-javascript'); break;
    case 'python':     g = require('tree-sitter-python'); break;
  }
  grammarCache.set(lang, g);
  return g;
}

const parserPool = new Map<AstLanguage, ParserInstance>();
function getParser(lang: AstLanguage): ParserInstance {
  const cached = parserPool.get(lang);
  if (cached) return cached;
  const Ctor = getParserCtor();
  const parser = new Ctor();
  parser.setLanguage(loadGrammar(lang));
  parserPool.set(lang, parser);
  return parser;
}

export function detectAstLanguage(relativePath: string): AstLanguage | null {
  return LANGUAGE_BY_EXT[extname(relativePath).toLowerCase()] ?? null;
}

const TREE_CACHE = new WeakMap<ScipDatabase, Map<string, { source: string; tree: Tree }>>();

/**
 * Parse a file with tree-sitter and cache the result. Returns null when the
 * language has no AST parser configured (caller should fall back to regex).
 */
export function getAst(db: ScipDatabase, relativePath: string): Tree | null {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;

  let perDb = TREE_CACHE.get(db);
  if (!perDb) {
    perDb = new Map();
    TREE_CACHE.set(db, perDb);
  }

  const source = getSourceText(db, relativePath);
  if (!source) return null;

  const cached = perDb.get(relativePath);
  if (cached && cached.source === source) return cached.tree;

  const tree = getParser(lang).parse(source);
  perDb.set(relativePath, { source, tree });
  return tree;
}

const QUERY_CACHE = new Map<string, QueryInstance>();
/** Compile (and cache) a tree-sitter query for the given language + query text. */
export function compileQuery(lang: AstLanguage, queryString: string): QueryInstance {
  const key = `${lang}::${queryString}`;
  const cached = QUERY_CACHE.get(key);
  if (cached) return cached;
  const Q = getParserCtor().Query;
  const compiled = new Q(loadGrammar(lang), queryString);
  QUERY_CACHE.set(key, compiled);
  return compiled;
}

export interface CallableSite {
  name: string;
  startLine: number;
  endLine: number;
}

const CALLABLE_QUERY_BY_LANG: Readonly<Record<AstLanguage, string>> = {
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
export function getCallableSites(db: ScipDatabase, relativePath: string): CallableSite[] | null {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;
  const tree = getAst(db, relativePath);
  if (!tree) return null;

  const cached = CALLABLE_CACHE.get(tree);
  if (cached) return cached;

  const query = compileQuery(lang, CALLABLE_QUERY_BY_LANG[lang]);
  const matches = query.matches(tree.rootNode);
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

  CALLABLE_CACHE.set(tree, sites);
  return sites;
}

export interface CallSite {
  /** Leaf name of what is being called — "foo" for `foo()`, `obj.foo()`, `Type::foo()`. */
  calleeLeaf: string;
  line: number;
}

const CALL_QUERY_BY_LANG: Readonly<Record<AstLanguage, string>> = {
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
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;
  const tree = getAst(db, relativePath);
  if (!tree) return null;

  const cached = CALLSITE_CACHE.get(tree);
  if (cached) return cached;

  const query = compileQuery(lang, CALL_QUERY_BY_LANG[lang]);
  const sites: CallSite[] = [];
  for (const match of query.matches(tree.rootNode)) {
    let target: SyntaxNode | null = null;
    let call: SyntaxNode | null = null;
    for (const cap of match.captures) {
      if (cap.name === 'target') target = cap.node;
      else if (cap.name === 'call') call = cap.node;
    }
    if (!target || !call) continue;
    const leaf = extractCallLeaf(target);
    if (!leaf) continue;
    sites.push({ calleeLeaf: leaf, line: call.startPosition.row });
  }

  CALLSITE_CACHE.set(tree, sites);
  return sites;
}

/**
 * Reasons a definition is "framework-owned" — invoked by something other
 * than statically-resolvable code (test runners, IPC bridges, derive macros).
 * Cross-file SCIP references won't show these calls; without filtering they
 * dominate the dead-code report.
 *
 * Two matching axes for robustness:
 *   - `startLine` / `endLine`: definitions whose start line falls in the
 *     range are excluded (catches functions and well-ranged fields).
 *   - `containerName`: definitions whose SCIP symbol descriptor names this
 *     type as a parent are excluded (catches struct fields whose SCIP
 *     enclosing-range points at the struct's first line — common with
 *     scip-rust). The `containerName` is the struct/enum/union's identifier.
 */
export interface ExclusionEntry {
  startLine: number;
  endLine: number;
  reason: string;
  containerName?: string;
}

const EXCLUSION_CACHE = new WeakMap<Tree, ExclusionEntry[]>();

/**
 * Find every definition the dead-code pass should skip because the symbol is
 * framework-invoked: Rust `#[tauri::command]`, `#[test]`, `#[bench]`, anything
 * inside `#[cfg(test)] mod`, and `#[derive(Serialize/Deserialize)]` struct
 * fields (touched by serde reflection); TS/JS test files (any file containing
 * top-level `describe()`, `it()`, `test()`, `beforeEach()`, etc. calls).
 */
export function getDefinitionExclusions(
  db: ScipDatabase,
  relativePath: string,
): ExclusionEntry[] {
  const lang = detectAstLanguage(relativePath);
  if (lang === 'rust') return getRustExclusions(db, relativePath);
  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    return getJsTestExclusions(db, relativePath);
  }
  return [];
}

const TEST_FRAMEWORK_NAMES = new Set([
  'describe', 'it', 'test', 'fdescribe', 'fit', 'xdescribe', 'xit',
  'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'before', 'after',
  'suite', 'bench', 'benchmark',
]);

function getJsTestExclusions(
  db: ScipDatabase,
  relativePath: string,
): ExclusionEntry[] {
  const tree = getAst(db, relativePath);
  if (!tree) return [];
  const cached = EXCLUSION_CACHE.get(tree);
  if (cached) return cached;

  // Next.js / Remix file conventions: any top-level export in a page-like
  // path is framework-invoked by the router.
  const isNextRoute = /(^|\/)(pages|app)\/.+\.(tsx?|jsx?)$/.test(relativePath)
    || /(^|\/)(layout|page|loading|error|not-found|head|template|default)\.(tsx?|jsx?)$/.test(relativePath);
  // Vite/Vue route component conventions
  const isViteRoute = /(^|\/)src\/(pages|views|routes)\/.+\.(tsx?|jsx?|vue)$/.test(relativePath);

  // Scan top-level `expression_statement > call_expression > identifier`
  // for test-framework names. Presence of any one classifies the whole
  // file as a test file — its top-level helpers are then framework-owned.
  let isTestFile = false;
  const program = tree.rootNode;
  for (const child of program.namedChildren) {
    if (child.type !== 'expression_statement') continue;
    const call = child.namedChild(0);
    if (!call || call.type !== 'call_expression') continue;
    const target = call.namedChild(0);
    if (!target) continue;
    const name = target.type === 'member_expression'
      ? target.namedChild(target.namedChildCount - 1)?.text
      : target.text;
    if (name && TEST_FRAMEWORK_NAMES.has(name)) {
      isTestFile = true;
      break;
    }
  }

  const out: ExclusionEntry[] = [];
  if (isTestFile) {
    out.push({
      startLine: 0,
      endLine: program.endPosition.row,
      reason: 'TS/JS test file (describe/it/test at top level)',
    });
  }

  if (isNextRoute || isViteRoute) {
    // Framework-routed file: every exported function/component is invoked
    // by the framework's router, not by static code.
    out.push({
      startLine: 0,
      endLine: program.endPosition.row,
      reason: isNextRoute ? 'Next.js / Remix route file' : 'Vite/Vue route component',
    });
  }

  // Custom React hook detection: top-level function whose name starts with
  // `use` followed by an uppercase letter is invoked by React's render loop
  // when called from a component — same dispatch invisibility as Tauri
  // commands and trait impls.
  for (const child of program.namedChildren) {
    let funcName: string | null = null;
    let funcNode: SyntaxNode | null = null;
    if (child.type === 'function_declaration') {
      funcName = child.namedChild(0)?.text ?? null;
      funcNode = child;
    } else if (child.type === 'export_statement') {
      const inner = child.namedChild(0);
      if (inner?.type === 'function_declaration') {
        funcName = inner.namedChild(0)?.text ?? null;
        funcNode = inner;
      }
    } else if (child.type === 'lexical_declaration') {
      const decl = child.namedChild(0);
      if (decl?.type === 'variable_declarator') {
        const name = decl.namedChild(0)?.text;
        const value = decl.namedChild(1);
        if (name && (value?.type === 'arrow_function' || value?.type === 'function_expression')) {
          funcName = name;
          funcNode = decl;
        }
      }
    }
    if (funcName && /^use[A-Z]/.test(funcName) && funcNode) {
      out.push({
        startLine: funcNode.startPosition.row,
        endLine: funcNode.endPosition.row,
        reason: 'React custom hook (use*)',
      });
    }
  }

  out.push(...collectSuppressionExclusions(
    tree,
    new Set(['function_declaration', 'method_definition', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'variable_declarator', 'export_statement']),
    new Set(['comment']),
  ));
  EXCLUSION_CACHE.set(tree, out);
  return out;
}

/**
 * Honor `// scip-query: ignore-dead` (or `// scip-query-ignore: dead-code`)
 * comments immediately before a definition. Lets users suppress known
 * false positives without modifying the detector's heuristics.
 */
const SUPPRESS_COMMENT_RE = /scip-query[\s:-]*ignore[\s:-]*(?:dead(?:-code)?|stale)?/i;
function isSuppressionComment(text: string): boolean {
  return SUPPRESS_COMMENT_RE.test(text);
}

function collectSuppressionExclusions(
  tree: Tree,
  matchableNodeTypes: ReadonlySet<string>,
  commentTypes: ReadonlySet<string>,
): ExclusionEntry[] {
  const out: ExclusionEntry[] = [];
  const walk = (node: SyntaxNode): void => {
    if (matchableNodeTypes.has(node.type) && node.parent) {
      const parent = node.parent;
      const children = parent.children;
      let idx = -1;
      for (let i = 0; i < children.length; i += 1) {
        if (children[i]!.startIndex === node.startIndex && children[i]!.type === node.type) {
          idx = i;
          break;
        }
      }
      if (idx > 0) {
        for (let i = idx - 1; i >= 0; i -= 1) {
          const sib = children[i]!;
          if (commentTypes.has(sib.type)) {
            if (isSuppressionComment(sib.text)) {
              out.push({
                startLine: node.startPosition.row,
                endLine: node.endPosition.row,
                reason: 'scip-query suppression comment',
              });
              break;
            }
            continue;
          }
          // Skip attribute_items between comment and node — common in Rust.
          if (sib.type === 'attribute_item' || sib.type === 'inner_attribute_item') continue;
          break;
        }
      }
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(tree.rootNode);
  return out;
}

function getRustExclusions(
  db: ScipDatabase,
  relativePath: string,
): ExclusionEntry[] {
  const tree = getAst(db, relativePath);
  if (!tree) return [];

  const cached = EXCLUSION_CACHE.get(tree);
  if (cached) return cached;

  const out: ExclusionEntry[] = [];

  const collectAttrTexts = (item: SyntaxNode): string[] => {
    const parent = item.parent;
    if (!parent) return [];
    // Match by startIndex to avoid issues if `parent.children[i]` returns a
    // fresh wrapper object that isn't reference-equal to `item`. Native
    // tree-sitter bindings sometimes re-create wrapper objects per access.
    const children = parent.children;
    let idx = -1;
    for (let i = 0; i < children.length; i += 1) {
      if (children[i]!.startIndex === item.startIndex && children[i]!.type === item.type) {
        idx = i;
        break;
      }
    }
    if (idx <= 0) return [];
    const attrs: string[] = [];
    for (let i = idx - 1; i >= 0; i -= 1) {
      const sibling = children[i]!;
      if (sibling.type === 'attribute_item' || sibling.type === 'inner_attribute_item') {
        attrs.push(sibling.text);
      } else if (sibling.type === 'line_comment' || sibling.type === 'block_comment') {
        continue;
      } else {
        break;
      }
    }
    return attrs;
  };

  const isFrameworkAttr = (attrText: string): string | null => {
    if (/#\[\s*tauri::command\b/.test(attrText)) return '#[tauri::command]';
    if (/#\[\s*command\b/.test(attrText)) return '#[command]'; // tauri shorthand
    if (/#\[\s*test\b/.test(attrText)) return '#[test]';
    if (/#\[\s*bench\b/.test(attrText)) return '#[bench]';
    if (/#\[\s*tokio::test\b/.test(attrText)) return '#[tokio::test]';
    if (/#\[\s*async_std::test\b/.test(attrText)) return '#[async_std::test]';
    if (/#\[\s*wasm_bindgen\b/.test(attrText)) return '#[wasm_bindgen]';
    if (/#\[\s*no_mangle\b/.test(attrText)) return '#[no_mangle]';
    if (/#\[\s*napi\b/.test(attrText)) return '#[napi]';
    if (/#\[\s*pyfunction\b/.test(attrText)) return '#[pyfunction]';
    if (/#\[\s*pymethod\b/.test(attrText)) return '#[pymethod]';
    if (/#\[\s*pyo3\b/.test(attrText)) return '#[pyo3]';
    if (/#\[\s*cfg\s*\(\s*test\s*\)/.test(attrText)) return '#[cfg(test)]';
    if (/#\[\s*doc\s*\(\s*hidden\s*\)/.test(attrText)) return '#[doc(hidden)]';
    return null;
  };

  const isReflectiveDeriveAttr = (attrText: string): boolean => {
    if (!/#\[\s*derive\s*\(/.test(attrText)) return false;
    // Any derive that touches fields via reflection / macro expansion. SCIP
    // doesn't see these accesses; without the exclusion every field of these
    // structs looks dead.
    return /\bSerialize\b/.test(attrText)
      || /\bDeserialize\b/.test(attrText)
      || /\bFromRow\b/.test(attrText)        // sqlx
      || /\bDeriveEntityModel\b/.test(attrText) // sea-orm
      || /\bIntoSchema\b/.test(attrText)     // utoipa
      || /\bToSchema\b/.test(attrText)       // utoipa
      || /\bDeriveValueType\b/.test(attrText)
      || /\bsqlx::FromRow\b/.test(attrText);
  };
  const isAllowDeadCodeAttr = (attrText: string): boolean => {
    return /#\[\s*allow\s*\(\s*dead_code\s*\)/.test(attrText);
  };

  const visit = (node: SyntaxNode, inTestMod: boolean, inTraitImpl: boolean): void => {
    let childInTestMod = inTestMod;
    let childInTraitImpl = inTraitImpl;

    if (node.type === 'impl_item') {
      // `impl Trait for Type` has TWO type_identifier children;
      // `impl Type` has one. Trait impl methods are invoked through the trait
      // (dynamic dispatch or generic bounds) — SCIP can't see those calls so
      // they look "dead" without this filter.
      const typeIds = node.namedChildren.filter((c) => c.type === 'type_identifier');
      if (typeIds.length >= 2) childInTraitImpl = true;
    }

    if (node.type === 'function_item' || node.type === 'function_signature_item') {
      const attrs = collectAttrTexts(node);
      let reason: string | null = null;
      if (inTraitImpl) reason = 'trait impl method (dynamic dispatch)';
      else if (inTestMod) reason = 'inside #[cfg(test)] mod';
      for (const attr of attrs) {
        const r = isFrameworkAttr(attr);
        if (r) { reason = r; break; }
        if (isAllowDeadCodeAttr(attr)) { reason = '#[allow(dead_code)]'; break; }
      }
      if (reason) {
        out.push({ startLine: node.startPosition.row, endLine: node.endPosition.row, reason });
      }
    } else if (node.type === 'struct_item' || node.type === 'enum_item' || node.type === 'union_item') {
      const attrs = collectAttrTexts(node);
      const isReflective = attrs.some(isReflectiveDeriveAttr);
      const isAllowed = attrs.some(isAllowDeadCodeAttr);
      const typeName = node.namedChildren.find((c) => c.type === 'type_identifier')?.text;
      if (isReflective) {
        out.push({
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          reason: '#[derive(<reflective>)] — fields accessed via macro/reflection',
          containerName: typeName,
        });
      }
      if (isAllowed) {
        out.push({
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          reason: '#[allow(dead_code)]',
          containerName: typeName,
        });
      }
      if (inTestMod) {
        out.push({
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          reason: 'inside #[cfg(test)] mod',
          containerName: typeName,
        });
      }
    } else if (node.type === 'mod_item') {
      const attrs = collectAttrTexts(node);
      if (attrs.some((a) => /#\[\s*cfg\s*\(\s*test\s*\)/.test(a))) {
        childInTestMod = true;
      }
    }

    for (const child of node.namedChildren) visit(child, childInTestMod, childInTraitImpl);
  };

  visit(tree.rootNode, false, false);

  // Suppression comments override the heuristic checks above.
  out.push(...collectSuppressionExclusions(
    tree,
    new Set(['function_item', 'function_signature_item', 'struct_item', 'enum_item', 'union_item', 'impl_item', 'mod_item', 'static_item', 'const_item']),
    new Set(['line_comment', 'block_comment']),
  ));

  EXCLUSION_CACHE.set(tree, out);
  return out;
}

/**
 * True when a function's body is a *direct* forward to one other call —
 * `return inner(a, b)` (or void `inner(a, b)`) where the call's args are
 * exactly the function's parameters in order. Passthrough-candidates uses
 * this to filter out type guards, defaulted wrappers, and partial
 * applications that happen to call exactly one function.
 *
 * Returns false when the body has any extra logic — additional statements,
 * literal args, computed args, default-value substitution, control flow.
 *
 * Per-file cache (we re-use the AST parse).
 */
export function isLiteralPassthrough(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): boolean {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return true; // No AST — fall back to LOC heuristic (current behavior).
  const tree = getAst(db, relativePath);
  if (!tree) return true;

  let cache = PASSTHROUGH_CACHE.get(tree);
  if (!cache) {
    cache = buildPassthroughIndex(tree, lang);
    PASSTHROUGH_CACHE.set(tree, cache);
  }
  const result = cache.get(`${startLine}:${endLine}`);
  return result ?? true;
}

const PASSTHROUGH_CACHE = new WeakMap<Tree, Map<string, boolean>>();

function buildPassthroughIndex(tree: Tree, lang: AstLanguage): Map<string, boolean> {
  const callableNodeTypes = lang === 'rust'
    ? new Set(['function_item', 'function_signature_item'])
    : lang === 'python'
      ? new Set(['function_definition'])
      : new Set(['function_declaration', 'method_definition', 'arrow_function', 'function_expression']);
  const index = new Map<string, boolean>();
  const walk = (node: SyntaxNode): void => {
    if (callableNodeTypes.has(node.type)) {
      index.set(`${node.startPosition.row}:${node.endPosition.row}`, isPassthroughBody(node, lang));
    }
    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);
  return index;
}

function isPassthroughBody(fnNode: SyntaxNode, lang: AstLanguage): boolean {
  // Find the body block.
  const body = fnNode.namedChildren.find((c) =>
    c.type === 'block' || c.type === 'statement_block',
  );
  if (!body) return false;

  // Body must contain exactly one statement (or for Rust an expression).
  const statements = body.namedChildren.filter((c) =>
    c.type !== 'comment' && c.type !== 'line_comment' && c.type !== 'block_comment',
  );
  if (statements.length !== 1) return false;
  const only = statements[0]!;

  // Unwrap return statements / expression statements to find the call.
  let callNode: SyntaxNode | null = null;
  if (only.type === 'return_statement') {
    callNode = only.namedChild(0) ?? null;
  } else if (only.type === 'expression_statement') {
    callNode = only.namedChild(0) ?? null;
  } else if (lang === 'rust' && (only.type === 'call_expression' || only.type === 'macro_invocation')) {
    // Rust expression-as-block tail
    callNode = only;
  }
  if (!callNode) return false;
  const callType = lang === 'python' ? 'call' : 'call_expression';
  if (callNode.type !== callType) return false;

  // Get the call's arguments and the function's parameters.
  const argsNode = callNode.namedChildren.find((c) =>
    c.type === 'arguments' || c.type === 'argument_list',
  );
  if (!argsNode) return false;
  const callArgs = argsNode.namedChildren.filter((c) => c.type !== 'comment');

  const paramsNode = fnNode.namedChildren.find((c) =>
    c.type === 'parameters' || c.type === 'formal_parameters',
  );
  if (!paramsNode) return false;
  const paramNames: string[] = [];
  for (const p of paramsNode.namedChildren) {
    // TS: required_parameter > identifier
    // Rust: parameter > identifier (also self_parameter for methods)
    // Python: identifier directly, or default_parameter > identifier
    if (p.type === 'identifier') paramNames.push(p.text);
    else {
      const id = p.namedChildren.find((c) => c.type === 'identifier');
      if (id) paramNames.push(id.text);
    }
  }

  // Args must equal params in order, by name.
  if (callArgs.length !== paramNames.length) return false;
  for (let i = 0; i < paramNames.length; i += 1) {
    const arg = callArgs[i]!;
    if (arg.type !== 'identifier') return false;
    if (arg.text !== paramNames[i]) return false;
  }
  return true;
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
  const lang = detectAstLanguage(relativePath);
  if (!lang) return new Map();
  const tree = getAst(db, relativePath);
  if (!tree) return new Map();

  const cached = TYPE_CONTAINER_CACHE.get(tree);
  if (cached) return cached;

  const result = new Map<string, Set<string>>();
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

  TYPE_CONTAINER_CACHE.set(tree, result);
  return result;
}

const TYPE_CONTAINER_CACHE = new WeakMap<Tree, Map<string, Set<string>>>();

/**
 * Names known to take a command-string argument that dispatches to a
 * cross-language handler. Hits in source code like `invoke('start_job', ...)`
 * are treated as references to a function named `start_job` defined in
 * another language (typically Rust via Tauri's IPC bridge).
 */
const CROSS_LANG_DISPATCH_NAMES = new Set([
  'invoke',           // Tauri JS API
  'invokeTauriCommand',
  'listen',           // Tauri event listener
  'once',             // Tauri one-shot listener
  'emit',             // Tauri event emit
  'subscribe',
  'dispatch',
  'sendCommand',
  'callRust',
]);

/**
 * Walk TS/JS callsites looking for string-arg dispatches like
 * `invoke('cmd_name')`. Returns the set of dispatched command names.
 *
 * Used by the dead-code detector: a Rust function whose leaf name appears
 * here was reached from JS even though no static call exists in the SCIP
 * graph. Without this, every Tauri command not annotated `#[tauri::command]`
 * (the framework allows lower-level registrations too) looks dead.
 */
export function getCrossLanguageDispatchNames(
  db: ScipDatabase,
  relativePath: string,
): Set<string> {
  const lang = detectAstLanguage(relativePath);
  if (lang !== 'typescript' && lang !== 'tsx' && lang !== 'javascript') {
    return new Set();
  }
  const tree = getAst(db, relativePath);
  if (!tree) return new Set();

  const cached = DISPATCH_NAMES_CACHE.get(tree);
  if (cached) return cached;

  const out = new Set<string>();
  const calls = tree.rootNode.descendantsOfType('call_expression');
  for (const call of calls) {
    const target = call.namedChild(0);
    if (!target) continue;
    // Resolve the call target's leaf — handles `invoke(...)`,
    // `tauri.invoke(...)`, `window.__TAURI__.invoke(...)`.
    const leaf = extractCallLeaf(target);
    if (!leaf || !CROSS_LANG_DISPATCH_NAMES.has(leaf)) continue;

    const args = call.namedChildren.find((c) => c.type === 'arguments');
    if (!args) continue;
    const firstArg = args.namedChild(0);
    if (!firstArg) continue;
    if (firstArg.type !== 'string') continue;
    const frag = firstArg.namedChildren.find((c) => c.type === 'string_fragment');
    if (frag) out.add(frag.text);
  }

  DISPATCH_NAMES_CACHE.set(tree, out);
  return out;
}

const DISPATCH_NAMES_CACHE = new WeakMap<Tree, Set<string>>();

export interface CallableSignature {
  paramCount: number;
}

const SIGNATURE_CACHE = new WeakMap<Tree, Map<string, CallableSignature>>();

/**
 * Pull a function's parameter count from the AST. Used by similar-pair
 * filtering to avoid declaring a 1-arg helper similar to a 7-arg orchestrator
 * just because they happen to share infrastructure callees.
 *
 * On first call per file, walks the entire AST once and indexes every
 * callable's signature by (startLine, endLine). Subsequent calls are O(1)
 * Map lookups — critical when called for thousands of candidates.
 */
export function getCallableSignature(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): CallableSignature | null {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;
  const tree = getAst(db, relativePath);
  if (!tree) return null;

  let cache = SIGNATURE_CACHE.get(tree);
  if (!cache) {
    cache = buildSignatureIndex(tree, lang);
    SIGNATURE_CACHE.set(tree, cache);
  }
  return cache.get(`${startLine}:${endLine}`) ?? null;
}

function buildSignatureIndex(tree: Tree, lang: AstLanguage): Map<string, CallableSignature> {
  const callableNodeTypes = lang === 'rust'
    ? new Set(['function_item', 'function_signature_item'])
    : lang === 'python'
      ? new Set(['function_definition'])
      : new Set(['function_declaration', 'method_definition', 'arrow_function', 'function_expression']);

  const index = new Map<string, CallableSignature>();
  const walk = (node: SyntaxNode): void => {
    if (callableNodeTypes.has(node.type)) {
      const paramsNode = node.namedChildren.find((c) =>
        c.type === 'parameters' || c.type === 'formal_parameters',
      );
      let paramCount = 0;
      if (paramsNode) {
        for (const p of paramsNode.namedChildren) {
          if (p.type === 'comment' || p.type === 'line_comment' || p.type === 'block_comment') continue;
          paramCount += 1;
        }
      }
      index.set(`${node.startPosition.row}:${node.endPosition.row}`, { paramCount });
    }
    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);
  return index;
}

export interface DetailedCallSite {
  /** Function/method name being invoked. */
  calleeName: string;
  /** Receiver expression's leftmost name, or null for free functions. */
  receiverName: string | null;
  line: number;
}

const DETAILED_CALL_CACHE = new WeakMap<Tree, DetailedCallSite[]>();

/**
 * Like getCallSites but also extracts the receiver name. For `obj.method()`
 * the receiver is "obj"; for `this.method()` the receiver is "this"; for a
 * free call like `foo()` the receiver is null. Used by getSourceCalls to
 * preserve the existing regex parser's contract.
 */
export function getDetailedCallSites(
  db: ScipDatabase,
  relativePath: string,
): DetailedCallSite[] | null {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;
  const tree = getAst(db, relativePath);
  if (!tree) return null;

  const cached = DETAILED_CALL_CACHE.get(tree);
  if (cached) return cached;

  const query = compileQuery(lang, CALL_QUERY_BY_LANG[lang]);
  const sites: DetailedCallSite[] = [];
  for (const match of query.matches(tree.rootNode)) {
    let target: SyntaxNode | null = null;
    let call: SyntaxNode | null = null;
    for (const cap of match.captures) {
      if (cap.name === 'target') target = cap.node;
      else if (cap.name === 'call') call = cap.node;
    }
    if (!target || !call) continue;
    const calleeName = extractCallLeaf(target);
    if (!calleeName) continue;
    sites.push({
      calleeName,
      receiverName: extractCallReceiver(target),
      line: call.startPosition.row,
    });
  }

  DETAILED_CALL_CACHE.set(tree, sites);
  return sites;
}

/**
 * Receiver = the part to the left of the dot/`::`. For `obj.method()` returns
 * "obj"; for `pkg::Type::method()` returns "Type"; for plain `foo()` returns
 * null. Used to disambiguate methods from free calls in getSourceCalls.
 */
function extractCallReceiver(node: SyntaxNode): string | null {
  switch (node.type) {
    case 'field_expression':
    case 'member_expression':
    case 'attribute': {
      const obj = node.namedChild(0);
      if (!obj) return null;
      if (obj.type === 'this' || obj.type === 'self' || obj.type === 'super') return obj.type;
      // Use rightmost identifier of the receiver expression for nested paths.
      return extractCallLeaf(obj);
    }
    case 'scoped_identifier': {
      // For `Type::method`, receiver is the next-to-last segment.
      const namedChildren = node.namedChildren;
      if (namedChildren.length < 2) return null;
      return extractCallLeaf(namedChildren[namedChildren.length - 2]!);
    }
    default:
      return null;
  }
}

export interface ConstructorBindingSite {
  localName: string;
  typeName: string;
}

const BINDING_CACHE = new WeakMap<Tree, ConstructorBindingSite[]>();

const BINDING_QUERY_BY_LANG: Readonly<Record<AstLanguage, string>> = {
  // TS captures three binding patterns the regex parser used:
  //   1. const x = new Foo()
  //   2. const x: Foo = ... — explicit type annotation on a variable
  //   3. function f(x: Foo) — parameter with type annotation
  // (2) and (3) are essential for resolving `x.method()` against a type the
  // parameter type names. The regex parser handled both via the same
  // `name: Type` pattern.
  typescript: `
    (variable_declarator name: (identifier) @name value: (new_expression constructor: (_) @ctor))
    (variable_declarator name: (identifier) @name type: (type_annotation (type_identifier) @ctor))
    (required_parameter pattern: (identifier) @name type: (type_annotation (type_identifier) @ctor))
    (optional_parameter pattern: (identifier) @name type: (type_annotation (type_identifier) @ctor))
    (public_field_definition name: (property_identifier) @name type: (type_annotation (type_identifier) @ctor))
  `,
  tsx: `
    (variable_declarator name: (identifier) @name value: (new_expression constructor: (_) @ctor))
    (variable_declarator name: (identifier) @name type: (type_annotation (type_identifier) @ctor))
    (required_parameter pattern: (identifier) @name type: (type_annotation (type_identifier) @ctor))
    (optional_parameter pattern: (identifier) @name type: (type_annotation (type_identifier) @ctor))
    (public_field_definition name: (property_identifier) @name type: (type_annotation (type_identifier) @ctor))
  `,
  javascript: `(variable_declarator name: (identifier) @name value: (new_expression constructor: (_) @ctor))`,
  python: `(assignment left: (identifier) @name right: (call function: (_) @ctor))`,
  rust: `(let_declaration pattern: (identifier) @name value: (call_expression function: (_) @ctor))`,
};

/**
 * Bindings of the form `const x = new Foo()` (TS/JS) or `let x = Foo::new()`
 * (Rust) so downstream queries can resolve `x.method()` to `Foo::method`.
 */
export function getConstructorBindings(
  db: ScipDatabase,
  relativePath: string,
): ConstructorBindingSite[] | null {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;
  const tree = getAst(db, relativePath);
  if (!tree) return null;

  const cached = BINDING_CACHE.get(tree);
  if (cached) return cached;

  const query = compileQuery(lang, BINDING_QUERY_BY_LANG[lang]);
  const sites: ConstructorBindingSite[] = [];
  for (const match of query.matches(tree.rootNode)) {
    let nameNode: SyntaxNode | null = null;
    let ctorNode: SyntaxNode | null = null;
    for (const cap of match.captures) {
      if (cap.name === 'name') nameNode = cap.node;
      else if (cap.name === 'ctor') ctorNode = cap.node;
    }
    if (!nameNode || !ctorNode) continue;
    const typeName = extractCallLeaf(ctorNode);
    if (!typeName) continue;
    sites.push({ localName: nameNode.text, typeName });
  }

  BINDING_CACHE.set(tree, sites);
  return sites;
}

/**
 * Pull the rightmost name out of a call target node. Handles plain
 * identifiers, dotted/member access (TS/JS, Python), Rust scoped paths and
 * field expressions, macro names with trailing `!`. Returns null when the
 * call target is something we can't statically attribute (e.g. a function
 * literal invoked inline).
 */
function extractCallLeaf(node: SyntaxNode): string | null {
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
