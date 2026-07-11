import { createHash } from 'node:crypto';
import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { getAllDefinitions } from '../../symbols/definition-catalog.js';
import { getSourceLines } from '../../source/source-text.js';
import { stripCommentsAndStrings } from '../../source/source-stripper.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { getFileAddRecords } from '../../analysis/git-history.js';
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

type DuplicateBodyEntryWithBody = DuplicateBodyEntry & { normalizedBody: string };

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
  const { scope, maxLoc = 15, minLoc = DEFAULT_MIN_BODY_LOC, limit, scanLimit } = opts;
  const ages = getFileAddRecords(db);
  const entries = duplicateBodyCandidates(db, { scope, maxLoc, scanLimit })
    .map((definition) => duplicateBodyEntry(db, definition, ages, minLoc))
    .filter((entry): entry is DuplicateBodyEntryWithBody => entry !== null);
  const groups = groupByHash(entries);
  return limit ? groups.slice(0, limit) : groups;
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
  const body = extractImplementationBody(source);
  return stripCommentsAndStrings(body).replace(/\s+/g, '');
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
    .filter((definition) => definitionLoc(definition) <= opts.maxLoc);

  definitions.sort(
    (left, right) => definitionLoc(right) - definitionLoc(left) || left.relativePath.localeCompare(right.relativePath),
  );
  return applyScanLimit(definitions, opts.scanLimit);
}

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
export function definitionSourceSnippet(db: ScipDatabase, definition: IndexedDefinition): string | null {
  const lines = getSourceLines(db, definition.relativePath);
  if (lines.length === 0) return null;
  return lines.slice(definition.startLine, definition.endLine + 1).join('\n');
}

/**
 * Isolate a callable's implementation body (brace-delimited block, or the
 * expression after `=>`) from its raw source snippet. Exported so other
 * detectors comparing bodies (twin-drift) reuse this instead of
 * re-implementing body extraction — that duplication is exactly the "twin
 * drift" defect class this file's sibling detector hunts.
 */
export function extractImplementationBody(source: string): string {
  const firstBrace = source.indexOf('{');
  const lastBrace = source.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return source.slice(firstBrace + 1, lastBrace);
  }
  const arrow = source.indexOf('=>');
  if (arrow >= 0) {
    return source.slice(arrow + 2).replace(/;+\s*$/, '');
  }
  return source;
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
