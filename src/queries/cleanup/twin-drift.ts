import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { getAllDefinitions } from '../../symbols/definition-catalog.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { classifyFile, isBarrel } from '../../analysis/file-classifier.js';
import { stripCommentsAndStrings } from '../../source/source-stripper.js';
import { applyScanLimit, definitionLoc } from '../query-utils.js';
import { definitionSourceSnippet, extractImplementationBody, normalizeBody } from './duplicate-bodies.js';

/**
 * Twin-drift: same leaf name (or a near-name variant like escapeRegex vs
 * escapeRegExp), used across two or more files, with bodies that have
 * *diverged* rather than stayed identical or being unrelated homonyms.
 *
 * Distinct from the existing detectors:
 * - duplicate-bodies requires byte-identical normalized bodies.
 * - similar requires callee-set overlap (any names).
 * - similar-signatures requires the same type shape (any names).
 *
 * This one is the missing "same concept, drifted implementation" case:
 * React/Vue helper families with drifted thresholds, escapeRegex vs
 * escapeRegExp, etc.
 */

export type TwinRelationship = 'identical' | 'divergent' | 'homonym';

export interface TwinMember {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
}

export interface TwinGroup {
  /** Representative leaf name for the near-name cluster. */
  leaf: string;
  relationship: TwinRelationship;
  /** 1 - normalized-token Jaccard similarity of the closest cross-file pair, rounded to 3 decimals. */
  maxDivergence: number;
  members: TwinMember[];
  /** First differing normalized token run between the closest divergent pair. Only set for 'divergent' groups. */
  firstDivergentTokens?: string;
}

/** Pure input record — the seam `groupTwins` tests are written against. */
export interface TwinDriftRecord {
  leaf: string;
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  normalizedBody: string;
  tokens: readonly string[];
}

export function twinDrift(
  db: ScipDatabase,
  opts: {
    scope?: string;
    minSimilarity?: number;
    includeHomonyms?: boolean;
    limit?: number;
    scanLimit?: number;
  } = {},
): TwinGroup[] {
  const { includeHomonyms = false, limit } = opts;
  const groups = allTwinGroups(db, opts).filter(
    (group) => group.relationship === 'divergent' || (includeHomonyms && group.relationship === 'homonym'),
  );
  return limit ? groups.slice(0, limit) : groups;
}

/**
 * Every classified twin group (identical, divergent, homonym) — including
 * the 'identical' groups `twinDrift` always defers to duplicate-bodies.
 * Internal consumers like diff-gate's twin-partner check need 'identical'
 * groups too (a same-name pair that WAS byte-identical is exactly the kind
 * of pair a one-sided edit should alarm on).
 */
export function allTwinGroups(
  db: ScipDatabase,
  opts: { scope?: string; minSimilarity?: number; scanLimit?: number } = {},
): TwinGroup[] {
  const { scope, minSimilarity = 0.3, scanLimit } = opts;
  const records = twinDriftRecords(db, { scope, scanLimit });
  return groupTwins(records, { minSimilarity });
}

/**
 * Pure grouping core: cluster records by (near-)leaf name, then classify
 * each cross-file cluster by its closest pair's body similarity.
 *   - every cross-file pair byte-identical after normalization -> 'identical' (defer to duplicate-bodies)
 *   - closest pair similarity in [minSimilarity, 1)                -> 'divergent' (the finding)
 *   - closest pair similarity < minSimilarity                      -> 'homonym' (coincidental name reuse)
 */
export function groupTwins(records: readonly TwinDriftRecord[], opts: { minSimilarity?: number } = {}): TwinGroup[] {
  const minSimilarity = opts.minSimilarity ?? 0.3;
  // 21.2 calibration retune (external calibration: Stable_Management §6.4,
  // Vega_2.0 §3 — the single worst twin-drift false-positive class on both
  // repos): every class in a TS/JS codebase has a member literally named
  // `<constructor>` (and other synthetic scip-generated names follow the
  // same `<...>` shape); grouping on that name matches unrelated classes by
  // convention alone, not by concept. Drop synthetic leaves before
  // clustering so they can never form a group.
  const realRecords = records.filter((record) => !isSyntheticLeaf(record.leaf));
  const leaves = [...new Set(realRecords.map((record) => record.leaf))];
  const clusters = clusterLeafNames(leaves);

  const groups: TwinGroup[] = [];
  for (const cluster of clusters) {
    const members = realRecords.filter((record) => cluster.has(record.leaf));
    if (members.length < 2) continue;
    if (new Set(members.map((member) => member.file)).size < 2) continue;
    // 21.2 calibration retune: a same-name pair that only exists inside
    // test files (mocks, fixtures, parallel test suites) is not the "two
    // production implementations drifted apart" shape twin-drift targets —
    // reuse the shared test-file classification (the same one dead.ts and
    // co-change use) instead of re-deriving a test-path heuristic here.
    if (members.every((member) => classifyFile(member.file) === 'test')) continue;

    let bestNonIdentical: { a: TwinDriftRecord; b: TwinDriftRecord; similarity: number } | null = null;
    let hasCrossFilePair = false;
    let hasIdenticalPair = false;

    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i]!;
        const b = members[j]!;
        if (a.file === b.file) continue;
        hasCrossFilePair = true;
        if (a.normalizedBody === b.normalizedBody) {
          hasIdenticalPair = true;
          continue;
        }
        const similarity = jaccardSimilarity(a.tokens, b.tokens);
        if (!bestNonIdentical || similarity > bestNonIdentical.similarity) {
          bestNonIdentical = { a, b, similarity };
        }
      }
    }
    if (!hasCrossFilePair) continue;

    const sortedMembers = [...members]
      .sort((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine)
      .map(toTwinMember);

    if (!bestNonIdentical) {
      // Every cross-file pair in this cluster is byte-identical — duplicate-bodies owns it.
      groups.push({
        leaf: representativeLeaf(cluster),
        relationship: hasIdenticalPair ? 'identical' : 'homonym',
        maxDivergence: 0,
        members: sortedMembers,
      });
      continue;
    }

    const relationship: TwinRelationship = bestNonIdentical.similarity >= minSimilarity ? 'divergent' : 'homonym';
    groups.push({
      leaf: representativeLeaf(cluster),
      relationship,
      maxDivergence: Math.round((1 - bestNonIdentical.similarity) * 1000) / 1000,
      members: sortedMembers,
      ...(relationship === 'divergent'
        ? { firstDivergentTokens: firstDivergentRun(bestNonIdentical.a.tokens, bestNonIdentical.b.tokens) }
        : {}),
    });
  }

  return groups.sort(
    (left, right) =>
      right.members.length - left.members.length ||
      right.maxDivergence - left.maxDivergence ||
      left.leaf.localeCompare(right.leaf),
  );
}

function twinDriftRecords(db: ScipDatabase, opts: { scope?: string; scanLimit?: number }): TwinDriftRecord[] {
  const definitions = getAllDefinitions(db, { scope: opts.scope })
    .filter((definition) => definition.isFunctionLike && !db.isIgnored(definition.relativePath))
    .filter((definition) => !isBarrel(definition.relativePath));

  definitions.sort(
    (left, right) => left.relativePath.localeCompare(right.relativePath) || left.startLine - right.startLine,
  );
  const scanned = applyScanLimit(definitions, opts.scanLimit);

  const records: TwinDriftRecord[] = [];
  for (const definition of scanned) {
    const record = twinDriftRecord(db, definition);
    if (record) records.push(record);
  }
  return records;
}

function twinDriftRecord(db: ScipDatabase, definition: IndexedDefinition): TwinDriftRecord | null {
  if (!definition.leaf) return null;
  const snippet = definitionSourceSnippet(db, definition);
  if (!snippet) return null;
  const normalizedBody = normalizeBody(snippet);
  if (!normalizedBody || normalizedBody.length < 8) return null;
  const tokens = tokenizeSnippet(snippet);
  if (tokens.length === 0) return null;
  return {
    leaf: definition.leaf,
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    file: definition.relativePath,
    startLine: definition.startLine,
    endLine: definition.endLine,
    loc: definitionLoc(definition),
    normalizedBody,
    tokens,
  };
}

const TOKEN_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g;

function tokenizeSnippet(snippet: string): string[] {
  const body = extractImplementationBody(snippet);
  const stripped = stripCommentsAndStrings(body);
  return stripped.match(TOKEN_PATTERN) ?? [];
}

function toTwinMember(record: TwinDriftRecord): TwinMember {
  return {
    symbol: record.symbol,
    shortName: record.shortName,
    file: record.file,
    startLine: record.startLine,
    endLine: record.endLine,
    loc: record.loc,
  };
}

function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function firstDivergentRun(a: readonly string[], b: readonly string[]): string {
  const len = Math.min(a.length, b.length);
  let index = 0;
  while (index < len && a[index] === b[index]) index += 1;
  const windowA = a.slice(index, index + 6).join(' ');
  const windowB = b.slice(index, index + 6).join(' ');
  if (!windowA && !windowB) return '(bodies differ only in trailing length)';
  return `A: ${windowA || '(end)'}  |  B: ${windowB || '(end)'}`;
}

/**
 * Cluster leaf names that are "the same concept": exact match after
 * case-folding, or edit-distance <= 2 for names long enough (>= 8 chars)
 * that a small edit is unlikely to be coincidental (catches escapeRegex vs
 * escapeRegExp without also merging unrelated short names like `get`/`set`).
 */
function clusterLeafNames(leaves: readonly string[]): Array<Set<string>> {
  const parent = new Map<string, string>();
  for (const leaf of leaves) parent.set(leaf, leaf);

  const find = (value: string): string => {
    let root = value;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = value;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  // Bucket by first lowercase character to avoid O(n^2) edit-distance work
  // across the whole leaf-name vocabulary.
  const byFirstChar = new Map<string, string[]>();
  for (const leaf of leaves) {
    const key = leaf.slice(0, 1).toLowerCase();
    const bucket = byFirstChar.get(key) ?? [];
    bucket.push(leaf);
    byFirstChar.set(key, bucket);
  }

  for (const bucket of byFirstChar.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        if (areNearNames(bucket[i]!, bucket[j]!)) union(bucket[i]!, bucket[j]!);
      }
    }
  }

  const clusters = new Map<string, Set<string>>();
  for (const leaf of leaves) {
    const root = find(leaf);
    const set = clusters.get(root) ?? new Set<string>();
    set.add(leaf);
    clusters.set(root, set);
  }
  return [...clusters.values()];
}

function areNearNames(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  if (a.length < 8 || b.length < 8) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  return levenshteinAtMost(a.toLowerCase(), b.toLowerCase(), 2);
}

/** Bounded edit distance check — returns false as soon as the distance provably exceeds `max`. */
function levenshteinAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = current[0]!;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return false;
    previous = current;
  }
  return previous[b.length]! <= max;
}

/**
 * scip-generated synthetic names (`<constructor>`, `<computed>`, and
 * friends) are wrapped in angle brackets by convention — every class in a
 * TS/JS codebase has a `<constructor>` member, so matching on the literal
 * name produces same-name pairs with no conceptual relationship at all.
 */
function isSyntheticLeaf(leaf: string): boolean {
  return leaf.startsWith('<') && leaf.endsWith('>');
}

function representativeLeaf(cluster: Set<string>): string {
  return [...cluster].sort()[0]!;
}
