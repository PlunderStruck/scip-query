import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { decodeObservationReceipt } from '../domain/observation-receipt.js';
import { stableJson } from '../domain/stable-json.js';
import { isCommandOperationRole, type CommandOperationRole } from './command-operation.js';
import { mutateTextFileRevisionAware } from './revisioned-file.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { createAttemptRecordFile } from '../storage/autonomous-work-ledger.js';
import { readIntendedChangeRecordFile } from '../storage/autonomous-work-state.js';
import { readAutonomousRestorationProjection } from '../storage/autonomous-work-restoration.js';

export const AUTONOMOUS_OPERATION_JOURNAL_SCHEMA_VERSION = 1 as const;
const MAX_JOURNAL_ENTRIES = 2_048;
const JOURNAL_RELATIVE_PATH = join('autonomous-workflow', 'operation-journal.json');
const MANUAL_WORK_STATE_COMMANDS = new Set(['goal', 'change', 'attempt', 'decision', 'obligation', 'completion']);

export interface AutomaticOperationJournalEntry {
  operationId: string;
  semanticIdentity: string;
  command: string;
  operationRole: CommandOperationRole;
  argv: readonly string[];
  state: 'started' | 'completed';
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  preReceipt?: ObservationReceiptV2;
  postReceipt?: ObservationReceiptV2;
  materializedAttemptId?: string;
}

interface AutomaticOperationJournal {
  schemaVersion: typeof AUTONOMOUS_OPERATION_JOURNAL_SCHEMA_VERSION;
  entries: readonly AutomaticOperationJournalEntry[];
}

export interface AutomaticOperationCapture {
  projectRoot: string;
  cacheDir: string;
  operationId: string;
}

export interface BeginAutomaticOperationCaptureInput {
  projectRoot: string;
  cacheDir: string;
  command: string;
  operationRole: CommandOperationRole;
  argv: readonly string[];
  preReceipt?: ObservationReceiptV2;
  operationId?: string;
  now?: string;
}

export interface CompleteAutomaticOperationCaptureInput {
  capture: AutomaticOperationCapture;
  exitCode: number;
  postReceipt?: ObservationReceiptV2;
  error?: string;
  now?: string;
}

export interface MaterializeAutomaticOperationAttemptsResult {
  createdAttemptIds: readonly string[];
  reusedAttemptIds: readonly string[];
  pendingOperationCount: number;
  skippedReason?: string;
}

/**
 * An automatic operation journal is reconstructable workspace state that
 * brackets one useful command before committing it to shared work history.
 * Its distinguishing job is to retain an unknown outcome if the process dies
 * between the command's start and its observable completion.
 */
export function beginAutomaticOperationCapture(
  input: BeginAutomaticOperationCaptureInput,
): AutomaticOperationCapture | undefined {
  if (automaticOperationCaptureDisabled() || MANUAL_WORK_STATE_COMMANDS.has(input.command)) return undefined;
  const operationId = input.operationId ?? randomUUID();
  const startedAt = input.now ?? new Date().toISOString();
  const semanticArgv = semanticInvocationArgv(input.argv);
  const entry: AutomaticOperationJournalEntry = {
    operationId,
    semanticIdentity: hashMeaning({
      command: input.command,
      operationRole: input.operationRole,
      argv: semanticArgv,
    }),
    command: input.command,
    operationRole: input.operationRole,
    argv: semanticArgv,
    state: 'started',
    startedAt,
    ...(input.preReceipt ? { preReceipt: input.preReceipt } : {}),
  };
  updateJournal(input.cacheDir, (journal) => {
    const withoutReplay = journal.entries.filter((candidate) => candidate.operationId !== operationId);
    return { ...journal, entries: boundedEntries([...withoutReplay, entry]) };
  });
  return { projectRoot: input.projectRoot, cacheDir: input.cacheDir, operationId };
}

export function completeAutomaticOperationCapture(input: CompleteAutomaticOperationCaptureInput): void {
  const completedAt = input.now ?? new Date().toISOString();
  updateJournal(input.capture.cacheDir, (journal) => {
    const current = journal.entries.find((entry) => entry.operationId === input.capture.operationId);
    if (!current) return journal;
    const completed: AutomaticOperationJournalEntry = {
      ...current,
      state: 'completed',
      completedAt,
      exitCode: input.exitCode,
      ...(input.error ? { error: input.error } : {}),
      ...(input.postReceipt ? { postReceipt: input.postReceipt } : {}),
    };
    const withoutCurrent = journal.entries.filter((entry) => entry.operationId !== completed.operationId);
    if (completed.exitCode === 0 && operationIsReadOnly(completed.operationRole)) {
      const duplicate = withoutCurrent.find(
        (entry) =>
          entry.state === 'completed' &&
          entry.exitCode === 0 &&
          entry.semanticIdentity === completed.semanticIdentity &&
          receiptMeaning(entry.postReceipt) === receiptMeaning(completed.postReceipt),
      );
      if (duplicate) return { ...journal, entries: withoutCurrent };
    }
    return { ...journal, entries: boundedEntries([...withoutCurrent, completed]) };
  });
}

export function materializeAutomaticOperationAttempts(
  projectRoot: string,
  cacheDir: string,
  toolVersion: string,
): MaterializeAutomaticOperationAttemptsResult {
  const journal = readJournal(cacheDir);
  const pending = journal.entries.filter((entry) => !entry.materializedAttemptId);
  if (pending.length === 0) {
    return { createdAttemptIds: [], reusedAttemptIds: [], pendingOperationCount: 0 };
  }
  const projection = readAutonomousRestorationProjection(projectRoot);
  if (!projection.safeToContinue) {
    return {
      createdAttemptIds: [],
      reusedAttemptIds: [],
      pendingOperationCount: pending.length,
      skippedReason: 'committed autonomous work state is not internally safe to extend',
    };
  }
  if (projection.changes.length !== 1) {
    return {
      createdAttemptIds: [],
      reusedAttemptIds: [],
      pendingOperationCount: pending.length,
      skippedReason:
        projection.changes.length === 0
          ? 'no active intended change exists'
          : 'more than one active intended change exists, so automatic attribution would be ambiguous',
    };
  }
  const projectedChange = projection.changes[0]!;
  const change = readIntendedChangeRecordFile(projectRoot, projectedChange.changeId);
  if (change.state !== 'current') {
    return {
      createdAttemptIds: [],
      reusedAttemptIds: [],
      pendingOperationCount: pending.length,
      skippedReason: `active intended change ${projectedChange.changeId} is not readable`,
    };
  }

  const createdAttemptIds: string[] = [];
  const reusedAttemptIds: string[] = [];
  const materialized = new Map<string, string>();
  for (const entry of pending) {
    const result = createAttemptRecordFile(
      projectRoot,
      change.record.collaborationDomainId,
      {
        changeId: change.record.changeId,
        idempotencyKey: `automatic-operation:${entry.operationId}`,
        intendedCondition: projectedChange.currentCondition,
        action: {
          family: `scip-query:${entry.command}`,
          summary: `scip-query ${entry.command} completed as ${entry.operationRole}`,
          effectClass: operationEffectClass(entry.operationRole),
        },
        evidenceReceipts: uniqueReceipts([entry.preReceipt, entry.postReceipt]),
        observedEffect: operationObservedEffect(entry),
        outcome: entry.state === 'started' ? 'unknown' : entry.exitCode === 0 ? 'succeeded' : 'failed',
      },
      { toolVersion, now: () => entry.completedAt ?? entry.startedAt },
    );
    materialized.set(entry.operationId, result.record.attemptId);
    (result.publication === 'created' ? createdAttemptIds : reusedAttemptIds).push(result.record.attemptId);
  }
  updateJournal(cacheDir, (current) => ({
    ...current,
    entries: current.entries.map((entry) => {
      const attemptId = materialized.get(entry.operationId);
      return attemptId ? { ...entry, materializedAttemptId: attemptId } : entry;
    }),
  }));
  return {
    createdAttemptIds,
    reusedAttemptIds,
    pendingOperationCount: pending.length,
  };
}

export function readAutomaticOperationJournal(cacheDir: string): readonly AutomaticOperationJournalEntry[] {
  return readJournal(cacheDir).entries;
}

function automaticOperationCaptureDisabled(): boolean {
  return process.env['SCIP_QUERY_AUTONOMOUS_CAPTURE'] === '0';
}

function journalPath(cacheDir: string): string {
  return join(cacheDir, JOURNAL_RELATIVE_PATH);
}

function readJournal(cacheDir: string): AutomaticOperationJournal {
  const path = journalPath(cacheDir);
  if (!existsSync(path)) return emptyJournal();
  const text = readSmallArtifactText(path, 'autonomous operation journal');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isJournal(parsed)) return emptyJournal();
    return parsed;
  } catch {
    return emptyJournal();
  }
}

function updateJournal(
  cacheDir: string,
  update: (journal: AutomaticOperationJournal) => AutomaticOperationJournal,
): void {
  const path = journalPath(cacheDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mutateTextFileRevisionAware(
    path,
    (snapshot) => {
      let current = emptyJournal();
      if (snapshot.text.trim()) {
        try {
          const parsed = JSON.parse(snapshot.text) as unknown;
          if (isJournal(parsed)) current = parsed;
        } catch {
          // Reconstructable local state: replace malformed bytes with the
          // current operation rather than blocking the useful command.
        }
      }
      const next = update(current);
      return { kind: 'write', text: `${JSON.stringify(next, null, 2)}\n`, mode: 0o600 };
    },
    { maxRetries: 3 },
  );
}

function emptyJournal(): AutomaticOperationJournal {
  return { schemaVersion: AUTONOMOUS_OPERATION_JOURNAL_SCHEMA_VERSION, entries: [] };
}

function boundedEntries(entries: readonly AutomaticOperationJournalEntry[]): AutomaticOperationJournalEntry[] {
  if (entries.length <= MAX_JOURNAL_ENTRIES) return [...entries];
  const materialized = entries.filter((entry) => entry.materializedAttemptId);
  const pending = entries.filter((entry) => !entry.materializedAttemptId);
  if (pending.length >= MAX_JOURNAL_ENTRIES) return pending;
  return [
    ...materialized.slice(Math.max(0, materialized.length - Math.max(0, MAX_JOURNAL_ENTRIES - pending.length))),
    ...pending,
  ].slice(-MAX_JOURNAL_ENTRIES);
}

function semanticInvocationArgv(argv: readonly string[]): string[] {
  const ignored = new Set(['--json', '--result-only', '--compact']);
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (ignored.has(value)) continue;
    if (value === '--output-page-size' || value === '--output-cursor') {
      index += 1;
      continue;
    }
    if (value.startsWith('--output-page-size=') || value.startsWith('--output-cursor=')) continue;
    result.push(value);
  }
  return result;
}

function operationIsReadOnly(role: CommandOperationRole): boolean {
  return (
    role === 'repository-observation' ||
    role === 'repository-preview' ||
    role === 'environment-observation' ||
    role === 'tool-information'
  );
}

function operationEffectClass(role: CommandOperationRole): 'read-only' | 'non-idempotent-write' {
  return operationIsReadOnly(role) ? 'read-only' : 'non-idempotent-write';
}

function operationObservedEffect(entry: AutomaticOperationJournalEntry): string {
  if (entry.state === 'started') return 'The command process ended before an outcome was durably observed.';
  if (entry.exitCode === 0) return 'The command completed successfully and its post-operation state was observed.';
  return `The command completed with exit code ${entry.exitCode ?? 1}${entry.error ? `: ${entry.error}` : '.'}`;
}

function uniqueReceipts(values: readonly (ObservationReceiptV2 | undefined)[]): ObservationReceiptV2[] {
  const byMeaning = new Map<string, ObservationReceiptV2>();
  for (const value of values) {
    if (!value) continue;
    byMeaning.set(receiptMeaning(value), value);
  }
  return [...byMeaning.values()].slice(0, 16);
}

function receiptMeaning(receipt: ObservationReceiptV2 | undefined): string {
  return receipt ? hashMeaning(receipt) : 'none';
}

function hashMeaning(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function isJournal(value: unknown): value is AutomaticOperationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['schemaVersion'] === AUTONOMOUS_OPERATION_JOURNAL_SCHEMA_VERSION &&
    Array.isArray(candidate['entries']) &&
    candidate['entries'].every(isJournalEntry)
  );
}

function isJournalEntry(value: unknown): value is AutomaticOperationJournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const receiptValid = (receipt: unknown): boolean =>
    receipt === undefined || decodeObservationReceipt(receipt).kind === 'supported';
  return (
    typeof entry['operationId'] === 'string' &&
    typeof entry['semanticIdentity'] === 'string' &&
    typeof entry['command'] === 'string' &&
    isCommandOperationRole(entry['operationRole']) &&
    Array.isArray(entry['argv']) &&
    entry['argv'].every((item) => typeof item === 'string') &&
    (entry['state'] === 'started' || entry['state'] === 'completed') &&
    typeof entry['startedAt'] === 'string' &&
    receiptValid(entry['preReceipt']) &&
    receiptValid(entry['postReceipt'])
  );
}
