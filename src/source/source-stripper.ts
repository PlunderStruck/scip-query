/**
 * source-stripper — masks comments and strings out of source text so a
 * downstream regex / identifier scan only sees code.
 *
 * Used by the regex-fallback paths inside per-language parsers (when
 * tree-sitter can't be loaded for a language) and by the regex fallback
 * in the identifier-line lookup. Each masked region is replaced with
 * spaces so byte offsets and line numbers stay aligned with the original
 * source.
 */
import type { ScipDatabase } from '../storage/db.js';
import { registerCacheClear } from '../storage/cache-registry.js';
import { createPerDbSourceCache } from '../storage/per-db-cache.js';

/**
 * Replace every comment and string literal with spaces (preserving newlines)
 * across all eight syntax flavours we currently care about: triple-quoted
 * Python strings, line-prefixed (`#`, `//`), block comments (`/* … *‍/`),
 * backtick template strings, single-quoted, and double-quoted.
 */
// scip-query: ignore-wrapper — public primitive of source-stripper; the heuristic
// only sees one external caller today but this is the module's defining function.
export function stripCommentsAndStrings(source: string): string {
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

const STRIPPED_LINES_CACHE = createPerDbSourceCache<string[]>('stripped-lines', {
  clearGroups: ['whole-project', 'source-file'],
});

// The single-entry strip cache below is keyed by source string identity, so
// it can serve stale lines after a file changes — register it alongside the
// per-db cache so both clear together.
registerCacheClear({
  name: 'stripped-source-singleton',
  groups: ['whole-project', 'source-file'],
  clearAll: () => {
    stripCacheSource = null;
    stripCacheResult = '';
  },
  clearFile: () => {
    stripCacheSource = null;
    stripCacheResult = '';
  },
});

/**
 * Per-(db, file, source) cache of stripCommentsAndStrings(source).split('\n').
 * Used by the regex-fallback path of `findIdentifierLines` (in
 * identifier-index.ts) so repeat lookups in the same file pay the strip cost
 * exactly once.
 */
// scip-query: ignore-wrapper — owns STRIPPED_LINES_CACHE; the cached read is the
// abstraction, not the lambda inside.
export function getStrippedLines(db: ScipDatabase, relativePath: string, source: string): string[] {
  return STRIPPED_LINES_CACHE.get(db, relativePath, source, () => stripCommentsAndStrings(source).split('\n'));
}

// Single-entry cache keyed by source string identity. Each parseXImports/Exports
// loop calls buildUsageBody many times with the same `source` string, but the
// previous implementation re-ran the 8-pass stripCommentsAndStrings for every
// call. For a 8,790-line Rust file with 50 use statements, that was 50 full-file
// regex sweeps. With this cache, each unique source pays the strip cost exactly
// once across an entire parser invocation.
let stripCacheSource: string | null = null;
let stripCacheResult = '';
function getStrippedSource(source: string): string {
  if (stripCacheSource === source) return stripCacheResult;
  stripCacheSource = source;
  stripCacheResult = stripCommentsAndStrings(source);
  return stripCacheResult;
}

/**
 * Mask the import statement at [start, end) inside `source` so identifier
 * scans for "is this binding used in the file?" don't match the import
 * statement itself. The rest of the source is returned with comments and
 * strings already stripped.
 */
export function buildUsageBody(source: string, start: number, end: number): string {
  const stripped = getStrippedSource(source);
  return `${stripped.slice(0, start)}${' '.repeat(end - start)}${stripped.slice(end)}`;
}

/**
 * `\b<identifier>\b` against the stripped body. The identifier must be a
 * full word so prefixes / suffixes don't false-positive (`foo` won't match
 * `foobar`).
 */
export function hasIdentifierUsage(body: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegex(identifier)}\\b`, 'm').test(body);
}

/**
 * `<namespace>.<member>` access scan. Returns the unique set of member
 * names accessed via the namespace prefix in the stripped body.
 */
export function collectNamespaceMembers(body: string, namespaceName: string): string[] {
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

/** Escape regex meta-characters so a user-supplied identifier matches literally. */
// scip-query: ignore-wrapper — used internally (hasIdentifierUsage, collectNamespaceMembers)
// AND exported for identifier-index.ts; the external-caller count of 1 understates real fan-in.
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parenBalance(value: string): number {
  let balance = 0;
  for (const char of value) {
    if (char === '(') balance += 1;
    if (char === ')') balance -= 1;
  }
  return balance;
}
