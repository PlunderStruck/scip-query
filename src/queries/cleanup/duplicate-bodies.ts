import { createHash } from 'node:crypto';
import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { getAllDefinitions } from '../../symbols/definition-catalog.js';
import { hasSuppressionCommentCategory } from '../../source/primitives/source-text.js';
import { analyzeSourceFunctions, type SourceFunction } from '../../source/ast/function-metrics.js';
import { readRepositoryTextFile } from '../../source/primitives/repository-text.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { getFileAddRecords } from '../../analysis/git-history.js';
import { classifyFile, isFrameworkEntrypointPath } from '../../analysis/file-classifier.js';
import { isUiKitFile } from '../../analysis/ui-kit-surface.js';
import { leafName } from '../../symbols/symbol-parser.js';
import { applyScanLimit, definitionLoc } from '../query-utils.js';

export interface DuplicateBodyEntry {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  ageCommits: number | null;
}

export interface DuplicateBodyGroup {
  hash: string;
  canonical: DuplicateBodyEntry;
  functions: DuplicateBodyEntry[];
}

export interface DuplicateBodyExclusion {
  reason: string;
  detail: string;
  count: number;
}

export interface DuplicateBodyScan {
  /** Groups that remain after the convention policy below. */
  groups: DuplicateBodyGroup[];
  /** Groups (or members) the policy removed, disclosed by reason. */
  exclusions: DuplicateBodyExclusion[];
}

type DuplicateBodyEntryWithBody = DuplicateBodyEntry & { normalizedBody: string };

// One parse per current file text and database lifetime; edits replace the entry.
const sourceFunctionsByDb = new WeakMap<ScipDatabase, Map<string, { text: string; functions: SourceFunction[] }>>();

/**
 * Default minimum body LOC (21.2 calibration retune). Below this, a
 * "duplicate" is usually a single-statement forwarding stub (command
 * handlers, thin API wrappers) — structurally identical by convention, not
 * an echo worth reviewing. Raised from 1 (external calibration: Stable_Management
 * §3/§5, Vega_2.0 §3 — both flagged this exact shape as the dominant noise
 * source). Callers that need the old behavior (e.g. tests asserting exact
 * normalization on tiny fixtures) can still pass `minLoc: 1` explicitly.
 */
const DEFAULT_MIN_BODY_LOC = 3;

export function duplicateBodies(
  db: ScipDatabase,
  opts: { scope?: string; maxLoc?: number; minLoc?: number; limit?: number; scanLimit?: number } = {},
): DuplicateBodyGroup[] {
  return duplicateBodyScan(db, opts).groups;
}

/**
 * Exact-duplicate scan with the convention policy applied and disclosed.
 * Identical bodies that exist because a convention demands them are not
 * consolidation candidates: every class carries a `<constructor>`, every
 * framework route file exports the same verb glue, vendored UI-kit files are
 * generated from one template, and test files copy fixtures on purpose.
 * Test-file members are dropped from mixed groups; a group survives only
 * when two product files still share the body.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; candidate load, grouping, and convention policy are one scan contract.
export function duplicateBodyScan(
  db: ScipDatabase,
  opts: { scope?: string; maxLoc?: number; minLoc?: number; limit?: number; scanLimit?: number } = {},
): DuplicateBodyScan {
  const { scope, maxLoc = 15, minLoc = DEFAULT_MIN_BODY_LOC, limit, scanLimit } = opts;
  const ages = getFileAddRecords(db);
  const entries = duplicateBodyCandidates(db, { scope, maxLoc, scanLimit })
    .map((definition) => duplicateBodyEntry(db, definition, ages, minLoc))
    .filter((entry): entry is DuplicateBodyEntryWithBody => entry !== null);
  const { groups, exclusions } = applyDuplicateBodyPolicy(db, groupByHash(entries));
  return { groups: limit ? groups.slice(0, limit) : groups, exclusions };
}

const FRAMEWORK_ROUTE_EXPORT = /^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|default|loader|action|load|actions)$/;

function applyDuplicateBodyPolicy(
  db: ScipDatabase,
  groups: readonly DuplicateBodyGroup[],
): { groups: DuplicateBodyGroup[]; exclusions: DuplicateBodyExclusion[] } {
  const counts = new Map<string, DuplicateBodyExclusion>();
  const record = (reason: string, detail: string): void => {
    const existing = counts.get(reason);
    if (existing) existing.count += 1;
    else counts.set(reason, { reason, detail, count: 1 });
  };
  const kept: DuplicateBodyGroup[] = [];
  for (const group of groups) {
    const functions: DuplicateBodyEntry[] = [];
    for (const entry of group.functions) {
      const verdict = duplicateBodyMemberVerdict(db, entry);
      if (verdict) {
        record(verdict.reason, verdict.detail);
        continue;
      }
      functions.push(entry);
    }
    if (functions.length < 2 || new Set(functions.map((entry) => entry.file)).size < 2) continue;
    kept.push({ hash: group.hash, canonical: functions[0]!, functions });
  }
  return {
    groups: kept,
    exclusions: [...counts.values()].sort((left, right) => left.reason.localeCompare(right.reason)),
  };
}

function duplicateBodyMemberVerdict(
  db: ScipDatabase,
  entry: DuplicateBodyEntry,
): { reason: string; detail: string } | null {
  const leaf = leafName(entry.symbol);
  if (leaf.startsWith('<') && leaf.endsWith('>')) {
    return {
      reason: 'synthetic-members',
      detail: 'duplicate constructors and other compiler-named members every class carries',
    };
  }
  if (classifyFile(entry.file) === 'test') {
    return {
      reason: 'test-file-members',
      detail: 'duplicate bodies in test files (fixture reuse, not product duplication)',
    };
  }
  if (FRAMEWORK_ROUTE_EXPORT.test(leaf) && isFrameworkEntrypointPath(entry.file)) {
    return {
      reason: 'framework-route-exports',
      detail: 'duplicate route-file verb exports whose identical glue the framework convention dictates',
    };
  }
  if (isUiKitFile(db, entry.file)) {
    return {
      reason: 'ui-kit-members',
      detail: 'duplicate bodies in vendored UI-kit directories generated from one template',
    };
  }
  return null;
}

export function exactDuplicateBodyMatches(
  db: ScipDatabase,
  symbol: string,
  opts: { scope?: string; maxLoc?: number; minLoc?: number; scanLimit?: number } = {},
): DuplicateBodyEntry[] {
  const { scope, maxLoc = 15, minLoc = DEFAULT_MIN_BODY_LOC, scanLimit } = opts;
  const ages = getFileAddRecords(db);
  const entries = duplicateBodyCandidates(db, { scope, maxLoc, scanLimit })
    .map((definition) => duplicateBodyEntry(db, definition, ages, minLoc))
    .filter((entry): entry is DuplicateBodyEntryWithBody => entry !== null);
  const target = entries.find((entry) => entry.symbol === symbol);
  if (!target) return [];
  return entries
    .filter(
      (entry) =>
        entry.symbol !== target.symbol && entry.normalizedBody === target.normalizedBody && entry.file !== target.file,
    )
    .sort(compareDuplicateBodyEntries)
    .map(({ normalizedBody: _body, ...entry }) => entry);
}

export function normalizeBody(source: string): string {
  const analysis = analyzeSourceFunctions('duplicate.ts', source);
  if (analysis.errors.length === 0 && analysis.functions[0]) return analysis.functions[0].bodyHash;
  const body = extractImplementationBody(source);
  // Unsupported syntax keeps exact body bytes: losing recall is preferable to erasing behavior.
  return body.trim();
}

export function groupByHash(entries: ReadonlyArray<DuplicateBodyEntryWithBody>): DuplicateBodyGroup[] {
  const buckets = new Map<string, DuplicateBodyEntryWithBody[]>();
  for (const entry of entries) {
    if (entry.normalizedBody.length < 8) continue;
    const hash = bodyHash(entry.normalizedBody);
    const bucket = buckets.get(hash) ?? [];
    bucket.push(entry);
    buckets.set(hash, bucket);
  }

  const groups: DuplicateBodyGroup[] = [];
  for (const [hash, bucket] of buckets) {
    const files = new Set(bucket.map((entry) => entry.file));
    if (bucket.length < 2 || files.size < 2) continue;
    const functions = [...bucket].sort(compareDuplicateBodyEntries).map(({ normalizedBody: _body, ...entry }) => entry);
    groups.push({ hash, canonical: functions[0]!, functions });
  }

  groups.sort((left, right) => {
    const sizeDiff = right.functions.length - left.functions.length;
    if (sizeDiff !== 0) return sizeDiff;
    const locDiff = totalLoc(right) - totalLoc(left);
    if (locDiff !== 0) return locDiff;
    return left.canonical.file.localeCompare(right.canonical.file);
  });
  return groups;
}

function duplicateBodyCandidates(
  db: ScipDatabase,
  opts: { scope?: string; maxLoc: number; scanLimit?: number },
): IndexedDefinition[] {
  const definitions = getAllDefinitions(db, { scope: opts.scope })
    .filter((definition) => definition.isFunctionLike && !db.isIgnored(definition.relativePath))
    // Exact bodies are the strongest form of similarity evidence. Reuse the
    // existing ignore-similar source decision so accepted parallel product
    // language is omitted from both duplicate and similarity detectors.
    .filter(
      (definition) => !hasSuppressionCommentCategory(db, definition.relativePath, definition.startLine, 'similar'),
    )
    .filter((definition) => definitionLoc(definition) <= opts.maxLoc);

  definitions.sort(
    (left, right) => definitionLoc(right) - definitionLoc(left) || left.relativePath.localeCompare(right.relativePath),
  );
  return applyScanLimit(definitions, opts.scanLimit);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function duplicateBodyEntry(
  db: ScipDatabase,
  definition: IndexedDefinition,
  ages: ReturnType<typeof getFileAddRecords>,
  minLoc: number,
): DuplicateBodyEntryWithBody | null {
  const snippet = definitionSourceSnippet(db, definition);
  if (!snippet) return null;
  if (bodyLineCount(snippet) < minLoc) return null;
  const normalizedBody = normalizedBodyForDefinition(db, definition);
  if (!normalizedBody) return null;
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    file: definition.relativePath,
    startLine: definition.startLine,
    endLine: definition.endLine,
    loc: definitionLoc(definition),
    ageCommits: ages?.get(definition.relativePath)?.commitsAgo ?? null,
    normalizedBody,
  };
}

export function normalizedBodyForDefinition(db: ScipDatabase, definition: IndexedDefinition): string | null {
  const snippet = definitionSourceSnippet(db, definition);
  if (!snippet) return null;
  const normalizedBody = normalizeBody(snippet);
  return normalizedBody || null;
}

/**
 * Raw source snippet spanning a definition's line range, before any
 * normalization. Shared by every detector that needs the definition's text
 * for its own comparison logic (e.g. twin-drift's token-level diffing) —
 * reuse this instead of re-deriving "read file, slice lines" per detector.
 */
export function definitionSourceSnippet(
  db: ScipDatabase,
  definition: Pick<IndexedDefinition, 'symbol' | 'relativePath' | 'startLine' | 'endLine'>,
): string | null {
  const observed = readRepositoryTextFile(db, definition.relativePath);
  if (!observed || observed.freshness.semantic.state === 'stale') return null;
  if (/\.[cm]?[jt]sx?$/i.test(definition.relativePath)) {
    let files = sourceFunctionsByDb.get(db);
    if (!files) {
      files = new Map();
      sourceFunctionsByDb.set(db, files);
    }
    let cached = files.get(definition.relativePath);
    if (!cached || cached.text !== observed.text) {
      cached = {
        text: observed.text,
        functions: analyzeSourceFunctions(definition.relativePath, observed.text).functions,
      };
      files.set(definition.relativePath, cached);
    }
    const rawLeaf = leafName(definition.symbol);
    const leaf = rawLeaf === '<constructor>' ? 'constructor' : rawLeaf;
    const matches = cached.functions.filter(
      (fn) =>
        (fn.name === leaf || fn.name.endsWith(`.${leaf}`)) &&
        fn.startLine - 1 >= definition.startLine &&
        fn.endLine - 1 <= definition.endLine,
    );
    if (matches.length !== 1) return null;
    return observed.text.slice(matches[0]!.startOffset, matches[0]!.endOffset);
  }
  return observed.text
    .split('\n')
    .slice(definition.startLine, definition.endLine + 1)
    .join('\n');
}

/**
 * Isolate a callable's implementation body (brace-delimited block, or the
 * expression after `=>`) from its raw source snippet. Exported so other
 * detectors comparing bodies (twin-drift) reuse this instead of
 * re-implementing body extraction — that duplication is exactly the "twin
 * drift" defect class this file's sibling detector hunts.
 */
export function extractImplementationBody(source: string): string {
  // The body starts at the first brace or arrow outside every parenthesis
  // and outside every type literal: a destructured parameter, a parameter
  // type, a type argument (`patchData<{ success: boolean }>(...)`), or a
  // return type (`): Promise<{ url: string }> {`) can hold braces before it.
  // A brace that follows `:`, `<`, `|`, `&`, `,`, `(`, or `=` opens a type or
  // value literal; the body brace follows `)`, `>`, `]`, or a type name.
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
    } else if (char === '{') {
      if (depth === 0 && !opensLiteral(source, index)) return sliceBlockBody(source, index);
      depth += 1;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && char === '=' && source[index + 1] === '>') {
      const rest = source.slice(index + 2).trimStart();
      if (rest.startsWith('{')) return sliceBlockBody(rest, 0);
      return rest.replace(/;+\s*$/, '');
    }
  }
  return source;
}

const LITERAL_OPENER_PREDECESSORS = new Set([':', '<', '|', '&', ',', '(', '=']);

function opensLiteral(source: string, braceIndex: number): boolean {
  let index = braceIndex - 1;
  while (index >= 0 && /\s/.test(source[index]!)) index -= 1;
  return index >= 0 && LITERAL_OPENER_PREDECESSORS.has(source[index]!);
}

function sliceBlockBody(source: string, openBrace: number): string {
  const lastBrace = source.lastIndexOf('}');
  return lastBrace > openBrace ? source.slice(openBrace + 1, lastBrace) : source;
}

/**
 * Number of non-blank statement lines in a callable's implementation body
 * (post-brace-extraction, pre-normalization — normalization collapses all
 * whitespace including newlines, so it can't answer "how many lines" by
 * itself). Used to exempt short forwarding-boilerplate bodies (single
 * `return foo(...)` stubs) from duplicate-bodies noise regardless of the
 * surrounding signature/brace lines counted by `definitionLoc`.
 */
function bodyLineCount(source: string): number {
  const body = extractImplementationBody(source);
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

function bodyHash(normalizedBody: string): string {
  return createHash('sha256').update(normalizedBody).digest('hex').slice(0, 16);
}

function compareDuplicateBodyEntries(left: DuplicateBodyEntry, right: DuplicateBodyEntry): number {
  const leftAge = left.ageCommits ?? -1;
  const rightAge = right.ageCommits ?? -1;
  return rightAge - leftAge || left.file.localeCompare(right.file) || left.startLine - right.startLine;
}

function totalLoc(group: DuplicateBodyGroup): number {
  return group.functions.reduce((sum, entry) => sum + entry.loc, 0);
}
