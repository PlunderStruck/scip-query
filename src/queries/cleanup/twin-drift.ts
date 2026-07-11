import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { getAllDefinitions } from '../../symbols/definition-catalog.js';
import { isCallableSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { getCallSites } from '../../source/ast/ast-facts.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { pathsResolveSame } from '../../source/path-normalization.js';
import { classifyFile, isBarrel } from '../../analysis/file-classifier.js';
import { stripCommentsAndStrings } from '../../source/source-stripper.js';
import { scipFunctionLikeKindNumbers } from '../../symbols/symbol-kind.js';
import { applyScanLimit, definitionLoc } from '../query-utils.js';
import { definitionSourceSnippet, extractImplementationBody, normalizeBody } from './duplicate-bodies.js';

const SCIP_FUNCTION_LIKE_KINDS = new Set(scipFunctionLikeKindNumbers());

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
  /**
   * True when the body is (up to a short guard) nothing more than a single
   * call expression, optionally `return`ed/`await`ed — the shape a thin
   * controller/service/storage delegate has. Purely structural (source-text
   * based); doesn't by itself mean the call target is the other twin — see
   * `isDelegatePair`/`buildDelegationChecker` for that.
   */
  isThinForwarder: boolean;
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
  return groupTwins(records, { minSimilarity, isDelegatePair: buildDelegationChecker(db) });
}

/**
 * Pure grouping core: cluster records by (near-)leaf name, then classify
 * each cross-file cluster by its closest pair's body similarity.
 *   - every cross-file pair byte-identical after normalization -> 'identical' (defer to duplicate-bodies)
 *   - closest pair similarity in [minSimilarity, 1)                -> 'divergent' (the finding)
 *   - closest pair similarity < minSimilarity                      -> 'homonym' (coincidental name reuse)
 */
export function groupTwins(
  records: readonly TwinDriftRecord[],
  opts: {
    minSimilarity?: number;
    /**
     * Injected so this stays a pure/DB-free function for `groupTwins`'s unit
     * tests: `isDelegatePair(from, to, clusterMembers)` answers "is `from` a
     * thin forwarder whose call target resolves to `to` (directly, or by
     * chaining through same-leaf-name delegates found in `clusterMembers`)?"
     * `allTwinGroups` wires the real, source/import-backed implementation
     * via `buildDelegationChecker`.
     */
    isDelegatePair?: (
      from: TwinDriftRecord,
      to: TwinDriftRecord,
      clusterMembers: readonly TwinDriftRecord[],
    ) => boolean;
  } = {},
): TwinGroup[] {
  const minSimilarity = opts.minSimilarity ?? 0.3;
  const isDelegatePair = opts.isDelegatePair;
  // 21.2 calibration retune (external calibration: Stable_Management §6.4,
  // Vega_2.0 §3 — the single worst twin-drift false-positive class on both
  // repos): every class in a TS/JS codebase has a member literally named
  // `<constructor>` (and other synthetic scip-generated names follow the
  // same `<...>` shape); grouping on that name matches unrelated classes by
  // convention alone, not by concept. Drop synthetic leaves before
  // clustering so they can never form a group.
  const realRecords = records.filter(
    (record) =>
      !isSyntheticLeaf(record.leaf) && !isConventionOnlyTwinLeaf(record.leaf) && classifyFile(record.file) !== 'test',
  );
  const leaves = [...new Set(realRecords.map((record) => record.leaf))];
  const clusters = clusterLeafNames(leaves);

  const groups: TwinGroup[] = [];
  for (const cluster of clusters) {
    const members = realRecords.filter((record) => cluster.has(record.leaf));
    if (members.length < 2) continue;
    if (new Set(members.map((member) => member.file)).size < 2) continue;
    let bestNonIdentical: { a: TwinDriftRecord; b: TwinDriftRecord; similarity: number } | null = null;
    let hasCrossFilePair = false;
    let hasIdenticalPair = false;
    const participatingSymbols = new Set<string>();

    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i]!;
        const b = members[j]!;
        if (a.file === b.file) continue;
        if (!hasEnoughConceptContext(a, b)) continue;
        // A thin controller/service/storage-style delegate calling its
        // same-name implementation (directly, or through a chain of
        // same-name forwarders) is not a drifted twin — it's the intended
        // architecture. Skip the pair entirely (as if it didn't exist for
        // grouping purposes) rather than merely excluding it from
        // similarity scoring, so a cluster whose *only* cross-file pair is a
        // delegation chain produces no group at all.
        if (isDelegatePair?.(a, b, members) || isDelegatePair?.(b, a, members)) continue;
        hasCrossFilePair = true;
        participatingSymbols.add(a.symbol);
        participatingSymbols.add(b.symbol);
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

    const sortedMembers = members
      .filter((member) => participatingSymbols.has(member.symbol))
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
    .filter((definition) => isTwinCallableDefinition(definition) && !db.isIgnored(definition.relativePath))
    .filter((definition) => !isBarrel(definition.relativePath));

  definitions.sort(
    (left, right) => left.relativePath.localeCompare(right.relativePath) || left.startLine - right.startLine,
  );
  const scanned = applyScanLimit(definitions, opts.scanLimit);
  const candidates =
    typeof opts.scanLimit === 'number' && Number.isFinite(opts.scanLimit)
      ? twinDriftCandidateDefinitions(scanned)
      : scanned;

  const records: TwinDriftRecord[] = [];
  for (const definition of candidates) {
    const record = twinDriftRecord(db, definition);
    if (record) records.push(record);
  }
  return records;
}

function isTwinCallableDefinition(definition: IndexedDefinition): boolean {
  if (!definition.isFunctionLike) return false;
  if (!definition.symbol.startsWith('rust-analyzer ')) return true;
  return typeof definition.kind === 'number' && SCIP_FUNCTION_LIKE_KINDS.has(definition.kind);
}

function twinDriftCandidateDefinitions(definitions: readonly IndexedDefinition[]): IndexedDefinition[] {
  const realDefinitions = definitions.filter((definition) => definition.leaf && !isSyntheticLeaf(definition.leaf));
  const definitionsByLeaf = new Map<string, IndexedDefinition[]>();
  for (const definition of realDefinitions) {
    const bucket = definitionsByLeaf.get(definition.leaf) ?? [];
    bucket.push(definition);
    definitionsByLeaf.set(definition.leaf, bucket);
  }

  const clusters = clusterLeafNames([...definitionsByLeaf.keys()]);
  const selected = new Set<IndexedDefinition>();
  for (const cluster of clusters) {
    const members = [...cluster].flatMap((leaf) => definitionsByLeaf.get(leaf) ?? []);
    if (members.length < 2) continue;
    if (new Set(members.map((member) => member.relativePath)).size < 2) continue;
    if (members.every((member) => classifyFile(member.relativePath) === 'test')) continue;
    for (const member of members) selected.add(member);
  }

  return definitions.filter((definition) => selected.has(definition));
}

function twinDriftRecord(db: ScipDatabase, definition: IndexedDefinition): TwinDriftRecord | null {
  if (!definition.leaf) return null;
  const snippet = definitionSourceSnippet(db, definition);
  if (!snippet) return null;
  if (!isCallableSymbol(definition.symbol) && !isTopLevelArrowFunctionSnippet(snippet, definition.leaf)) return null;
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
    isThinForwarder: isThinForwarderBody(snippet),
  };
}

function isTopLevelArrowFunctionSnippet(snippet: string, leaf: string): boolean {
  const escapedLeaf = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b(?:const|let|var)\\s+${escapedLeaf}(?:\\s*:[^=]+)?\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`,
    's',
  ).test(snippet);
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
  if (commonCharacterPrefixLength(a.toLowerCase(), b.toLowerCase()) / Math.max(a.length, b.length) < 0.8) {
    return false;
  }
  return levenshteinAtMost(a.toLowerCase(), b.toLowerCase(), 2);
}

function commonCharacterPrefixLength(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let index = 0;
  while (index < length && a[index] === b[index]) index += 1;
  return index;
}

function isConventionOnlyTwinLeaf(leaf: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(leaf) || CONVENTION_ONLY_TWIN_LEAVES.has(leaf.toLowerCase());
}

const CONVENTION_ONLY_TWIN_LEAVES = new Set(['main', 'row']);

const GENERIC_CONTEXT_SEGMENTS = new Set([
  'app',
  'component',
  'components',
  'feature',
  'features',
  'index',
  'lib',
  'route',
  'routes',
  'shared',
  'src',
  'tsx',
  'typescript',
  'ui',
]);

function hasEnoughConceptContext(a: TwinDriftRecord, b: TwinDriftRecord): boolean {
  if (a.leaf.toLowerCase() !== b.leaf.toLowerCase()) return true;
  if (a.leaf.length > 4) return true;
  const aContext = twinContextTokens(a);
  return [...twinContextTokens(b)].some((token) => aContext.has(token));
}

function twinContextTokens(record: TwinDriftRecord): Set<string> {
  const leaf = record.leaf.toLowerCase();
  return new Set(
    `${record.file}/${record.shortName}`
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && token !== leaf && !GENERIC_CONTEXT_SEGMENTS.has(token)),
  );
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
 * Structural (source-text-only) check for a thin forwarding body: at most
 * two top-level statements, no branching/looping, and the last statement is
 * nothing more than a single call expression (optionally `return`ed and/or
 * `await`ed). This is the shape a controller/service/storage delegate has —
 * `return this.service.jsonHandler(req, res);` — as opposed to a body that
 * actually implements the behavior. Purely structural; whether the call
 * target is actually the other twin is a separate, DB-backed check (see
 * `buildDelegationChecker`). Exported so other detectors that need the same
 * "is this body just a forwarding call?" shape (decorative-checkers'
 * one-hop delegate resolution) reuse it instead of re-deriving the same
 * statement-count/control-flow/call-shape check.
 */
export function isThinForwarderBody(rawSnippet: string): boolean {
  const body = stripCommentsAndStrings(extractImplementationBody(rawSnippet)).trim();
  if (!body) return false;
  if (CONTROL_FLOW_PATTERN.test(body)) return false;
  const statements = splitTopLevelStatements(body);
  if (statements.length === 0 || statements.length > 2) return false;
  return isForwardingCallStatement(statements[statements.length - 1]!);
}

const CONTROL_FLOW_PATTERN = /\b(?:if|else|for|while|switch|try|catch|do)\b/;
const FORWARDING_CALL_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^[\]]*\])*\((?:[^()]|\([^()]*\))*\)$/;

function isForwardingCallStatement(statement: string): boolean {
  const trimmed = statement
    .trim()
    .replace(/^return\s+/, '')
    .replace(/^await\s+/, '')
    .replace(/;\s*$/, '')
    .trim();
  return FORWARDING_CALL_PATTERN.test(trimmed);
}

/**
 * Split a statement block on top-level `;` (ignoring `;` nested inside
 * `()`/`[]`/`{}`). Exported so other detectors that need a body's top-level
 * statement shape (not-implemented's throw-stub check, decorative-checkers'
 * single-statement body check) reuse this instead of re-deriving the same
 * depth-tracked splitter.
 */
export function splitTopLevelStatements(body: string): string[] {
  const statements: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    if (char === ';' && depth === 0) {
      statements.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

const MAX_DELEGATION_CHAIN_HOPS = 3;

/**
 * Builds the real `isDelegatePair` predicate for `groupTwins`, backed by
 * source facts rather than the general call graph: the general call-graph
 * attribution path (`getCalleeRowsForSymbol`/`pickAstCallCandidate`) prefers
 * a same-file, same-leaf-name candidate over an imported one and treats that
 * as self-recursion — which is *always* true for this exact shape (every
 * member of a twin cluster has the same leaf name as its own file's
 * definition), so it silently reports zero callees for exactly the calls
 * this check needs to see. Instead, resolve directly: does `from`'s body
 * contain a call site whose leaf matches `to`'s leaf, and does `from`'s file
 * import (and, for namespace imports, actually use) a module that resolves
 * to `to`'s file (directly, or by chaining through other thin-forwarder
 * members of the same cluster)?
 */
function buildDelegationChecker(
  db: ScipDatabase,
): (from: TwinDriftRecord, to: TwinDriftRecord, clusterMembers: readonly TwinDriftRecord[]) => boolean {
  const cache = new Map<string, boolean>();
  return (from, to, clusterMembers) => {
    if (!from.isThinForwarder) return false;
    const key = `${from.symbol}\x00${to.symbol}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = reachesSameNameTarget(db, from, to, clusterMembers, MAX_DELEGATION_CHAIN_HOPS, new Set());
    cache.set(key, result);
    return result;
  };
}

function reachesSameNameTarget(
  db: ScipDatabase,
  from: TwinDriftRecord,
  to: TwinDriftRecord,
  clusterMembers: readonly TwinDriftRecord[],
  hopsLeft: number,
  visited: Set<string>,
): boolean {
  if (hopsLeft <= 0 || visited.has(from.symbol)) return false;
  visited.add(from.symbol);

  const sites = (getCallSites(db, from.file) ?? []).filter(
    (site) => site.line >= from.startLine && site.line <= from.endLine && site.calleeLeaf === to.leaf,
  );
  if (sites.length === 0) return false;

  const importedFiles = new Set(
    getSourceImports(db, from.file)
      .filter((entry) => entry.sourcePath && (entry.kind !== 'namespace' || entry.usedMembers.includes(to.leaf)))
      .map((entry) => entry.sourcePath!),
  );
  if ([...importedFiles].some((file) => pathsResolveSame(file, to.file))) return true;

  for (const mid of clusterMembers) {
    if (mid.symbol === from.symbol || mid.symbol === to.symbol || !mid.isThinForwarder) continue;
    if (![...importedFiles].some((file) => pathsResolveSame(file, mid.file))) continue;
    if (reachesSameNameTarget(db, mid, to, clusterMembers, hopsLeft - 1, visited)) return true;
  }
  return false;
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
