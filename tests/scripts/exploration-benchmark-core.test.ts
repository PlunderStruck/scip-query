import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The benchmark core is an executable-script module and intentionally stays
// as native ESM outside the shipped TypeScript source tree.
// @ts-expect-error native script modules do not ship TypeScript declarations
import {
  evaluateExplorationTrial,
  validateExplorationBenchmarkDefinition,
} from '../../scripts/exploration-benchmark-core.mjs';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFINITION = readJson(join(PROJECT_ROOT, 'benchmarks/exploration/self-host-runtime-boundaries-v1.json'));
const COMPLETE_TRIAL = readJson(join(PROJECT_ROOT, 'tests/fixtures/exploration-benchmark/complete-trial.json'));
const MISSING_FACT_TRIAL = readJson(join(PROJECT_ROOT, 'tests/fixtures/exploration-benchmark/missing-fact-trial.json'));

describe('exploration benchmark core', () => {
  it('accepts an accurate scip-only trial within the preregistered budgets', () => {
    expect(evaluateExplorationTrial(DEFINITION, COMPLETE_TRIAL)).toMatchObject({
      pass: true,
      factsRecovered: 5,
      factsRequired: 5,
      missingFacts: [],
      metrics: {
        toolCalls: 2,
        semanticQueries: 2,
        transportContinuations: 0,
        nativeExplorationReads: 0,
      },
      gates: {
        accuracy: true,
        claimPrecision: true,
        toolCalls: true,
        semanticQueries: true,
        renderedCharacters: true,
        nativeExplorationReads: true,
      },
    });
  });

  it('records model tokens and precomputed output sizes without changing accuracy gates', () => {
    const trial = structuredClone(COMPLETE_TRIAL);
    trial.calls[0].outputCharacters = 100;
    trial.usage = {
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 100,
      reasoningOutputTokens: 25,
    };

    expect(evaluateExplorationTrial(DEFINITION, trial)).toMatchObject({
      pass: true,
      metrics: {
        renderedCharacters: 125,
        modelInputTokens: 1000,
        cachedModelInputTokens: 400,
        uncachedModelInputTokens: 600,
        modelOutputTokens: 100,
        reasoningOutputTokens: 25,
        totalModelTokens: 1100,
      },
    });
  });

  it('fails when the persisted-graph reader fact is removed from an otherwise accurate answer', () => {
    expect(evaluateExplorationTrial(DEFINITION, MISSING_FACT_TRIAL)).toMatchObject({
      pass: false,
      factsRecovered: 4,
      missingFacts: ['system-map-loads'],
      gates: { accuracy: false },
    });
  });

  it('fails independently for native exploration, forbidden claims, and output budget excess', () => {
    const native = structuredClone(COMPLETE_TRIAL);
    native.calls.push({
      surface: 'native-read',
      kind: 'query',
      command: 'sed -n 1,20p src/example.ts',
      output: 'source',
    });
    expect(evaluateExplorationTrial(DEFINITION, native).gates.nativeExplorationReads).toBe(false);

    const forbidden = structuredClone(COMPLETE_TRIAL);
    forbidden.answer += ' Symbols live inside a runtime boundary.';
    expect(evaluateExplorationTrial(DEFINITION, forbidden).gates.claimPrecision).toBe(false);

    const oversized = structuredClone(COMPLETE_TRIAL);
    oversized.calls[0].output = 'x'.repeat(15_001);
    expect(evaluateExplorationTrial(DEFINITION, oversized).gates.renderedCharacters).toBe(false);
  });

  it('does not charge a map-order precondition refusal as executed semantic analysis', () => {
    const refused = structuredClone(COMPLETE_TRIAL);
    refused.calls.push({
      surface: 'scip-query',
      kind: 'query',
      command: 'scip-query inspect --at src/file.ts:1',
      output: 'error: NAVIGATION MAP REQUIRED',
      preconditionRefusal: true,
    });

    expect(evaluateExplorationTrial(DEFINITION, refused).metrics).toMatchObject({
      toolCalls: 3,
      semanticQueries: 2,
    });
  });

  it('rejects malformed definitions before scoring them', () => {
    expect(() => validateExplorationBenchmarkDefinition({ ...DEFINITION, requiredFacts: [] })).toThrow(
      'requiredFacts must not be empty',
    );
    expect(() =>
      validateExplorationBenchmarkDefinition({
        ...DEFINITION,
        requiredFacts: [DEFINITION.requiredFacts[0], DEFINITION.requiredFacts[0]],
      }),
    ).toThrow('requiredFacts ids must be unique');
  });
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
