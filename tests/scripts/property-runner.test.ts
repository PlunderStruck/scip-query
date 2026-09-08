import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { it } from 'vitest';

it.each([
  { SCIP_PROPERTY_COMPONENT_RUNS: '1', SCIP_PROPERTY_SEED: '42' },
  { SCIP_PROPERTY_COMPONENT_RUNS: '200', SCIP_PROPERTY_SEED: 'invalid' },
])(
  'property CLI fails and writes an honest receipt for invalid/incomplete runs: %j',
  (overrides) => {
    const child = spawnSync(process.execPath, ['scripts/test-properties.mjs', '--area', 'graphs'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, ...overrides, SCIP_PROPERTY_INTEGRATION_RUNS: '1' },
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    const path = child.stdout.match(/Full results: ([^\r\n]+)/u)?.[1];
    assert.ok(path, child.stdout + child.stderr);
    try {
      const summary = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(summary.failed, true);
      assert.ok(summary.summary[0].componentCases < 200);
      if (overrides.SCIP_PROPERTY_SEED === 'invalid') assert.deepEqual(summary.runs, []);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  },
  30_000,
);
