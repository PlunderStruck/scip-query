import { extname } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { fileContentHash } from '../storage/evidence-cache.js';
import { isRecord, stringArray } from '../storage/evidence-payload.js';
import { createFileEvidenceProduct } from '../storage/evidence-products.js';
import { createSourceFileCache } from '../storage/per-db-cache.js';
import { getAst } from './ast/ast-core.js';
import type { SyntaxNode } from './ast/ast-types.js';
import { detectAstLanguage, type AstLanguage } from './ast/ast-language.js';
import { callSiteForNode } from './source-calls.js';
import { getSourceFiles } from './source-fileset.js';
import { getSourceLines, getSourceText } from './source-text.js';

export interface ReactComponentBehaviorProfile {
  file: string;
  name: string;
  kind: 'component' | 'hook';
  startLine: number;
  endLine: number;
  loc: number;
  fileLines: number;
  jsxTokens: Set<string>;
  behaviorTokens: Set<string>;
  componentNames: string[];
  nativeTags: string[];
  propNames: string[];
  eventNames: string[];
  hookNames: string[];
  requestNames: string[];
  stateNames: string[];
  effectNames: string[];
  handlerNames: string[];
}

export interface ReactComponentProfileOptions {
  scope?: string;
  minJsxTokens?: number;
  minBehaviorTokens?: number;
  scanLimit?: number;
}

const REACT_EXTENSIONS = ['.tsx', '.jsx'] as const;
const BUILTIN_HOOKS = new Set([
  'useActionState',
  'useCallback',
  'useContext',
  'useDebugValue',
  'useDeferredValue',
  'useEffect',
  'useId',
  'useImperativeHandle',
  'useInsertionEffect',
  'useLayoutEffect',
  'useMemo',
  'useOptimistic',
  'useReducer',
  'useRef',
  'useState',
  'useSyncExternalStore',
  'useTransition',
]);
const EFFECT_HOOKS = new Set(['useEffect', 'useInsertionEffect', 'useLayoutEffect']);
const STATE_HOOKS = new Set(['useActionState', 'useOptimistic', 'useReducer', 'useRef', 'useState']);
const GENERIC_HOOKS = new Set(['useLocation', 'useNavigate', 'useParams', 'useSearchParams', 'useTranslation']);
const REQUEST_CALLS = new Set([
  'axios',
  'fetch',
  'gql',
  'graphql',
  'mutate',
  'query',
  'request',
  'useMutation',
  'useQuery',
  'useSuspenseQuery',
]);
const HANDLER_VERBS = new Set([
  'add',
  'apply',
  'cancel',
  'change',
  'clear',
  'close',
  'create',
  'delete',
  'fetch',
  'filter',
  'handle',
  'load',
  'open',
  'refresh',
  'remove',
  'render',
  'reset',
  'save',
  'select',
  'submit',
  'toggle',
  'update',
]);
const JSX_TOKEN_STOP_WORDS = new Set(['children', 'className', 'false', 'key', 'null', 'style', 'true', 'undefined']);
const JSX_PROP_STOP_WORDS = new Set([
  'aria-hidden',
  'className',
  'clipRule',
  'd',
  'fill',
  'fillRule',
  'height',
  'role',
  'stroke',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeWidth',
  'style',
  'viewBox',
  'width',
  'xmlns',
]);
const REACT_COMPONENT_BEHAVIOR_PROFILE_CACHE = createSourceFileCache<ReactComponentBehaviorProfile[]>(
  'react-component-behavior-profiles',
);
const REACT_COMPONENT_BEHAVIOR_PROFILE_PRODUCT = createFileEvidenceProduct<ReactComponentBehaviorProfile[]>({
  kind: 'react-component-behavior-profiles',
  serialize: serializeReactComponentBehaviorProfiles,
  deserialize: deserializeReactComponentBehaviorProfiles,
});

export function buildReactComponentBehaviorProfiles(
  db: ScipDatabase,
  opts: ReactComponentProfileOptions = {},
): ReactComponentBehaviorProfile[] {
  const files = getSourceFiles(db, { extensions: REACT_EXTENSIONS })
    .filter((file) => !opts.scope || file.includes(opts.scope))
    .sort();
  const limitedFiles =
    typeof opts.scanLimit === 'number' && opts.scanLimit > 0 ? files.slice(0, opts.scanLimit) : files;

  return limitedFiles
    .flatMap((file) => buildReactComponentBehaviorProfilesForFile(db, file))
    .filter(
      (profile) =>
        (opts.minJsxTokens === undefined || profile.jsxTokens.size >= opts.minJsxTokens) &&
        (opts.minBehaviorTokens === undefined || profile.behaviorTokens.size >= opts.minBehaviorTokens),
      );
}

// scip-query: ignore-wrapper — optimized per-file cache entry shared by broad
// React scans and the frontend behavior product's file-scoped read method.
export function buildReactComponentBehaviorProfilesForFile(
  db: ScipDatabase,
  relativePath: string,
): ReactComponentBehaviorProfile[] {
  const file = relativePath.replace(/\\/g, '/');
  const source = getSourceText(db, file);
  const cached = REACT_COMPONENT_BEHAVIOR_PROFILE_CACHE.get(db, file, source, () =>
    loadOrBuildReactComponentBehaviorProfiles(db, file, source),
  );
  return cached.map(cloneReactComponentBehaviorProfile);
}

function loadOrBuildReactComponentBehaviorProfiles(
  db: ScipDatabase,
  file: string,
  source: string,
): ReactComponentBehaviorProfile[] {
  const contentHash = fileContentHash(db, file, source);
  const cached = REACT_COMPONENT_BEHAVIOR_PROFILE_PRODUCT.read(db, file, contentHash);
  if (cached) return cached;

  const profiles = buildReactComponentBehaviorProfilesForFileUncached(db, file);
  REACT_COMPONENT_BEHAVIOR_PROFILE_PRODUCT.write(db, file, contentHash, profiles);
  return profiles;
}

function buildReactComponentBehaviorProfilesForFileUncached(
  db: ScipDatabase,
  file: string,
): ReactComponentBehaviorProfile[] {
  const language = reactLanguage(file);
  if (!language) return [];
  const tree = getAst(db, file);
  if (!tree) return [];
  const fileLines = getSourceLines(db, file).length;
  const candidates = collectReactCandidates(tree.rootNode, language).filter(
    (candidate) => candidate.kind === 'hook' || containsJsx(candidate.bodyNode),
  );

  return candidates.map((candidate) => {
    const jsxFacts = collectJsxFacts(candidate.bodyNode);
    const behaviorFacts = collectBehaviorFacts(candidate.bodyNode, language);
    return {
      file,
      name: candidate.name,
      kind: candidate.kind,
      startLine: candidate.node.startPosition.row,
      endLine: candidate.node.endPosition.row,
      loc: Math.max(1, candidate.node.endPosition.row - candidate.node.startPosition.row + 1),
      fileLines,
      jsxTokens: jsxFacts.tokens,
      behaviorTokens: behaviorFacts.tokens,
      componentNames: sorted(jsxFacts.componentNames),
      nativeTags: sorted(jsxFacts.nativeTags),
      propNames: sorted(jsxFacts.propNames),
      eventNames: sorted(jsxFacts.eventNames),
      hookNames: sorted(behaviorFacts.hookNames),
      requestNames: sorted(behaviorFacts.requestNames),
      stateNames: sorted(behaviorFacts.stateNames),
      effectNames: sorted(behaviorFacts.effectNames),
      handlerNames: sorted(behaviorFacts.handlerNames),
    };
  });
}

function cloneReactComponentBehaviorProfile(profile: ReactComponentBehaviorProfile): ReactComponentBehaviorProfile {
  return {
    ...profile,
    jsxTokens: new Set(profile.jsxTokens),
    behaviorTokens: new Set(profile.behaviorTokens),
    componentNames: [...profile.componentNames],
    nativeTags: [...profile.nativeTags],
    propNames: [...profile.propNames],
    eventNames: [...profile.eventNames],
    hookNames: [...profile.hookNames],
    requestNames: [...profile.requestNames],
    stateNames: [...profile.stateNames],
    effectNames: [...profile.effectNames],
    handlerNames: [...profile.handlerNames],
  };
}

type SerializedReactComponentBehaviorProfile = Omit<ReactComponentBehaviorProfile, 'jsxTokens' | 'behaviorTokens'> & {
  jsxTokens: string[];
  behaviorTokens: string[];
};

function serializeReactComponentBehaviorProfiles(profiles: readonly ReactComponentBehaviorProfile[]): string {
  return JSON.stringify(
    profiles.map(
      (profile): SerializedReactComponentBehaviorProfile => ({
        ...profile,
        jsxTokens: [...profile.jsxTokens],
        behaviorTokens: [...profile.behaviorTokens],
      }),
    ),
  );
}

function deserializeReactComponentBehaviorProfiles(payload: string): ReactComponentBehaviorProfile[] | null {
  try {
    const raw = JSON.parse(payload) as unknown;
    if (!Array.isArray(raw)) return null;
    const profiles: ReactComponentBehaviorProfile[] = [];
    for (const item of raw) {
      const profile = deserializeReactComponentBehaviorProfile(item);
      if (!profile) return null;
      profiles.push(profile);
    }
    return profiles;
  } catch {
    return null;
  }
}

function deserializeReactComponentBehaviorProfile(raw: unknown): ReactComponentBehaviorProfile | null {
  if (!isRecord(raw)) return null;
  const {
    file,
    name,
    kind,
    startLine,
    endLine,
    loc,
    fileLines,
    jsxTokens,
    behaviorTokens,
    componentNames,
    nativeTags,
    propNames,
    eventNames,
    hookNames,
    requestNames,
    stateNames,
    effectNames,
    handlerNames,
  } = raw;
  if (typeof file !== 'string' || typeof name !== 'string') return null;
  if (kind !== 'component' && kind !== 'hook') return null;
  if (!isFiniteNumber(startLine) || !isFiniteNumber(endLine) || !isFiniteNumber(loc) || !isFiniteNumber(fileLines)) {
    return null;
  }
  const stringArrays = {
    jsxTokens: stringArray(jsxTokens),
    behaviorTokens: stringArray(behaviorTokens),
    componentNames: stringArray(componentNames),
    nativeTags: stringArray(nativeTags),
    propNames: stringArray(propNames),
    eventNames: stringArray(eventNames),
    hookNames: stringArray(hookNames),
    requestNames: stringArray(requestNames),
    stateNames: stringArray(stateNames),
    effectNames: stringArray(effectNames),
    handlerNames: stringArray(handlerNames),
  };
  if (Object.values(stringArrays).some((value) => value === null)) return null;
  return {
    file,
    name,
    kind,
    startLine,
    endLine,
    loc,
    fileLines,
    jsxTokens: new Set(stringArrays.jsxTokens!),
    behaviorTokens: new Set(stringArrays.behaviorTokens!),
    componentNames: stringArrays.componentNames!,
    nativeTags: stringArrays.nativeTags!,
    propNames: stringArrays.propNames!,
    eventNames: stringArrays.eventNames!,
    hookNames: stringArrays.hookNames!,
    requestNames: stringArrays.requestNames!,
    stateNames: stringArrays.stateNames!,
    effectNames: stringArrays.effectNames!,
    handlerNames: stringArrays.handlerNames!,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

interface ReactCandidate {
  name: string;
  kind: 'component' | 'hook';
  node: SyntaxNode;
  bodyNode: SyntaxNode;
}

function reactLanguage(file: string): AstLanguage | null {
  const ext = extname(file).toLowerCase();
  if (ext !== '.tsx' && ext !== '.jsx') return null;
  return detectAstLanguage(file);
}

function collectReactCandidates(root: SyntaxNode, language: AstLanguage): ReactCandidate[] {
  const out: ReactCandidate[] = [];
  const seen = new Set<string>();
  const walk = (node: SyntaxNode): void => {
    const candidate = reactCandidateForNode(node);
    if (candidate && !hasFunctionAncestor(node)) {
      const key = `${candidate.name}:${candidate.node.startIndex}:${candidate.node.endIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(candidate);
      }
      return;
    }
    for (const child of node.namedChildren) walk(child);
  };
  if (language === 'tsx' || language === 'javascript') walk(root);
  return out;
}

function reactCandidateForNode(node: SyntaxNode): ReactCandidate | null {
  if (node.type === 'function_declaration') {
    const name = callableName(node);
    if (!name || !isReactUnitName(name)) return null;
    return { name, kind: reactUnitKind(name), node, bodyNode: node };
  }

  if (node.type !== 'variable_declarator') return null;
  const nameNode = node.childForFieldName('name') ?? node.namedChild(0);
  const valueNode = node.childForFieldName('value') ?? node.namedChild(1);
  const name = simpleIdentifier(nameNode);
  if (!name || !valueNode || !isReactUnitName(name)) return null;
  const bodyNode = unwrapReactCallable(valueNode);
  if (!bodyNode) return null;
  return { name, kind: reactUnitKind(name), node, bodyNode };
}

function isReactUnitName(name: string): boolean {
  return /^[A-Z]/.test(name) || /^use[A-Z0-9_]/.test(name);
}

function reactUnitKind(name: string): 'component' | 'hook' {
  return /^use[A-Z0-9_]/.test(name) ? 'hook' : 'component';
}

function unwrapReactCallable(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'arrow_function' || node.type === 'function_expression') return node;
  if (node.type !== 'call_expression') return null;
  const callName = callableCalleeName(node);
  if (callName !== 'memo' && callName !== 'forwardRef') return null;
  const args = node.namedChildren.find((child) => child.type === 'arguments');
  const fn = args?.namedChildren.find(
    (child) => child.type === 'arrow_function' || child.type === 'function_expression',
  );
  return fn ?? null;
}

function hasFunctionAncestor(node: SyntaxNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === 'function_declaration' ||
      parent.type === 'function_expression' ||
      parent.type === 'arrow_function' ||
      parent.type === 'method_definition'
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

function callableName(node: SyntaxNode): string | null {
  return simpleIdentifier(node.childForFieldName('name') ?? node.namedChild(0));
}

function callableCalleeName(node: SyntaxNode): string | null {
  const target = node.childForFieldName('function') ?? node.namedChild(0);
  if (!target) return null;
  return target.text.split('.').pop() ?? target.text;
}

function containsJsx(node: SyntaxNode): boolean {
  if (node.type.startsWith('jsx_')) return true;
  return node.namedChildren.some(containsJsx);
}

interface JsxFacts {
  tokens: Set<string>;
  componentNames: Set<string>;
  nativeTags: Set<string>;
  propNames: Set<string>;
  eventNames: Set<string>;
}

function collectJsxFacts(root: SyntaxNode): JsxFacts {
  const facts: JsxFacts = {
    tokens: new Set(),
    componentNames: new Set(),
    nativeTags: new Set(),
    propNames: new Set(),
    eventNames: new Set(),
  };
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
      recordJsxElement(node, facts);
    } else if (node.type === 'jsx_expression') {
      recordJsxExpression(node, facts);
    } else if (node.type === 'jsx_fragment') {
      facts.tokens.add('jsx:fragment');
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return facts;
}

function recordJsxElement(node: SyntaxNode, facts: JsxFacts): void {
  const tag = jsxTagName(node);
  let componentTag = false;
  if (tag) {
    const normalizedTag = normalizeJsxName(tag);
    componentTag = isComponentTag(normalizedTag);
    if (componentTag) {
      facts.componentNames.add(normalizedTag);
      facts.tokens.add(`component:${normalizedTag}`);
    } else {
      facts.nativeTags.add(normalizedTag);
      facts.tokens.add(`native:${normalizedTag}`);
    }
  }

  for (const child of node.namedChildren) {
    if (child.type === 'jsx_attribute') {
      const attr = jsxAttributeName(child);
      if (!attr) continue;
      const normalized = normalizeJsxName(attr);
      if (normalized.startsWith('on') && normalized.length > 2) {
        const event = normalized.slice(2).replace(/^[A-Z]/, (match) => match.toLowerCase());
        facts.eventNames.add(event);
        facts.tokens.add(`event:${event}`);
      } else if (!JSX_PROP_STOP_WORDS.has(normalized)) {
        facts.propNames.add(normalized);
        facts.tokens.add(`${componentTag ? 'prop' : 'native-prop'}:${normalized}`);
      }
    } else if (child.type === 'jsx_spread_attribute') {
      facts.tokens.add('prop:spread');
    }
  }
}

function recordJsxExpression(node: SyntaxNode, facts: JsxFacts): void {
  const text = node.text;
  if (text.includes('&&') || text.includes('?')) facts.tokens.add('jsx:conditional');
  if (text.includes('.map(') || text.includes('.flatMap(')) facts.tokens.add('jsx:list');
  for (const name of identifiersInText(text)) {
    if (JSX_TOKEN_STOP_WORDS.has(name)) continue;
    facts.tokens.add(`binding:${name}`);
  }
}

function jsxTagName(node: SyntaxNode): string | null {
  for (const child of node.namedChildren) {
    if (
      child.type === 'identifier' ||
      child.type === 'jsx_identifier' ||
      child.type === 'property_identifier' ||
      child.type === 'member_expression' ||
      child.type === 'jsx_member_expression'
    ) {
      return child.text;
    }
  }
  return /^<\s*([A-Za-z][\w$.]*)/.exec(node.text)?.[1] ?? null;
}

function jsxAttributeName(node: SyntaxNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === 'property_identifier' || child.type === 'identifier' || child.type === 'jsx_identifier') {
      return child.text;
    }
  }
  return /^([A-Za-z_$][\w$:-]*)/.exec(node.text)?.[1] ?? null;
}

interface BehaviorFacts {
  tokens: Set<string>;
  hookNames: Set<string>;
  requestNames: Set<string>;
  stateNames: Set<string>;
  effectNames: Set<string>;
  handlerNames: Set<string>;
}

function collectBehaviorFacts(root: SyntaxNode, language: AstLanguage): BehaviorFacts {
  const facts: BehaviorFacts = {
    tokens: new Set(),
    hookNames: new Set(),
    requestNames: new Set(),
    stateNames: new Set(),
    effectNames: new Set(),
    handlerNames: new Set(),
  };

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'call_expression') {
      const call = callSiteForNode(node, language);
      if (call) recordCall(call.calleeLeaf, facts);
    } else if (node.type === 'variable_declarator') {
      recordVariableDeclarator(node, facts);
    } else if (node.type === 'function_declaration') {
      const name = callableName(node);
      if (name) recordHandlerName(name, facts);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return facts;
}

function recordCall(name: string, facts: BehaviorFacts): void {
  if (/^use[A-Z0-9_]/.test(name)) {
    facts.hookNames.add(name);
    if (!BUILTIN_HOOKS.has(name) && !GENERIC_HOOKS.has(name)) {
      facts.tokens.add(`hook:${name}`);
    }
  }
  if (BUILTIN_HOOKS.has(name)) facts.tokens.add(`react-hook:${name}`);
  if (EFFECT_HOOKS.has(name)) {
    facts.effectNames.add(name);
    facts.tokens.add(`effect:${name}`);
  }
  if (STATE_HOOKS.has(name)) facts.tokens.add(`state-hook:${name}`);
  if (isRequestCall(name)) {
    facts.requestNames.add(name);
    facts.tokens.add(`request:${name}`);
  }
}

function isRequestCall(name: string): boolean {
  if (REQUEST_CALLS.has(name)) return true;
  const hookName = /^use([A-Z0-9_].*)$/.exec(name)?.[1];
  return hookName ? /(Query|Mutation|Fetch|Resource)$/.test(hookName) : false;
}

function recordVariableDeclarator(node: SyntaxNode, facts: BehaviorFacts): void {
  const nameNode = node.childForFieldName('name') ?? node.namedChild(0);
  const valueNode = node.childForFieldName('value') ?? node.namedChild(1);
  if (nameNode?.type === 'array_pattern' && valueNode?.text.includes('useState')) {
    const state = nameNode.namedChildren.find((child) => simpleIdentifier(child));
    const name = simpleIdentifier(state);
    if (name) {
      facts.stateNames.add(name);
      facts.tokens.add(`state:${name}`);
    }
  }
  const name = simpleIdentifier(nameNode);
  if (name) recordHandlerName(name, facts);
}

function recordHandlerName(name: string, facts: BehaviorFacts): void {
  const verb = leadingVerb(name);
  if (!verb || !HANDLER_VERBS.has(verb)) return;
  facts.handlerNames.add(name);
  facts.tokens.add(`handler:${name}`);
  facts.tokens.add(`handler-verb:${verb}`);
}

function leadingVerb(name: string): string | null {
  const normalized =
    name.startsWith('handle') && name.length > 'handle'.length
      ? name.slice('handle'.length).replace(/^[A-Z]/, (match) => match.toLowerCase())
      : name;
  return /^[a-z]+/.exec(normalized)?.[0] ?? null;
}

function isComponentTag(name: string): boolean {
  return /^[A-Z]/.test(name) || name.includes('.');
}

function normalizeJsxName(name: string): string {
  return name.replace(/^this\./, '').replace(/\$/g, '.');
}

function simpleIdentifier(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (
    node.type === 'identifier' ||
    node.type === 'property_identifier' ||
    node.type === 'shorthand_property_identifier'
  ) {
    return node.text;
  }
  return /^[A-Za-z_$][\w$]*$/.test(node.text) ? node.text : null;
}

function identifiersInText(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const name = match[0];
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort();
}
