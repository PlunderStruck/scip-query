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
 * Outcome meaning and transition rules live in src/domain/finding-outcomes.ts.
 * Write failures must never break a gate run; callers wrap
 * appendOutcomeEvents in try/catch.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OutcomeEvent } from '../domain/finding-outcomes.js';
import { readProfileArtifactText, readSmallArtifactText } from '../filesystem/bounded-file.js';
import {
  createOutcomeEventRecord,
  decodeOutcomeEventRecord,
  outcomeEventIdentity,
} from '../domain/outcome-event-record.js';
import {
  summarizeRecordCompatibility,
  type RecordCompatibilityObservation,
  type RecordCompatibilitySummary,
} from '../domain/record-compatibility.js';

export type { OutcomeEvent } from '../domain/finding-outcomes.js';

export const OUTCOME_EVENTS_DIR = join('.scipquery', 'events');
const LEGACY_LEDGER_DIR = join('.scipquery', 'ledger');
const LEGACY_LEDGER_FILENAME = 'events.jsonl';

// scip-query: ignore-stale -- Read result keeps events, compatibility evidence, and warnings inseparable.
export interface OutcomeEventReadResult {
  events: OutcomeEvent[];
  compatibility: RecordCompatibilitySummary;
  warnings: string[];
}

export interface AppendOutcomeEventOptions {
  toolVersion: string;
}

export interface AppendOutcomeEventsResult {
  warning?: string;
}

interface OutcomeEventCandidateRead extends OutcomeEventReadResult {
  observations: RecordCompatibilityObservation[];
}

function legacyLedgerDirPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_LEDGER_DIR);
}

function legacyLedgerFilePath(projectRoot: string): string {
  return join(legacyLedgerDirPath(projectRoot), LEGACY_LEDGER_FILENAME);
}

/**
 * Add events as independent JSON files. When a legacy JSONL ledger exists,
 * migrate its compatible records. The shared source is removed only when
 * every non-empty line was understood; otherwise accepted rows are copied
 * idempotently and the incompatible source bytes remain for a newer reader.
 */
export function appendOutcomeEvents(
  projectRoot: string,
  events: readonly OutcomeEvent[],
  options: AppendOutcomeEventOptions,
): AppendOutcomeEventsResult {
  const legacyPath = legacyLedgerFilePath(projectRoot);
  const hasLegacyLedger = existsSync(legacyPath);
  const legacy = hasLegacyLedger ? readLegacyOutcomeEvents(legacyPath) : emptyOutcomeEventCandidateRead();
  const pending = [...legacy.events, ...events];

  if (pending.length > 0) {
    const dir = join(projectRoot, OUTCOME_EVENTS_DIR);
    mkdirSync(dir, { recursive: true });
    for (const event of pending) writeOutcomeEvent(dir, event, options.toolVersion);
  }

  if (hasLegacyLedger && legacy.compatibility.complete) {
    removeLegacyLedger(projectRoot);
  } else if (hasLegacyLedger) {
    return {
      warning: `legacy outcome ledger preserved because ${legacy.compatibility.omitted} of ${legacy.compatibility.total} non-empty record(s) are incompatible: ${legacy.warnings.join('; ')}`,
    };
  }
  return {};
}

function writeOutcomeEvent(dir: string, event: OutcomeEvent, toolVersion: string): void {
  const contents = `${JSON.stringify(createOutcomeEventRecord(event, toolVersion), null, 2)}\n`;
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16).toUpperCase();
  const path = join(dir, `${event.ts}-${hash}.json`);
  try {
    writeFileSync(path, contents, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readSmallArtifactText(path, 'outcome event record') !== contents) {
      throw new Error(`outcome event filename collision: ${path}`, { cause: error });
    }
  }
}

function removeLegacyLedger(projectRoot: string): void {
  rmSync(legacyLedgerFilePath(projectRoot));

  const attributesPath = join(legacyLedgerDirPath(projectRoot), '.gitattributes');
  if (!existsSync(attributesPath)) return;
  const remaining = readSmallArtifactText(attributesPath, 'outcome event attributes')
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
 * Every candidate is classified before accepted duplicates are collapsed.
 */
export function readOutcomeEvents(projectRoot: string): OutcomeEventReadResult {
  const events: OutcomeEvent[] = [];
  const observations: RecordCompatibilityObservation[] = [];

  const dir = join(projectRoot, OUTCOME_EVENTS_DIR);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.json')) continue;
      const path = `${OUTCOME_EVENTS_DIR}/${entry}`;
      const decoded = parseOutcomeEventRecord(readSmallArtifactText(join(dir, entry), 'outcome event record'));
      observations.push({
        path,
        state: decoded.state,
        ...('error' in decoded ? { reason: decoded.error } : {}),
      });
      if ('event' in decoded) events.push(decoded.event);
    }
  }

  const legacyPath = legacyLedgerFilePath(projectRoot);
  if (existsSync(legacyPath)) {
    const legacy = readLegacyOutcomeEvents(legacyPath);
    events.push(...legacy.events);
    observations.push(...legacy.observations);
  }
  return outcomeEventReadResult(events, observations);
}

function readLegacyOutcomeEvents(path: string): OutcomeEventCandidateRead {
  const events: OutcomeEvent[] = [];
  const observations: RecordCompatibilityObservation[] = [];
  const recordPath = `${LEGACY_LEDGER_DIR}/${LEGACY_LEDGER_FILENAME}`;
  for (const [index, line] of readProfileArtifactText(path, 'legacy outcome-event ledger').split('\n').entries()) {
    if (line.trim() === '') continue;
    const decoded = parseOutcomeEventRecord(line);
    observations.push({
      path: `${recordPath}:${index + 1}`,
      state: decoded.state,
      ...('error' in decoded ? { reason: decoded.error } : {}),
    });
    if ('event' in decoded) events.push(decoded.event);
  }
  return { ...outcomeEventReadResult(events, observations), observations };
}

function parseOutcomeEventRecord(contents: string): ReturnType<typeof decodeOutcomeEventRecord> {
  if (contents.trim() === '') return { state: 'malformed', error: 'empty record' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { state: 'malformed', error: 'malformed JSON' };
  }
  return decodeOutcomeEventRecord(parsed);
}

/** Collapse duplicate (check, findingId, event, commit) facts to the earliest ts, preserving time order. */
export function dedupeEvents(events: readonly OutcomeEvent[]): OutcomeEvent[] {
  const byKey = new Map<string, OutcomeEvent>();
  for (const event of events) {
    const key = outcomeEventIdentity(event);
    const existing = byKey.get(key);
    if (
      !existing ||
      eventEvidenceScore(event) > eventEvidenceScore(existing) ||
      (eventEvidenceScore(event) === eventEvidenceScore(existing) && event.ts < existing.ts)
    ) {
      byKey.set(key, event);
    }
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.ts - right.ts ||
      left.check.localeCompare(right.check) ||
      left.findingId.localeCompare(right.findingId) ||
      outcomeTransitionOrder(left.event) - outcomeTransitionOrder(right.event),
  );
}

function eventEvidenceScore(event: OutcomeEvent): number {
  return (
    Number(event.verifiedAgainstCommit !== undefined) * 64 +
    Number(event.comparisonBaseCommit !== undefined) * 32 +
    Number(event.observer?.authority === 'protected-external') * 16 +
    Number(event.observer !== undefined) * 8 +
    Number(event.observation !== undefined) * 4 +
    Number(event.gateRunId !== undefined) * 2 +
    Number(event.suppressionPolicyVersion !== undefined)
  );
}

function outcomeTransitionOrder(event: OutcomeEvent['event']): number {
  if (event === 'caught') return 0;
  if (event === 'resolved') return 1;
  if (event === 'suppressed') return 2;
  return 3;
}

function outcomeEventReadResult(
  events: readonly OutcomeEvent[],
  observations: readonly RecordCompatibilityObservation[],
): OutcomeEventReadResult {
  const compatibility = summarizeRecordCompatibility(observations);
  return {
    events: dedupeEvents(events),
    compatibility,
    warnings: compatibility.issues.map((issue) => `${issue.path}: ${issue.reason} — ignored`),
  };
}

function emptyOutcomeEventCandidateRead(): OutcomeEventCandidateRead {
  return { ...outcomeEventReadResult([], []), observations: [] };
}
