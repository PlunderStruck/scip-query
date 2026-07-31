import { MISSION_TRIAL_METRICS_VERSION, type MissionTrialMetricReport } from './mission-trial-metrics.js';
import {
  MISSION_TRIAL_DECISION_RULE_VERSION,
  type MissionTrialDecisionThresholds,
  type MissionTrialProgramV1,
} from './mission-trials.js';

export const MISSION_TRIAL_CLASSIFICATION_VERSION = 1 as const;

export type MissionTrialClassification = 'established' | 'promising' | 'neutral' | 'regressed' | 'insufficient';

export interface MissionTrialCompletionAssessment {
  result: 'established' | 'positive' | 'neutral' | 'regressed' | 'unknown';
  controlRate: number | null;
  workflowRate: number | null;
  rateDifference: number | null;
  minimumRateDifference: number;
  probabilityTreatmentBetter: number;
  requiredProbability: number;
}

export interface MissionTrialSafetyAssessment {
  result: 'within-bounds' | 'regressed' | 'unknown';
  treatmentFalseBlockingRate: number | null;
  maximumTreatmentFalseBlockingRate: number;
  architectureRegressionRate: number | null;
  maximumArchitectureRegressionRate: number;
}

export interface MissionTrialEfficiencyAssessment {
  result: 'improved' | 'within-bounds' | 'regressed' | 'unknown';
  elapsedRatio: number | null;
  maximumElapsedRegressionRatio: number;
  tokenRatio: number | null;
  maximumTokenRegressionRatio: number;
  improvedDimensions: readonly ('elapsed' | 'model-tokens')[];
}

export interface MissionTrialPairedUncertainty {
  method: 'beta-1-1-posterior-and-wilson-direction-interval';
  improvedPairs: number;
  regressedPairs: number;
  discordantPairs: number;
  directionEstimate: number | null;
  probabilityTreatmentBetter: number;
  interval: {
    level: number;
    lower: number;
    upper: number;
  };
}

export interface MissionTrialClassificationResult {
  version: typeof MISSION_TRIAL_CLASSIFICATION_VERSION;
  programId: string;
  programDigest: string;
  metricsVersion: typeof MISSION_TRIAL_METRICS_VERSION;
  decisionRuleVersion: typeof MISSION_TRIAL_DECISION_RULE_VERSION;
  thresholds: MissionTrialDecisionThresholds;
  classification: MissionTrialClassification;
  matchedPairs: number;
  sufficiencyIssues: readonly string[];
  reasonCodes: readonly string[];
  completion: MissionTrialCompletionAssessment;
  safety: MissionTrialSafetyAssessment;
  efficiency: MissionTrialEfficiencyAssessment;
  uncertainty: MissionTrialPairedUncertainty;
}

/**
 * Applies only the thresholds content-bound into the trial program. The
 * result is deterministic over one immutable program and metric report.
 */
export function classifyMissionTrialReport(
  program: MissionTrialProgramV1,
  report: MissionTrialMetricReport,
): MissionTrialClassificationResult {
  const thresholds = program.decisionThresholds;
  const uncertainty = pairedCompletionUncertainty(
    report.quality.improvedPairs,
    report.quality.regressedPairs,
    thresholds.confidenceLevel,
  );
  const sufficiencyIssues = missionTrialSufficiencyIssues(program, report);
  const completion = assessCompletion(report, thresholds, uncertainty);
  const safety = assessSafety(report, thresholds);
  const efficiency = assessEfficiency(report, thresholds);
  const decision = decideClassification(sufficiencyIssues, completion, safety, efficiency);

  return {
    version: MISSION_TRIAL_CLASSIFICATION_VERSION,
    programId: program.programId,
    programDigest: program.semanticDigest,
    metricsVersion: MISSION_TRIAL_METRICS_VERSION,
    decisionRuleVersion: MISSION_TRIAL_DECISION_RULE_VERSION,
    thresholds,
    classification: decision.classification,
    matchedPairs: report.matchedPairCount,
    sufficiencyIssues,
    reasonCodes: decision.reasonCodes,
    completion,
    safety,
    efficiency,
    uncertainty,
  };
}

export function pairedCompletionUncertainty(
  improvedPairs: number,
  regressedPairs: number,
  confidenceLevel: number,
): MissionTrialPairedUncertainty {
  const discordantPairs = improvedPairs + regressedPairs;
  const directionEstimate = discordantPairs > 0 ? improvedPairs / discordantPairs : null;
  const interval = wilsonInterval(improvedPairs, discordantPairs, confidenceLevel);
  return {
    method: 'beta-1-1-posterior-and-wilson-direction-interval',
    improvedPairs,
    regressedPairs,
    discordantPairs,
    directionEstimate,
    probabilityTreatmentBetter: betaPosteriorProbabilityAboveHalf(improvedPairs + 1, regressedPairs + 1),
    interval: {
      level: confidenceLevel,
      ...interval,
    },
  };
}

function missionTrialSufficiencyIssues(program: MissionTrialProgramV1, report: MissionTrialMetricReport): string[] {
  const issues: string[] = [];
  if (report.programId !== program.programId) issues.push('program-report-identity-mismatch');
  if (report.version !== MISSION_TRIAL_METRICS_VERSION) issues.push('unsupported-metrics-version');
  if (report.integrityIssues.length > 0) issues.push('trial-record-integrity-issues');
  if (report.matchedPairCount < program.decisionThresholds.minimumPairs) {
    issues.push('below-minimum-paired-trial-count');
  }
  if (report.quality.control.fullCompletion.unknown > 0 || report.quality.workflow.fullCompletion.unknown > 0) {
    issues.push('unknown-full-completion-outcomes');
  }
  if (report.quality.workflow.falseBlocking.unknown > 0) {
    issues.push('unknown-treatment-false-blocking-outcomes');
  }
  if (report.quality.workflow.architectureRegression.unknown > 0) {
    issues.push('unknown-treatment-architecture-outcomes');
  }
  if (report.efficiency.elapsedMs.observedPairs !== report.matchedPairCount) {
    issues.push('unknown-paired-elapsed-time');
  }
  if (report.efficiency.modelTokens.observedPairs !== report.matchedPairCount) {
    issues.push('unknown-paired-model-tokens');
  }
  if (report.efficiency.elapsedMs.medianRatio === null) {
    issues.push('unusable-elapsed-time-baseline');
  }
  if (report.efficiency.modelTokens.medianRatio === null) {
    issues.push('unusable-model-token-baseline');
  }
  return [...new Set(issues)].sort();
}

function assessCompletion(
  report: MissionTrialMetricReport,
  thresholds: MissionTrialDecisionThresholds,
  uncertainty: MissionTrialPairedUncertainty,
): MissionTrialCompletionAssessment {
  const controlRate = report.quality.control.fullCompletion.rate;
  const workflowRate = report.quality.workflow.fullCompletion.rate;
  const rateDifference = report.quality.fullCompletionRateDifference;
  const evidenceEstablished =
    rateDifference !== null &&
    rateDifference > 0 &&
    rateDifference >= thresholds.minimumFullCompletionRateDelta &&
    uncertainty.probabilityTreatmentBetter > 0.5 &&
    uncertainty.probabilityTreatmentBetter >= thresholds.confidenceLevel;
  let result: MissionTrialCompletionAssessment['result'];
  if (rateDifference === null) result = 'unknown';
  else if (rateDifference < 0) result = 'regressed';
  else if (evidenceEstablished) result = 'established';
  else if (rateDifference > 0) result = 'positive';
  else result = 'neutral';
  return {
    result,
    controlRate,
    workflowRate,
    rateDifference,
    minimumRateDifference: thresholds.minimumFullCompletionRateDelta,
    probabilityTreatmentBetter: uncertainty.probabilityTreatmentBetter,
    requiredProbability: thresholds.confidenceLevel,
  };
}

function assessSafety(
  report: MissionTrialMetricReport,
  thresholds: MissionTrialDecisionThresholds,
): MissionTrialSafetyAssessment {
  const treatmentFalseBlockingRate = report.quality.workflow.falseBlocking.rate;
  const architectureRegressionRate = report.quality.workflow.architectureRegression.rate;
  let result: MissionTrialSafetyAssessment['result'];
  if (treatmentFalseBlockingRate === null || architectureRegressionRate === null) {
    result = 'unknown';
  } else if (
    treatmentFalseBlockingRate > thresholds.maximumTreatmentFalseBlockingRate ||
    architectureRegressionRate > thresholds.maximumArchitectureRegressionRate
  ) {
    result = 'regressed';
  } else {
    result = 'within-bounds';
  }
  return {
    result,
    treatmentFalseBlockingRate,
    maximumTreatmentFalseBlockingRate: thresholds.maximumTreatmentFalseBlockingRate,
    architectureRegressionRate,
    maximumArchitectureRegressionRate: thresholds.maximumArchitectureRegressionRate,
  };
}

function assessEfficiency(
  report: MissionTrialMetricReport,
  thresholds: MissionTrialDecisionThresholds,
): MissionTrialEfficiencyAssessment {
  const elapsedRatio = report.efficiency.elapsedMs.medianRatio;
  const tokenRatio = report.efficiency.modelTokens.medianRatio;
  const improvedDimensions: Array<'elapsed' | 'model-tokens'> = [];
  if (elapsedRatio !== null && elapsedRatio < 1) improvedDimensions.push('elapsed');
  if (tokenRatio !== null && tokenRatio < 1) improvedDimensions.push('model-tokens');
  let result: MissionTrialEfficiencyAssessment['result'];
  if (elapsedRatio === null || tokenRatio === null) {
    result = 'unknown';
  } else if (
    elapsedRatio > thresholds.maximumElapsedRegressionRatio ||
    tokenRatio > thresholds.maximumTokenRegressionRatio
  ) {
    result = 'regressed';
  } else if (improvedDimensions.length > 0) {
    result = 'improved';
  } else {
    result = 'within-bounds';
  }
  return {
    result,
    elapsedRatio,
    maximumElapsedRegressionRatio: thresholds.maximumElapsedRegressionRatio,
    tokenRatio,
    maximumTokenRegressionRatio: thresholds.maximumTokenRegressionRatio,
    improvedDimensions,
  };
}

function decideClassification(
  sufficiencyIssues: readonly string[],
  completion: MissionTrialCompletionAssessment,
  safety: MissionTrialSafetyAssessment,
  efficiency: MissionTrialEfficiencyAssessment,
): { classification: MissionTrialClassification; reasonCodes: string[] } {
  if (sufficiencyIssues.length > 0) {
    return {
      classification: 'insufficient',
      reasonCodes: ['required-trial-evidence-is-insufficient'],
    };
  }
  const regressions: string[] = [];
  if (completion.result === 'regressed') regressions.push('full-completion-regressed');
  if (safety.result === 'regressed') regressions.push('safety-bound-exceeded');
  if (efficiency.result === 'regressed') regressions.push('efficiency-bound-exceeded');
  if (regressions.length > 0) {
    return { classification: 'regressed', reasonCodes: regressions };
  }
  if (completion.result === 'established' && safety.result === 'within-bounds' && efficiency.result === 'improved') {
    return {
      classification: 'established',
      reasonCodes: [
        'full-completion-improvement-established',
        'safety-within-preregistered-bounds',
        'efficiency-improved-within-preregistered-bounds',
      ],
    };
  }
  if (completion.result === 'positive' || completion.result === 'established') {
    return {
      classification: 'promising',
      reasonCodes: [
        completion.result === 'positive'
          ? 'full-completion-direction-positive-but-not-established'
          : 'full-completion-established-but-efficiency-not-improved',
        'safety-within-preregistered-bounds',
      ],
    };
  }
  return {
    classification: 'neutral',
    reasonCodes: ['no-full-completion-advantage-established', 'no-unacceptable-regression-observed'],
  };
}

function betaPosteriorProbabilityAboveHalf(alpha: number, beta: number): number {
  const trials = alpha + beta - 1;
  let logTerm = -trials * Math.log(2);
  let logSum = Number.NEGATIVE_INFINITY;
  for (let successes = 0; successes < alpha; successes += 1) {
    logSum = logAdd(logSum, logTerm);
    if (successes < alpha - 1) {
      logTerm += Math.log(trials - successes) - Math.log(successes + 1);
    }
  }
  return clampProbability(Math.exp(logSum));
}

function wilsonInterval(positive: number, total: number, confidenceLevel: number): { lower: number; upper: number } {
  if (total === 0 || confidenceLevel >= 1) return { lower: 0, upper: 1 };
  const proportion = positive / total;
  if (confidenceLevel <= 0) return { lower: proportion, upper: proportion };
  const z = inverseStandardNormal((1 + confidenceLevel) / 2);
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const spread = (z / denominator) * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total);
  return {
    lower: clampProbability(center - spread),
    upper: clampProbability(center + spread),
  };
}

// Peter Acklam's rational approximation, sufficient for reported trial intervals.
function inverseStandardNormal(probability: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lower = 0.02425;
  const upper = 1 - lower;
  if (probability < lower) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return rationalTail(q, c, d);
  }
  if (probability > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -rationalTail(q, c, d);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

function rationalTail(q: number, numerator: readonly number[], denominator: readonly number[]): number {
  return (
    (((((numerator[0]! * q + numerator[1]!) * q + numerator[2]!) * q + numerator[3]!) * q + numerator[4]!) * q +
      numerator[5]!) /
    ((((denominator[0]! * q + denominator[1]!) * q + denominator[2]!) * q + denominator[3]!) * q + 1)
  );
}

function logAdd(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) return right;
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
}

function clampProbability(value: number): number {
  return Math.min(1, Math.max(0, value));
}
