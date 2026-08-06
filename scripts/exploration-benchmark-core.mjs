export const EXPLORATION_BENCHMARK_SCHEMA_VERSION = 1;

const CALL_SURFACES = new Set(['scip-query', 'native-search', 'native-read', 'other']);
const CALL_KINDS = new Set(['query', 'continuation', 'status', 'other']);

export function validateExplorationBenchmarkDefinition(value) {
  const definition = record(value, 'benchmark definition');
  if (definition.schemaVersion !== EXPLORATION_BENCHMARK_SCHEMA_VERSION) {
    throw new Error(
      `benchmark schemaVersion must be ${EXPLORATION_BENCHMARK_SCHEMA_VERSION}; received ${String(definition.schemaVersion)}`,
    );
  }
  requiredString(definition.id, 'benchmark id');
  requiredString(definition.question, 'benchmark question');
  const requiredFacts = nonEmptyArray(definition.requiredFacts, 'requiredFacts').map((fact, index) => {
    const parsed = record(fact, `requiredFacts[${index}]`);
    return {
      id: requiredString(parsed.id, `requiredFacts[${index}].id`),
      description: requiredString(parsed.description, `requiredFacts[${index}].description`),
      answerEvidenceAlternatives: evidenceAlternatives(
        parsed.answerEvidenceAlternatives,
        `requiredFacts[${index}].answerEvidenceAlternatives`,
      ),
    };
  });
  uniqueIds(requiredFacts, 'requiredFacts');
  const forbiddenClaims = array(definition.forbiddenClaims, 'forbiddenClaims').map((claim, index) => {
    const parsed = record(claim, `forbiddenClaims[${index}]`);
    return {
      id: requiredString(parsed.id, `forbiddenClaims[${index}].id`),
      answerIncludesAny: stringArray(parsed.answerIncludesAny, `forbiddenClaims[${index}].answerIncludesAny`, true),
    };
  });
  uniqueIds(forbiddenClaims, 'forbiddenClaims');
  const budgets = record(definition.budgets, 'budgets');
  const parsedBudgets = {
    maxToolCalls: nonNegativeInteger(budgets.maxToolCalls, 'budgets.maxToolCalls'),
    maxSemanticQueries: nonNegativeInteger(budgets.maxSemanticQueries, 'budgets.maxSemanticQueries'),
    maxRenderedCharacters: nonNegativeInteger(budgets.maxRenderedCharacters, 'budgets.maxRenderedCharacters'),
    maxNativeExplorationReads: nonNegativeInteger(
      budgets.maxNativeExplorationReads,
      'budgets.maxNativeExplorationReads',
    ),
  };
  return {
    ...definition,
    schemaVersion: EXPLORATION_BENCHMARK_SCHEMA_VERSION,
    id: definition.id,
    question: definition.question,
    requiredFacts,
    forbiddenClaims,
    budgets: parsedBudgets,
  };
}

export function validateExplorationTrial(value) {
  const trial = record(value, 'exploration trial');
  requiredString(trial.benchmarkId, 'trial benchmarkId');
  const calls = array(trial.calls, 'trial calls').map((call, index) => {
    const parsed = record(call, `trial calls[${index}]`);
    const surface = requiredString(parsed.surface, `trial calls[${index}].surface`);
    const kind = requiredString(parsed.kind, `trial calls[${index}].kind`);
    if (!CALL_SURFACES.has(surface)) throw new Error(`unsupported trial call surface: ${surface}`);
    if (!CALL_KINDS.has(kind)) throw new Error(`unsupported trial call kind: ${kind}`);
    return {
      surface,
      kind,
      command: requiredString(parsed.command, `trial calls[${index}].command`),
      output: typeof parsed.output === 'string' ? parsed.output : '',
      outputCharacters:
        parsed.outputCharacters === undefined
          ? typeof parsed.output === 'string'
            ? parsed.output.length
            : 0
          : nonNegativeInteger(parsed.outputCharacters, `trial calls[${index}].outputCharacters`),
    };
  });
  const usage = trial.usage === undefined ? undefined : modelUsage(trial.usage, 'trial usage');
  return {
    ...trial,
    benchmarkId: trial.benchmarkId,
    answer: requiredString(trial.answer, 'trial answer'),
    calls,
    ...(usage ? { usage } : {}),
  };
}

export function evaluateExplorationTrial(definitionValue, trialValue) {
  const definition = validateExplorationBenchmarkDefinition(definitionValue);
  const trial = validateExplorationTrial(trialValue);
  if (trial.benchmarkId !== definition.id) {
    throw new Error(`trial benchmarkId ${trial.benchmarkId} does not match definition ${definition.id}`);
  }

  const normalizedAnswer = normalizeText(trial.answer);
  const factResults = definition.requiredFacts.map((fact) => {
    const matchedAlternative = fact.answerEvidenceAlternatives.findIndex((alternative) =>
      alternative.every((evidence) => normalizedAnswer.includes(normalizeText(evidence))),
    );
    return {
      id: fact.id,
      description: fact.description,
      recovered: matchedAlternative >= 0,
      matchedAlternative: matchedAlternative >= 0 ? matchedAlternative : null,
    };
  });
  const forbiddenClaimResults = definition.forbiddenClaims.map((claim) => ({
    id: claim.id,
    found: claim.answerIncludesAny.some((evidence) => normalizedAnswer.includes(normalizeText(evidence))),
  }));
  const metrics = {
    toolCalls: trial.calls.filter((call) => call.kind !== 'status' && call.surface !== 'other').length,
    semanticQueries: trial.calls.filter((call) => call.surface === 'scip-query' && call.kind === 'query').length,
    transportContinuations: trial.calls.filter((call) => call.surface === 'scip-query' && call.kind === 'continuation')
      .length,
    renderedCharacters: trial.calls
      .filter((call) => call.kind !== 'status' && call.surface !== 'other')
      .reduce((total, call) => total + call.outputCharacters, 0),
    nativeExplorationReads: trial.calls.filter(
      (call) => call.surface === 'native-search' || call.surface === 'native-read',
    ).length,
    ...(trial.usage
      ? {
          modelInputTokens: trial.usage.inputTokens,
          cachedModelInputTokens: trial.usage.cachedInputTokens,
          uncachedModelInputTokens: trial.usage.inputTokens - trial.usage.cachedInputTokens,
          modelOutputTokens: trial.usage.outputTokens,
          reasoningOutputTokens: trial.usage.reasoningOutputTokens,
          totalModelTokens: trial.usage.inputTokens + trial.usage.outputTokens,
        }
      : {}),
  };
  const gates = {
    accuracy: factResults.every((fact) => fact.recovered),
    claimPrecision: forbiddenClaimResults.every((claim) => !claim.found),
    toolCalls: metrics.toolCalls <= definition.budgets.maxToolCalls,
    semanticQueries: metrics.semanticQueries <= definition.budgets.maxSemanticQueries,
    renderedCharacters: metrics.renderedCharacters <= definition.budgets.maxRenderedCharacters,
    nativeExplorationReads: metrics.nativeExplorationReads <= definition.budgets.maxNativeExplorationReads,
  };
  return {
    schemaVersion: EXPLORATION_BENCHMARK_SCHEMA_VERSION,
    benchmarkId: definition.id,
    pass: Object.values(gates).every(Boolean),
    factsRecovered: factResults.filter((fact) => fact.recovered).length,
    factsRequired: factResults.length,
    missingFacts: factResults.filter((fact) => !fact.recovered).map((fact) => fact.id),
    forbiddenClaimsFound: forbiddenClaimResults.filter((claim) => claim.found).map((claim) => claim.id),
    metrics,
    budgets: definition.budgets,
    gates,
    factResults,
  };
}

function evidenceAlternatives(value, label) {
  return nonEmptyArray(value, label).map((alternative, index) => stringArray(alternative, `${label}[${index}]`, true));
}

function normalizeText(value) {
  return value.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function nonEmptyArray(value, label) {
  const parsed = array(value, label);
  if (parsed.length === 0) throw new Error(`${label} must not be empty`);
  return parsed;
}

function stringArray(value, label, nonEmpty = false) {
  const parsed = array(value, label).map((entry, index) => requiredString(entry, `${label}[${index}]`));
  if (nonEmpty && parsed.length === 0) throw new Error(`${label} must not be empty`);
  return parsed;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function modelUsage(value, label) {
  const parsed = record(value, label);
  const usage = {
    inputTokens: nonNegativeInteger(parsed.inputTokens, `${label}.inputTokens`),
    cachedInputTokens: nonNegativeInteger(parsed.cachedInputTokens, `${label}.cachedInputTokens`),
    outputTokens: nonNegativeInteger(parsed.outputTokens, `${label}.outputTokens`),
    reasoningOutputTokens: nonNegativeInteger(parsed.reasoningOutputTokens, `${label}.reasoningOutputTokens`),
  };
  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new Error(`${label}.cachedInputTokens must not exceed inputTokens`);
  }
  return usage;
}

function uniqueIds(values, label) {
  const ids = values.map((value) => value.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ids must be unique`);
}
