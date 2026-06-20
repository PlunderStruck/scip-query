import type { AstLanguage } from './ast/ast-language.js';
import type { SyntaxNode } from './ast/ast-types.js';
import { extractCallLeaf } from './source-calls.js';

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

export function collectCrossLanguageDispatchName(
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

export function collectRustAttrHelperNames(attrText: string, out: Set<string>): void {
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
