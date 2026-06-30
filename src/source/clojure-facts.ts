import type { SourceFacts } from './source-fact-types.js';

const CALLABLE_DEF_KINDS = new Map<string, NonNullable<SourceFacts['callables'][number]['clojureKind']>>([
  ['defn', 'function'],
  ['defn-', 'function'],
  ['defmacro', 'macro'],
  ['defmacro-', 'macro'],
  ['defmethod', 'method'],
]);
const NON_CALL_HEADS = new Set([
  'catch',
  'comment',
  'def',
  'defprotocol',
  'defrecord',
  'deftype',
  'defmethod',
  'defmacro',
  'defmacro-',
  'defn',
  'defn-',
  'do',
  'doseq',
  'dotimes',
  'fn',
  'for',
  'if',
  'let',
  'loop',
  'ns',
  'quote',
  'recur',
  'throw',
  'try',
  'extend-protocol',
  'extend-type',
  'when',
  'when-let',
  'when-not',
]);

interface FormFrame {
  kind: '(' | '[' | '{';
  startLine: number;
  endLine: number;
  headTokens: ClojureToken[];
  tokens: ClojureToken[];
  children: ClojureForm[];
}

interface ClojureToken {
  text: string;
  line: number;
}

interface ClojureForm extends FormFrame {}

export function buildClojureSourceFacts(source: string): SourceFacts {
  const callables: SourceFacts['callables'] = [];
  const callSites: SourceFacts['callSites'] = [];
  const clojureMembers: SourceFacts['clojureMembers'] = [];
  const identifierLineMap = new Map<string, number[]>();
  const stack: FormFrame[] = [];
  let line = 0;
  let index = 0;

  const recordIdentifier = (name: string, row: number): void => {
    const existing = identifierLineMap.get(name);
    if (!existing) {
      identifierLineMap.set(name, [row]);
      return;
    }
    if (existing[existing.length - 1] !== row) existing.push(row);
  };

  while (index < source.length) {
    const char = source[index]!;
    if (char === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (char === ';') {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === '"') {
      const skipped = skipString(source, index, line);
      line = skipped.line;
      index = skipped.index;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      stack.push({ kind: char, startLine: line, endLine: line, headTokens: [], tokens: [], children: [] });
      index += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      const frame = stack.pop();
      if (frame) {
        frame.endLine = line;
        recordCompletedFrame(frame, { callables, callSites, clojureMembers, recordIdentifier });
        stack[stack.length - 1]?.children.push(frame);
      }
      index += 1;
      continue;
    }
    if (isReaderMacroPrefix(char)) {
      index += 1;
      continue;
    }

    const tokenStartLine = line;
    const tokenStart = index;
    while (index < source.length && !isTokenDelimiter(source[index]!)) {
      index += 1;
    }
    const text = source.slice(tokenStart, index);
    if (!text) continue;
    const token = { text, line: tokenStartLine };
    recordFrameToken(stack[stack.length - 1], token);
    recordIdentifier(clojureLeaf(text), tokenStartLine);
  }

  return {
    language: 'clojure',
    callables,
    callSites,
    clojureMembers,
    typeContainerMap: new Map(),
    identifierLineMap,
    identifiersByLine: identifierLines(identifierLineMap),
    fileIdentifiers: new Set(identifierLineMap.keys()),
    rustAttrReferencedNames: new Set(),
    crossLanguageDispatchNames: new Set(),
  };
}

function recordCompletedFrame(
  frame: FormFrame,
  out: {
    callables: SourceFacts['callables'];
    callSites: SourceFacts['callSites'];
    clojureMembers: SourceFacts['clojureMembers'];
    recordIdentifier: (name: string, line: number) => void;
  },
): void {
  if (frame.kind !== '(' || frame.headTokens.length === 0) return;
  const head = frame.headTokens[0]!;
  const headLeaf = clojureLeaf(head.text);
  const callableKind = CALLABLE_DEF_KINDS.get(head.text);
  if (callableKind) {
    const nameToken = frame.headTokens[1];
    if (nameToken) {
      const name = clojureLeaf(nameToken.text);
      out.recordIdentifier(name, nameToken.line);
      out.callables.push({
        name,
        startLine: frame.startLine,
        endLine: frame.endLine,
        paramCount: 0,
        params: [],
        paramsEndLine: nameToken.line,
        isLiteralPassthrough: false,
        clojureKind: callableKind,
      });
    }
  }
  recordClojureMembers(frame, out);

  if (!headLeaf || NON_CALL_HEADS.has(head.text) || NON_CALL_HEADS.has(headLeaf) || headLeaf.startsWith(':')) return;
  const call = clojureCallParts(head.text);
  out.callSites.push({
    calleeLeaf: call.leaf,
    calleeQualifier: call.qualifier,
    calleeText: call.text,
    memberAccess: false,
    line: head.line,
  });
}

function recordFrameToken(frame: FormFrame | undefined, token: ClojureToken): void {
  if (!frame) return;
  if (frame.headTokens.length < 2) frame.headTokens.push(token);
  if (frame.tokens.length < 200) frame.tokens.push(token);
}

function recordClojureMembers(
  frame: ClojureForm,
  out: {
    clojureMembers: SourceFacts['clojureMembers'];
    recordIdentifier: (name: string, line: number) => void;
  },
): void {
  const head = clojureLeaf(frame.tokens[0]?.text ?? '');
  if (head === 'defprotocol') {
    const owner = clojureLeaf(frame.tokens[1]?.text ?? '');
    if (!owner) return;
    for (const child of memberForms(frame)) recordMember(out, owner, 'protocol', child, 'protocol-method');
    return;
  }

  if (head === 'defrecord' || head === 'deftype') {
    const owner = clojureLeaf(frame.tokens[1]?.text ?? '');
    if (!owner) return;
    const ownerKind = head === 'defrecord' ? 'record' : 'type';
    const memberKind = head === 'defrecord' ? 'record-method' : 'type-method';
    for (const child of memberForms(frame)) recordMember(out, owner, ownerKind, child, memberKind);
    return;
  }

  if (head === 'extend-type') {
    const owner = clojureLeaf(frame.tokens[1]?.text ?? '');
    if (!owner) return;
    for (const child of memberForms(frame)) recordMember(out, owner, 'extension', child, 'extension-method');
    return;
  }

  if (head === 'extend-protocol') {
    const protocol = clojureLeaf(frame.tokens[1]?.text ?? '');
    for (const child of memberForms(frame)) {
      if (protocol) recordMember(out, protocol, 'extension', child, 'extension-method');
      const owner = extensionOwnerBefore(frame, child.startLine);
      if (owner && owner !== protocol) recordMember(out, owner, 'extension', child, 'extension-method');
    }
  }
}

function memberForms(frame: ClojureForm): ClojureForm[] {
  return frame.children.filter(isMemberForm);
}

function isMemberForm(frame: ClojureForm): boolean {
  if (frame.kind !== '(') return false;
  const head = clojureLeaf(frame.tokens[0]?.text ?? '');
  return Boolean(head && !NON_CALL_HEADS.has(head) && !head.startsWith(':'));
}

function recordMember(
  out: {
    clojureMembers: SourceFacts['clojureMembers'];
    recordIdentifier: (name: string, line: number) => void;
  },
  ownerName: string,
  ownerKind: SourceFacts['clojureMembers'][number]['ownerKind'],
  child: ClojureForm,
  memberKind: SourceFacts['clojureMembers'][number]['memberKind'],
): void {
  const head = child.tokens[0];
  const memberName = clojureLeaf(head?.text ?? '');
  if (!head || !memberName) return;
  out.recordIdentifier(memberName, head.line);
  out.clojureMembers.push({
    ownerName,
    ownerKind,
    memberName,
    memberKind,
    startLine: child.startLine,
    endLine: child.endLine,
  });
}

function extensionOwnerBefore(frame: ClojureForm, line: number): string | null {
  let owner: string | null = null;
  for (let index = 2; index < frame.tokens.length; index += 1) {
    const token = frame.tokens[index]!;
    if (token.line > line) break;
    const name = clojureLeaf(token.text);
    if (name && !name.startsWith(':')) owner = name;
  }
  return owner;
}

function clojureLeaf(symbol: string): string {
  return (
    symbol
      .replace(/^#?['`~@]+/, '')
      .split('/')
      .pop()
      ?.replace(/^\./, '') ?? ''
  );
}

function clojureCallParts(symbol: string): { leaf: string; qualifier?: string; text?: string } {
  const text = symbol.replace(/^#?['`~@]+/, '');
  const slash = text.lastIndexOf('/');
  const leaf = clojureLeaf(text);
  if (slash <= 0) return { leaf, text };
  const qualifier = text.slice(0, slash);
  return { leaf, qualifier, text };
}

function skipLineComment(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
  return cursor;
}

function skipString(source: string, index: number, line: number): { index: number; line: number } {
  let cursor = index + 1;
  let row = line;
  while (cursor < source.length) {
    const char = source[cursor]!;
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === '\n') row += 1;
    cursor += 1;
    if (char === '"') break;
  }
  return { index: cursor, line: row };
}

function isReaderMacroPrefix(char: string): boolean {
  return char === "'" || char === '`' || char === '~' || char === '@' || char === '^' || char === '#';
}

function isTokenDelimiter(char: string): boolean {
  return (
    /\s|,/.test(char) || char === '(' || char === ')' || char === '[' || char === ']' || char === '{' || char === '}'
  );
}

function identifierLines(identifierLineMap: Map<string, number[]>): Array<Set<string>> {
  const lines: Array<Set<string>> = [];
  for (const [identifier, rows] of identifierLineMap) {
    for (const row of rows) {
      lines[row] ??= new Set();
      lines[row]!.add(identifier);
    }
  }
  return lines;
}
