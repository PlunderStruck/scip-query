/**
 * Committed outcome-event ledger: .scipquery/ledger/events.jsonl in the
 * target repo, one JSON event per line, append-only.
 *
 * This is the durable, team-shared complement to the per-machine
 * finding_outcome_ledger in evidence.db (src/storage/evidence-cache.ts).
 * evidence.db answers "what has this machine seen"; the event ledger
 * answers "what happened to findings in this repository over time" — it
 * survives re-clones and aggregates across machines because it merges:
 *
 *   - append-only JSONL + a scoped .gitattributes `merge=union` entry means
 *     concurrent branch appends never conflict;
 *   - events are idempotent facts keyed by (check, findingId, event, commit),
 *     so duplicated or reordered lines are absorbed by read-side dedupe.
 *
 * Nothing here decides outcomes — deriveOutcomeEvents() is a pure diff of
 * two ledger snapshots produced by recordFindingOutcomes()
 * (src/queries/health/finding-outcome-ledger.ts). Write failures must never
 * break a gate run; callers wrap appendOutcomeEvents in try/catch.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerKey } from '../queries/health/finding-outcome-ledger.js';
import type { FindingOutcomeRecord } from '../queries/health/finding-outcome-ledger.js';
import { runGit } from '../analysis/git-history.js';

export const LEDGER_DIR = join('.scipquery', 'ledger');
export const LEDGER_FILENAME = 'events.jsonl';

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

export function ledgerDirPath(projectRoot: string): string {
  return join(projectRoot, LEDGER_DIR);
}

export function ledgerFilePath(projectRoot: string): string {
  return join(ledgerDirPath(projectRoot), LEDGER_FILENAME);
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
 * Append events as one JSON object per line. Creates the ledger directory
 * and its scoped .gitattributes (merge=union) on first write so the file
 * is conflict-free from the first commit that contains it.
 */
export function appendOutcomeEvents(projectRoot: string, events: readonly OutcomeEvent[]): void {
  if (events.length === 0) return;
  const dir = ledgerDirPath(projectRoot);
  mkdirSync(dir, { recursive: true });
  ensureLedgerGitattributes(dir);
  const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  appendFileSync(ledgerFilePath(projectRoot), lines);
}

/**
 * Scoped merge driver: `.scipquery/ledger/.gitattributes` marks the events
 * file merge=union so concurrent appends from different branches combine
 * instead of conflicting. Idempotent.
 */
export function ensureLedgerGitattributes(ledgerDir: string): void {
  const path = join(ledgerDir, '.gitattributes');
  const entry = `${LEDGER_FILENAME} merge=union\n`;
  if (!existsSync(path)) {
    writeFileSync(path, entry);
    return;
  }
  const current = readFileSync(path, 'utf-8');
  if (!current.includes(`${LEDGER_FILENAME} merge=union`)) {
    writeFileSync(path, current + (current.endsWith('\n') || current === '' ? '' : '\n') + entry);
  }
}

/**
 * Read the committed event log. Malformed lines are skipped (a union merge
 * can in principle interleave partial writes); duplicates from replayed or
 * merged histories are collapsed to the earliest observation.
 */
export function readOutcomeEvents(projectRoot: string): OutcomeEvent[] {
  const path = ledgerFilePath(projectRoot);
  if (!existsSync(path)) return [];
  const events: OutcomeEvent[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isOutcomeEvent(parsed)) continue;
    events.push(parsed);
  }
  return dedupeEvents(events);
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
