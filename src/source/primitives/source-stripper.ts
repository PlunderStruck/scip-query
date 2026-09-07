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
import { registerCacheClear } from '../../storage/cache-registry.js';
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
  while (i < source.length) {
    const commentEnd = tsSafeCommentEnd(source, i);
    if (commentEnd !== null) {
      result += maskRange(source, i, commentEnd);
      i = commentEnd;
      continue;
    }
    const char = source[i];
    if (char === '`' || char === "'" || char === '"') {
      const end = tsSafeQuotedEnd(source, i, char);
      result += opts.maskStrings ? maskRange(source, i, end) : source.slice(i, end);
      i = end;
      continue;
    }
    result += char;
    i += 1;
  }
  return result;
}

function tsSafeCommentEnd(source: string, start: number): number | null {
  if (source[start] !== '/') return null;
  if (source[start + 1] === '/') {
    const end = source.indexOf('\n', start);
    return end === -1 ? source.length : end;
  }
  if (source[start + 1] === '*') {
    const closeIndex = source.indexOf('*/', start + 2);
    return closeIndex === -1 ? source.length : closeIndex + 2;
  }
  return null;
}

function tsSafeQuotedEnd(source: string, start: number, quote: string): number {
  let end = start + 1;
  while (end < source.length) {
    if (source[end] === '\\') {
      end += 2;
      continue;
    }
    if (source[end] === quote) return end + 1;
    // Recover at a real newline for malformed single/double-quoted strings;
    // template literals may span lines. Escapes retain their two-byte advance.
    if (quote !== '`' && source[end] === '\n') break;
    end += 1;
  }
  return end;
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

// Release the retained source and result when source evidence is cleared.
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
