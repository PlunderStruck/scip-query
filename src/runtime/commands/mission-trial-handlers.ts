import { resolve } from 'node:path';

import { sanitizeTerminalLine } from '../../platform/terminal-output.js';
import { deriveMissionTrialMetrics, type MissionTrialMetricReport } from '../../domain/mission-trial-metrics.js';
import type { MissionTrialProgramV1 } from '../../domain/mission-trials.js';
import {
  assertProtectedRootOutsideCandidate,
  finalizeMissionTrialRun,
  missionTrialRunCondition,
  observeMissionTrialArtifacts,
  readMissionTrialProgramFile,
  readMissionTrialRunFile,
  readMissionTrialRuns,
  writeMissionTrialProgram,
  writeMissionTrialRun,
} from '../../storage/mission-trials.js';
import {
  booleanOptionValue,
  commandOptions,
  parseEnumArgument,
  printJsonEnvelope,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import { resolveProjectRoot } from '../cli-context.js';
import { cliVersion } from '../cli-support.js';

const MISSION_TRIAL_OPERATIONS = ['register', 'validate', 'record', 'list', 'report'] as const;
type MissionTrialOperation = (typeof MISSION_TRIAL_OPERATIONS)[number];

export function handleMissionTrial(operationValue: unknown, programValue: unknown, rawOpts: unknown): void {
  const operation = missionTrialOperation(operationValue);
  const programPath = requiredString(programValue, 'mission-trial requires a program file');
  const opts = commandOptions(rawOpts);
  const protectedRoot = requiredString(
    stringOptionValue(opts, 'protectedRoot'),
    'mission-trial requires --protected-root outside the candidate worktree',
  );
  const candidateRoot = stringOptionValue(opts, 'candidateRoot') ?? resolveProjectRoot();

  try {
    assertProtectedRootOutsideCandidate(protectedRoot, candidateRoot);
    const decodedProgram = readMissionTrialProgramFile(resolve(programPath));
    if (decodedProgram.state !== 'current') {
      throw new Error(`program is ${decodedProgram.state}: ${decodedProgram.error}`);
    }
    const program = decodedProgram.record;
    const result = runMissionTrialOperation(
      operation,
      programPath,
      protectedRoot,
      candidateRoot,
      stringOptionValue(opts, 'input'),
      program,
    );
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('mission-trial', [operation, programPath], opts, result);
      return;
    }
    renderMissionTrialResult(operation, result);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function runMissionTrialOperation(
  operation: MissionTrialOperation,
  programPath: string,
  protectedRoot: string,
  candidateRoot: string,
  inputPath: string | undefined,
  program: MissionTrialProgramV1,
): unknown {
  if (operation === 'register') {
    return {
      operation,
      programPath,
      publication: writeMissionTrialProgram(protectedRoot, program),
    };
  }
  if (operation === 'validate') {
    const artifacts = observeMissionTrialArtifacts(protectedRoot, program);
    return {
      operation,
      program,
      conditions: {
        control: missionTrialRunCondition(program, 'control'),
        workflow: missionTrialRunCondition(program, 'workflow'),
      },
      artifacts,
      valid: artifacts.observations.every(
        (observation) => artifactMatches(observation.fixtureArchive) && artifactMatches(observation.protectedEvaluator),
      ),
    };
  }
  if (operation === 'record') {
    if (!inputPath) throw new Error('mission-trial record requires --input with a completed run record');
    const decodedRun = readMissionTrialRunFile(resolve(inputPath));
    if (decodedRun.state !== 'current') {
      throw new Error(`run input is ${decodedRun.state}: ${decodedRun.error}`);
    }
    if (decodedRun.record.programId !== program.programId) {
      throw new Error(`run ${decodedRun.record.runId} belongs to another trial program`);
    }
    const finalized = finalizeMissionTrialRun(program, decodedRun.record, {
      now: () => new Date().toISOString(),
      toolVersion: cliVersion,
    });
    return {
      operation,
      programId: program.programId,
      publication: writeMissionTrialRun(protectedRoot, candidateRoot, finalized),
      eligible: finalized.exclusionReasons.length === 0,
      exclusionReasons: finalized.exclusionReasons,
    };
  }
  const runs = readMissionTrialRuns(protectedRoot, program.programId);
  if (operation === 'report') {
    return {
      operation,
      programId: program.programId,
      runCount: runs.records.length,
      report: deriveMissionTrialMetrics(program, runs.records),
      issues: runs.issues,
    };
  }
  return {
    operation,
    programId: program.programId,
    runCount: runs.records.length,
    runs: runs.records,
    issues: runs.issues,
  };
}

function renderMissionTrialResult(operation: MissionTrialOperation, result: unknown): void {
  const value = result as {
    publication?: { path: string; publication: string };
    program?: { programId: string; fixtures: readonly unknown[] };
    valid?: boolean;
    conditions?: Record<string, { workflow: string; conditionDigest: string }>;
    artifacts?: { observations: Array<{ fixtureId: string }> };
    programId?: string;
    eligible?: boolean;
    exclusionReasons?: readonly string[];
    runCount?: number;
    issues?: readonly unknown[];
    report?: MissionTrialMetricReport;
  };
  if (operation === 'register' || operation === 'record') {
    console.log(
      sanitizeTerminalLine(
        `${operation === 'register' ? 'Program' : 'Run'} ${value.publication?.publication ?? 'unknown'} at ${value.publication?.path ?? 'unknown path'}.`,
      ),
    );
    if (operation === 'record') {
      console.log(`Eligible: ${value.eligible === true ? 'yes' : 'no'}`);
      for (const reason of value.exclusionReasons ?? []) console.log(`  excluded: ${sanitizeTerminalLine(reason)}`);
    }
    return;
  }
  if (operation === 'validate') {
    console.log(
      `Program ${sanitizeTerminalLine(value.program?.programId ?? 'unknown')}: ${value.valid ? 'valid' : 'invalid'}`,
    );
    console.log(`Fixtures: ${value.program?.fixtures.length ?? 0}`);
    for (const [condition, detail] of Object.entries(value.conditions ?? {})) {
      console.log(`  ${condition}: ${detail.workflow} (${detail.conditionDigest})`);
    }
    return;
  }
  console.log(`Program ${sanitizeTerminalLine(value.programId ?? 'unknown')}: ${value.runCount ?? 0} run(s)`);
  console.log(`Record issues: ${value.issues?.length ?? 0}`);
  if (operation === 'report' && value.report) {
    console.log(`Matched pairs: ${value.report.matchedPairCount}`);
    console.log(
      `Full completion: control ${formatRate(value.report.quality.control.fullCompletion.rate)}, workflow ${formatRate(value.report.quality.workflow.fullCompletion.rate)}, difference ${formatSignedRate(value.report.quality.fullCompletionRateDifference)}`,
    );
    console.log(
      `Workflow false blocking: ${formatRate(value.report.quality.workflow.falseBlocking.rate)}; architecture regression: ${formatRate(value.report.quality.workflow.architectureRegression.rate)}`,
    );
    console.log(
      `Median workflow/control ratio: elapsed ${formatRatio(value.report.efficiency.elapsedMs.medianRatio)}, model tokens ${formatRatio(value.report.efficiency.modelTokens.medianRatio)}`,
    );
    const excluded = value.report.rawSamples.filter((sample) => sample.selection !== 'selected').length;
    console.log(`Selected outcomes: ${value.report.selectedRunCount}; excluded or superseded records: ${excluded}`);
  }
}

function artifactMatches(artifact: {
  expectedSha256: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}): boolean {
  return artifact.beforeSha256 === artifact.expectedSha256 && artifact.afterSha256 === artifact.expectedSha256;
}

function missionTrialOperation(value: unknown): MissionTrialOperation {
  return parseEnumArgument(value, MISSION_TRIAL_OPERATIONS, 'mission-trial operation');
}

function requiredString(value: unknown, message: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  throw new Error(message);
}

function formatRate(value: number | null): string {
  return value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`;
}

function formatSignedRate(value: number | null): string {
  if (value === null) return 'unknown';
  const percentage = value * 100;
  return `${percentage >= 0 ? '+' : ''}${percentage.toFixed(1)}pp`;
}

function formatRatio(value: number | null): string {
  return value === null ? 'unknown' : `${value.toFixed(2)}x`;
}
