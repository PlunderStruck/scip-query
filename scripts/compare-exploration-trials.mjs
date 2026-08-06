#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { classifyExplorationCommand } from './codex-exploration-trial-core.mjs';
import { evaluateExplorationTrial } from './exploration-benchmark-core.mjs';

const [definitionPath, treatmentPath, controlPath, ...rest] = process.argv.slice(2);
if (!definitionPath || !treatmentPath || !controlPath || rest.length > 0) {
  process.stderr.write(
    'Usage: node scripts/compare-exploration-trials.mjs <definition.json> <treatment.json> <control.json>\n',
  );
  process.exit(2);
}

const definition = JSON.parse(readFileSync(definitionPath, 'utf8'));
const treatment = readArtifact(treatmentPath);
const control = readArtifact(controlPath);
if (treatment.trial.benchmarkId !== control.trial.benchmarkId) {
  throw new Error('treatment and control benchmark IDs differ');
}

const comparison = {
  benchmarkId: treatment.trial.benchmarkId,
  accuracyComparable: treatment.currentEvaluation.gates.accuracy && control.currentEvaluation.gates.accuracy,
  claimPrecisionComparable:
    treatment.currentEvaluation.gates.claimPrecision && control.currentEvaluation.gates.claimPrecision,
  treatment: summarize(treatment),
  control: summarize(control),
  delta: {
    modelInputTokens: delta(treatment, control, 'modelInputTokens'),
    uncachedModelInputTokens: delta(treatment, control, 'uncachedModelInputTokens'),
    modelOutputTokens: delta(treatment, control, 'modelOutputTokens'),
    totalModelTokens: delta(treatment, control, 'totalModelTokens'),
    renderedCharacters: delta(treatment, control, 'renderedCharacters'),
    toolCalls: delta(treatment, control, 'toolCalls'),
  },
};
process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);

function summarize(artifact) {
  return {
    factsRecovered: artifact.currentEvaluation.factsRecovered,
    factsRequired: artifact.currentEvaluation.factsRequired,
    missingFacts: artifact.currentEvaluation.missingFacts,
    claimPrecision: artifact.currentEvaluation.gates.claimPrecision,
    metrics: artifact.currentEvaluation.metrics,
    durationMs: artifact.trial.durationMs,
  };
}

function delta(treatmentArtifact, controlArtifact, key) {
  const treatmentValue = treatmentArtifact.currentEvaluation.metrics[key];
  const controlValue = controlArtifact.currentEvaluation.metrics[key];
  if (typeof treatmentValue !== 'number' || typeof controlValue !== 'number') return null;
  const absolute = treatmentValue - controlValue;
  return {
    absolute,
    percentOfControl: controlValue === 0 ? null : Number(((absolute / controlValue) * 100).toFixed(1)),
  };
}

function readArtifact(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed?.trial || !parsed?.evaluation) throw new Error(`${path} is not a model exploration artifact`);
  const trial = {
    ...parsed.trial,
    calls: parsed.trial.calls.map((call) => ({ ...call, ...classifyExplorationCommand(call.command) })),
  };
  return { ...parsed, trial, currentEvaluation: evaluateExplorationTrial(definition, trial) };
}
