import {
  missionTrialRunExclusionReasons,
  type MissionTrialEvaluation,
  type MissionTrialFailureOrigin,
  type MissionTrialProgramV1,
  type MissionTrialRunStatus,
  type MissionTrialRunV1,
  type MissionTrialTelemetry,
  type MissionTrialTreatment,
} from './mission-trials.js';

export const MISSION_TRIAL_METRICS_VERSION = 1 as const;

const TELEMETRY_FIELDS = [
  'elapsedMs',
  'modelTokens',
  'toolCalls',
  'failedAttempts',
  'reworkEdits',
  'metadataCommands',
  'repeatedContextTokens',
] as const;

type TelemetryField = (typeof TELEMETRY_FIELDS)[number];
type SelectionState = 'selected' | 'excluded' | 'superseded';

export interface MissionTrialRawMetric {
  runId: string;
  pairId: string;
  fixtureId: string;
  treatment: MissionTrialTreatment;
  rerunOrdinal: number;
  status: MissionTrialRunStatus;
  selection: SelectionState;
  exclusionReasons: readonly string[];
  fullCompletion: boolean | null;
  missedAffectedArtifacts: readonly string[] | null;
  residueDefects: readonly string[] | null;
  reintroducedBehaviors: readonly string[] | null;
  architectureViolations: readonly string[] | null;
  architectureRegression: boolean | null;
  falseBlocking: boolean | null;
  failureOrigin: MissionTrialFailureOrigin;
  telemetry: MissionTrialTelemetry;
}

export interface MissionTrialTelemetryDifference {
  control: number | null;
  workflow: number | null;
  difference: number | null;
  ratio: number | null;
}

export interface MissionTrialPairMetric {
  pairId: string;
  fixtureId: string;
  control: MissionTrialRawMetric;
  workflow: MissionTrialRawMetric;
  fullCompletionDifference: -1 | 0 | 1 | null;
  telemetry: Record<TelemetryField, MissionTrialTelemetryDifference>;
}

export interface MissionTrialRateSummary {
  observed: number;
  positive: number;
  unknown: number;
  rate: number | null;
}

export interface MissionTrialQualityConditionSummary {
  fullCompletion: MissionTrialRateSummary;
  falseBlocking: MissionTrialRateSummary;
  architectureRegression: MissionTrialRateSummary;
}

export interface MissionTrialQualitySummary {
  control: MissionTrialQualityConditionSummary;
  workflow: MissionTrialQualityConditionSummary;
  fullCompletionRateDifference: number | null;
  improvedPairs: number;
  regressedPairs: number;
  tiedPairs: number;
  unknownPairs: number;
}

export interface MissionTrialTelemetrySummary {
  observedPairs: number;
  unknownPairs: number;
  medianControl: number | null;
  medianWorkflow: number | null;
  medianDifference: number | null;
  medianRatio: number | null;
}

export interface MissionTrialFailureSummary {
  detectorMiss: number;
  controllerMiss: number;
  agentFailure: number;
  apparatusFailure: number;
  unattributed: number;
}

export interface MissionTrialMetricReport {
  version: typeof MISSION_TRIAL_METRICS_VERSION;
  programId: string;
  inputRunCount: number;
  uniqueRunCount: number;
  selectedRunCount: number;
  matchedPairCount: number;
  selectionPolicy: 'first-eligible-candidate-outcome-v1';
  rawSamples: readonly MissionTrialRawMetric[];
  pairs: readonly MissionTrialPairMetric[];
  unmatched: readonly MissionTrialRawMetric[];
  quality: MissionTrialQualitySummary;
  efficiency: Record<TelemetryField, MissionTrialTelemetrySummary>;
  failureOrigins: {
    control: MissionTrialFailureSummary;
    workflow: MissionTrialFailureSummary;
  };
  integrityIssues: readonly string[];
}

interface SelectionCandidate {
  run: MissionTrialRunV1;
  reasons: Set<string>;
  selection: SelectionState;
}

/**
 * Derives comparison evidence without changing or filling gaps in protected
 * trial observations. A selected outcome is the first uncontaminated,
 * non-apparatus result for one condition; later candidate outcomes cannot
 * replace it.
 */
export function deriveMissionTrialMetrics(
  program: MissionTrialProgramV1,
  inputRuns: readonly MissionTrialRunV1[],
): MissionTrialMetricReport {
  const integrityIssues: string[] = [];
  const uniqueRuns = uniqueMissionTrialRuns(inputRuns, integrityIssues);
  const conflictingRunIds = conflictingMissionTrialRunIds(inputRuns);
  const pairFixtureConflicts = conflictingPairFixtureIds(uniqueRuns);
  const candidates = uniqueRuns
    .map<SelectionCandidate>((run) => {
      const reasons = new Set(missionTrialRunExclusionReasons(program, run));
      if (run.rerunOrdinal > program.maximumRerunsPerCondition) {
        reasons.add(`rerun ordinal ${run.rerunOrdinal} exceeds maximum ${program.maximumRerunsPerCondition}`);
      }
      if (conflictingRunIds.has(run.runId)) {
        reasons.add('conflicting records share the immutable run identity');
      }
      if (pairFixtureConflicts.has(run.pairId)) {
        reasons.add(`pair ${run.pairId} is associated with more than one fixture`);
      }
      return {
        run,
        reasons,
        selection: 'excluded',
      };
    })
    .sort(compareSelectionCandidates);

  for (const pairId of [...pairFixtureConflicts].sort()) {
    integrityIssues.push(`pair ${pairId} is associated with more than one fixture`);
  }
  for (const runId of [...conflictingRunIds].sort()) {
    integrityIssues.push(`run ${runId} has conflicting immutable records`);
  }

  selectConditionOutcomes(candidates);
  const rawSamples = candidates.map(toRawMetric);
  const selected = rawSamples.filter((sample) => sample.selection === 'selected');
  const { pairs, unmatched } = pairSelectedOutcomes(selected);

  return {
    version: MISSION_TRIAL_METRICS_VERSION,
    programId: program.programId,
    inputRunCount: inputRuns.length,
    uniqueRunCount: uniqueRuns.length,
    selectedRunCount: selected.length,
    matchedPairCount: pairs.length,
    selectionPolicy: 'first-eligible-candidate-outcome-v1',
    rawSamples,
    pairs,
    unmatched,
    quality: summarizeQuality(pairs),
    efficiency: summarizeEfficiency(pairs),
    failureOrigins: {
      control: summarizeFailureOrigins(pairs.map((pair) => pair.control)),
      workflow: summarizeFailureOrigins(pairs.map((pair) => pair.workflow)),
    },
    integrityIssues: [...new Set(integrityIssues)].sort(),
  };
}

export function missionTrialFullCompletion(
  status: MissionTrialRunStatus,
  evaluation: MissionTrialEvaluation,
): boolean | null {
  if (status !== 'completed') return false;
  if (
    evaluation.goalSatisfied === false ||
    evaluation.invariantsPreserved === false ||
    evaluation.affectedSurfaceReconciled === false ||
    hasObservedDefects(evaluation.missedAffectedArtifacts) ||
    hasObservedDefects(evaluation.residueDefects) ||
    hasObservedDefects(evaluation.reintroducedBehaviors) ||
    hasObservedDefects(evaluation.architectureViolations)
  ) {
    return false;
  }
  if (
    evaluation.goalSatisfied === true &&
    evaluation.invariantsPreserved === true &&
    evaluation.affectedSurfaceReconciled === true &&
    isKnownEmpty(evaluation.missedAffectedArtifacts) &&
    isKnownEmpty(evaluation.residueDefects) &&
    isKnownEmpty(evaluation.reintroducedBehaviors) &&
    isKnownEmpty(evaluation.architectureViolations)
  ) {
    return true;
  }
  return null;
}

export function missionTrialFalseBlocking(evaluation: MissionTrialEvaluation): boolean | null {
  if (evaluation.controllerBlocked === false) return false;
  if (evaluation.controllerBlocked === true && evaluation.blockerWasValid === false) return true;
  if (evaluation.controllerBlocked === true && evaluation.blockerWasValid === true) return false;
  return null;
}

function uniqueMissionTrialRuns(runs: readonly MissionTrialRunV1[], integrityIssues: string[]): MissionTrialRunV1[] {
  const byId = new Map<string, MissionTrialRunV1>();
  for (const run of [...runs].sort(compareRuns)) {
    const existing = byId.get(run.runId);
    if (!existing) {
      byId.set(run.runId, run);
      continue;
    }
    if (JSON.stringify(existing) === JSON.stringify(run)) {
      integrityIssues.push(`duplicate copy of run ${run.runId} was ignored`);
    }
  }
  return [...byId.values()].sort(compareRuns);
}

function conflictingMissionTrialRunIds(runs: readonly MissionTrialRunV1[]): Set<string> {
  const identities = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const run of runs) {
    const serialized = JSON.stringify(run);
    const prior = identities.get(run.runId);
    if (prior !== undefined && prior !== serialized) conflicts.add(run.runId);
    else identities.set(run.runId, serialized);
  }
  return conflicts;
}

function conflictingPairFixtureIds(runs: readonly MissionTrialRunV1[]): Set<string> {
  const fixtures = new Map<string, Set<string>>();
  for (const run of runs) {
    const values = fixtures.get(run.pairId) ?? new Set<string>();
    values.add(run.fixtureId);
    fixtures.set(run.pairId, values);
  }
  return new Set([...fixtures].filter(([, values]) => values.size > 1).map(([pairId]) => pairId));
}

function selectConditionOutcomes(candidates: SelectionCandidate[]): void {
  const groups = new Map<string, SelectionCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.run.pairId}\u0000${candidate.run.fixtureId}\u0000${candidate.run.treatment}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort(compareSelectionCandidates);
    if (group[0]?.run.rerunOrdinal !== 0) {
      for (const candidate of group) candidate.reasons.add('condition has no primary run at rerun ordinal 0');
      continue;
    }
    let selected = false;
    for (const candidate of group) {
      if (candidate.reasons.size > 0) continue;
      if (candidate.run.failureOrigin === 'apparatus-failure') {
        candidate.reasons.add('apparatus failure does not score a candidate outcome');
        continue;
      }
      if (selected) {
        candidate.selection = 'superseded';
        candidate.reasons.add('rerun cannot replace an already recorded candidate outcome');
        continue;
      }
      candidate.selection = 'selected';
      selected = true;
    }
  }
}

function toRawMetric(candidate: SelectionCandidate): MissionTrialRawMetric {
  const { run } = candidate;
  return {
    runId: run.runId,
    pairId: run.pairId,
    fixtureId: run.fixtureId,
    treatment: run.treatment,
    rerunOrdinal: run.rerunOrdinal,
    status: run.status,
    selection: candidate.selection,
    exclusionReasons: [...candidate.reasons].sort(),
    fullCompletion: missionTrialFullCompletion(run.status, run.evaluation),
    missedAffectedArtifacts: run.evaluation.missedAffectedArtifacts,
    residueDefects: run.evaluation.residueDefects,
    reintroducedBehaviors: run.evaluation.reintroducedBehaviors,
    architectureViolations: run.evaluation.architectureViolations,
    architectureRegression: nullableListPresence(run.evaluation.architectureViolations),
    falseBlocking: missionTrialFalseBlocking(run.evaluation),
    failureOrigin: run.failureOrigin,
    telemetry: run.telemetry,
  };
}

function pairSelectedOutcomes(selected: readonly MissionTrialRawMetric[]): {
  pairs: MissionTrialPairMetric[];
  unmatched: MissionTrialRawMetric[];
} {
  const groups = new Map<string, Partial<Record<MissionTrialTreatment, MissionTrialRawMetric>>>();
  for (const sample of selected) {
    const key = `${sample.pairId}\u0000${sample.fixtureId}`;
    const group = groups.get(key) ?? {};
    group[sample.treatment] = sample;
    groups.set(key, group);
  }
  const pairs: MissionTrialPairMetric[] = [];
  const unmatched: MissionTrialRawMetric[] = [];
  for (const group of groups.values()) {
    if (!group.control || !group.workflow) {
      if (group.control) unmatched.push(group.control);
      if (group.workflow) unmatched.push(group.workflow);
      continue;
    }
    pairs.push(toPairMetric(group.control, group.workflow));
  }
  return {
    pairs: pairs.sort(comparePairs),
    unmatched: unmatched.sort(compareRawMetrics),
  };
}

function toPairMetric(control: MissionTrialRawMetric, workflow: MissionTrialRawMetric): MissionTrialPairMetric {
  const telemetry = {} as Record<TelemetryField, MissionTrialTelemetryDifference>;
  for (const field of TELEMETRY_FIELDS) {
    const controlValue = control.telemetry[field];
    const workflowValue = workflow.telemetry[field];
    const observed = controlValue !== null && workflowValue !== null;
    telemetry[field] = {
      control: controlValue,
      workflow: workflowValue,
      difference: observed ? workflowValue - controlValue : null,
      ratio: observed && controlValue > 0 ? workflowValue / controlValue : null,
    };
  }
  return {
    pairId: control.pairId,
    fixtureId: control.fixtureId,
    control,
    workflow,
    fullCompletionDifference: booleanDifference(control.fullCompletion, workflow.fullCompletion),
    telemetry,
  };
}

function summarizeQuality(pairs: readonly MissionTrialPairMetric[]): MissionTrialQualitySummary {
  const control = summarizeQualityCondition(pairs.map((pair) => pair.control));
  const workflow = summarizeQualityCondition(pairs.map((pair) => pair.workflow));
  const differences = pairs.map((pair) => pair.fullCompletionDifference);
  return {
    control,
    workflow,
    fullCompletionRateDifference:
      control.fullCompletion.rate === null || workflow.fullCompletion.rate === null
        ? null
        : workflow.fullCompletion.rate - control.fullCompletion.rate,
    improvedPairs: differences.filter((value) => value === 1).length,
    regressedPairs: differences.filter((value) => value === -1).length,
    tiedPairs: differences.filter((value) => value === 0).length,
    unknownPairs: differences.filter((value) => value === null).length,
  };
}

function summarizeQualityCondition(samples: readonly MissionTrialRawMetric[]): MissionTrialQualityConditionSummary {
  return {
    fullCompletion: summarizeRate(samples.map((sample) => sample.fullCompletion)),
    falseBlocking: summarizeRate(samples.map((sample) => sample.falseBlocking)),
    architectureRegression: summarizeRate(samples.map((sample) => sample.architectureRegression)),
  };
}

function summarizeRate(values: readonly (boolean | null)[]): MissionTrialRateSummary {
  const known = values.filter((value): value is boolean => value !== null);
  const positive = known.filter(Boolean).length;
  return {
    observed: known.length,
    positive,
    unknown: values.length - known.length,
    rate: known.length > 0 ? positive / known.length : null,
  };
}

function summarizeEfficiency(
  pairs: readonly MissionTrialPairMetric[],
): Record<TelemetryField, MissionTrialTelemetrySummary> {
  const summaries = {} as Record<TelemetryField, MissionTrialTelemetrySummary>;
  for (const field of TELEMETRY_FIELDS) {
    const differences = pairs.map((pair) => pair.telemetry[field]);
    const observed = differences.filter(
      (
        value,
      ): value is MissionTrialTelemetryDifference & {
        control: number;
        workflow: number;
        difference: number;
      } => value.control !== null && value.workflow !== null && value.difference !== null,
    );
    const ratios = observed.map((value) => value.ratio).filter((value): value is number => value !== null);
    summaries[field] = {
      observedPairs: observed.length,
      unknownPairs: pairs.length - observed.length,
      medianControl: trialMedian(observed.map((value) => value.control)),
      medianWorkflow: trialMedian(observed.map((value) => value.workflow)),
      medianDifference: trialMedian(observed.map((value) => value.difference)),
      medianRatio: trialMedian(ratios),
    };
  }
  return summaries;
}

function summarizeFailureOrigins(samples: readonly MissionTrialRawMetric[]): MissionTrialFailureSummary {
  return {
    detectorMiss: samples.filter((sample) => sample.failureOrigin === 'detector-miss').length,
    controllerMiss: samples.filter((sample) => sample.failureOrigin === 'controller-miss').length,
    agentFailure: samples.filter((sample) => sample.failureOrigin === 'agent-failure').length,
    apparatusFailure: samples.filter((sample) => sample.failureOrigin === 'apparatus-failure').length,
    unattributed: samples.filter((sample) => sample.failureOrigin === null).length,
  };
}

function hasObservedDefects(value: readonly string[] | null): boolean {
  return value !== null && value.length > 0;
}

function isKnownEmpty(value: readonly string[] | null): boolean {
  return value !== null && value.length === 0;
}

function nullableListPresence(value: readonly string[] | null): boolean | null {
  return value === null ? null : value.length > 0;
}

function booleanDifference(control: boolean | null, workflow: boolean | null): -1 | 0 | 1 | null {
  if (control === null || workflow === null) return null;
  if (control === workflow) return 0;
  return workflow ? 1 : -1;
}

function trialMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle]!;
  return sorted.length % 2 === 1 ? upper : (sorted[middle - 1]! + upper) / 2;
}

function compareRuns(left: MissionTrialRunV1, right: MissionTrialRunV1): number {
  return (
    left.pairId.localeCompare(right.pairId) ||
    left.fixtureId.localeCompare(right.fixtureId) ||
    left.treatment.localeCompare(right.treatment) ||
    left.rerunOrdinal - right.rerunOrdinal ||
    left.recordedAt.localeCompare(right.recordedAt) ||
    left.runId.localeCompare(right.runId)
  );
}

function compareSelectionCandidates(left: SelectionCandidate, right: SelectionCandidate): number {
  return compareRuns(left.run, right.run);
}

function compareRawMetrics(left: MissionTrialRawMetric, right: MissionTrialRawMetric): number {
  return (
    left.pairId.localeCompare(right.pairId) ||
    left.fixtureId.localeCompare(right.fixtureId) ||
    left.treatment.localeCompare(right.treatment) ||
    left.rerunOrdinal - right.rerunOrdinal ||
    left.runId.localeCompare(right.runId)
  );
}

function comparePairs(left: MissionTrialPairMetric, right: MissionTrialPairMetric): number {
  return left.pairId.localeCompare(right.pairId) || left.fixtureId.localeCompare(right.fixtureId);
}
