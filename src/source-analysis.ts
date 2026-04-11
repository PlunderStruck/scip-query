import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
} from 'node:path';
import type { ScipDatabase } from './db.js';

export interface ParsedSourceImport {
  importedName: string;
  localName: string | null;
  sourcePath: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  used: boolean;
  usedMembers: string[];
}

export interface ParsedSourceCall {
  calleeName: string;
  receiverName: string | null;
  line: number;
}

export interface ParsedSourceBinding {
  localName: string;
  typeName: string;
}

const SOURCE_IMPORT_CACHE = new WeakMap<ScipDatabase, Map<string, ParsedSourceImport[]>>();
const SOURCE_TEXT_CACHE = new WeakMap<ScipDatabase, Map<string, string>>();
const SOURCE_CALL_CACHE = new WeakMap<ScipDatabase, Map<string, ParsedSourceCall[]>>();
const SOURCE_BINDING_CACHE = new WeakMap<ScipDatabase, Map<string, ParsedSourceBinding[]>>();
const INDEXED_PATH_CACHE = new WeakMap<ScipDatabase, Set<string>>();

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const PYTHON_SOURCE_EXTENSIONS = ['.py', '.pyi'] as const;

export function getSourceImports(
  db: ScipDatabase,
  relativePath: string,
): ParsedSourceImport[] {
  const cache = getCachedMap(SOURCE_IMPORT_CACHE, db);
  const normalized = normalizePath(relativePath);
  const cached = cache.get(normalized);
  if (cached) {
    return cached;
  }

  const fullPath = join(db.config.projectRoot, normalized);
  if (!existsSync(fullPath)) {
    cache.set(normalized, []);
    return [];
  }

  const source = readFileSync(fullPath, 'utf-8');
  const parsed = isPythonSourcePath(normalized)
    ? parsePythonImports(db, normalized, source)
    : parseJavaScriptImports(db, normalized, source);

  cache.set(normalized, parsed);
  return parsed;
}

export function getSourceCalls(
  db: ScipDatabase,
  relativePath: string,
  opts: { startLine?: number; endLine?: number } = {},
): ParsedSourceCall[] {
  const normalized = normalizePath(relativePath);
  if (!isPythonSourcePath(normalized) && !isJavaScriptSourcePath(normalized)) {
    return [];
  }

  const cache = getCachedMap(SOURCE_CALL_CACHE, db);
  const key = `${normalized}:${opts.startLine ?? 0}:${opts.endLine ?? Number.MAX_SAFE_INTEGER}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const source = getSourceText(db, normalized);
  if (!source) {
    cache.set(key, []);
    return [];
  }

  const lines = source.split('\n');
  const startLine = Math.max(0, opts.startLine ?? 0);
  const endLine = Math.min(lines.length - 1, opts.endLine ?? lines.length - 1);
  const scopedLines = lines.slice(startLine, endLine + 1);
  const calls = isPythonSourcePath(normalized)
    ? parsePythonCalls(scopedLines, startLine)
    : parseJavaScriptCalls(scopedLines, startLine);

  cache.set(key, calls);
  return calls;
}

export function getSourceConstructorBindings(
  db: ScipDatabase,
  relativePath: string,
  opts: { startLine?: number; endLine?: number } = {},
): ParsedSourceBinding[] {
  const normalized = normalizePath(relativePath);
  if (!isPythonSourcePath(normalized) && !isJavaScriptSourcePath(normalized)) {
    return [];
  }

  const cache = getCachedMap(SOURCE_BINDING_CACHE, db);
  const key = `${normalized}:${opts.startLine ?? 0}:${opts.endLine ?? Number.MAX_SAFE_INTEGER}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const source = getSourceText(db, normalized);
  if (!source) {
    cache.set(key, []);
    return [];
  }

  const lines = source.split('\n');
  const startLine = Math.max(0, opts.startLine ?? 0);
  const endLine = Math.min(lines.length - 1, opts.endLine ?? lines.length - 1);
  const scopedLines = lines.slice(startLine, endLine + 1);
  const bindings = isPythonSourcePath(normalized)
    ? parsePythonConstructorBindings(scopedLines)
    : parseJavaScriptConstructorBindings(scopedLines);

  cache.set(key, bindings);
  return bindings;
}

export function findIdentifierLines(
  db: ScipDatabase,
  relativePath: string,
  identifier: string,
  opts: { excludeStartLine?: number; excludeEndLine?: number } = {},
): number[] {
  if (!identifier) {
    return [];
  }

  const source = getSourceText(db, normalizePath(relativePath));
  if (!source) {
    return [];
  }

  const lines = stripCommentsAndStrings(source).split('\n');
  const regex = new RegExp(`\\b${escapeRegex(identifier)}\\b`);
  const results: number[] = [];

  for (let line = 0; line < lines.length; line++) {
    if (
      typeof opts.excludeStartLine === 'number'
      && typeof opts.excludeEndLine === 'number'
      && line >= opts.excludeStartLine
      && line <= opts.excludeEndLine
    ) {
      continue;
    }

    if (regex.test(lines[line] ?? '')) {
      results.push(line);
    }
  }

  return results;
}

function parseJavaScriptImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  return parseJavaScriptImportStatements(source)
    .flatMap((statement) => parseJavaScriptImportStatement(
      db,
      importerPath,
      statement.clause,
      statement.specifier,
      statement.start,
      statement.end,
      source,
    ));
}

function parseJavaScriptImportStatements(source: string): Array<{
  clause: string | null;
  specifier: string;
  start: number;
  end: number;
}> {
  const statements: Array<{
    clause: string | null;
    specifier: string;
    start: number;
    end: number;
  }> = [];

  const importFromRegex = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(importFromRegex)) {
    const full = match[0];
    const clause = match[1];
    const specifier = match[2];
    if (!full || !specifier || typeof match.index !== 'number') continue;
    statements.push({
      clause,
      specifier,
      start: match.index,
      end: match.index + full.length,
    });
  }

  const sideEffectRegex = /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(sideEffectRegex)) {
    const full = match[0];
    const specifier = match[1];
    if (!full || !specifier || typeof match.index !== 'number') continue;
    statements.push({
      clause: null,
      specifier,
      start: match.index,
      end: match.index + full.length,
    });
  }

  return statements.sort((a, b) => a.start - b.start);
}

function parseJavaScriptImportStatement(
  db: ScipDatabase,
  importerPath: string,
  clause: string | null,
  specifier: string,
  start: number,
  end: number,
  source: string,
): ParsedSourceImport[] {
  const resolvedSource = resolveImportPath(db, importerPath, specifier);
  const body = buildUsageBody(source, start, end);

  if (!clause) {
    return [{
      importedName: '*',
      localName: null,
      sourcePath: resolvedSource,
      kind: 'side-effect',
      used: true,
      usedMembers: [],
    }];
  }

  const bindings = parseImportClause(clause).map((binding) => ({
    ...binding,
    sourcePath: resolvedSource,
  }));

  return bindings.map((binding) => {
    if (binding.kind === 'namespace') {
      const usedMembers = collectNamespaceMembers(body, binding.localName!);
      return {
        ...binding,
        used: usedMembers.length > 0 || hasIdentifierUsage(body, binding.localName!),
        usedMembers,
      };
    }

    if (binding.kind === 'side-effect') {
      return { ...binding, used: true, usedMembers: [] };
    }

    return {
      ...binding,
      used: binding.localName ? hasIdentifierUsage(body, binding.localName) : false,
      usedMembers: [],
    };
  });
}

function parsePythonCalls(lines: string[], baseLine: number): ParsedSourceCall[] {
  const calls: ParsedSourceCall[] = [];
  const controlKeywords = new Set([
    'if',
    'for',
    'while',
    'with',
    'except',
    'elif',
    'return',
    'yield',
    'assert',
    'raise',
    'lambda',
    'class',
    'def',
  ]);

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] ?? '';
    const stripped = stripCommentsAndStrings(rawLine);
    if (!stripped.trim()) continue;

    const attributeMatches = [...stripped.matchAll(/\b([A-Za-z_][\w]*)\s*\.\s*([A-Za-z_][\w]*)\s*\(/g)];
    const attributeRanges = attributeMatches.map((match) => ({
      start: match.index ?? -1,
      end: (match.index ?? -1) + match[0].length,
    }));

    for (const match of attributeMatches) {
      const receiverName = match[1];
      const calleeName = match[2];
      if (!receiverName || !calleeName) continue;
      calls.push({
        receiverName,
        calleeName,
        line: baseLine + index,
      });
    }

    for (const match of stripped.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      const calleeName = match[1];
      const start = match.index ?? -1;
      if (!calleeName || start < 0) continue;
      if (controlKeywords.has(calleeName)) continue;
      if (attributeRanges.some((range) => start >= range.start && start < range.end)) continue;

      const prefix = stripped.slice(0, start).trimEnd();
      if (prefix.endsWith('def') || prefix.endsWith('class') || prefix.endsWith('async def')) {
        continue;
      }

      calls.push({
        receiverName: null,
        calleeName,
        line: baseLine + index,
      });
    }
  }

  return calls;
}

function parseJavaScriptCalls(lines: string[], baseLine: number): ParsedSourceCall[] {
  const calls: ParsedSourceCall[] = [];
  const controlKeywords = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'function',
    'class',
    'return',
    'typeof',
    'import',
  ]);

  for (let index = 0; index < lines.length; index++) {
    const stripped = stripCommentsAndStrings(lines[index] ?? '');
    if (!stripped.trim()) continue;

    const attributeMatches = [
      ...stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*\(/g),
      ...stripped.matchAll(/\bthis\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*\(/g),
    ];
    const attributeRanges = attributeMatches.map((match) => ({
      start: match.index ?? -1,
      end: (match.index ?? -1) + match[0].length,
    }));

    for (const match of attributeMatches) {
      const receiverName = match[2] ? match[1] : 'this';
      const calleeName = match[2] ?? match[1];
      if (!receiverName || !calleeName) continue;
      calls.push({
        receiverName,
        calleeName,
        line: baseLine + index,
      });
    }

    for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const calleeName = match[1];
      const start = match.index ?? -1;
      if (!calleeName || start < 0) continue;
      if (controlKeywords.has(calleeName)) continue;
      if (attributeRanges.some((range) => start >= range.start && start < range.end)) continue;

      const prefix = stripped.slice(0, start).trimEnd();
      if (
        prefix.endsWith('function')
        || prefix.endsWith('class')
        || prefix.endsWith('new')
      ) {
        continue;
      }

      calls.push({
        receiverName: null,
        calleeName,
        line: baseLine + index,
      });
    }
  }

  return calls;
}

function parsePythonConstructorBindings(lines: string[]): ParsedSourceBinding[] {
  const bindings = new Map<string, string>();

  for (const rawLine of lines) {
    const stripped = stripCommentsAndStrings(rawLine);
    const constructorMatch = stripped.match(/\b([A-Za-z_][\w]*)\s*=\s*([A-Z][\w]*)\s*\(/);
    if (constructorMatch?.[1] && constructorMatch[2]) {
      bindings.set(constructorMatch[1], constructorMatch[2]);
    }
  }

  return [...bindings.entries()].map(([localName, typeName]) => ({ localName, typeName }));
}

function parseJavaScriptConstructorBindings(lines: string[]): ParsedSourceBinding[] {
  const bindings = new Map<string, string>();

  for (const rawLine of lines) {
    const stripped = stripCommentsAndStrings(rawLine);

    for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*([A-Z][A-Za-z0-9_$]*)\b/g)) {
      const localName = match[1];
      const typeName = match[2];
      if (localName && typeName) {
        bindings.set(localName, typeName);
      }
    }

    const constructorMatch = stripped.match(/\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*[A-Z][A-Za-z0-9_$<> ,]*)?\s*=\s*new\s+([A-Z][A-Za-z0-9_$]*)\s*\(/);
    if (constructorMatch?.[1] && constructorMatch[2]) {
      bindings.set(constructorMatch[1], constructorMatch[2]);
    }
  }

  return [...bindings.entries()].map(([localName, typeName]) => ({ localName, typeName }));
}

function parsePythonImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  return collectPythonImportStatements(source).flatMap((statement) =>
    parsePythonImportStatement(db, importerPath, statement, source),
  );
}

function collectPythonImportStatements(source: string): Array<{
  kind: 'import' | 'from';
  module: string | null;
  clause: string;
  start: number;
  end: number;
}> {
  const lines = source.split('\n');
  const statements: Array<{
    kind: 'import' | 'from';
    module: string | null;
    clause: string;
    start: number;
    end: number;
  }> = [];

  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const trimmed = line.trimStart();
    const lineStart = offset;
    offset += line.length + 1;

    if (!trimmed.startsWith('import ') && !trimmed.startsWith('from ')) {
      continue;
    }

    let statement = line;
    let statementEnd = lineStart + line.length;
    let balance = pythonParenBalance(line);

    while (
      lineIndex + 1 < lines.length
      && (balance > 0 || statement.trimEnd().endsWith('\\'))
    ) {
      lineIndex++;
      const nextLine = lines[lineIndex]!;
      statement += `\n${nextLine}`;
      statementEnd += 1 + nextLine.length;
      balance += pythonParenBalance(nextLine);
      offset += nextLine.length + 1;
    }

    const parsed = parsePythonStatementHeader(statement);
    if (parsed) {
      statements.push({
        ...parsed,
        start: lineStart,
        end: statementEnd,
      });
    }
  }

  return statements;
}

function parsePythonStatementHeader(statement: string): {
  kind: 'import' | 'from';
  module: string | null;
  clause: string;
} | null {
  const normalized = statement
    .replace(/\\\s*\n/g, ' ')
    .trim();

  if (normalized.startsWith('import ')) {
    return {
      kind: 'import',
      module: null,
      clause: normalized.slice('import '.length).trim(),
    };
  }

  const fromMatch = normalized.match(/^from\s+([.\w]+)\s+import\s+([\s\S]+)$/);
  if (!fromMatch) {
    return null;
  }

  let clause = fromMatch[2]!.trim();
  if (clause.startsWith('(') && clause.endsWith(')')) {
    clause = clause.slice(1, -1).trim();
  }

  return {
    kind: 'from',
    module: fromMatch[1]!,
    clause,
  };
}

function parsePythonImportStatement(
  db: ScipDatabase,
  importerPath: string,
  statement: {
    kind: 'import' | 'from';
    module: string | null;
    clause: string;
    start: number;
    end: number;
  },
  source: string,
): ParsedSourceImport[] {
  const body = buildUsageBody(source, statement.start, statement.end);
  const normalizedClause = statement.clause.replace(/\n/g, ' ').trim();

  if (statement.kind === 'import') {
    return splitTopLevel(normalizedClause).flatMap((entry) => {
      const cleaned = entry.trim().replace(/,$/, '');
      if (!cleaned) return [];

      const [moduleName, alias] = cleaned.split(/\s+as\s+/);
      const importedName = moduleName!.trim();
      const localName = (alias ?? importedName.split('.')[0] ?? importedName).trim();
      const sourcePath = resolvePythonImportPath(db, importerPath, importedName);
      const usedMembers = collectNamespaceMembers(body, localName);

      return [{
        importedName,
        localName,
        sourcePath,
        kind: 'namespace' as const,
        used: hasIdentifierUsage(body, localName) || usedMembers.length > 0,
        usedMembers,
      }];
    });
  }

  const sourcePath = statement.module
    ? resolvePythonImportPath(db, importerPath, statement.module)
    : null;
  const results: ParsedSourceImport[] = [];
  for (const entry of splitTopLevel(normalizedClause)) {
    const cleaned = entry.trim().replace(/,$/, '');
    if (!cleaned) continue;

    if (cleaned === '*') {
      results.push({
        importedName: '*',
        localName: null,
        sourcePath,
        kind: 'side-effect' as const,
        used: true,
        usedMembers: [],
      });
      continue;
    }

    const [importedName, alias] = cleaned.split(/\s+as\s+/);
    const localName = (alias ?? importedName)!.trim();
    results.push({
      importedName: importedName!.trim(),
      localName,
      sourcePath,
      kind: 'named' as const,
      used: hasIdentifierUsage(body, localName),
      usedMembers: [],
    });
  }

  return results;
}

function parseImportClause(clause: string): Array<{
  importedName: string;
  localName: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
}> {
  const trimmed = clause.trim().replace(/^type\s+/, '');
  const [first, second] = splitImportClause(trimmed);
  const entries: Array<{
    importedName: string;
    localName: string | null;
    kind: 'named' | 'default' | 'namespace' | 'side-effect';
  }> = [];

  if (first) {
    entries.push(...parseImportBinding(first));
  }

  if (second) {
    entries.push(...parseImportBinding(second));
  }

  return entries;
}

function parseImportBinding(
  binding: string,
): Array<{
  importedName: string;
  localName: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
}> {
  const trimmed = binding.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];

    return splitTopLevel(inner).map((entry) => {
      const cleaned = entry.trim().replace(/^type\s+/, '');
      const [importedName, alias] = cleaned.split(/\s+as\s+/);
      return {
        importedName: importedName!.trim(),
        localName: (alias ?? importedName)!.trim(),
        kind: 'named' as const,
      };
    });
  }

  if (trimmed.startsWith('* as ')) {
    return [{
      importedName: '*',
      localName: trimmed.slice(5).trim(),
      kind: 'namespace',
    }];
  }

  return [{
    importedName: 'default',
    localName: trimmed,
    kind: 'default',
  }];
}

function splitImportClause(clause: string): [string, string | null] {
  let depth = 0;
  for (let i = 0; i < clause.length; i++) {
    const char = clause[i]!;
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (char === ',' && depth === 0) {
      return [clause.slice(0, i).trim(), clause.slice(i + 1).trim()];
    }
  }

  return [clause.trim(), null];
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === '{' || char === '[' || char === '(') depth++;
    if (char === '}' || char === ']' || char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function buildUsageBody(source: string, start: number, end: number): string {
  const masked = `${source.slice(0, start)}${' '.repeat(end - start)}${source.slice(end)}`;
  return stripCommentsAndStrings(masked);
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/'''[\s\S]*?'''/g, maskPreservingLines)
    .replace(/"""[\s\S]*?"""/g, maskPreservingLines)
    .replace(/#.*$/gm, maskPreservingLines)
    .replace(/\/\/.*$/gm, maskPreservingLines)
    .replace(/\/\*[\s\S]*?\*\//g, maskPreservingLines)
    .replace(/`(?:\\[\s\S]|[^`])*`/g, maskPreservingLines)
    .replace(/'(?:\\.|[^'\\\r\n])*'/g, maskPreservingLines)
    .replace(/"(?:\\.|[^"\\\r\n])*"/g, maskPreservingLines);
}

function maskPreservingLines(segment: string): string {
  return segment.replace(/[^\r\n]/g, ' ');
}

function hasIdentifierUsage(body: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegex(identifier)}\\b`, 'm').test(body);
}

function collectNamespaceMembers(body: string, namespaceName: string): string[] {
  const members = new Set<string>();
  const regex = new RegExp(`\\b${escapeRegex(namespaceName)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
  for (const match of body.matchAll(regex)) {
    const member = match[1];
    if (member) {
      members.add(member);
    }
  }
  return [...members];
}

function resolveImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  if (isPythonSourcePath(importerPath)) {
    return resolvePythonImportPath(db, importerPath, specifier);
  }

  return resolveJavaScriptImportPath(db, importerPath, specifier);
}

function resolveJavaScriptImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }

  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const absolute = resolve(importerDir, specifier);
  const indexedPaths = getIndexedPaths(db);

  for (const candidate of candidateImportPaths(absolute)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }

  return normalizePath(relative(db.config.projectRoot, absolute));
}

function resolvePythonImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  const indexedPaths = getIndexedPaths(db);

  let basePath: string;
  if (specifier.startsWith('.')) {
    const match = specifier.match(/^(\.+)(.*)$/);
    if (!match) return null;

    const dots = match[1]!.length;
    const remainder = match[2]!.replace(/^\./, '');
    let baseDir = dirname(join(db.config.projectRoot, importerPath));

    for (let i = 1; i < dots; i++) {
      baseDir = dirname(baseDir);
    }

    basePath = remainder
      ? resolve(baseDir, remainder.replace(/\./g, '/'))
      : baseDir;
  } else {
    basePath = resolve(db.config.projectRoot, specifier.replace(/\./g, '/'));
  }

  for (const candidate of pythonCandidateImportPaths(basePath)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }

  return null;
}

function pythonCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (PYTHON_SOURCE_EXTENSIONS.includes(ext as typeof PYTHON_SOURCE_EXTENSIONS[number])) {
    return [basePath];
  }

  return [
    `${basePath}.py`,
    `${basePath}.pyi`,
    join(basePath, '__init__.py'),
    join(basePath, '__init__.pyi'),
  ];
}

function candidateImportPaths(absolute: string): string[] {
  const ext = extname(absolute);
  const candidates = new Set<string>();

  if (ext) {
    candidates.add(absolute);
    for (const sourceExt of SOURCE_EXTENSIONS) {
      candidates.add(absolute.slice(0, -ext.length) + sourceExt);
    }
  } else {
    for (const sourceExt of SOURCE_EXTENSIONS) {
      candidates.add(`${absolute}${sourceExt}`);
      candidates.add(join(absolute, `index${sourceExt}`));
    }
  }

  return [...candidates];
}

function getIndexedPaths(db: ScipDatabase): Set<string> {
  const cached = INDEXED_PATH_CACHE.get(db);
  if (cached) {
    return cached;
  }

  const paths = new Set(
    db.all<{ relative_path: string }>(
      `SELECT relative_path
       FROM documents
       WHERE 1 = 1
         ${db.pathExclusionsFor('documents')}`,
    )
      .map((row) => normalizePath(row.relative_path))
      .filter((relativePath) => !db.isIgnored(relativePath)),
  );

  INDEXED_PATH_CACHE.set(db, paths);
  return paths;
}

function getCachedMap<K, V>(
  cache: WeakMap<ScipDatabase, Map<K, V>>,
  db: ScipDatabase,
): Map<K, V> {
  let map = cache.get(db);
  if (!map) {
    map = new Map<K, V>();
    cache.set(db, map);
  }
  return map;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isJavaScriptSourcePath(relativePath: string): boolean {
  return SOURCE_EXTENSIONS.includes(extname(relativePath).toLowerCase() as typeof SOURCE_EXTENSIONS[number]);
}

function isPythonSourcePath(relativePath: string): boolean {
  return PYTHON_SOURCE_EXTENSIONS.includes(extname(relativePath).toLowerCase() as typeof PYTHON_SOURCE_EXTENSIONS[number]);
}

export function getSourceText(
  db: ScipDatabase,
  relativePath: string,
): string {
  const cache = getCachedMap(SOURCE_TEXT_CACHE, db);
  const normalized = normalizePath(relativePath);
  const cached = cache.get(normalized);
  if (typeof cached === 'string') {
    return cached;
  }

  const fullPath = join(db.config.projectRoot, normalized);
  if (!existsSync(fullPath)) {
    cache.set(normalized, '');
    return '';
  }

  const source = readFileSync(fullPath, 'utf-8');
  cache.set(normalized, source);
  return source;
}

function pythonParenBalance(value: string): number {
  let balance = 0;
  for (const char of value) {
    if (char === '(') balance++;
    if (char === ')') balance--;
  }
  return balance;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
