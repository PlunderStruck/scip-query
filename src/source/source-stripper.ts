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
import { escapeRegex } from './regex-utils.js';

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

/**
 * Comments-only variant of `stripCommentsAndStrings`: masks `//` and `/* *‍/`
 * comments but leaves string literals intact. Detectors that need to read a
 * string literal's *content* (a throw message, an error-result field) while
 * still splitting on statement boundaries safely need this — the full
 * comments-and-strings strip would blank the very text they're matching
 * against. Deliberately narrower than `stripCommentsAndStrings` (no `#`
 * line comments, no triple-quoted strings): today's only caller targets
 * brace-delimited languages (TS/JS). Backed by `tokenizeTsSafe`'s single-pass
 * scanner rather than a standalone block-comment regex — that regex doesn't
 * know about strings, so a comment-open-shaped substring *inside* a string or
 * template literal (a double-star-slash-star glob pattern, a regex literal)
 * gets misread as a real comment opener and swallows everything up to the
 * next unrelated comment-close sequence in the file as "comment" (found
 * dogfooding test-quality: a glob pattern inside one test's tsconfig fixture
 * ate a chunk of an unrelated earlier test). The tokenizer already knows to
 * skip over string contents without inspecting them for comment syntax, so
 * it can't have this bug.
 */
export function stripComments(source: string): string {
  return tokenizeTsSafe(source, { maskStrings: false });
}

/**
 * TS/JS-safe comments-AND-strings mask, single-pass tokenizer.
 *
 * `stripCommentsAndStrings` applies each comment/quote type as its own
 * whole-file global replace, in a fixed order. That's two independent bug
 * classes for TS/JS input, both found dogfooding the D1-D3 integrity
 * detectors against this repo's own source before they shipped:
 *  - A *lower-priority* quote character appearing inside a *higher-priority*
 *    one's content corrupts pairing: a single-quoted test title containing a
 *    backtick (`'resolves a \`@/*\` alias...'`, a common code-span-in-a-title
 *    shape) makes the backtick-string regex treat that interior backtick as
 *    opening a template literal, then greedily consume up to the next
 *    unrelated backtick as one "string".
 *  - The comment regex isn't string-aware at all (see `stripComments`'s doc
 *    comment) — a `/*`-shaped substring inside ANY string/template literal
 *    is misread as a comment opener.
 *
 * A real single-pass scan — advance one token at a time, and once inside a
 * comment or a quote, keep consuming until THAT construct's own close,
 * without re-interpreting what's inside it as a different construct —
 * cannot have either bug class by construction. WITHOUT
 * `stripCommentsAndStrings`'s Python-only `#.*$` line-comment and
 * triple-quoted-string passes (nothing this function's callers scan is
 * Python).
 */
export function stripCommentsAndStringsTsSafe(source: string): string {
  return tokenizeTsSafe(source, { maskStrings: true });
}

/**
 * Shared single-pass scanner behind `stripComments` and
 * `stripCommentsAndStringsTsSafe`: comments are always masked; string/
 * template-literal content is masked only when `maskStrings` is true
 * (`stripComments` still needs to SKIP OVER string contents while scanning —
 * otherwise a `/*`-shaped substring inside a string would be misread as a
 * comment opener — it just doesn't blank what it skips).
 */
function tokenizeTsSafe(source: string, opts: { maskStrings: boolean }): string {
  let result = '';
  let i = 0;
  const length = source.length;
  while (i < length) {
    if (source[i] === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? length : end;
      result += maskRange(source, i, stop);
      i = stop;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      const closeIndex = source.indexOf('*/', i + 2);
      const stop = closeIndex === -1 ? length : closeIndex + 2;
      result += maskRange(source, i, stop);
      i = stop;
      continue;
    }
    const char = source[i];
    if (char === '`' || char === "'" || char === '"') {
      const quote = char;
      let j = i + 1;
      while (j < length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j += 1;
          break;
        }
        // Single/double-quoted strings can't span a real newline in valid
        // JS — bail at the newline instead of accidentally swallowing the
        // rest of the file when a quote is unterminated (e.g. an apostrophe
        // inside a non-string comment survives this far in malformed input).
        if (quote !== '`' && source[j] === '\n') break;
        j += 1;
      }
      result += opts.maskStrings ? maskRange(source, i, j) : source.slice(i, j);
      i = j;
      continue;
    }
    result += char;
    i += 1;
  }
  return result;
}

function maskRange(source: string, start: number, end: number): string {
  let masked = '';
  for (let index = start; index < end; index += 1) {
    masked += source[index] === '\n' ? '\n' : ' ';
  }
  return masked;
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

export function parenBalance(value: string): number {
  let balance = 0;
  for (const char of value) {
    if (char === '(') balance += 1;
    if (char === ')') balance -= 1;
  }
  return balance;
}
