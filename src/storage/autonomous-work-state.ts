import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  createGoalRecord,
  createIntendedChangeRecord,
  decodeGoalRecord,
  decodeIntendedChangeRecord,
  goalRequestMatchesRecord,
  intendedChangeRequestMatchesRecord,
  isGoalId,
  isIntendedChangeId,
  type GoalCreateRequest,
  type GoalRecordV1,
  type IntendedChangeCreateRequest,
  type IntendedChangeRecordV1,
  type WorkStateDecodeResult,
} from '../domain/autonomous-work-state.js';
import {
  summarizeRecordCompatibility,
  type RecordCompatibilityObservation,
  type RecordCompatibilitySummary,
} from '../domain/record-compatibility.js';
import { readSmallArtifactText } from '../filesystem/bounded-file.js';
import { createFileAtomicExclusive, type AchievedFileDurability, type AtomicFileRuntime } from './atomic-file.js';

export const GOALS_DIR = join('.scipquery', 'goals');
export const INTENDED_CHANGES_DIR = join('.scipquery', 'changes');

export interface WorkStateCreateOptions {
  toolVersion: string;
  now?: () => string;
  atomicRuntime?: AtomicFileRuntime;
}

export interface WorkStateCreateResult<RecordType> {
  record: RecordType;
  path: string;
  publication: 'created' | 'existing';
  achievedDurability: AchievedFileDurability | 'existing';
}

export type WorkStateRecordReadResult<RecordType> =
  | { state: 'missing'; path: string; error: string }
  | ({ path: string } & WorkStateDecodeResult<RecordType>);

export interface WorkStateCollectionReadResult<RecordType> {
  records: RecordType[];
  compatibility: RecordCompatibilitySummary;
  warnings: string[];
}

export interface IntendedChangeCollectionReadResult extends WorkStateCollectionReadResult<IntendedChangeRecordV1> {
  integrityIssues: string[];
}

export interface WorkStatePublicationInput<RecordType> {
  relativeDirectory: string;
  identity: string;
  record: RecordType;
  readExisting: () => WorkStateRecordReadResult<RecordType>;
  matchesExisting: (record: RecordType) => boolean;
  collisionMessage: (relativePath: string) => string;
}

export function createGoalRecordFile(
  projectRoot: string,
  collaborationDomainId: string,
  request: GoalCreateRequest,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<GoalRecordV1> {
  const record = createGoalRecord({
    collaborationDomainId,
    request,
    createdAt: (options.now ?? defaultNow)(),
    toolVersion: options.toolVersion,
  });
  if (record.predecessorGoalId) {
    const predecessor = readGoalRecordFile(projectRoot, record.predecessorGoalId);
    if (predecessor.state !== 'current') {
      throw new Error(`predecessor goal ${record.predecessorGoalId} is not a readable current record`);
    }
    if (predecessor.record.collaborationDomainId !== collaborationDomainId) {
      throw new Error(`predecessor goal ${record.predecessorGoalId} belongs to another collaboration domain`);
    }
  }
  return publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: GOALS_DIR,
      identity: record.goalId,
      record,
      readExisting: () => readGoalRecordFile(projectRoot, record.goalId),
      matchesExisting: (existing) => goalRequestMatchesRecord(collaborationDomainId, request, existing),
      collisionMessage: (relativePath) =>
        `goal identity collision at ${relativePath}: existing record has different meaning or metadata`,
    },
    options,
  );
}

export function createIntendedChangeRecordFile(
  projectRoot: string,
  collaborationDomainId: string,
  request: IntendedChangeCreateRequest,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<IntendedChangeRecordV1> {
  const goal = readGoalRecordFile(projectRoot, request.goalId);
  if (goal.state !== 'current') throw new Error(`goal ${request.goalId} is not a readable current record`);
  if (goal.record.collaborationDomainId !== collaborationDomainId) {
    throw new Error(`goal ${request.goalId} belongs to another collaboration domain`);
  }
  const record = createIntendedChangeRecord({
    collaborationDomainId,
    request,
    createdAt: (options.now ?? defaultNow)(),
    toolVersion: options.toolVersion,
  });
  return publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: INTENDED_CHANGES_DIR,
      identity: record.changeId,
      record,
      readExisting: () => readIntendedChangeRecordFile(projectRoot, record.changeId),
      matchesExisting: (existing) => intendedChangeRequestMatchesRecord(collaborationDomainId, request, existing),
      collisionMessage: (relativePath) =>
        `intended-change idempotency collision at ${relativePath}: this key already names a different request`,
    },
    options,
  );
}

export function requireIntendedChangeRecord(
  projectRoot: string,
  collaborationDomainId: string,
  changeId: string,
): IntendedChangeRecordV1 {
  const change = readIntendedChangeRecordFile(projectRoot, changeId);
  if (change.state !== 'current') throw new Error(`intended change ${changeId} is not a readable current record`);
  if (change.record.collaborationDomainId !== collaborationDomainId) {
    throw new Error(`intended change ${changeId} belongs to another collaboration domain`);
  }
  return change.record;
}

export function publishWorkStateRecord<RecordType>(
  projectRoot: string,
  input: WorkStatePublicationInput<RecordType>,
  options: Pick<WorkStateCreateOptions, 'atomicRuntime'>,
): WorkStateCreateResult<RecordType> {
  const relativePath = join(input.relativeDirectory, `${input.identity}.json`);
  const absolutePath = join(projectRoot, relativePath);
  try {
    const publication = createFileAtomicExclusive(absolutePath, serializeRecord(input.record), {
      durability: 'durable',
      ...(options.atomicRuntime ? { runtime: options.atomicRuntime } : {}),
    });
    return {
      record: input.record,
      path: relativePath,
      publication: 'created',
      achievedDurability: publication.achievedDurability,
    };
  } catch (error) {
    if (!isExistingPathError(error)) throw error;
    if (!recordPathExists(absolutePath, options.atomicRuntime)) throw error;
    const existing = input.readExisting();
    if (existing.state !== 'current' || !input.matchesExisting(existing.record)) {
      throw new Error(input.collisionMessage(relativePath), { cause: error });
    }
    return {
      record: existing.record,
      path: relativePath,
      publication: 'existing',
      achievedDurability: 'existing',
    };
  }
}

export function readGoalRecordFile(projectRoot: string, goalId: string): WorkStateRecordReadResult<GoalRecordV1> {
  if (!isGoalId(goalId)) throw new Error(`invalid goal identity: ${goalId}`);
  const relativePath = join(GOALS_DIR, `${goalId}.json`);
  return readRecordFile(projectRoot, relativePath, decodeGoalRecord);
}

export function readIntendedChangeRecordFile(
  projectRoot: string,
  changeId: string,
): WorkStateRecordReadResult<IntendedChangeRecordV1> {
  if (!isIntendedChangeId(changeId)) throw new Error(`invalid intended-change identity: ${changeId}`);
  const relativePath = join(INTENDED_CHANGES_DIR, `${changeId}.json`);
  return readRecordFile(projectRoot, relativePath, decodeIntendedChangeRecord);
}

export function readGoalRecordPath(path: string): WorkStateDecodeResult<GoalRecordV1> {
  return parseRecordFile(path, 'goal record', decodeGoalRecord);
}

export function readIntendedChangeRecordPath(path: string): WorkStateDecodeResult<IntendedChangeRecordV1> {
  return parseRecordFile(path, 'intended-change record', decodeIntendedChangeRecord);
}

export function readGoalRecords(projectRoot: string): WorkStateCollectionReadResult<GoalRecordV1> {
  return readRecordDirectory(projectRoot, GOALS_DIR, 'goal record', decodeGoalRecord, (record) => record.goalId);
}

export function readIntendedChangeRecords(
  projectRoot: string,
  goals: WorkStateCollectionReadResult<GoalRecordV1> = readGoalRecords(projectRoot),
): IntendedChangeCollectionReadResult {
  const result = readRecordDirectory(
    projectRoot,
    INTENDED_CHANGES_DIR,
    'intended-change record',
    decodeIntendedChangeRecord,
    (record) => record.changeId,
  );
  const goalsById = new Map(goals.records.map((goal) => [goal.goalId, goal]));
  const integrityIssues = result.records.flatMap((change) => {
    const goal = goalsById.get(change.goalId);
    if (!goal) return [`${change.changeId} references missing or incompatible goal ${change.goalId}`];
    if (goal.collaborationDomainId !== change.collaborationDomainId) {
      return [`${change.changeId} and goal ${change.goalId} belong to different collaboration domains`];
    }
    return [];
  });
  return { ...result, integrityIssues };
}

export function readRecordFile<RecordType>(
  projectRoot: string,
  relativePath: string,
  decode: (value: unknown) => WorkStateDecodeResult<RecordType>,
): WorkStateRecordReadResult<RecordType> {
  const absolutePath = join(projectRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return { state: 'missing', path: relativePath, error: `record does not exist: ${relativePath}` };
  }
  return { path: relativePath, ...parseRecordFile(absolutePath, 'work-state record', decode) };
}

export function readRecordDirectory<RecordType>(
  projectRoot: string,
  relativeDirectory: string,
  label: string,
  decode: (value: unknown) => WorkStateDecodeResult<RecordType>,
  identity: (record: RecordType) => string,
): WorkStateCollectionReadResult<RecordType> {
  const absoluteDirectory = join(projectRoot, relativeDirectory);
  if (!existsSync(absoluteDirectory)) {
    return { records: [], compatibility: summarizeRecordCompatibility([]), warnings: [] };
  }
  const records: RecordType[] = [];
  const observations: RecordCompatibilityObservation[] = [];
  for (const entry of readdirSync(absoluteDirectory).sort()) {
    if (!entry.endsWith('.json')) continue;
    const relativePath = join(relativeDirectory, entry);
    const decoded = parseRecordFile(join(absoluteDirectory, entry), label, decode);
    if (decoded.state !== 'current') {
      observations.push({ path: relativePath, state: decoded.state, reason: decoded.error });
      continue;
    }
    const expectedEntry = `${identity(decoded.record)}.json`;
    if (entry !== expectedEntry) {
      observations.push({
        path: relativePath,
        state: 'malformed',
        reason: `filename must be ${expectedEntry}`,
      });
      continue;
    }
    observations.push({ path: relativePath, state: 'current' });
    records.push(decoded.record);
  }
  const compatibility = summarizeRecordCompatibility(observations);
  return {
    records,
    compatibility,
    warnings: compatibility.issues.map((issue) => `${issue.path}: ${issue.reason} — ignored`),
  };
}

export function parseRecordFile<RecordType>(
  path: string,
  label: string,
  decode: (value: unknown) => WorkStateDecodeResult<RecordType>,
): WorkStateDecodeResult<RecordType> {
  let parsed: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { state: 'malformed', error: `${label} path must be a regular non-symlink file` };
    }
    parsed = JSON.parse(readSmallArtifactText(path, label));
  } catch (error) {
    return {
      state: 'malformed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return decode(parsed);
}

export function serializeRecord(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function isExistingPathError(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'EEXIST';
}

function recordPathExists(path: string, runtime: AtomicFileRuntime | undefined): boolean {
  return runtime ? runtime.pathExists(path) : existsSync(path);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}
