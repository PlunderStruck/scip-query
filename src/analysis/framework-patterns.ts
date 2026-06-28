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
 *  - Generic suppression-comment honoring (`// scip-query: ignore-dead`).
 */
import type { ScipDatabase } from '../storage/db.js';
import { fileContentHash, readCachedFileEvidence, writeCachedFileEvidence } from '../storage/evidence-cache.js';
import { detectAstLanguage, getAst, type SyntaxNode, type Tree } from '../source/ast.js';
import { getSourceText } from '../source/source-text.js';

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
 * top-level `describe()`, `it()`, `test()`, `beforeEach()`, etc. calls), plus
 * explicit suppressions and React custom hooks.
 */
export function getDefinitionExclusions(db: ScipDatabase, relativePath: string): ExclusionEntry[] {
  const lang = detectAstLanguage(relativePath);
  const supported = lang === 'rust' || lang === 'typescript' || lang === 'tsx' || lang === 'javascript';
  if (!supported) return [];
  const source = getSourceText(db, relativePath);
  if (!source) return [];
  const contentHash = fileContentHash(db, relativePath, source);
  const cached = readCachedFileEvidence(db, 'definition-exclusions', relativePath, contentHash);
  if (cached) {
    const entries = parseCachedDefinitionExclusions(cached);
    if (entries) return entries;
  }
  const entries = lang === 'rust' ? getRustExclusions(db, relativePath) : getJsTestExclusions(db, relativePath);
  writeCachedFileEvidence(db, 'definition-exclusions', relativePath, contentHash, JSON.stringify(entries));
  return entries;
}

function parseCachedDefinitionExclusions(payload: string): ExclusionEntry[] | null {
  try {
    const value = JSON.parse(payload) as unknown;
    if (!Array.isArray(value)) return null;
    if (!value.every(isExclusionEntry)) return null;
    return value;
  } catch {
    return null;
  }
}

function isExclusionEntry(value: unknown): value is ExclusionEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ExclusionEntry>;
  if (typeof entry.startLine !== 'number' || !Number.isFinite(entry.startLine)) return false;
  if (typeof entry.endLine !== 'number' || !Number.isFinite(entry.endLine)) return false;
  if (typeof entry.reason !== 'string') return false;
  return entry.containerName === undefined || typeof entry.containerName === 'string';
}

const TEST_FRAMEWORK_NAMES = new Set([
  'describe',
  'it',
  'test',
  'fdescribe',
  'fit',
  'xdescribe',
  'xit',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'before',
  'after',
  'suite',
  'bench',
  'benchmark',
]);
const TEST_FRAMEWORK_CALL_RE =
  /\b(?:describe|it|test|fdescribe|fit|xdescribe|xit|beforeEach|afterEach|beforeAll|afterAll|before|after|suite|bench|benchmark)\s*\(/;
const REACT_HOOK_DECLARATION_RE =
  /\b(?:export\s+)?(?:async\s+)?function\s+use[A-Z][A-Za-z0-9_$]*\b|\b(?:const|let|var)\s+use[A-Z][A-Za-z0-9_$]*\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:function\b|(?:<[^=;{]+>\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/;

function getJsTestExclusions(db: ScipDatabase, relativePath: string): ExclusionEntry[] {
  const source = getSourceText(db, relativePath);
  if (!source || !mayContainJsExclusion(source)) return [];

  const tree = getAst(db, relativePath);
  if (!tree) return [];
  const cached = EXCLUSION_CACHE.get(tree);
  if (cached) return cached;

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
    const name =
      target.type === 'member_expression' ? target.namedChild(target.namedChildCount - 1)?.text : target.text;
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

  out.push(
    ...collectSuppressionExclusions(
      tree,
      new Set([
        'function_declaration',
        'method_definition',
        'class_declaration',
        'interface_declaration',
        'type_alias_declaration',
        'enum_declaration',
        'variable_declarator',
        'export_statement',
      ]),
      new Set(['comment']),
    ),
  );
  EXCLUSION_CACHE.set(tree, out);
  return out;
}

function mayContainJsExclusion(source: string): boolean {
  if (source.includes('scip-query')) return true;
  let mayContainTestFrameworkCall = false;
  for (const name of TEST_FRAMEWORK_NAMES) {
    if (!source.includes(name)) continue;
    mayContainTestFrameworkCall = true;
    break;
  }
  if (mayContainTestFrameworkCall && TEST_FRAMEWORK_CALL_RE.test(source)) return true;
  return source.includes('use') && REACT_HOOK_DECLARATION_RE.test(source);
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

// scip-query: ignore-extract — this is the Rust exclusion policy aggregator:
// generated-file shortcut, AST exclusions, suppression comments, and serde
// module handling are one accuracy contract for dead-code filtering.
function getRustExclusions(db: ScipDatabase, relativePath: string): ExclusionEntry[] {
  const tree = getAst(db, relativePath);
  if (!tree) return [];

  const cached = EXCLUSION_CACHE.get(tree);
  if (cached) return cached;

  const out: ExclusionEntry[] = [];

  const generatedExclusion = generatedRustFileExclusion(tree);
  if (generatedExclusion) {
    EXCLUSION_CACHE.set(tree, generatedExclusion);
    return generatedExclusion;
  }

  collectRustAstExclusions(tree.rootNode, out, false, false);

  // Suppression comments override the heuristic checks above.
  out.push(
    ...collectSuppressionExclusions(
      tree,
      new Set([
        'function_item',
        'function_signature_item',
        'struct_item',
        'enum_item',
        'union_item',
        'impl_item',
        'mod_item',
        'static_item',
        'const_item',
      ]),
      new Set(['line_comment', 'block_comment']),
    ),
  );

  out.push(...serdeWithModuleExclusions(tree.rootNode));

  EXCLUSION_CACHE.set(tree, out);
  return out;
}

function generatedRustFileExclusion(tree: Tree): ExclusionEntry[] | null {
  // Generated-file shortcut. tonic-build, prost-build, openapi-generator-rust,
  // and bindgen all stamp an `@generated` marker into the first few lines.
  // Every definition inside is reflection/macro/network-driven and the SCIP
  // graph never connects callers to it. Bail out wholesale instead of
  // case-handling each indirection.
  if (!isGeneratedFileHeader(tree.rootNode)) return null;
  return [
    {
      startLine: 0,
      endLine: tree.rootNode.endPosition.row,
      reason: 'generated file (@generated header)',
    },
  ];
}

// scip-query: ignore-extract — this is the recursive Rust syntax visitor for
// framework exclusions; inherited test-module and trait-impl state drive each
// child visit, so splitting branches would hide the traversal state.
function collectRustAstExclusions(
  node: SyntaxNode,
  out: ExclusionEntry[],
  inTestMod: boolean,
  inTraitImpl: boolean,
): void {
  let childInTestMod = inTestMod;
  let childInTraitImpl = inTraitImpl;

  if (node.type === 'trait_item') {
    out.push({
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      reason: 'trait declaration body (dynamic dispatch)',
    });
  }

  if (node.type === 'impl_item' && node.childForFieldName('trait')) {
    childInTraitImpl = true;
    out.push({
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      reason: 'trait impl block (dynamic dispatch)',
    });
  }

  if (node.type === 'function_item' || node.type === 'function_signature_item') {
    collectRustFunctionExclusion(node, out, inTestMod, inTraitImpl);
  } else if (inTraitImpl && isRustAssociatedTraitItem(node)) {
    out.push({
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      reason: 'trait impl associated item (dynamic dispatch)',
    });
  } else if (node.type === 'struct_item' || node.type === 'enum_item' || node.type === 'union_item') {
    collectRustTypeExclusions(node, out, inTestMod);
  } else if (node.type === 'mod_item') {
    if (rustAttributeTexts(node).some((a) => /#\[\s*cfg\s*\(\s*test\s*\)/.test(a))) {
      childInTestMod = true;
    }
  }

  for (const child of node.namedChildren) {
    collectRustAstExclusions(child, out, childInTestMod, childInTraitImpl);
  }
}

function collectRustFunctionExclusion(
  node: SyntaxNode,
  out: ExclusionEntry[],
  inTestMod: boolean,
  inTraitImpl: boolean,
): void {
  const attrs = rustAttributeTexts(node);
  let reason: string | null = null;
  if (inTraitImpl) reason = 'trait impl method (dynamic dispatch)';
  else if (inTestMod) reason = 'inside #[cfg(test)] mod';
  for (const attr of attrs) {
    const frameworkReason = rustFrameworkAttrReason(attr);
    if (frameworkReason) {
      reason = frameworkReason;
      break;
    }
    if (isRustAllowDeadCodeAttr(attr)) {
      reason = '#[allow(dead_code)]';
      break;
    }
  }
  if (reason) {
    out.push({ startLine: node.startPosition.row, endLine: node.endPosition.row, reason });
  }
}

function collectRustTypeExclusions(node: SyntaxNode, out: ExclusionEntry[], inTestMod: boolean): void {
  const attrs = rustAttributeTexts(node);
  const typeName = node.namedChildren.find((c) => c.type === 'type_identifier')?.text;

  if (attrs.some(isRustReflectiveDeriveAttr)) {
    out.push({
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      reason: '#[derive(<reflective>)] — fields accessed via macro/reflection',
      containerName: typeName,
    });
  }
  if (attrs.some(isRustAllowDeadCodeAttr)) {
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
}

function rustAttributeTexts(item: SyntaxNode): string[] {
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
}

const RUST_FRAMEWORK_ATTR_REASONS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /#\[\s*tauri::command\b/, reason: '#[tauri::command]' },
  { re: /#\[\s*command\b/, reason: '#[command]' }, // tauri shorthand
  { re: /#\[\s*test\b/, reason: '#[test]' },
  { re: /#\[\s*bench\b/, reason: '#[bench]' },
  { re: /#\[\s*tokio::test\b/, reason: '#[tokio::test]' },
  { re: /#\[\s*async_std::test\b/, reason: '#[async_std::test]' },
  { re: /#\[\s*wasm_bindgen\b/, reason: '#[wasm_bindgen]' },
  { re: /#\[\s*no_mangle\b/, reason: '#[no_mangle]' },
  { re: /#\[\s*napi\b/, reason: '#[napi]' },
  { re: /#\[\s*pyfunction\b/, reason: '#[pyfunction]' },
  { re: /#\[\s*pymethod\b/, reason: '#[pymethod]' },
  { re: /#\[\s*pyo3\b/, reason: '#[pyo3]' },
  { re: /#\[\s*cfg\s*\(\s*test\s*\)/, reason: '#[cfg(test)]' },
  { re: /#\[\s*doc\s*\(\s*hidden\s*\)/, reason: '#[doc(hidden)]' },
];

function rustFrameworkAttrReason(attrText: string): string | null {
  return RUST_FRAMEWORK_ATTR_REASONS.find(({ re }) => re.test(attrText))?.reason ?? null;
}

const RUST_REFLECTIVE_DERIVE_RES: ReadonlyArray<RegExp> = [
  /\bSerialize\b/,
  /\bDeserialize\b/,
  /\bFromRow\b/, // sqlx
  /\bsqlx::FromRow\b/,
  /\bDeriveEntityModel\b/, // sea-orm
  /\bIntoSchema\b/, // utoipa
  /\bToSchema\b/, // utoipa
  /\bDeriveValueType\b/,
  /\bError\b/, // thiserror and compatible generated Display impls
  /\bthiserror::Error\b/,
];

function isRustReflectiveDeriveAttr(attrText: string): boolean {
  if (!/#\[\s*derive\s*\(/.test(attrText)) return false;
  // Any derive that touches fields via reflection / macro expansion. SCIP
  // doesn't see these accesses; without the exclusion every field of these
  // structs looks dead.
  return RUST_REFLECTIVE_DERIVE_RES.some((re) => re.test(attrText));
}

function isRustAllowDeadCodeAttr(attrText: string): boolean {
  return /#\[\s*allow\s*\(\s*dead_code\s*\)/.test(attrText);
}

function isRustAssociatedTraitItem(node: SyntaxNode): boolean {
  return (
    node.type === 'const_item' ||
    node.type === 'type_item' ||
    node.type === 'static_item' ||
    node.type === 'associated_type'
  );
}

function serdeWithModuleExclusions(root: SyntaxNode): ExclusionEntry[] {
  const serdeWithModNames = collectSerdeWithModNames(root);
  if (serdeWithModNames.size === 0) return [];

  const out: ExclusionEntry[] = [];
  for (const mod of root.descendantsOfType('mod_item')) {
    const name = mod.childForFieldName('name')?.text;
    if (name && serdeWithModNames.has(name)) {
      out.push({
        startLine: mod.startPosition.row,
        endLine: mod.endPosition.row,
        reason: 'serde `with = "..."` module — body invoked via reflection',
        containerName: name,
      });
    }
  }
  return out;
}

/**
 * Detect tonic-build / prost-build / openapi-generator / bindgen style
 * `@generated` markers in the first few comments of a file.
 */
function isGeneratedFileHeader(root: SyntaxNode): boolean {
  // Scan top-level leading comments only — `@generated` further down is
  // commentary about a single item, not the whole file.
  for (let i = 0; i < Math.min(root.namedChildCount, 12); i += 1) {
    const child = root.namedChild(i);
    if (!child) break;
    if (child.type !== 'line_comment' && child.type !== 'block_comment') break;
    if (/@generated\b/.test(child.text)) return true;
    if (/This file is .*generated\b/i.test(child.text)) return true;
    if (/Code generated by/i.test(child.text)) return true;
    // openapi-generator's banner is multi-line and uses "Generated by:".
    if (/Generated by:\s*https?:\/\/openapi-generator/i.test(child.text)) return true;
    if (/openapi-generator/i.test(child.text) && /Generated by/i.test(child.text)) return true;
  }
  return false;
}

const SERDE_ATTR_HEAD = /^#!?\[\s*serde\s*\(/;
const SERDE_WITH_RE = /\bwith\s*=\s*"([^"]+)"/g;

/**
 * Subset of attribute scanning aimed at `serde(with = "module_name")` —
 * returns the bare module names referenced. `getRustExclusions` uses this to
 * blanket-exclude the named `mod` block.
 */
function collectSerdeWithModNames(root: SyntaxNode): Set<string> {
  const out = new Set<string>();
  for (const attr of root.descendantsOfType('attribute_item')) {
    if (!SERDE_ATTR_HEAD.test(attr.text)) continue;
    SERDE_WITH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SERDE_WITH_RE.exec(attr.text)) !== null) {
      const value = m[1]!;
      const leaf = value.split('::').pop() ?? value;
      if (leaf) out.add(leaf);
    }
  }
  return out;
}
