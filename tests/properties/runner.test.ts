import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, it, vi } from 'vitest';
import { checkProperty } from './support.js';

afterEach(() => vi.unstubAllEnvs());

it('property runner records and replays a shrunk failing counterexample instead of reporting success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-property-runner-'));
  vi.stubEnv('SCIP_PROPERTY_RESULTS', root);
  vi.stubEnv('SCIP_PROPERTY_SEED', '12345');
  vi.stubEnv('SCIP_PROPERTY_COMPONENT_RUNS', '20');
  vi.stubEnv('SCIP_PROPERTY_PATH', undefined);
  const deliberatelyWrong = () => fc.property(fc.integer({ min: 10, max: 1000 }), (value) => value < 10);
  try {
    await assert.rejects(checkProperty('graphs', 'negative-control', deliberatelyWrong()), /Property failed/);
    const first = JSON.parse(readFileSync(join(root, readdirSync(root)[0]!), 'utf8'));
    assert.equal(first.failed, true);
    assert.equal(first.interrupted, false);
    assert.equal(first.seed, 12345);
    assert.equal(first.counterexample, '[10]');
    assert.equal(typeof first.counterexamplePath, 'string');
    vi.stubEnv('SCIP_PROPERTY_PATH', first.counterexamplePath);
    await assert.rejects(checkProperty('graphs', 'negative-control-replay', deliberatelyWrong()), /Property failed/);
    const replay = readdirSync(root)
      .map((file) => JSON.parse(readFileSync(join(root, file), 'utf8')))
      .find((run) => run.name === 'negative-control-replay');
    assert.equal(replay.counterexample, first.counterexample);
    assert.equal(replay.failed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('property runner refuses a zero case budget and an invalid seed', async () => {
  vi.stubEnv('SCIP_PROPERTY_COMPONENT_RUNS', '0');
  await assert.rejects(
    checkProperty(
      'graphs',
      'zero-budget',
      fc.property(fc.boolean(), () => true),
    ),
    /positive safe integer/,
  );
  vi.stubEnv('SCIP_PROPERTY_COMPONENT_RUNS', '1');
  vi.stubEnv('SCIP_PROPERTY_SEED', 'not-a-seed');
  await assert.rejects(
    checkProperty(
      'graphs',
      'invalid-seed',
      fc.property(fc.boolean(), () => true),
    ),
    /signed 32-bit integer/,
  );
});
