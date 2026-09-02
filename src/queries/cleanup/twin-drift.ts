import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { getAllDefinitions } from '../../symbols/definition-catalog.js';
import { isCallableSymbol, isRustTraitImplMember, shortenSymbol } from '../../symbols/symbol-parser.js';
import { getCallSites } from '../../source/facts/ast-facts.js';
import { getReExports, getSourceImports } from '../../language-parsers/index.js';
import { pathsResolveSame } from '../../domain/path-normalization.js';
import { classifyFile, isBarrel, isFrameworkEntrypointPath } from '../../analysis/file-classifier.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { stripCommentsAndStrings } from '../../source/primitives/source-stripper.js';
import { hasSuppressionCommentCategory } from '../../source/primitives/source-text.js';
import { scipFunctionLikeKindNumbers } from '../../symbols/symbol-kind.js';
import { applyScanLimit, definitionLoc } from '../query-utils.js';
import { definitionSourceSnippet, extractImplementationBody } from './duplicate-bodies.js';

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
  /**
   * For a thin forwarder, the leaf name of the one call its body makes; a
   * forwarder whose target has a different name than its own is a stub over
   * another concept (an HTTP client, an adapter), not a twin of it.
   */
  forwardTargetLeaf?: string | null;
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
 * Internal consumers that classify twin partners need 'identical'
 * groups too (a same-name pair that WAS byte-identical is exactly the kind
 * of pair a one-sided edit should alarm on).
 */
export function allTwinGroups(
  db: ScipDatabase,
  opts: { scope?: string; minSimilarity?: number; scanLimit?: number } = {},
): TwinGroup[] {
  const { scope, minSimilarity = 0.3, scanLimit } = opts;
  const records = twinDriftRecords(db, { scope, scanLimit });
  return groupTwins(records, { minSimilarity, isDelegatePair: buildDelegationChecker(db) }).filter(
    (group) =>
      !group.members.some((member) => hasSuppressionCommentCategory(db, member.file, member.startLine, 'twin')),
  );
}

/**
 * Pure grouping core: cluster records by (near-)leaf name, then classify
 * each cross-file cluster by its closest pair's body similarity.
 *   - every cross-file pair byte-identical after normalization -> 'identical' (defer to duplicate-bodies)
 *   - closest pair similarity in [minSimilarity, 1)                -> 'divergent' (the finding)
 *   - closest pair similarity < minSimilarity                      -> 'homonym' (coincidental name reuse)
 */
// scip-query: ignore-similar — candidate selection and group classification are separate detector stages.
export function groupTwins(
  records: readonly TwinDriftRecord[],
  opts: {
    minSimilarity?: number;
    /**
     * Injected so this stays a pure/DB-free function for `groupTwins`'s unit
     * tests: `isDelegatePair(from, to, clusterMembers)` answers "does `from`
     * call `to` (directly, or by chaining through same-leaf-name thin
     * forwarders found in `clusterMembers`)?" A member that calls its
     * same-name counterpart is a layer over it, not a parallel
     * implementation. `allTwinGroups` wires the real, source/import-backed
     * implementation via `buildDelegationChecker`.
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
      !isSyntheticLeaf(record.leaf) &&
      !isConventionOnlyTwinLeaf(record.leaf) &&
      !isConventionOnlyMemberTwin(record.symbol, record.leaf) &&
      !isFrameworkRouteConventionTwin(record.file, record.leaf) &&
      classifyFile(record.file) !== 'test' &&
      !isRustTraitImplMember(record.symbol) &&
      !isRustInlineTestSymbol(record.symbol) &&
      !isRustConventionOnlyTwin(record.symbol, record.leaf),
  );
  const { recordsByLeaf, recordOrder } = profileSpan(
    'twin-drift.group-by-leaf',
    () => indexTwinRecordsByLeaf(realRecords),
    () => ({ records: realRecords.length }),
  );
  const clusters = profileSpan(
    'twin-drift.cluster-leaf-names',
    () => clusterLeafNames([...recordsByLeaf.keys()]),
    () => ({ leaves: recordsByLeaf.size }),
  );

  const groups = profileSpan(
    'twin-drift.compare-clusters',
    () => {
      const output: TwinGroup[] = [];
      for (const cluster of clusters) {
        const clusterMembers = twinMembersForCluster(cluster, recordsByLeaf, recordOrder);
        // A member that calls another member of its cluster is a layer over it
        // (a facade method, a controller over its service), not a parallel
        // implementation of anything; it leaves the cluster before pairing so
        // it cannot pair with the near-name members either.
        const layered = new Set(
          clusterMembers
            .filter((member) =>
              clusterMembers.some(
                (other) =>
                  other !== member && other.file !== member.file && isDelegatePair?.(member, other, clusterMembers),
              ),
            )
            .map((member) => member.symbol),
        );
        const members = clusterMembers.filter((member) => !layered.has(member.symbol));
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
            if (isStubOverPeer(a, b) || isStubOverPeer(b, a)) continue;
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
          output.push({
            leaf: representativeLeaf(cluster),
            relationship: hasIdenticalPair ? 'identical' : 'homonym',
            maxDivergence: 0,
            members: sortedMembers,
          });
          continue;
        }

        const relationship: TwinRelationship = bestNonIdentical.similarity >= minSimilarity ? 'divergent' : 'homonym';
        output.push({
          leaf: representativeLeaf(cluster),
          relationship,
          maxDivergence: Math.round((1 - bestNonIdentical.similarity) * 1000) / 1000,
          members: sortedMembers,
          ...(relationship === 'divergent'
            ? { firstDivergentTokens: firstDivergentRun(bestNonIdentical.a.tokens, bestNonIdentical.b.tokens) }
            : {}),
        });
      }
      return output;
    },
    () => ({ clusters: clusters.length, records: realRecords.length }),
  );

  return groups.sort(
    (left, right) =>
      right.members.length - left.members.length ||
      right.maxDivergence - left.maxDivergence ||
      left.leaf.localeCompare(right.leaf),
  );
}

/**
 * Keeps twin groups from re-scanning every record for every leaf-name cluster.
 * The ordinal preserves the prior `records.filter(...)` traversal order when a
 * near-name cluster combines multiple leaf buckets.
 */
function indexTwinRecordsByLeaf(records: readonly TwinDriftRecord[]): {
  recordsByLeaf: Map<string, TwinDriftRecord[]>;
  recordOrder: Map<TwinDriftRecord, number>;
} {
  const recordsByLeaf = new Map<string, TwinDriftRecord[]>();
  const recordOrder = new Map<TwinDriftRecord, number>();
  for (const [index, record] of records.entries()) {
    const bucket = recordsByLeaf.get(record.leaf) ?? [];
    bucket.push(record);
    recordsByLeaf.set(record.leaf, bucket);
    recordOrder.set(record, index);
  }
  return { recordsByLeaf, recordOrder };
}

function twinMembersForCluster(
  cluster: ReadonlySet<string>,
  recordsByLeaf: ReadonlyMap<string, readonly TwinDriftRecord[]>,
  recordOrder: ReadonlyMap<TwinDriftRecord, number>,
): TwinDriftRecord[] {
  const members = [...cluster].flatMap((leaf) => recordsByLeaf.get(leaf) ?? []);
  if (cluster.size > 1) {
    members.sort((left, right) => (recordOrder.get(left) ?? 0) - (recordOrder.get(right) ?? 0));
  }
  return members;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function twinDriftRecords(db: ScipDatabase, opts: { scope?: string; scanLimit?: number }): TwinDriftRecord[] {
  const definitions = profileSpan('twin-drift.load-definitions', () =>
    getAllDefinitions(db, { scope: opts.scope })
      .filter((definition) => isTwinCallableDefinition(definition) && !db.isIgnored(definition.relativePath))
      .filter((definition) => !isBarrel(definition.relativePath)),
  );

  profileSpan(
    'twin-drift.sort-definitions',
    () =>
      definitions.sort(
        (left, right) => left.relativePath.localeCompare(right.relativePath) || left.startLine - right.startLine,
      ),
    () => ({ definitions: definitions.length }),
  );
  const scanned = applyScanLimit(definitions, opts.scanLimit);
  const candidates = profileSpan(
    'twin-drift.select-candidates',
    () => twinDriftCandidateDefinitions(scanned),
    () => ({ scanned: scanned.length }),
  );

  return profileSpan(
    'twin-drift.build-records',
    () => {
      const records: TwinDriftRecord[] = [];
      for (const definition of candidates) {
        const record = twinDriftRecord(db, definition);
        if (record) records.push(record);
      }
      return records;
    },
    () => ({ candidates: candidates.length, scanned: scanned.length }),
  );
}

function isTwinCallableDefinition(definition: IndexedDefinition): boolean {
  if (!definition.isFunctionLike) return false;
  if (!definition.symbol.startsWith('rust-analyzer ')) return true;
  return typeof definition.kind === 'number' && SCIP_FUNCTION_LIKE_KINDS.has(definition.kind);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function twinDriftCandidateDefinitions(definitions: readonly IndexedDefinition[]): IndexedDefinition[] {
  const realDefinitions = definitions.filter(
    (definition) =>
      definition.leaf &&
      !isSyntheticLeaf(definition.leaf) &&
      !isConventionOnlyMemberTwin(definition.symbol, definition.leaf) &&
      !isFrameworkRouteConventionTwin(definition.relativePath, definition.leaf) &&
      !isRustTraitImplMember(definition.symbol) &&
      !isRustInlineTestSymbol(definition.symbol) &&
      !isRustConventionOnlyTwin(definition.symbol, definition.leaf),
  );
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function twinDriftRecord(db: ScipDatabase, definition: IndexedDefinition): TwinDriftRecord | null {
  if (!definition.leaf) return null;
  const snippet = definitionSourceSnippet(db, definition);
  if (!snippet) return null;
  if (!isCallableSymbol(definition.symbol) && !isTopLevelArrowFunctionSnippet(snippet, definition.leaf)) return null;
  // An abstract member and its overrides are one polymorphic contract; their
  // bodies differ by design.
  if (isAbstractOrOverrideDeclaration(snippet, definition.leaf)) return null;
  const strippedBody = stripCommentsAndStrings(extractImplementationBody(snippet));
  const normalizedBody = strippedBody.replace(/\s+/g, '');
  if (!normalizedBody || normalizedBody.length < 8) return null;
  const tokens = strippedBody.match(TOKEN_PATTERN) ?? [];
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
    isThinForwarder: isThinForwarderStrippedBody(strippedBody),
    forwardTargetLeaf: thinForwardTargetLeaf(strippedBody),
  };
}

function isAbstractOrOverrideDeclaration(snippet: string, leaf: string): boolean {
  const escapedLeaf = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = snippet.split('\n').slice(0, 2).join('\n');
  return new RegExp(`\\b(?:abstract|override)\\b[^\\n]*\\b${escapedLeaf}\\s*[(<]`).test(declaration);
}

/** The leaf of the single call a thin forwarder makes, or null for any other body. */
function thinForwardTargetLeaf(strippedBody: string): string | null {
  if (!isThinForwarderStrippedBody(strippedBody)) return null;
  const statements = splitTopLevelStatements(strippedBody.trim());
  const last = forwardingCallText(statements[statements.length - 1]!);
  const target = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/.exec(last)?.[1];
  if (!target) return null;
  return target.split('.').pop() ?? null;
}

/**
 * `stub` forwards its arguments to one call whose name is neither its own nor
 * `peer`'s (a web client calling `apiClient.patchData`, an adapter calling a
 * vendor function) while `peer` has a body of its own: the stub reaches the
 * peer's concept through a boundary rather than reimplementing it.
 */
function isStubOverPeer(stub: TwinDriftRecord, peer: TwinDriftRecord): boolean {
  const target = stub.forwardTargetLeaf;
  return typeof target === 'string' && target !== stub.leaf && target !== peer.leaf && !peer.isThinForwarder;
}

function isTopLevelArrowFunctionSnippet(snippet: string, leaf: string): boolean {
  const escapedLeaf = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b(?:const|let|var)\\s+${escapedLeaf}(?:\\s*:[^=]+)?\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`,
    's',
  ).test(snippet);
}

const TOKEN_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g;

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

  // `areNearNames` requires an 80% common prefix for names long enough to be
  // near-name candidates. Two leading lowercase characters are therefore a
  // safe bucket: any accepted pair shares them. Exact short-name matches also
  // share the same two-character prefix (or the whole shorter name).
  const byPrefix = new Map<string, string[]>();
  for (const leaf of leaves) {
    const key = leaf.slice(0, 2).toLowerCase();
    const bucket = byPrefix.get(key) ?? [];
    bucket.push(leaf);
    byPrefix.set(key, bucket);
  }

  for (const bucket of byPrefix.values()) {
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
  // `requireUser` and `requireUserId`: the longer name appends a whole
  // capitalized word, which names a different thing (an id, a list, a count)
  // rather than misspelling the same one (`escapeRegex` / `escapeRegExp`).
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length > shorter.length && longer.startsWith(shorter) && /^[A-Z]/.test(longer.slice(shorter.length))) {
    return false;
  }
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
  return (
    /^[A-Z][A-Z0-9_]*$/.test(leaf) || /^__[^_].*__$/.test(leaf) || CONVENTION_ONLY_TWIN_LEAVES.has(leaf.toLowerCase())
  );
}

const CONVENTION_ONLY_TWIN_LEAVES = new Set(['main', 'row']);

/**
 * Method names that an object-oriented convention hands to every class of a
 * kind: CRUD verbs on services and repositories, lifecycle verbs on anything
 * with a lifecycle. `ChatService.delete` and `IssueService.delete` share a
 * name because both are services, not because they implement one concept,
 * so a same-name cluster of such members carries no drift signal. Applied
 * only to members declared directly on a type; free functions keep the
 * ordinary near-name rules.
 */
const CONVENTION_ONLY_MEMBER_LEAVES = new Set([
  'close',
  'connect',
  'count',
  'create',
  'delete',
  'destroy',
  'disconnect',
  'dispose',
  'execute',
  'exists',
  'find',
  'findAll',
  'findById',
  'findOne',
  'get',
  'getAll',
  'getById',
  'handle',
  'init',
  'initialize',
  'list',
  'load',
  'open',
  'patch',
  'process',
  'read',
  'remove',
  'reset',
  'run',
  'save',
  'shutdown',
  'start',
  'stop',
  'toJSON',
  'toString',
  'update',
  'upsert',
]);
const TYPE_MEMBER_SYMBOL = /#(?:`[^`]+`|[^#/`]+)\(\)\.$/;

/** `getBySlug`, `findByEmail`, `listForOrganization`: a lookup verb qualified by a key is a repository convention, not a concept. */
const CONVENTION_MEMBER_LOOKUP_PATTERN =
  /^(?:get|find|list|load|fetch|count|delete|remove|update|upsert)(?:By|For)[A-Z]\w*$/;

function isConventionOnlyMemberTwin(symbol: string, leaf: string): boolean {
  return (
    (CONVENTION_ONLY_MEMBER_LEAVES.has(leaf) || CONVENTION_MEMBER_LOOKUP_PATTERN.test(leaf)) &&
    TYPE_MEMBER_SYMBOL.test(symbol)
  );
}

/**
 * Names a file-system router or its per-route glue dictates: every Next.js
 * `route.ts` exports the HTTP verbs and, by project convention, names its
 * per-method implementation `handler`/`handleGet`/`postHandler`; every
 * `page.tsx` exports a `*Page` default and `generateMetadata`. Two routes
 * sharing such a name implement different endpoints by construction, so the
 * name carries no concept identity. Only applied inside framework entry
 * files, where the convention is the reason the name exists.
 */
const FRAMEWORK_ROUTE_CONVENTION_LEAF =
  /^(?:handler|handle(?:Get|Post|Put|Patch|Delete|Options|Head|Request)|(?:get|post|put|patch|delete|options|head|route|request)Handler|generateMetadata|generateStaticParams|generateViewport|generateSitemaps|loader|action|clientLoader|clientAction|middleware|config|default|load|actions|[A-Z][A-Za-z0-9]*(?:Page|Layout|Loading|Template|Route|Screen))$/;

function isFrameworkRouteConventionTwin(file: string, leaf: string): boolean {
  return FRAMEWORK_ROUTE_CONVENTION_LEAF.test(leaf) && isFrameworkEntrypointPath(file.replace(/\\/g, '/'));
}

const GENERIC_CONTEXT_SEGMENTS = new Set([
  'app',
  'component',
  'components',
  'feature',
  'features',
  'impl',
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

function isRustInlineTestSymbol(symbol: string): boolean {
  return symbol.startsWith('rust-analyzer ') && /\/(?:tests?|benches?)\//.test(symbol);
}

const RUST_CONVENTION_ONLY_TWIN_LEAVES = new Set(['default', 'new', 'reset']);

function isRustConventionOnlyTwin(symbol: string, leaf: string): boolean {
  return symbol.startsWith('rust-analyzer ') && RUST_CONVENTION_ONLY_TWIN_LEAVES.has(leaf.toLowerCase());
}

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
  return isThinForwarderStrippedBody(stripCommentsAndStrings(extractImplementationBody(rawSnippet)));
}

/**
 * Stricter than `isThinForwarderBody`: exactly one statement, that statement
 * is one call (optionally returned or awaited), and its arguments are plain
 * values — identifiers, member paths, literals, `??`/`||` defaults, spreads.
 * A preparatory statement, a callback, a nested call, or an array/object
 * literal the body builds makes the callable a helper rather than the
 * "inline this into its only consumer" shape the wrapper claim describes.
 */
export function isSingleForwardingCallBody(rawSnippet: string): boolean {
  const body = stripCommentsAndStrings(extractImplementationBody(rawSnippet)).trim();
  if (!body || CONTROL_FLOW_PATTERN.test(body)) return false;
  const statements = splitTopLevelStatements(body);
  if (statements.length !== 1) return false;
  const statement = forwardingCallText(statements[0]!);
  const match = SINGLE_FORWARDING_CALL_PATTERN.exec(statement);
  if (!match) return false;
  const args = match[1]!.replace(/\[\s*\]|\{\s*\}/g, '');
  return !COMPUTED_ARGUMENT_PATTERN.test(args);
}

const SINGLE_FORWARDING_CALL_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^[\]]*\])*\(([\s\S]*)\)$/;
const COMPUTED_ARGUMENT_PATTERN = /[()[\]{}]|=>|\b(?:await|new|function)\b/;

function isThinForwarderStrippedBody(strippedBody: string): boolean {
  const body = strippedBody.trim();
  if (!body) return false;
  if (CONTROL_FLOW_PATTERN.test(body)) return false;
  const statements = splitTopLevelStatements(body);
  if (statements.length === 0 || statements.length > 2) return false;
  return isForwardingCallStatement(statements[statements.length - 1]!);
}

const CONTROL_FLOW_PATTERN = /\b(?:if|else|for|while|switch|try|catch|do)\b/;
const FORWARDING_CALL_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^[\]]*\])*\((?:[^()]|\([^()]*\))*\)$/;

function isForwardingCallStatement(statement: string): boolean {
  return FORWARDING_CALL_PATTERN.test(forwardingCallText(statement));
}

/** The call text of a statement with `return`, `await`, the trailing semicolon, and the call's type arguments removed. */
function forwardingCallText(statement: string): string {
  return withoutCallTypeArguments(
    statement
      .trim()
      .replace(/^return\s+/, '')
      .replace(/^await\s+/, '')
      .replace(/;\s*$/, '')
      .trim(),
  );
}

/** `client.getData<Response<{ ok: true }>>(x)` -> `client.getData(x)`: type arguments are not arguments. */
function withoutCallTypeArguments(call: string): string {
  const open = call.indexOf('<');
  if (open < 0 || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(call.slice(0, open))) return call;
  let depth = 0;
  for (let index = open; index < call.length; index += 1) {
    const char = call[index];
    if (char === '<') depth += 1;
    else if (char === '>') {
      depth -= 1;
      if (depth === 0) return call[index + 1] === '(' ? call.slice(0, open) + call.slice(index + 1) : call;
    }
  }
  return call;
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

  const imports = getSourceImports(db, from.file);
  // `import { x as y }` lets the caller reach the target under a local alias;
  // the call-site leaf is then the alias, not the target's own name. Once an
  // alias exists, a bare `x(...)` inside `from` names `from`'s own file (its
  // own recursion or a same-file sibling), so only the alias counts.
  const targetLocalNames = new Set<string>();
  for (const entry of imports) {
    if (entry.importedName === to.leaf && entry.localName && entry.localName !== to.leaf) {
      targetLocalNames.add(entry.localName);
    }
  }
  if (targetLocalNames.size === 0) targetLocalNames.add(to.leaf);
  const sites = (getCallSites(db, from.file) ?? []).filter(
    (site) => site.line >= from.startLine && site.line <= from.endLine && targetLocalNames.has(site.calleeLeaf),
  );
  if (sites.length === 0) return false;
  // `issueOrderingService.updateBoardOrder(...)` where the receiver is an
  // imported binding: the receiver's own module imports the target's file
  // (a capabilities hub instantiating services), one hop beyond the barrel.
  for (const site of sites) {
    if (!site.calleeQualifier) continue;
    const receiverImport = imports.find((entry) => entry.localName === site.calleeQualifier && entry.sourcePath);
    if (!receiverImport?.sourcePath) continue;
    if (pathsResolveSame(receiverImport.sourcePath, to.file)) return true;
    for (const hop of getSourceImports(db, receiverImport.sourcePath)) {
      if (hop.sourcePath && pathsResolveSame(hop.sourcePath, to.file)) return true;
    }
  }

  const importedFiles = new Set(
    imports
      .filter((entry) => entry.sourcePath && (entry.kind !== 'namespace' || entry.usedMembers.includes(to.leaf)))
      .map((entry) => entry.sourcePath!),
  );
  // `import { recorder } from './runtime-settings.js'` where runtime-settings
  // re-exports the recorder: the target's file sits one re-export away.
  for (const file of [...importedFiles]) {
    for (const reExport of getReExports(db, file)) {
      if (reExport.sourcePath) importedFiles.add(reExport.sourcePath);
    }
  }
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
