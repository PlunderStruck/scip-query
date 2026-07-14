/**
 * Committed outcome-event ledger: one immutable JSON file per observation
 * under .scipquery/events/ in the target repo.
 *
 * This is the durable, team-shared complement to the per-machine
 * finding_outcome_ledger in evidence.db (src/storage/evidence-cache.ts).
 * evidence.db answers "what has this machine seen"; the event ledger
 * answers "what happened to findings in this repository over time" — it
 * survives re-clones and aggregates across machines because:
 *
 *   - independent observations create independent paths, so concurrent
 *     branches do not edit a shared file;
 *   - events are idempotent facts keyed by (check, findingId, event, commit),
 *     so duplicated or reordered files are absorbed by read-side dedupe.
 *
 * Nothing here decides outcomes — deriveOutcomeEvents() is a pure diff of
 * two ledger snapshots produced by recordFindingOutcomes()
 * (src/queries/health/finding-outcome-ledger.ts). Write failures must never
 * break a gate run; callers wrap appendOutcomeEvents in try/catch.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerKey } from '../queries/health/finding-outcome-ledger.js';
import type { FindingOutcomeRecord } from '../queries/health/finding-outcome-ledger.js';
import { runGit } from '../analysis/git-history.js';

export const OUTCOME_EVENTS_DIR = join('.scipquery', 'events');
const LEGACY_LEDGER_DIR = join('.scipquery', 'ledger');
const LEGACY_LEDGER_FILENAME = 'events.jsonl';

export type OutcomeEventKind = 'caught' | 'resolved' | 'suppressed' | 'reopened';

export interface OutcomeEvent {
  /** Wall-clock ms when the transition was observed. */
  ts: number;
  check: string;
  findingId: string;
  event: OutcomeEventKind;
  /** HEAD commit at observation time; null when git is unavailable. */
  commit: string | null;
  /** SCIP symbol of the finding when known — enables rename ("moved") reclassification at query time. */
  symbol?: string;
}

function legacyLedgerDirPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_LEDGER_DIR);
}

function legacyLedgerFilePath(projectRoot: string): string {
  return join(legacyLedgerDirPath(projectRoot), LEGACY_LEDGER_FILENAME);
}

/**
 * Pure transition diff: compare the ledger before and after one gate run
 * and emit the events that describe what changed.
 *
 *   new record                       -> caught (+ suppressed when it arrives suppressed)
 *   still-open|suppressed -> resolved -> resolved
 *   still-open -> suppressed          -> suppressed
 *   resolved|suppressed -> still-open -> reopened
 */
export function deriveOutcomeEvents(
  previous: readonly FindingOutcomeRecord[],
  next: readonly FindingOutcomeRecord[],
  symbolByFindingId: ReadonlyMap<string, string>,
  commit: string | null,
  now: number,
): OutcomeEvent[] {
  const prevByKey = new Map(previous.map((record) => [ledgerKey(record.check, record.findingId), record]));
  const events: OutcomeEvent[] = [];

  const push = (record: FindingOutcomeRecord, event: OutcomeEventKind) => {
    const symbol = symbolByFindingId.get(record.findingId);
    events.push({
      ts: now,
      check: record.check,
      findingId: record.findingId,
      event,
      commit,
      ...(symbol ? { symbol } : {}),
    });
  };

  for (const record of next) {
    const before = prevByKey.get(ledgerKey(record.check, record.findingId));
    if (!before) {
      push(record, 'caught');
      if (record.outcome === 'suppressed') push(record, 'suppressed');
      continue;
    }
    if (before.outcome === record.outcome) continue;
    if (record.outcome === 'resolved') push(record, 'resolved');
    else if (record.outcome === 'suppressed') push(record, 'suppressed');
    else if (record.outcome === 'still-open') push(record, 'reopened');
  }

  return events;
}

/** HEAD commit sha for stamping events; null when the project is not a usable git repo. */
export function headCommit(projectRoot: string): string | null {
  try {
    const sha = runGit(projectRoot, ['rev-parse', 'HEAD']).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Add events as independent JSON files. When a legacy JSONL ledger exists,
 * migrate its valid records before removing the shared file and merge rule.
 */
export function appendOutcomeEvents(projectRoot: string, events: readonly OutcomeEvent[]): void {
  const legacyPath = legacyLedgerFilePath(projectRoot);
  const hasLegacyLedger = existsSync(legacyPath);
  const pending = [...(hasLegacyLedger ? readLegacyOutcomeEvents(legacyPath) : []), ...events];

  if (pending.length > 0) {
    const dir = join(projectRoot, OUTCOME_EVENTS_DIR);
    mkdirSync(dir, { recursive: true });
    for (const event of pending) writeOutcomeEvent(dir, event);
  }

  if (hasLegacyLedger) removeLegacyLedger(projectRoot);
}

function writeOutcomeEvent(dir: string, event: OutcomeEvent): void {
  const contents = `${JSON.stringify(
    {
      ts: event.ts,
      check: event.check,
      findingId: event.findingId,
      event: event.event,
      commit: event.commit,
      ...(event.symbol ? { symbol: event.symbol } : {}),
    },
    null,
    2,
  )}\n`;
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16).toUpperCase();
  const path = join(dir, `${event.ts}-${hash}.json`);
  try {
    writeFileSync(path, contents, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readFileSync(path, 'utf-8') !== contents) {
      throw new Error(`outcome event filename collision: ${path}`, { cause: error });
    }
  }
}

function removeLegacyLedger(projectRoot: string): void {
  rmSync(legacyLedgerFilePath(projectRoot));

  const attributesPath = join(legacyLedgerDirPath(projectRoot), '.gitattributes');
  if (!existsSync(attributesPath)) return;
  const remaining = readFileSync(attributesPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== `${LEGACY_LEDGER_FILENAME} merge=union`)
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  if (remaining === '') {
    rmSync(attributesPath);
  } else {
    writeFileSync(attributesPath, `${remaining}\n`);
  }
}

/**
 * Read committed event files plus a legacy JSONL ledger during migration.
 * Malformed records are skipped; duplicates from replayed or merged histories
 * are collapsed to the earliest observation.
 */
export function readOutcomeEvents(projectRoot: string): OutcomeEvent[] {
  const events: OutcomeEvent[] = [];

  const dir = join(projectRoot, OUTCOME_EVENTS_DIR);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.json')) continue;
      const event = parseOutcomeEvent(readFileSync(join(dir, entry), 'utf-8'));
      if (event) events.push(event);
    }
  }

  const legacyPath = legacyLedgerFilePath(projectRoot);
  if (existsSync(legacyPath)) events.push(...readLegacyOutcomeEvents(legacyPath));
  return dedupeEvents(events);
}

function readLegacyOutcomeEvents(path: string): OutcomeEvent[] {
  const events: OutcomeEvent[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const event = parseOutcomeEvent(line);
    if (event) events.push(event);
  }
  return events;
}

function parseOutcomeEvent(contents: string): OutcomeEvent | null {
  if (contents.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  return isOutcomeEvent(parsed) ? parsed : null;
}

/** Collapse duplicate (check, findingId, event, commit) facts to the earliest ts, preserving time order. */
export function dedupeEvents(events: readonly OutcomeEvent[]): OutcomeEvent[] {
  const byKey = new Map<string, OutcomeEvent>();
  for (const event of events) {
    const key = `${event.check}\0${event.findingId}\0${event.event}\0${event.commit ?? ''}`;
    const existing = byKey.get(key);
    if (!existing || event.ts < existing.ts) byKey.set(key, event);
  }
  return [...byKey.values()].sort((left, right) => left.ts - right.ts);
}

const EVENT_KINDS: readonly OutcomeEventKind[] = ['caught', 'resolved', 'suppressed', 'reopened'];

function isOutcomeEvent(value: unknown): value is OutcomeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['ts'] === 'number' &&
    typeof candidate['check'] === 'string' &&
    typeof candidate['findingId'] === 'string' &&
    EVENT_KINDS.includes(candidate['event'] as OutcomeEventKind) &&
    (candidate['commit'] === null || typeof candidate['commit'] === 'string') &&
    (candidate['symbol'] === undefined || typeof candidate['symbol'] === 'string')
  );
}
