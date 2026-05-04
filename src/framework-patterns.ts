/**
 * Framework-pattern AST analyzers — per-language registry of "the framework
 * dispatches this, static analysis can't see it" patterns.
 *
 * Pulled out of ast.ts because:
 *  - Per-language patterns grow independently of the AST runtime.
 *  - Mixing them with parser plumbing made ast.ts the answer to two
 *    different questions ("how do I parse?" + "what does Rust's tauri
 *    macro look like?").
 *
 * Owned here today:
 *  - getDefinitionExclusions: the dead-code "skip this, it's framework-
 *    invoked" verdict.
 *  - getCrossLanguageDispatchNames: Tauri-style `invoke('cmd_name', ...)`
 *    string-arg dispatches that cross language boundaries.
 *  - Generic suppression-comment honoring (`// scip-query: ignore-dead`).
 */
import type { ScipDatabase } from './db.js';
import {
  type AstLanguage,
  detectAstLanguage,
  extractCallLeaf,
  getAst,
  runCachedAstWalk,
  type SyntaxNode,
  type Tree,
} from './ast.js';

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
  return runCachedAstWalk(db, relativePath, DISPATCH_NAMES_CACHE, () => new Set<string>(), (tree, lang, out) => {
    if (lang !== 'typescript' && lang !== 'tsx' && lang !== 'javascript') return;

    for (const call of tree.rootNode.descendantsOfType('call_expression')) {
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
  }) ?? new Set();
}

const DISPATCH_NAMES_CACHE = new WeakMap<Tree, Set<string>>();
