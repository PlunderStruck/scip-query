import type { ScipDatabase } from '../storage/db.js';
import { detectAstLanguage, type AstLanguage } from './ast-language.js';
import { getAst } from './ast-core.js';
import type { SyntaxNode, Tree } from './ast-types.js';

export interface CallableFact {
  name: string;
  startLine: number;
  endLine: number;
  paramCount: number;
  isLiteralPassthrough: boolean;
}

export interface SourceCallSite {
  calleeLeaf: string;
  memberAccess: boolean;
  line: number;
}

export interface SourceFacts {
  language: AstLanguage;
  callables: CallableFact[];
  callSites: SourceCallSite[];
  typeContainerMap: Map<string, Set<string>>;
  identifierLineMap: Map<string, number[]>;
  identifiersByLine: Array<Set<string>>;
  fileIdentifiers: Set<string>;
  rustAttrReferencedNames: Set<string>;
  crossLanguageDispatchNames: Set<string>;
}

const SOURCE_FACTS_CACHE = new WeakMap<Tree, SourceFacts>();

const RUST_IDENTIFIER_TYPES = new Set(['identifier', 'type_identifier', 'field_identifier']);
const PYTHON_IDENTIFIER_TYPES = new Set(['identifier']);
const DEFAULT_IDENTIFIER_TYPES = new Set(['identifier', 'property_identifier', 'type_identifier']);
const INTERPOLATION_LANGUAGES = new Set<AstLanguage>(['rust', 'python']);
const JAVASCRIPT_NAMED_CALLABLE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'method_signature',
  'function_signature',
]);
const ATTR_HELPER_RES: ReadonlyArray<RegExp> = [
  /\bdefault\s*=\s*"([^"]+)"/g,
  /\bwith\s*=\s*"([^"]+)"/g,
  /\bserialize_with\s*=\s*"([^"]+)"/g,
  /\bdeserialize_with\s*=\s*"([^"]+)"/g,
  /\bskip_serializing_if\s*=\s*"([^"]+)"/g,
  /\bgetter\s*=\s*"([^"]+)"/g,
  /\brename_all_with\s*=\s*"([^"]+)"/g,
  /\bschema_with\s*=\s*"([^"]+)"/g,
];
const SERDE_ATTR_HEAD = /^#!?\[\s*serde\s*\(/;
const SCHEMARS_ATTR_HEAD = /^#!?\[\s*schemars\s*\(/;
const VALIDATE_ATTR_HEAD = /^#!?\[\s*validate\s*\(/;
const CROSS_LANG_DISPATCH_NAMES = new Set([
  'invoke',
  'invokeTauriCommand',
  'listen',
  'once',
  'emit',
  'subscribe',
  'dispatch',
  'sendCommand',
  'callRust',
]);
const BRACE_BLOCK_RE = /\{([^{}]*)\}/g;
const IDENT_IN_BLOCK_RE = /\b([A-Za-z_][\w]*)\b/g;

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
): CallableFact | null {
  return facts.callables.find((callable) =>
    callable.startLine === startLine && callable.endLine === endLine,
  ) ?? null;
}

function buildSourceFacts(tree: Tree, language: AstLanguage): SourceFacts {
  const callables: CallableFact[] = [];
  const callSites: SourceCallSite[] = [];
  const rustAttrReferencedNames = new Set<string>();
  const crossLanguageDispatchNames = new Set<string>();
  const identifierLineMap = new Map<string, number[]>();
  const identifierTypes = identifierTypesForLanguage(language);

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

    if (identifierTypes.has(node.type)) {
      recordIdentifier(node.text, node.startPosition.row);
    }
    if (INTERPOLATION_LANGUAGES.has(language) && node.type === 'string_content') {
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

function callableFactForNode(
  node: SyntaxNode,
  language: AstLanguage,
): CallableFact | null {
  const named = namedCallableNode(node, language);
  if (named) {
    return {
      name: named.name,
      startLine: named.definitionNode.startPosition.row,
      endLine: named.definitionNode.endPosition.row,
      paramCount: parameterCount(named.functionNode),
      isLiteralPassthrough: isPassthroughBody(named.functionNode, language),
    };
  }

  if (!isNamedCallableType(node.type, language)) return null;
  const nameNode = node.childForFieldName('name')
    ?? node.namedChildren.find((child) =>
      child.type === 'identifier' || child.type === 'property_identifier',
    );
  if (!nameNode) return null;

  return {
    name: nameNode.text,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    paramCount: parameterCount(node),
    isLiteralPassthrough: isPassthroughBody(node, language),
  };
}

function isNamedCallableType(nodeType: string, language: AstLanguage): boolean {
  if (language === 'rust') return nodeType === 'function_item' || nodeType === 'function_signature_item';
  if (language === 'python') return nodeType === 'function_definition';
  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    return JAVASCRIPT_NAMED_CALLABLE_TYPES.has(nodeType);
  }
  return false;
}

function namedCallableNode(
  node: SyntaxNode,
  language: AstLanguage,
): { name: string; definitionNode: SyntaxNode; functionNode: SyntaxNode } | null {
  if (language !== 'typescript' && language !== 'tsx' && language !== 'javascript') return null;

  if (node.type === 'variable_declarator') {
    const name = node.childForFieldName('name') ?? node.namedChild(0);
    const value = node.childForFieldName('value') ?? node.namedChild(1);
    if (!name || !value) return null;
    if (value.type !== 'arrow_function' && value.type !== 'function_expression') return null;
    return { name: name.text, definitionNode: node, functionNode: value };
  }

  if (node.type === 'public_field_definition') {
    const name = node.childForFieldName('name') ?? node.namedChild(0);
    const value = node.childForFieldName('value') ?? node.namedChild(1);
    if (!name || !value) return null;
    if (value.type !== 'arrow_function' && value.type !== 'function_expression') return null;
    return { name: name.text, definitionNode: node, functionNode: value };
  }

  return null;
}

function parameterCount(fnNode: SyntaxNode): number {
  const paramsNode = fnNode.namedChildren.find((child) =>
    child.type === 'parameters' || child.type === 'formal_parameters',
  );
  if (!paramsNode) return 0;

  let count = 0;
  for (const param of paramsNode.namedChildren) {
    if (isCommentNode(param)) continue;
    count += 1;
  }
  return count;
}

function isPassthroughBody(fnNode: SyntaxNode, language: AstLanguage): boolean {
  const body = fnNode.namedChildren.find((child) =>
    child.type === 'block' || child.type === 'statement_block',
  );
  if (!body) return false;

  const statements = body.namedChildren.filter((child) => !isCommentNode(child));
  if (statements.length !== 1) return false;
  const only = statements[0]!;

  let callNode: SyntaxNode | null = null;
  if (only.type === 'return_statement') {
    callNode = only.namedChild(0) ?? null;
  } else if (only.type === 'expression_statement') {
    callNode = only.namedChild(0) ?? null;
  } else if (language === 'rust' && (only.type === 'call_expression' || only.type === 'macro_invocation')) {
    callNode = only;
  }
  if (!callNode) return false;

  const callType = language === 'python' ? 'call' : 'call_expression';
  if (callNode.type !== callType) return false;

  const argsNode = callNode.namedChildren.find((child) =>
    child.type === 'arguments' || child.type === 'argument_list',
  );
  if (!argsNode) return false;
  const callArgs = argsNode.namedChildren.filter((child) => !isCommentNode(child));

  const paramsNode = fnNode.namedChildren.find((child) =>
    child.type === 'parameters' || child.type === 'formal_parameters',
  );
  if (!paramsNode) return false;

  const paramNames: string[] = [];
  for (const param of paramsNode.namedChildren) {
    if (param.type === 'identifier') {
      paramNames.push(param.text);
      continue;
    }
    const id = param.namedChildren.find((child) => child.type === 'identifier');
    if (id) paramNames.push(id.text);
  }

  if (callArgs.length !== paramNames.length) return false;
  for (let index = 0; index < paramNames.length; index += 1) {
    const arg = callArgs[index]!;
    if (arg.type !== 'identifier') return false;
    if (arg.text !== paramNames[index]) return false;
  }
  return true;
}

function callSiteForNode(node: SyntaxNode, language: AstLanguage): SourceCallSite | null {
  const target = callTargetForNode(node, language);
  if (!target) return null;
  const leaf = extractCallLeaf(target);
  if (!leaf) return null;
  return {
    calleeLeaf: leaf,
    memberAccess: isMemberAccessTarget(target),
    line: node.startPosition.row,
  };
}

function callTargetForNode(node: SyntaxNode, language: AstLanguage): SyntaxNode | null {
  if (language === 'rust') {
    if (node.type === 'call_expression') {
      return node.childForFieldName('function') ?? node.namedChild(0);
    }
    if (node.type === 'macro_invocation') {
      return node.childForFieldName('macro') ?? node.namedChild(0);
    }
    return null;
  }

  if (language === 'python') {
    if (node.type !== 'call') return null;
    return node.childForFieldName('function') ?? node.namedChild(0);
  }

  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    if (node.type === 'call_expression') {
      return node.childForFieldName('function') ?? node.namedChild(0);
    }
    if (node.type === 'new_expression') {
      return node.childForFieldName('constructor') ?? node.namedChild(0);
    }
  }

  return null;
}

function collectCrossLanguageDispatchName(
  node: SyntaxNode,
  language: AstLanguage,
  out: Set<string>,
): void {
  if (language !== 'typescript' && language !== 'tsx' && language !== 'javascript') return;
  if (node.type !== 'call_expression') return;

  const target = node.childForFieldName('function') ?? node.namedChild(0);
  if (!target) return;
  const leaf = extractCallLeaf(target);
  if (!leaf || !CROSS_LANG_DISPATCH_NAMES.has(leaf)) return;

  const args = node.namedChildren.find((child) => child.type === 'arguments');
  if (!args) return;
  const firstArg = args.namedChild(0);
  if (!firstArg || firstArg.type !== 'string') return;
  const frag = firstArg.namedChildren.find((child) => child.type === 'string_fragment');
  if (frag) out.add(frag.text);
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

function buildTypeContainerMap(tree: Tree, language: AstLanguage): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const link = (child: string, container: string): void => {
    if (child === container) return;
    let bucket = result.get(child);
    if (!bucket) {
      bucket = new Set();
      result.set(child, bucket);
    }
    bucket.add(container);
  };

  const refTypes = language === 'python'
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

  if (language === 'rust') {
    for (const node of tree.rootNode.descendantsOfType(['struct_item', 'enum_item', 'union_item', 'type_item'])) {
      const name = node.namedChildren.find((child) => child.type === 'type_identifier')?.text;
      if (!name) continue;
      const body = node.namedChildren.find((child) => child.type === 'field_declaration_list'
        || child.type === 'enum_variant_list'
        || child.type === 'ordered_field_declaration_list');
      if (body) collectChildren(body, name);
      if (node.type === 'type_item') collectChildren(node, name);
    }
  } else if (language === 'python') {
    for (const cls of tree.rootNode.descendantsOfType('class_definition')) {
      const name = cls.namedChildren.find((child) => child.type === 'identifier')?.text;
      if (!name) continue;
      const body = cls.namedChildren.find((child) => child.type === 'block');
      if (!body) continue;
      for (const typeNode of body.descendantsOfType('type')) {
        for (const id of typeNode.descendantsOfType('identifier')) {
          if (id.text !== name) link(id.text, name);
        }
      }
    }
  } else {
    for (const node of tree.rootNode.descendantsOfType(['interface_declaration', 'type_alias_declaration', 'class_declaration'])) {
      const name = node.namedChildren.find((child) => child.type === 'type_identifier')?.text;
      if (!name) continue;
      collectChildren(node, name);
    }
  }

  return result;
}

function identifiersByLine(lineMap: ReadonlyMap<string, number[]>): Array<Set<string>> {
  let maxLine = 0;
  for (const lines of lineMap.values()) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last > maxLine) maxLine = last;
  }

  const out: Array<Set<string>> = new Array(maxLine + 1);
  for (let index = 0; index <= maxLine; index += 1) out[index] = new Set();
  for (const [name, lines] of lineMap) {
    for (const line of lines) out[line]!.add(name);
  }
  return out;
}

function identifierTypesForLanguage(language: AstLanguage): ReadonlySet<string> {
  if (language === 'rust') return RUST_IDENTIFIER_TYPES;
  if (language === 'python') return PYTHON_IDENTIFIER_TYPES;
  return DEFAULT_IDENTIFIER_TYPES;
}

function collectRustAttrHelperNames(attrText: string, out: Set<string>): void {
  const isSerde = SERDE_ATTR_HEAD.test(attrText);
  const isSchemars = SCHEMARS_ATTR_HEAD.test(attrText);
  const isValidate = VALIDATE_ATTR_HEAD.test(attrText);
  if (!isSerde && !isSchemars && !isValidate) return;

  for (const re of ATTR_HELPER_RES) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(attrText)) !== null) {
      const value = match[1]!;
      const leaf = value.split('::').pop() ?? value;
      if (leaf === 'is_none' && /\bOption\b/.test(value)) continue;
      if (leaf === 'is_empty' && /\b(String|Vec|HashMap|BTreeMap|HashSet|BTreeSet)\b/.test(value)) continue;
      if (leaf) out.add(leaf);
    }
  }
}

function recordInterpolatedIdentifiers(
  node: SyntaxNode,
  recordIdentifier: (name: string, line: number) => void,
): void {
  const baseLine = node.startPosition.row;
  for (const block of node.text.matchAll(BRACE_BLOCK_RE)) {
    const inner = block[1] ?? '';
    for (const ident of inner.matchAll(IDENT_IN_BLOCK_RE)) {
      if (ident[1]) recordIdentifier(ident[1], baseLine);
    }
  }
}

function isCommentNode(node: SyntaxNode): boolean {
  return node.type === 'comment' || node.type === 'line_comment' || node.type === 'block_comment';
}
