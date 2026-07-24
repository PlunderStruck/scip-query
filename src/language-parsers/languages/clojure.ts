import type { ParsedSourceImport } from '../../domain/types.js';
import { resolveClojureImportPath } from '../../source/import-path-resolver.js';
import { escapeRegex } from '../../source/regex-utils.js';
import { isReaderMacroPrefix, isTokenDelimiter, skipLineComment, skipString } from '../../source/clojure-facts.js';
import type { ScipDatabase } from '../../storage/db.js';
import { buildUsedImport } from '../utils.js';

type FormKind = 'list' | 'vector' | 'map';

interface AtomForm {
  type: 'atom';
  text: string;
  start: number;
  end: number;
}

interface CollectionForm {
  type: FormKind;
  children: ClojureForm[];
  start: number;
  end: number;
}

type ClojureForm = AtomForm | CollectionForm;

interface NamespaceImportSpec {
  namespace: string;
  alias: string | null;
  refers: string[];
  referAll: boolean;
}

const REQUIRE_CLAUSES = new Set([':require', ':require-macros', ':use']);
const IDENTIFIER_CHARS = String.raw`A-Za-z0-9_$*+!?.<>=-`;

export function parseClojureImports(db: ScipDatabase, _importerPath: string, source: string): ParsedSourceImport[] {
  const nsForm = parseNamespaceForm(source);
  if (!nsForm) return [];

  const body = buildClojureUsageBody(source, nsForm.start, nsForm.end);
  const imports: ParsedSourceImport[] = [];

  for (const clause of nsForm.children.slice(2)) {
    if (clause.type !== 'list' || clause.children.length === 0) continue;
    const clauseHead = atomText(clause.children[0]);
    if (!clauseHead) continue;

    if (REQUIRE_CLAUSES.has(clauseHead)) {
      for (const spec of parseRequireClause(clause.children.slice(1))) {
        imports.push(...clojureNamespaceImports(db, spec, body));
      }
      continue;
    }

    if (clauseHead === ':import') {
      for (const imported of clojureParseImportClause(clause.children.slice(1))) {
        imports.push(imported);
      }
    }
  }

  return imports;
}

function isNamespaceForm(form: ClojureForm): form is CollectionForm {
  return form.type === 'list' && atomText(form.children[0]) === 'ns';
}

function clojureNamespaceImports(db: ScipDatabase, spec: NamespaceImportSpec, body: string): ParsedSourceImport[] {
  const sourcePath = resolveClojureImportPath(db, spec.namespace);
  const usagePrefix = spec.alias ?? spec.namespace;
  const usedMembers = collectQualifiedMembers(body, usagePrefix);
  const imports: ParsedSourceImport[] = [
    {
      importedName: spec.namespace,
      localName: usagePrefix,
      sourcePath,
      kind: 'namespace',
      used:
        spec.refers.length > 0 ||
        spec.referAll ||
        usedMembers.length > 0 ||
        hasQualifiedNamespaceUsage(body, spec.namespace),
      usedMembers,
    },
  ];

  if (spec.referAll) {
    imports.push({
      importedName: '*',
      localName: null,
      sourcePath,
      kind: 'side-effect',
      used: true,
      usedMembers: [],
    });
  }

  for (const referred of spec.refers) {
    imports.push({
      importedName: referred,
      localName: referred,
      sourcePath,
      kind: 'named',
      used: hasClojureIdentifierUsage(body, referred),
      usedMembers: [],
    });
  }

  return imports;
}

function parseRequireClause(entries: ClojureForm[]): NamespaceImportSpec[] {
  return entries.flatMap((entry) => parseRequireEntry(entry, null));
}

function parseRequireEntry(entry: ClojureForm, prefix: string | null): NamespaceImportSpec[] {
  if (entry.type === 'atom') {
    if (entry.text.startsWith(':')) return [];
    return [{ namespace: qualifyNamespace(prefix, entry.text), alias: null, refers: [], referAll: false }];
  }

  if (entry.type === 'vector') {
    if (entry.children.length > 0 && atomText(entry.children[0]) === null) {
      return entry.children.flatMap((child) => parseRequireEntry(child, prefix));
    }
    return parseRequireVector(entry, prefix);
  }

  if (entry.type === 'list' && entry.children.length > 0) {
    const head = atomText(entry.children[0]);
    if (!head) return entry.children.flatMap((child) => parseRequireEntry(child, prefix));
    if (!head || head.startsWith(':')) return [];
    return entry.children.slice(1).flatMap((child) => parseRequireEntry(child, qualifyNamespace(prefix, head)));
  }

  return [];
}

function parseRequireVector(vector: CollectionForm, prefix: string | null): NamespaceImportSpec[] {
  const namespace = atomText(vector.children[0]);
  if (!namespace || namespace.startsWith(':')) return [];

  const spec: NamespaceImportSpec = {
    namespace: qualifyNamespace(prefix, namespace),
    alias: null,
    refers: [],
    referAll: false,
  };

  for (let index = 1; index < vector.children.length; index += 1) {
    const key = atomText(vector.children[index]);
    if (!key?.startsWith(':')) continue;
    const value = vector.children[index + 1];

    if ((key === ':as' || key === ':as-alias') && value) {
      spec.alias = atomText(value);
      index += 1;
      continue;
    }

    if (key === ':refer' && value) {
      if (atomText(value) === ':all') {
        spec.referAll = true;
      } else if (value.type === 'vector' || value.type === 'list') {
        spec.refers.push(...value.children.map(atomText).filter(isImportName));
      }
      index += 1;
    }
  }

  return [spec];
}

function clojureParseImportClause(entries: ClojureForm[]): ParsedSourceImport[] {
  const imports: ParsedSourceImport[] = [];
  for (const entry of entries) {
    if (entry.type === 'atom') {
      const importedName = entry.text.split('.').pop() ?? entry.text;
      imports.push(buildUsedImport(importedName, importedName, null, true));
      continue;
    }

    if (entry.type !== 'vector') continue;
    const packageName = atomText(entry.children[0]);
    if (!packageName) continue;
    for (const classForm of entry.children.slice(1)) {
      const className = atomText(classForm);
      if (!className) continue;
      imports.push(buildUsedImport(`${packageName}.${className}`, className, null, true));
    }
  }
  return imports;
}

function qualifyNamespace(prefix: string | null, value: string): string {
  return prefix ? `${prefix}.${value}` : value;
}

function atomText(form: ClojureForm | undefined): string | null {
  return form?.type === 'atom' ? form.text : null;
}

function isImportName(value: string | null): value is string {
  return Boolean(value && !value.startsWith(':'));
}

function collectQualifiedMembers(body: string, prefix: string): string[] {
  const members = new Set<string>();
  const regex = new RegExp(`${symbolBoundary()}${escapeRegex(prefix)}\\s*/\\s*([${IDENTIFIER_CHARS}]+)`, 'g');
  for (const match of body.matchAll(regex)) {
    const member = match[1];
    if (member) members.add(member);
  }
  return [...members];
}

function hasQualifiedNamespaceUsage(body: string, namespace: string): boolean {
  return new RegExp(`${symbolBoundary()}${escapeRegex(namespace)}\\s*/`, 'm').test(body);
}

function hasClojureIdentifierUsage(body: string, identifier: string): boolean {
  return new RegExp(`${symbolBoundary()}${escapeRegex(identifier)}(?![${IDENTIFIER_CHARS}])`, 'm').test(body);
}

function symbolBoundary(): string {
  return `(?<![${IDENTIFIER_CHARS}])`;
}

function buildClojureUsageBody(source: string, start: number, end: number): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    if (index >= start && index < end) {
      out += source[index] === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    const char = source[index]!;
    if (char === ';') {
      const next = skipLineComment(source, index);
      out += maskPreservingLines(source.slice(index, next));
      index = next;
      continue;
    }
    if (char === '"') {
      const next = skipString(source, index, 0).index;
      out += maskPreservingLines(source.slice(index, next));
      index = next;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function parseNamespaceForm(source: string): CollectionForm | null {
  let index = 0;
  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (index >= source.length) break;
    const parsed = parseForm(source, index);
    if (!parsed) {
      index += 1;
      continue;
    }
    if (isNamespaceForm(parsed.form)) return parsed.form;
    index = parsed.index;
  }
  return null;
}

function parseForm(source: string, start: number): { form: ClojureForm; index: number } | null {
  let index = skipWhitespace(source, start);
  if (source.startsWith('#?@', index) || source.startsWith('#?', index)) {
    return parseReaderConditional(source, index);
  }
  if (source.startsWith('#_', index)) {
    const discarded = parseForm(source, index + 2);
    return discarded
      ? { form: { type: 'atom', text: '', start: index, end: discarded.index }, index: discarded.index }
      : null;
  }

  while (isReaderMacroPrefix(source[index]!)) index += 1;

  const char = source[index];
  if (!char) return null;
  if (char === '(') return parseCollection(source, index, 'list', ')');
  if (char === '[') return parseCollection(source, index, 'vector', ']');
  if (char === '{') return parseCollection(source, index, 'map', '}');
  if (char === '"')
    return {
      form: { type: 'atom', text: '', start: index, end: skipString(source, index, 0).index },
      index: skipString(source, index, 0).index,
    };
  return parseAtom(source, index);
}

function parseReaderConditional(source: string, start: number): { form: ClojureForm; index: number } | null {
  const prefixLength = source.startsWith('#?@', start) ? 3 : 2;
  const parsed = parseForm(source, start + prefixLength);
  if (!parsed) return null;
  const branchValues =
    parsed.form.type === 'list' || parsed.form.type === 'vector' || parsed.form.type === 'map'
      ? readerConditionalBranchValues(parsed.form.children)
      : [];
  return {
    form: { type: 'list', children: branchValues, start, end: parsed.index },
    index: parsed.index,
  };
}

function readerConditionalBranchValues(children: ClojureForm[]): ClojureForm[] {
  const values: ClojureForm[] = [];
  for (let index = 0; index < children.length; index += 2) {
    const platform = atomText(children[index]);
    const value = children[index + 1];
    if (platform?.startsWith(':') && value) values.push(value);
  }
  return values;
}

function parseCollection(
  source: string,
  start: number,
  type: FormKind,
  closer: ')' | ']' | '}',
): { form: CollectionForm; index: number } {
  const children: ClojureForm[] = [];
  let index = start + 1;

  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (source[index] === closer) {
      return { form: { type, children, start, end: index + 1 }, index: index + 1 };
    }
    const parsed = parseForm(source, index);
    if (!parsed) {
      index += 1;
      continue;
    }
    if (!(parsed.form.type === 'atom' && parsed.form.text === '')) children.push(parsed.form);
    index = parsed.index;
  }

  return { form: { type, children, start, end: source.length }, index: source.length };
}

function parseAtom(source: string, start: number): { form: AtomForm; index: number } {
  let index = start;
  while (index < source.length && !isTokenDelimiter(source[index]!)) index += 1;
  return { form: { type: 'atom', text: source.slice(start, index), start, end: index }, index };
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (char === ';') {
      index = skipLineComment(source, index);
      continue;
    }
    break;
  }
  return index;
}

// scip-query: ignore-twin — Clojure reader masking preserves different syntax from generic source masking.
function maskPreservingLines(segment: string): string {
  return segment.replace(/[^\r\n]/g, ' ');
}
