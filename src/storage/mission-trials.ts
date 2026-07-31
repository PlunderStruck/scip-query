import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  createMissionTrialRun,
  decodeMissionTrialProgram,
  decodeMissionTrialRun,
  missionTrialConditionDigest,
  missionTrialRunExclusionReasons,
  type MissionTrialCreateOptions,
  type MissionTrialDecodeResult,
  type MissionTrialObservedArtifact,
  type MissionTrialProgramV1,
  type MissionTrialRunRequest,
  type MissionTrialRunV1,
  type MissionTrialTreatment,
} from '../domain/mission-trials.js';
import { readSmallArtifactText, sha256FileWithinLimit } from '../filesystem/bounded-file.js';
import {
  createFileAtomicExclusive,
  isExclusivePublicationConflict,
  type AchievedFileDurability,
  type AtomicFileRuntime,
} from './atomic-file.js';

export const MISSION_TRIAL_PROGRAMS_DIR = 'programs';
export const MISSION_TRIAL_RUNS_DIR = 'runs';
export const MISSION_TRIAL_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;

export interface MissionTrialArtifactObservation {
  fixtureId: string;
  fixtureArchive: MissionTrialObservedArtifact;
  protectedEvaluator: MissionTrialObservedArtifact;
}

export interface MissionTrialArtifactSnapshot {
  programId: string;
  protectedRoot: string;
  observations: MissionTrialArtifactObservation[];
}

export interface MissionTrialWriteOptions {
  atomicRuntime?: AtomicFileRuntime;
}

export interface MissionTrialWriteResult<RecordType> {
  record: RecordType;
  path: string;
  publication: 'created' | 'existing';
  achievedDurability: AchievedFileDurability | 'existing';
}

export interface MissionTrialRunReadResult {
  records: MissionTrialRunV1[];
  issues: Array<{
    path: string;
    state: Exclude<MissionTrialDecodeResult<MissionTrialRunV1>['state'], 'current'>;
    reason: string;
  }>;
}

export function readMissionTrialProgramFile(path: string): MissionTrialDecodeResult<MissionTrialProgramV1> {
  return readMissionTrialRecord(path, 'mission trial program', decodeMissionTrialProgram);
}

export function readMissionTrialRunFile(path: string): MissionTrialDecodeResult<MissionTrialRunV1> {
  return readMissionTrialRecord(path, 'mission trial run', decodeMissionTrialRun);
}

export function writeMissionTrialProgram(
  protectedRoot: string,
  program: MissionTrialProgramV1,
  options: MissionTrialWriteOptions = {},
): MissionTrialWriteResult<MissionTrialProgramV1> {
  const decoded = decodeMissionTrialProgram(program);
  if (decoded.state !== 'current') throw new Error(decoded.error);
  return publishMissionTrialRecord(
    join(resolve(protectedRoot), MISSION_TRIAL_PROGRAMS_DIR, `${program.programId}.json`),
    program,
    () =>
      readMissionTrialProgramFile(
        join(resolve(protectedRoot), MISSION_TRIAL_PROGRAMS_DIR, `${program.programId}.json`),
      ),
    (existing) => existing.semanticDigest === program.semanticDigest,
    options,
  );
}

export function writeMissionTrialRun(
  protectedRoot: string,
  candidateRoot: string,
  run: MissionTrialRunV1,
  options: MissionTrialWriteOptions = {},
): MissionTrialWriteResult<MissionTrialRunV1> {
  assertProtectedRootOutsideCandidate(protectedRoot, candidateRoot);
  const decoded = decodeMissionTrialRun(run);
  if (decoded.state !== 'current') throw new Error(decoded.error);
  const path = join(resolve(protectedRoot), MISSION_TRIAL_RUNS_DIR, run.programId, `${run.runId}.json`);
  return publishMissionTrialRecord(
    path,
    run,
    () => readMissionTrialRunFile(path),
    (existing) => JSON.stringify(existing) === JSON.stringify(run),
    options,
  );
}

export function finalizeMissionTrialRun(
  program: MissionTrialProgramV1,
  request: MissionTrialRunRequest,
  options: MissionTrialCreateOptions,
): MissionTrialRunV1 {
  return createMissionTrialRun(
    {
      ...request,
      exclusionReasons: missionTrialRunExclusionReasons(program, request),
    },
    options,
  );
}

export function observeMissionTrialArtifacts(
  protectedRoot: string,
  program: MissionTrialProgramV1,
): MissionTrialArtifactSnapshot {
  const resolvedRoot = realpathSync(protectedRoot);
  const observations = program.fixtures.map((fixture) => ({
    fixtureId: fixture.fixtureId,
    fixtureArchive: observeProtectedArtifact(
      resolvedRoot,
      fixture.repositoryArchive.relativePath,
      fixture.repositoryArchive.sha256,
    ),
    protectedEvaluator: observeProtectedArtifact(
      resolvedRoot,
      fixture.protectedEvaluator.relativePath,
      fixture.protectedEvaluator.sha256,
    ),
  }));
  return {
    programId: program.programId,
    protectedRoot: resolvedRoot,
    observations,
  };
}

export function missionTrialRunCondition(
  program: MissionTrialProgramV1,
  treatment: MissionTrialTreatment,
): { workflow: 'disabled' | 'autonomous-completion-v1'; conditionDigest: string } {
  return {
    workflow: treatment === 'control' ? program.conditions.control.workflow : program.conditions.treatment.workflow,
    conditionDigest: missionTrialConditionDigest(program, treatment),
  };
}

export function readMissionTrialRuns(protectedRoot: string, programId: string): MissionTrialRunReadResult {
  const directory = join(resolve(protectedRoot), MISSION_TRIAL_RUNS_DIR, programId);
  if (!existsSync(directory)) return { records: [], issues: [] };
  const records: MissionTrialRunV1[] = [];
  const issues: MissionTrialRunReadResult['issues'] = [];
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith('.json')) continue;
    const path = join(directory, entry);
    const decoded = readMissionTrialRunFile(path);
    if (decoded.state !== 'current') {
      issues.push({ path, state: decoded.state, reason: decoded.error });
      continue;
    }
    if (entry !== `${decoded.record.runId}.json`) {
      issues.push({ path, state: 'malformed', reason: `filename must be ${decoded.record.runId}.json` });
      continue;
    }
    records.push(decoded.record);
  }
  return { records, issues };
}

export function assertProtectedRootOutsideCandidate(protectedRoot: string, candidateRoot: string): void {
  const protectedPath = resolve(protectedRoot);
  const candidatePath = resolve(candidateRoot);
  if (protectedPath === candidatePath || pathIsWithin(candidatePath, protectedPath)) {
    throw new Error('mission trial protected root must be outside the candidate-editable worktree');
  }
}

function observeProtectedArtifact(
  protectedRoot: string,
  relativePath: string,
  expectedSha256: string,
): MissionTrialObservedArtifact {
  const path = resolve(protectedRoot, relativePath);
  if (!pathIsWithin(protectedRoot, path) || !existsSync(path)) {
    return { expectedSha256, beforeSha256: null, afterSha256: null };
  }
  const digest = hashRegularArtifact(path);
  return { expectedSha256, beforeSha256: digest, afterSha256: digest };
}

function hashRegularArtifact(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return sha256FileWithinLimit(path, {
      inputKind: 'mission trial protected artifact',
      maxBytes: MISSION_TRIAL_ARTIFACT_MAX_BYTES,
    });
  } catch {
    return null;
  }
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation.length > 0 && !relation.startsWith('..') && !isAbsolute(relation);
}

function readMissionTrialRecord<RecordType>(
  path: string,
  label: string,
  decode: (value: unknown) => MissionTrialDecodeResult<RecordType>,
): MissionTrialDecodeResult<RecordType> {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { state: 'malformed', error: `${label} path must be a regular non-symlink file` };
    }
    return decode(JSON.parse(readSmallArtifactText(path, label)));
  } catch (error) {
    return { state: 'malformed', error: error instanceof Error ? error.message : String(error) };
  }
}

function publishMissionTrialRecord<RecordType>(
  path: string,
  record: RecordType,
  readExisting: () => MissionTrialDecodeResult<RecordType>,
  matches: (existing: RecordType) => boolean,
  options: MissionTrialWriteOptions,
): MissionTrialWriteResult<RecordType> {
  try {
    const publication = createFileAtomicExclusive(path, `${JSON.stringify(record, null, 2)}\n`, {
      durability: 'durable',
      ...(options.atomicRuntime ? { runtime: options.atomicRuntime } : {}),
    });
    return {
      record,
      path,
      publication: 'created',
      achievedDurability: publication.achievedDurability,
    };
  } catch (error) {
    if (!isExclusivePublicationConflict(error)) throw error;
    const existing = readExisting();
    if (existing.state !== 'current' || !matches(existing.record)) {
      throw new Error(`immutable mission trial record collision at ${path}`, { cause: error });
    }
    return {
      record: existing.record,
      path,
      publication: 'existing',
      achievedDurability: 'existing',
    };
  }
}
