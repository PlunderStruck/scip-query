import {
  ElementTypes,
  NodeTypes,
  parse as parseTemplate,
  type AttributeNode,
  type DirectiveNode,
  type ElementNode,
  type ExpressionNode,
  type RootNode,
  type TemplateChildNode,
} from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import type { ScipDatabase } from '../../storage/db.js';
import { createSourceFileCache } from '../../storage/per-db-cache.js';
import { isFrontendIdentifierStopWord } from '../primitives/frontend-identifier-stoplist.js';
import { pascalCaseSeparated } from '../primitives/name-normalization.js';
import { getSourceText } from '../primitives/source-text.js';
import { getVueSfcUnit, type VueSfcResolvedBlock } from '../ast/vue-sfc.js';

export interface VueTemplateBlock {
  body: string;
  startLine: number;
  endLine: number;
}

export interface VueTemplateTagFact {
  tag: string;
  normalized: string;
  kind: 'component' | 'native' | 'builtin';
  startLine: number;
  endLine: number;
}

export interface VueTemplateBindingFact {
  name: string;
  kind: 'prop' | 'event' | 'directive' | 'slot';
  value: string | null;
  startLine: number;
  endLine: number;
}

export interface VueTemplateIdentifierFact {
  name: string;
  startLine: number;
  endLine: number;
}

// scip-query: ignore-stale — public template facts envelope returned by
// getVueTemplateFacts() and consumed by Vue profile/query/reporting layers.
export interface VueTemplateFacts {
  relativePath: string;
  template: { startLine: number; endLine: number } | null;
  componentTags: VueTemplateTagFact[];
  nativeTags: VueTemplateTagFact[];
  builtinTags: VueTemplateTagFact[];
  props: VueTemplateBindingFact[];
  events: VueTemplateBindingFact[];
  directives: VueTemplateBindingFact[];
  slots: VueTemplateBindingFact[];
  expressionIdentifiers: VueTemplateIdentifierFact[];
  structuralTokens: string[];
}

const VUE_TEMPLATE_FACTS_CACHE = createSourceFileCache<VueTemplateFacts>('vue-template-facts');

const BUILTIN_TAGS = new Set([
  'component',
  'keep-alive',
  'slot',
  'suspense',
  'teleport',
  'template',
  'transition',
  'transition-group',
]);

const NATIVE_HTML_TAGS = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'param',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'svg',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

const GENERIC_NATIVE_TAGS = new Set(['div', 'span', 'template']);

const EXPRESSION_STOP_WORDS = new Set([
  'as',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'of',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

export function getVueTemplateFacts(db: ScipDatabase, relativePath: string): VueTemplateFacts {
  const normalized = relativePath.replace(/\\/g, '/');
  const source = getSourceText(db, normalized);
  return VUE_TEMPLATE_FACTS_CACHE.get(db, normalized, source, () =>
    buildVueTemplateFactsFromBlock(normalized, getVueSfcUnit(db, normalized).template),
  );
}

export function extractVueTemplateBlock(source: string): VueTemplateBlock | null {
  const parsed = parseSfc(source);
  const template = parsed.descriptor.template;
  if (!template) return null;
  const startLine = Math.max(0, template.loc.start.line - 1);
  return {
    body: template.content,
    startLine,
    endLine: Math.max(startLine, template.loc.end.line - 1),
  };
}

function buildVueTemplateFactsFromBlock(
  relativePath: string,
  template: Pick<VueSfcResolvedBlock, 'body' | 'startLine' | 'endLine'> | null,
): VueTemplateFacts {
  const facts: VueTemplateFacts = {
    relativePath,
    template: template ? { startLine: template.startLine, endLine: template.endLine } : null,
    componentTags: [],
    nativeTags: [],
    builtinTags: [],
    props: [],
    events: [],
    directives: [],
    slots: [],
    expressionIdentifiers: [],
    structuralTokens: [],
  };
  if (!template) return facts;

  let root: RootNode;
  try {
    root = parseTemplate(template.body, { comments: false });
  } catch {
    return facts;
  }

  const tokens = new Set<string>();
  const addToken = (token: string): void => {
    if (token.trim()) tokens.add(token);
  };

  walkTemplateChildren(root.children, template.startLine, facts, addToken);
  facts.structuralTokens = [...tokens].sort();
  return facts;
}

function walkTemplateChildren(
  children: readonly TemplateChildNode[],
  lineOffset: number,
  facts: VueTemplateFacts,
  addToken: (token: string) => void,
): void {
  for (const child of children) {
    if (child.type === NodeTypes.ELEMENT) {
      recordElement(child, lineOffset, facts, addToken);
      walkTemplateChildren(child.children, lineOffset, facts, addToken);
    } else if (child.type === NodeTypes.INTERPOLATION) {
      addToken('interpolation');
      const value = expressionSource(child.content);
      if (value) recordExpressionIdentifiers(value, lineOffset, child.loc.start.line, facts, addToken);
    }
  }
}

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
function recordElement(
  element: ElementNode,
  lineOffset: number,
  facts: VueTemplateFacts,
  addToken: (token: string) => void,
): void {
  const normalized = normalizeTagName(element.tag);
  const tagFact: VueTemplateTagFact = {
    tag: element.tag,
    normalized,
    kind: classifyTag(element),
    startLine: toSourceLine(lineOffset, element.loc.start.line),
    endLine: toSourceLine(lineOffset, element.loc.end.line),
  };

  if (tagFact.kind === 'component') {
    facts.componentTags.push(tagFact);
    addToken(`component:${normalized}`);
  } else if (tagFact.kind === 'builtin') {
    facts.builtinTags.push(tagFact);
    addToken(`builtin:${normalized}`);
  } else {
    facts.nativeTags.push(tagFact);
    if (!GENERIC_NATIVE_TAGS.has(element.tag)) addToken(`native:${element.tag}`);
  }

  for (const prop of element.props) {
    recordProp(prop, lineOffset, facts, addToken);
  }
}

function recordProp(
  prop: AttributeNode | DirectiveNode,
  lineOffset: number,
  facts: VueTemplateFacts,
  addToken: (token: string) => void,
): void {
  if (prop.type === NodeTypes.ATTRIBUTE) {
    const value = prop.value?.content ?? null;
    const fact = bindingFact('prop', prop.name, value, lineOffset, prop.loc.start.line, prop.loc.end.line);
    facts.props.push(fact);
    addToken(`prop:${prop.name}`);
    return;
  }

  const name = directiveDisplayName(prop);
  const value = expressionSource(prop.exp);
  const fact = bindingFact(directiveKind(prop.name), name, value, lineOffset, prop.loc.start.line, prop.loc.end.line);
  switch (fact.kind) {
    case 'prop':
      facts.props.push(fact);
      addToken(`prop:${name}`);
      break;
    case 'event':
      facts.events.push(fact);
      addToken(`event:${name}`);
      break;
    case 'slot':
      facts.slots.push(fact);
      addToken(`slot:${name}`);
      break;
    case 'directive':
      facts.directives.push(fact);
      addToken(`directive:${name}`);
      break;
  }
  if (value) recordExpressionIdentifiers(value, lineOffset, prop.loc.start.line, facts, addToken);
}

function bindingFact(
  kind: VueTemplateBindingFact['kind'],
  name: string,
  value: string | null,
  lineOffset: number,
  startLine: number,
  endLine: number,
): VueTemplateBindingFact {
  return {
    kind,
    name,
    value,
    startLine: toSourceLine(lineOffset, startLine),
    endLine: toSourceLine(lineOffset, endLine),
  };
}

function directiveKind(name: string): VueTemplateBindingFact['kind'] {
  switch (name) {
    case 'bind':
    case 'model':
      return 'prop';
    case 'on':
      return 'event';
    case 'slot':
      return 'slot';
    default:
      return 'directive';
  }
}

function directiveDisplayName(prop: DirectiveNode): string {
  const arg = expressionSource(prop.arg);
  if (arg) return arg;
  return prop.name;
}

function expressionSource(expression: ExpressionNode | undefined): string | null {
  if (!expression) return null;
  const content = (
    'content' in expression && typeof expression.content === 'string' ? expression.content : expression.loc.source
  ).trim();
  return content ? content : null;
}

function recordExpressionIdentifiers(
  expression: string,
  lineOffset: number,
  expressionStartLine: number,
  facts: VueTemplateFacts,
  addToken: (token: string) => void,
): void {
  for (const name of expressionIdentifiers(expression)) {
    const fact = {
      name,
      startLine: toSourceLine(lineOffset, expressionStartLine),
      endLine: toSourceLine(lineOffset, expressionStartLine),
    };
    facts.expressionIdentifiers.push(fact);
    addToken(`id:${name}`);
  }
}

function expressionIdentifiers(expression: string): string[] {
  const out = new Set<string>();
  const searchable = stripExpressionStrings(expression);
  const re = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(searchable))) {
    const name = match[0]!;
    if (EXPRESSION_STOP_WORDS.has(name) || isFrontendIdentifierStopWord(name)) continue;
    if (/^[A-Z_]+$/.test(name)) continue;
    out.add(name);
  }
  return [...out].sort();
}

function stripExpressionStrings(expression: string): string {
  return expression
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(
      /`(?:\\[\s\S]|\$\{([^}]*)\}|[^`\\])*`/g,
      (_match, interpolation: string | undefined) => interpolation ?? ' ',
    )
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, ' ')
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, ' ');
}

function classifyTag(element: ElementNode): VueTemplateTagFact['kind'] {
  const tag = element.tag;
  if (element.tagType === ElementTypes.COMPONENT) return 'component';
  if (BUILTIN_TAGS.has(tag)) return 'builtin';
  if (NATIVE_HTML_TAGS.has(tag)) return 'native';
  return /^[A-Z]/.test(tag) || tag.includes('-') ? 'component' : 'native';
}

function normalizeTagName(tag: string): string {
  return pascalCaseSeparated(tag, /[-_:]/);
}

function toSourceLine(lineOffset: number, templateLine: number): number {
  return lineOffset + Math.max(0, templateLine - 1);
}
