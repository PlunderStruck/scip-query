import type { ScipDatabase } from '../../storage/db.js';
import { classifyFile } from '../../analysis/file-classifier.js';
import { getSourceFiles } from '../../source/primitives/source-fileset.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { stripCommentsAndStringsTsSafe } from '../../source/primitives/source-stripper.js';
import { runGit } from '../../analysis/git-history.js';
import { applyScanLimit } from '../query-utils.js';

/**
 * test-quality (D3): the biggest uncovered surface — test files are not
 * SCIP-indexed (house convention), so this detector works entirely from the
 * source-facts layer (raw source text + `classifyFile`'s test-file
 * classification), never the graph. Three independently reportable
 * sub-checks:
 *  - assertion-free: `it`/`test` bodies with no reachable assertion call.
 *  - skipped: `it.skip`/`describe.skip`/`xit`/`.todo` inventory with
 *    git-blame age on the skip line.
 *  - mock-echo: a test asserting the same literal it stubbed into a mock.
 */

export type AssertionFreeSeverity = 'high' | 'low';
export type SkippedTestKind = 'skip' | 'todo';
export type SkipRot = 'rot' | 'workflow' | 'unknown';

export interface AssertionFreeFinding {
  file: string;
  startLine: number;
  endLine: number;
  title: string;
  severity: AssertionFreeSeverity;
}

export interface SkippedTestFinding {
  file: string;
  startLine: number;
  title: string;
  skipKind: SkippedTestKind;
  blockKind: 'it' | 'test' | 'describe';
  ageDays: number | null;
  rot: SkipRot;
}

export interface MockEchoFinding {
  file: string;
  startLine: number;
  endLine: number;
  title: string;
  echoedValue: string;
}

export interface TestQualityReport {
  assertionFree: AssertionFreeFinding[];
  skipped: SkippedTestFinding[];
  mockEcho: MockEchoFinding[];
}

export interface TestQualityOptions {
  scope?: string;
  limit?: number;
  scanLimit?: number;
  /** Skips older than this many days are reported as 'rot' rather than 'workflow'. Default 60. */
  rotDays?: number;
}

const DEFAULT_ROT_DAYS = 60;

// scip-query: ignore-extract — reviewed E1 workflow owner; test discovery, scoring, and report aggregation stay together.
export function testQuality(db: ScipDatabase, opts: TestQualityOptions = {}): TestQualityReport {
  const { scope, limit = 30, scanLimit, rotDays = DEFAULT_ROT_DAYS } = opts;

  const testFiles = applyScanLimit(
    getSourceFiles(db, { extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] })
      .filter((file) => classifyFile(file) === 'test')
      .filter((file) => !scope || file.includes(scope))
      .filter((file) => !db.isIgnored(file))
      .sort(),
    scanLimit,
  );

  const assertionFree: AssertionFreeFinding[] = [];
  const skipped: SkippedTestFinding[] = [];
  const mockEcho: MockEchoFinding[] = [];

  for (const file of testFiles) {
    const source = getSourceText(db, file);
    if (!source) continue;
    const masked = stripCommentsAndStringsTsSafe(source);
    const vocabulary = assertionVocabulary(source);
    // One-hop, same-file only: a local helper (`expectValidTypeScript(x)`)
    // whose own body calls a base-vocabulary assertion inherits that
    // status, the same "delegating checker" idea D1/D2 resolve through the
    // call graph — test files have no call graph to resolve through (they
    // aren't SCIP-indexed), so this does it syntactically, one hop, same
    // file only. Found dogfooding: this repo's own instrument.test.ts calls
    // a local `expectValidTypeScript` helper that wraps a real `expect(...)`
    // — without this, every test using it looked assertion-free.
    for (const helperName of localAssertionHelperNames(masked, vocabulary)) vocabulary.add(helperName);

    const blocks = findTestBlocks(masked);
    for (const block of blocks) {
      if (block.skip) {
        skipped.push(skippedFinding(db, file, block, rotDays));
        continue;
      }
      if (block.kind === 'describe') continue; // grouping construct, not itself asserted

      const title = extractTitle(source, block.argsStart);
      const bodyMasked = masked.slice(block.argsStart, block.callEnd);
      const bodyRaw = source.slice(block.argsStart, block.callEnd);

      if (!hasAssertionCall(bodyMasked, vocabulary)) {
        assertionFree.push({
          file,
          startLine: lineNumberAt(source, block.callStart),
          endLine: lineNumberAt(source, block.callEnd),
          title,
          severity: /\bawait\b/.test(bodyMasked) ? 'low' : 'high',
        });
      }

      const echo = findMockEcho(bodyMasked, bodyRaw);
      if (echo) {
        mockEcho.push({
          file,
          startLine: lineNumberAt(source, block.callStart),
          endLine: lineNumberAt(source, block.callEnd),
          title,
          echoedValue: echo,
        });
      }
    }
  }

  return {
    assertionFree: limit ? assertionFree.slice(0, limit) : assertionFree,
    skipped: limit ? skipped.slice(0, limit) : skipped,
    mockEcho: limit ? mockEcho.slice(0, limit) : mockEcho,
  };
}

// ── Block discovery ──────────────────────────────────────────────

type BlockKind = 'it' | 'test' | 'describe';

interface TestBlock {
  kind: BlockKind;
  skip: boolean;
  skipKind: SkippedTestKind;
  callStart: number;
  /** Offset right after the call's opening `(` — where the title argument begins. */
  argsStart: number;
  callEnd: number;
}

// `it(`/`test(`, `it.skip(`/`test.only(`/`describe.skip(`, `xit(`/`xdescribe(`, `it.todo(`.
// Excludes a preceding `.` (negative lookbehind): external calibration
// (2026-07-03, against Vega_2.0) found this matching `.test(` on a REGEXP
// or STRING method call (`/pattern/i.test(sql)`, extremely common in test
// files that assert against regex-matched content) as if it were a vitest
// `test(...)` block declaration — vitest/jest test-block globals are always
// called bare (`it(...)`, `test(...)`) or as `it.skip(...)`-style chains off
// the BARE name, never as a method on some other value.
const BLOCK_PATTERN =
  /(?<!\.)\b(?:x(it|test|describe)|(it|test|describe)(?:\.\s*(skip|only|todo|each\s*\([^)]*\)))?)\s*\(/g;

function findTestBlocks(masked: string): TestBlock[] {
  const blocks: TestBlock[] = [];
  BLOCK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLOCK_PATTERN.exec(masked))) {
    const xPrefixed = match[1];
    const kind = (xPrefixed ?? match[2]) as BlockKind | undefined;
    if (!kind) continue;
    const modifier = match[3]?.split(/\s*\(/)[0]; // 'skip' | 'only' | 'todo' | 'each' | undefined
    const callStart = match.index;
    const openParenIndex = match.index + match[0].length - 1;
    const callEnd = findMatchingParenEnd(masked, openParenIndex);
    BLOCK_PATTERN.lastIndex = openParenIndex + 1;
    if (modifier === 'each') continue; // table-driven — title/body shape differs too much to judge generically
    blocks.push({
      kind,
      skip: xPrefixed !== undefined || modifier === 'skip' || modifier === 'todo',
      skipKind: modifier === 'todo' ? 'todo' : 'skip',
      callStart,
      argsStart: openParenIndex + 1,
      callEnd: callEnd + 1,
    });
  }
  return blocks;
}

function findMatchingParenEnd(masked: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return masked.length - 1;
}

function lineNumberAt(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function extractTitle(source: string, argsStart: number): string {
  const window = source.slice(argsStart, argsStart + 400);
  const match = /^\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(window);
  return match ? match[2]! : '(anonymous)';
}

// ── assertion-free ────────────────────────────────────────────────

const ASSERTION_MODULES = new Set([
  'vitest',
  'chai',
  'jest',
  '@jest/globals',
  'assert',
  'node:assert',
  'node:assert/strict',
  'assert/strict',
  'uvu/assert',
  'expect',
  'chai-as-promised',
]);

const IMPORT_PATTERN = /import\s+(?:\*\s+as\s+(\w+)|\{([^}]*)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;

/**
 * Assertion vocabulary detected from this file's own imports, floored by the
 * two names that need no import to work (Jest/Mocha-style globals, and the
 * common `assert` convention) — "detect the repo's assertion vocabulary from
 * imports" per the drill design, without hardcoding every matcher library.
 */
function assertionVocabulary(source: string): Set<string> {
  const vocabulary = new Set<string>(['expect', 'assert']);
  IMPORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_PATTERN.exec(source))) {
    const [, namespaceAlias, namedList, defaultName, moduleSpecifier] = match;
    if (!moduleSpecifier || !ASSERTION_MODULES.has(moduleSpecifier)) continue;
    if (namespaceAlias) vocabulary.add(namespaceAlias);
    if (defaultName) vocabulary.add(defaultName);
    if (namedList) {
      for (const entry of namedList.split(',')) {
        const trimmed = entry.trim().replace(/^type\s+/, '');
        if (!trimmed) continue;
        const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(trimmed);
        vocabulary.add(asMatch ? asMatch[2]! : trimmed);
      }
    }
  }
  return vocabulary;
}

function hasAssertionCall(maskedBody: string, vocabulary: ReadonlySet<string>): boolean {
  if (/\.should\b/.test(maskedBody)) return true; // chai's should-style, not name-gated
  // Testing Library's async findBy* queries reject when no element appears,
  // and condition-specific waitFor helpers throw or time out when their named
  // condition is absent. Awaiting either is an assertion mechanism even when
  // the test does not wrap the result in expect().
  if (/\bawait\s+(?:[\w$.]+\.)?findBy[A-Z]\w*\s*\(/.test(maskedBody)) return true;
  if (/\bawait\s+\w*waitFor(?:Text|Value|Condition|Result|Event)\s*\(/.test(maskedBody)) return true;
  // A test that manually collects failures and `throw`s a descriptive error
  // (rather than calling expect/assert) is a legitimate, common assertion
  // mechanism — expect() failures throw internally too. External
  // calibration (2026-07-03, against Vega_2.0) found this pattern in a
  // coverage-sweep test that iterates every API endpoint and throws with
  // the full failure list; the vocabulary-only check couldn't see it.
  if (/\bthrow\b/.test(maskedBody)) return true;
  for (const name of vocabulary) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Optional TS generic type argument between the name and the call, e.g.
    // vitest's `expectTypeOf<T>()` — also found in the same calibration pass.
    const pattern = new RegExp(`\\b${escaped}\\s*(?:<[^<>]*>)?\\s*[.(]`);
    if (pattern.test(maskedBody)) return true;
  }
  return false;
}

const FUNCTION_DECL_PATTERN = /\bfunction\s+(\w+)\s*\(/g;
const CONST_ARROW_DECL_PATTERN = /\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
const MAX_SIGNATURE_TO_BODY_GAP = 60;

/**
 * Local (same-file) helper functions whose own body directly calls a
 * base-vocabulary assertion — a one-hop resolution, syntactic and same-file
 * only (test files have no call graph to resolve through). Deliberately
 * narrow: only brace-bodied declarations (`function f(...) { ... }` /
 * `const f = (...) => { ... }`) with a short signature-to-body gap are
 * considered, so a concise-body arrow or an unrelated same-name call
 * elsewhere doesn't get misread as a helper declaration.
 */
function localAssertionHelperNames(masked: string, baseVocabulary: ReadonlySet<string>): Set<string> {
  const helpers = new Set<string>();
  for (const pattern of [FUNCTION_DECL_PATTERN, CONST_ARROW_DECL_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked))) {
      const name = match[1]!;
      const parenOpenIndex = match.index + match[0].length - 1;
      const parenCloseIndex = findMatchingParenEnd(masked, parenOpenIndex);
      const braceOpenIndex = masked.indexOf('{', parenCloseIndex + 1);
      if (braceOpenIndex === -1 || braceOpenIndex - parenCloseIndex > MAX_SIGNATURE_TO_BODY_GAP) continue;
      const braceCloseIndex = findMatchingBraceEnd(masked, braceOpenIndex);
      const body = masked.slice(braceOpenIndex + 1, braceCloseIndex);
      if (hasAssertionCall(body, baseVocabulary)) helpers.add(name);
    }
  }
  return helpers;
}

function findMatchingBraceEnd(masked: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return masked.length - 1;
}

// ── mock-echo ─────────────────────────────────────────────────────

const MOCK_RETURN_PATTERN = /\bmock(?:ReturnValue|ResolvedValue)(?:Once)?\s*\(/g;
const EXPECT_CALL_PATTERN = /\bexpect\s*\(/g;
const EQUALITY_MATCHER_PATTERN = /^\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(/;
// Deliberately excludes true/false/null/undefined/empty-string: dogfooding
// this against the repo's own suite found a same-literal false positive
// where `vi.spyOn(process, 'kill').mockReturnValue(true)` (stubbing an
// unrelated syscall's return) coincidentally shared the literal `true` with
// a totally unrelated `expect(existsSync(...)).toBe(true)` later in the same
// test — the two calls have nothing to do with each other, they just both
// happen to use the single most common boolean literal. A numeric or
// non-empty string literal repeating between a stub and an assertion is a
// much stronger, low-cardinality signal that the assertion is validating
// the mock rather than the behavior under test.
const SIMPLE_LITERAL_PATTERN = /^(?:-?\d+(?:\.\d+)?|(['"`]).+\1)$/;

/**
 * Syntactic same-literal case only: a value stubbed via `mockReturnValue`/
 * `mockResolvedValue` and then asserted with `toBe`/`toEqual` in the SAME
 * test body, where the two argument texts are byte-identical simple
 * literals. High precision, low recall by design — no dataflow tracing.
 */
function findMockEcho(maskedBody: string, rawBody: string): string | null {
  const mockValues = literalArgs(maskedBody, rawBody, MOCK_RETURN_PATTERN);
  if (mockValues.length === 0) return null;
  const assertedValues = equalityAssertedValues(maskedBody, rawBody);
  for (const asserted of assertedValues) {
    if (mockValues.includes(asserted)) return asserted;
  }
  return null;
}

/** Every `mockReturnValue(...)`/`mockResolvedValue(...)` simple-literal argument in the body. */
function literalArgs(maskedBody: string, rawBody: string, pattern: RegExp): string[] {
  const values: string[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(maskedBody))) {
    const openParenIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingParenEnd(maskedBody, openParenIndex);
    const rawArg = rawBody.slice(openParenIndex + 1, closeIndex).trim();
    if (SIMPLE_LITERAL_PATTERN.test(rawArg)) values.push(rawArg);
    pattern.lastIndex = closeIndex + 1;
  }
  return values;
}

/**
 * Every simple-literal argument passed to `.toBe(...)`/`.toEqual(...)`/
 * `.toStrictEqual(...)` chained directly off an `expect(...)` call. Depth-
 * tracks the `expect(...)` call's own argument span first (`expect(fetcher())`
 * is a common, entirely ordinary shape) instead of assuming it's paren-free,
 * then looks for the equality matcher immediately after it.
 */
function equalityAssertedValues(maskedBody: string, rawBody: string): string[] {
  const values: string[] = [];
  EXPECT_CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPECT_CALL_PATTERN.exec(maskedBody))) {
    const expectOpenIndex = match.index + match[0].length - 1;
    const expectCloseIndex = findMatchingParenEnd(maskedBody, expectOpenIndex);
    const afterExpect = maskedBody.slice(expectCloseIndex + 1);
    const matcherMatch = EQUALITY_MATCHER_PATTERN.exec(afterExpect);
    EXPECT_CALL_PATTERN.lastIndex = expectCloseIndex + 1;
    if (!matcherMatch) continue;
    const matcherOpenIndex = expectCloseIndex + 1 + matcherMatch[0].length - 1;
    const matcherCloseIndex = findMatchingParenEnd(maskedBody, matcherOpenIndex);
    const rawArg = rawBody.slice(matcherOpenIndex + 1, matcherCloseIndex).trim();
    if (SIMPLE_LITERAL_PATTERN.test(rawArg)) values.push(rawArg);
  }
  return values;
}

// ── skipped-test ledger ───────────────────────────────────────────

function skippedFinding(db: ScipDatabase, file: string, block: TestBlock, rotDays: number): SkippedTestFinding {
  const source = getSourceText(db, file);
  const title = extractTitle(source, block.argsStart);
  const line = lineNumberAt(source, block.callStart);
  const ageDays = blameAgeDays(db.config.projectRoot, file, line);
  const rot: SkipRot = ageDays === null ? 'unknown' : ageDays >= rotDays ? 'rot' : 'workflow';
  return {
    file,
    startLine: line,
    title,
    skipKind: block.skipKind,
    blockKind: block.kind,
    ageDays,
    rot,
  };
}

function blameAgeDays(projectRoot: string, file: string, zeroIndexedLine: number): number | null {
  const gitLine = zeroIndexedLine + 1;
  try {
    const output = runGit(projectRoot, ['blame', '-L', `${gitLine},${gitLine}`, '--porcelain', '--', file]);
    const match = /^author-time (\d+)$/m.exec(output);
    if (!match) return null;
    const authorTimeSeconds = Number(match[1]);
    if (!Number.isFinite(authorTimeSeconds)) return null;
    return Math.max(0, Math.round((Date.now() / 1000 - authorTimeSeconds) / 86400));
  } catch {
    return null;
  }
}
